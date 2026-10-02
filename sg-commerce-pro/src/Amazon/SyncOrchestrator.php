<?php
/**
 * SyncOrchestrator — pulls SP-API data into our database.
 *
 * Two endpoints currently:
 *   GET /fba/inventory/v1/summaries — inventory levels
 *   GET /products/pricing/v0/items   — Buy Box price + lowest price
 *
 * Per-marketplace sync is wrapped in try/catch so one broken region
 * doesn't kill the whole run. Records are persisted via repositories.
 * After each upsert we record a price snapshot for analytics.
 *
 * Emits events:
 *   product.synced            after each row
 *   sync.market.completed     after each market
 *   sync.completed            after all markets
 *
 * @package SevenGum\Commerce\Amazon
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon;

use SevenGum\Commerce\Database\Repositories\PriceHistoryRepository;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Events\EventDispatcher;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class SyncOrchestrator {

	public function __construct(
		private AmazonClient $client,
		private Marketplaces $marketplaces,
		private ProductRepository $products,
		private PriceHistoryRepository $price_history,
		private EventDispatcher $events,
		private Logger $logger,
	) {}

	public function sync_market( string $market, int $max_pages = 5 ): array {
		$mp = $this->marketplaces->get( $market );
		if ( null === $mp ) {
			throw new \RuntimeException( "Unknown marketplace: {$market}" );
		}

		$lock_key = 'sg_sync_lock_' . $market;
		if ( get_transient( $lock_key ) ) {
			throw new \RuntimeException( "Sync already in progress for {$market}." );
		}
		set_transient( $lock_key, time(), 10 * MINUTE_IN_SECONDS );

		try {
			$summary = $this->do_sync_market( $mp, $market, $max_pages );
			$this->events->emit( 'sync.market.completed', array( 'market' => $market, 'summary' => $summary ) );
			return $summary;
		} finally {
			delete_transient( $lock_key );
		}
	}

	private function do_sync_market( array $mp, string $market, int $max_pages ): array {
		$next_token = null;
		$total      = 0;
		$page       = 0;
		$asins      = array();

		do {
			$query = array(
				'granularityType' => 'Marketplace',
				'granularityId'   => $mp['id'],
				'marketplaceIds'  => $mp['id'],
				'details'         => 'true',
			);
			if ( null !== $next_token ) {
				$query['nextToken'] = $next_token;
			}

			$json = $this->client->request(
				'GET',
				$market,
				'/fba/inventory/v1/summaries',
				$query,
				null,
				'fbaInventory.summaries'
			);

			$summaries = $json['payload']['inventorySummaries'] ?? array();
			if ( ! is_array( $summaries ) ) {
				break;
			}

			foreach ( $summaries as $item ) {
				$sku  = (string) ( $item['sellerSku']   ?? '' );
				$asin = (string) ( $item['asin']        ?? '' );
				$name = (string) ( $item['productName'] ?? '' );
				$details = $item['inventoryDetails'] ?? array();
				$qty  = (int) ( $details['fulfillableQuantity'] ?? 0 );
				$rsv  = (int) ( $details['reservedQuantity']['totalReservedQuantity'] ?? 0 );
				$inb  = (int) ( $details['inboundWorkingQuantity'] ?? 0 )
					+ (int) ( $details['inboundShippedQuantity'] ?? 0 )
					+ (int) ( $details['inboundReceivingQuantity'] ?? 0 );

				if ( '' === $sku ) {
					continue;
				}

				try {
					$id = $this->products->upsert_from_sync( array(
						'market'          => $market,
						'sku'             => $sku,
						'asin'            => $asin,
						'product_name'    => $name,
						'fulfillable_qty' => $qty,
						'reserved_qty'    => $rsv,
						'inbound_qty'     => $inb,
					) );
					if ( $id > 0 ) {
						++$total;
						if ( '' !== $asin ) {
							$asins[ $id ] = $asin;
						}
						$this->events->emit( 'product.synced', array( 'product_id' => $id, 'market' => $market ) );
					}
				} catch ( \Throwable $e ) {
					$this->logger->error( 'product upsert failed', array( 'sku' => $sku, 'err' => $e->getMessage() ) );
				}
			}

			$next_token = (string) ( $json['pagination']['nextToken'] ?? '' );
			++$page;
		} while ( '' !== $next_token && $page < $max_pages );

		// Pricing pass — fetch competitive pricing for ASINs we just synced.
		if ( ! empty( $asins ) ) {
			$this->sync_pricing_for( $market, $mp['id'], $asins );
		}

		$this->logger->info( 'sync market complete', array( 'market' => $market, 'rows' => $total, 'pages' => $page ) );
		return array( 'rows' => $total, 'pages' => $page );
	}

	/**
	 * Fetch competitive pricing for up to 20 ASINs at a time.
	 *
	 * @param array<int,string> $product_id_to_asin
	 */
	private function sync_pricing_for( string $market, string $market_id, array $product_id_to_asin ): void {
		$chunks = array_chunk( $product_id_to_asin, 20, true );

		foreach ( $chunks as $chunk ) {
			try {
				$json = $this->client->request(
					'GET',
					$market,
					'/products/pricing/v0/competitivePrice',
					array(
						'MarketplaceId' => $market_id,
						'ItemType'      => 'Asin',
						'Asins'         => implode( ',', array_values( $chunk ) ),
					),
					null,
					'pricing.competitivePricing'
				);
			} catch ( \Throwable $e ) {
				$this->logger->warning( 'pricing fetch failed', array( 'market' => $market, 'err' => $e->getMessage() ) );
				continue;
			}

			$payload = $json['payload'] ?? array();
			if ( ! is_array( $payload ) ) {
				continue;
			}
			$asin_to_id = array_flip( $chunk );

			foreach ( $payload as $entry ) {
				$asin = (string) ( $entry['ASIN'] ?? '' );
				if ( '' === $asin || ! isset( $asin_to_id[ $asin ] ) ) {
					continue;
				}
				$id = (int) $asin_to_id[ $asin ];

				$competitive = $entry['Product']['CompetitivePricing']['CompetitivePrices'] ?? array();
				$best        = $this->extract_buybox( $competitive );

				$row = $this->products->find( $id );
				if ( ! $row ) continue;

				try {
					$this->products->upsert_from_sync( array(
						'market'          => $row['market'],
						'sku'             => $row['sku'],
						'asin'            => $row['asin'],
						'product_name'    => $row['product_name'],
						'fulfillable_qty' => (int) $row['fulfillable_qty'],
						'reserved_qty'    => (int) $row['reserved_qty'],
						'inbound_qty'     => (int) $row['inbound_qty'],
						'buybox_price'    => $best['price'],
						'buybox_currency' => $best['currency'],
						'buybox_is_mine'  => 0, // determined by /listings — out of scope for v3.0
						'lowest_price'    => $best['price'],
					) );

					$this->price_history->record( $id, array(
						'my_price'        => isset( $row['my_price'] ) ? (float) $row['my_price'] : null,
						'buybox_price'    => $best['price'],
						'lowest_price'    => $best['price'],
						'currency'        => $best['currency'],
						'buybox_is_mine'  => 0,
						'fulfillable_qty' => (int) $row['fulfillable_qty'],
					) );
				} catch ( \Throwable $e ) {
					$this->logger->error( 'pricing upsert failed', array( 'id' => $id, 'err' => $e->getMessage() ) );
				}
			}
		}
	}

	/** Extract the New-condition Buy Box price from a competitive-prices payload. */
	private function extract_buybox( array $prices ): array {
		foreach ( $prices as $cp ) {
			if ( ( $cp['CompetitivePriceId'] ?? '' ) === '1' && ( $cp['condition'] ?? 'New' ) === 'New' ) {
				return array(
					'price'    => isset( $cp['Price']['LandedPrice']['Amount'] )
						? (float) $cp['Price']['LandedPrice']['Amount']
						: null,
					'currency' => (string) ( $cp['Price']['LandedPrice']['CurrencyCode'] ?? '' ),
				);
			}
		}
		return array( 'price' => null, 'currency' => '' );
	}

	public function sync_all( int $max_pages = 5 ): array {
		$results = array( 'total' => 0, 'by_market' => array(), 'errors' => array() );
		foreach ( $this->marketplaces->enabled_codes() as $market ) {
			try {
				$summary = $this->sync_market( $market, $max_pages );
				$results['by_market'][ $market ] = $summary['rows'];
				$results['total']               += $summary['rows'];
			} catch ( \Throwable $e ) {
				$results['errors'][ $market ] = $e->getMessage();
				$this->logger->error( 'market sync failed', array( 'market' => $market, 'err' => $e->getMessage() ) );
			}
		}
		$this->events->emit( 'sync.completed', $results );
		return $results;
	}

	/** Cron entrypoint. */
	public function cron_sync(): void {
		if ( ! $this->client->has_credentials() ) {
			return;
		}
		try {
			$result = $this->sync_all();
			update_option( 'sg_commerce_last_cron_sync', array(
				'at'        => time(),
				'total'     => $result['total'],
				'by_market' => $result['by_market'],
				'errors'    => $result['errors'],
			), false );
		} catch ( \Throwable $e ) {
			$this->logger->error( 'cron sync failed: ' . $e->getMessage() );
		}
	}
}
