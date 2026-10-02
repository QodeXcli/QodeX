<?php
/**
 * OrdersSync — near-real-time orders via SP-API Orders v0, plus bulk
 * history via the flat-file all-orders report.
 *
 *   GET /orders/v0/orders?MarketplaceIds=…&LastUpdatedAfter=…        (0.0167 rps, burst 20)
 *   GET /orders/v0/orders/{orderId}/orderItems                       (0.5 rps, burst 30)
 *
 * The Orders API is the only source for *today's* sales (reports lag by
 * ~30 min to hours), but order items cost one call per order — so items
 * are fetched lazily, N orders per tick (`suite_order_items_per_run`).
 * History older than a day comes from the report pipeline, which ships
 * orders AND items in one document.
 *
 * Buyer PII (name, address, email) is never requested and never stored —
 * only ship country for geography analytics, which is not restricted data.
 *
 * @package SevenGum\Commerce\Suite\Orders
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Orders;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Suite\Reports\ReportParser;
use SevenGum\Commerce\Suite\SuiteSettings;
use SevenGum\Commerce\Suite\Support\Db;
use SevenGum\Commerce\Suite\Support\SuiteTime;

defined( 'ABSPATH' ) || exit;

final class OrdersSync {

	private const CURSOR_OPTION = 'sg_suite_orders_cursor_';
	private const MAX_PAGES     = 10;

	public function __construct(
		private AmazonClient $client,
		private Marketplaces $marketplaces,
		private SuiteSettings $settings,
		private Logger $logger,
	) {}

	/** @return array{orders:int, items:int} */
	public function run(): array {
		$stats = array( 'orders' => 0, 'items' => 0 );
		if ( ! $this->client->has_credentials() ) {
			return $stats;
		}
		foreach ( $this->marketplaces->enabled_codes() as $market ) {
			try {
				$stats['orders'] += $this->sync_market( $market );
			} catch ( \Throwable $e ) {
				$this->logger->warning( 'Suite orders sync failed', array( 'market' => $market, 'error' => $e->getMessage() ) );
			}
		}
		$stats['items'] = $this->sync_pending_items( max( 1, $this->settings->int( 'suite_order_items_per_run' ) ) );
		return $stats;
	}

	public function sync_market( string $market ): int {
		$mp = $this->marketplaces->get( $market );
		if ( ! $mp ) {
			return 0;
		}
		$cursor = (string) get_option( self::CURSOR_OPTION . $market, '' );
		if ( '' === $cursor ) {
			// First run: the report backfill covers history; API covers the last 2 days.
			$cursor = gmdate( 'Y-m-d\TH:i:s\Z', time() - 2 * DAY_IN_SECONDS );
		}
		$query = array(
			'MarketplaceIds'    => $mp['id'],
			'LastUpdatedAfter'  => $cursor,
			'MaxResultsPerPage' => 100,
		);
		$count  = 0;
		$pages  = 0;
		$latest = $cursor;
		do {
			$res     = $this->client->request( 'GET', $market, '/orders/v0/orders', $query, null, 'orders.list' );
			$payload = (array) ( $res['payload'] ?? array() );
			foreach ( (array) ( $payload['Orders'] ?? array() ) as $o ) {
				if ( $this->store_api_order( $o, $market ) ) {
					$count++;
				}
				$lu = (string) ( $o['LastUpdateDate'] ?? '' );
				if ( '' !== $lu && strcmp( $lu, $latest ) > 0 ) {
					$latest = $lu;
				}
			}
			$next  = (string) ( $payload['NextToken'] ?? '' );
			$query = array( 'MarketplaceIds' => $mp['id'], 'NextToken' => $next );
			$pages++;
		} while ( '' !== $next && $pages < self::MAX_PAGES );

		update_option( self::CURSOR_OPTION . $market, $latest, false );
		return $count;
	}

	public function store_api_order( array $o, string $market, bool $demo = false ): bool {
		$id = (string) ( $o['AmazonOrderId'] ?? '' );
		if ( '' === $id ) {
			return false;
		}
		$purchase = SuiteTime::to_mysql( (string) ( $o['PurchaseDate'] ?? '' ) ) ?? Db::now();
		$code     = $this->marketplaces->code_by_id( (string) ( $o['MarketplaceId'] ?? '' ) ) ?: $market;
		$units    = (int) ( $o['NumberOfItemsShipped'] ?? 0 ) + (int) ( $o['NumberOfItemsUnshipped'] ?? 0 );
		$row = array(
			'market'              => $code,
			'amazon_order_id'     => $id,
			'purchase_date'       => $purchase,
			'local_date'          => SuiteTime::local_date( $purchase, $code ),
			'last_update'         => SuiteTime::to_mysql( (string) ( $o['LastUpdateDate'] ?? '' ) ),
			'status'              => (string) ( $o['OrderStatus'] ?? '' ),
			'fulfillment_channel' => (string) ( $o['FulfillmentChannel'] ?? '' ),
			'sales_channel'       => (string) ( $o['SalesChannel'] ?? '' ),
			'order_total'         => (float) ( $o['OrderTotal']['Amount'] ?? 0 ),
			'currency'            => (string) ( $o['OrderTotal']['CurrencyCode'] ?? '' ),
			'units'               => $units,
			'is_business'         => ! empty( $o['IsBusinessOrder'] ) ? 1 : 0,
			'is_prime'            => ! empty( $o['IsPrime'] ) ? 1 : 0,
			'ship_country'        => substr( (string) ( $o['ShippingAddress']['CountryCode'] ?? '' ), 0, 2 ),
			'earliest_delivery'   => SuiteTime::to_mysql( (string) ( $o['EarliestDeliveryDate'] ?? '' ) ),
			'latest_delivery'     => SuiteTime::to_mysql( (string) ( $o['LatestDeliveryDate'] ?? '' ) ),
			'is_demo'             => $demo ? 1 : 0,
		);
		$ok = Db::upsert( 'orders', $row, array( 'items_synced' ) );
		// Status changes (e.g. Pending → Shipped, → Canceled) must cascade to items.
		Db::exec( 'UPDATE {t:order_items} SET status = %s WHERE amazon_order_id = %s', array( $row['status'], $id ) );
		return $ok;
	}

	/** Fetch items for orders that don't have them yet. */
	public function sync_pending_items( int $limit ): int {
		$orders = Db::rows(
			"SELECT amazon_order_id, market, local_date, status FROM {t:orders}
			 WHERE items_synced = 0 AND is_demo = 0 AND status <> 'Canceled'
			 ORDER BY purchase_date DESC LIMIT %d",
			array( $limit )
		);
		$n = 0;
		foreach ( $orders as $o ) {
			try {
				$res   = $this->client->request( 'GET', (string) $o['market'], '/orders/v0/orders/' . rawurlencode( (string) $o['amazon_order_id'] ) . '/orderItems', array(), null, 'orders.items' );
				$items = (array) ( $res['payload']['OrderItems'] ?? array() );
				if ( $items ) {
					// Real OrderItemIds supersede report-derived placeholder rows.
					Db::exec( 'DELETE FROM {t:order_items} WHERE amazon_order_id = %s AND order_item_id LIKE %s', array( $o['amazon_order_id'], 'ff-%' ) );
				}
				foreach ( $items as $it ) {
					$this->store_item( (string) $o['amazon_order_id'], (string) $o['market'], (string) $o['local_date'], (string) $o['status'], $it );
					$n++;
				}
				// Only mark synced once priced (Pending orders return no ItemPrice).
				$priced = 'Pending' !== $o['status'];
				Db::exec( 'UPDATE {t:orders} SET items_synced = %d WHERE amazon_order_id = %s', array( $priced ? 1 : 0, $o['amazon_order_id'] ) );
			} catch ( \Throwable $e ) {
				$this->logger->warning( 'Suite order items fetch failed', array( 'order' => $o['amazon_order_id'], 'error' => $e->getMessage() ) );
				break; // Likely throttled — resume next tick.
			}
		}
		return $n;
	}

	public function store_item( string $order_id, string $market, string $local_date, string $status, array $it, bool $demo = false ): bool {
		return Db::upsert( 'order_items', array(
			'market'          => $market,
			'amazon_order_id' => $order_id,
			'order_item_id'   => (string) ( $it['OrderItemId'] ?? md5( $order_id . ( $it['SellerSKU'] ?? '' ) ) ),
			'local_date'      => $local_date,
			'sku'             => (string) ( $it['SellerSKU'] ?? '' ),
			'asin'            => (string) ( $it['ASIN'] ?? '' ),
			'title'           => mb_substr( (string) ( $it['Title'] ?? '' ), 0, 255 ),
			'qty'             => (int) ( $it['QuantityOrdered'] ?? 0 ),
			'item_price'      => (float) ( $it['ItemPrice']['Amount'] ?? 0 ),
			'item_tax'        => (float) ( $it['ItemTax']['Amount'] ?? 0 ),
			'promo_discount'  => (float) ( $it['PromotionDiscount']['Amount'] ?? 0 ),
			'status'          => $status,
			'is_demo'         => $demo ? 1 : 0,
		) );
	}

	/**
	 * Ingest GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL (TSV).
	 * One row per order item; PII columns are ignored.
	 */
	public function ingest_flat_file( string $raw, string $market ): int {
		$rows   = ReportParser::tsv( $raw );
		$orders = array();
		$n      = 0;
		$api_owned = array(); // order id => true when the Orders API already stored real items.
		foreach ( $rows as $r ) {
			$id = (string) ( $r['amazon-order-id'] ?? '' );
			if ( '' === $id ) {
				continue;
			}
			if ( ! isset( $api_owned[ $id ] ) ) {
				$api_owned[ $id ] = (int) Db::var(
					'SELECT COUNT(*) FROM {t:order_items} WHERE amazon_order_id = %s AND order_item_id NOT LIKE %s',
					array( $id, 'ff-%' )
				) > 0;
			}
			$sales_channel = (string) ( $r['sales-channel'] ?? '' );
			if ( '' !== $sales_channel && ! str_starts_with( strtolower( $sales_channel ), 'amazon.' ) ) {
				continue; // Non-Amazon (MCF) orders are not marketplace sales.
			}
			$purchase = SuiteTime::to_mysql( (string) ( $r['purchase-date'] ?? '' ) ) ?? Db::now();
			$local    = SuiteTime::local_date( $purchase, $market );
			$status   = (string) ( $r['order-status'] ?? '' );
			$price    = ReportParser::money( $r['item-price'] ?? 0 );
			$qty      = (int) ( $r['quantity'] ?? 0 );
			if ( ! isset( $orders[ $id ] ) ) {
				$orders[ $id ] = array(
					'market'              => $market,
					'amazon_order_id'     => $id,
					'purchase_date'       => $purchase,
					'local_date'          => $local,
					'last_update'         => SuiteTime::to_mysql( (string) ( $r['last-updated-date'] ?? '' ) ),
					'status'              => $status,
					'fulfillment_channel' => 'Amazon' === ( $r['fulfillment-channel'] ?? '' ) ? 'AFN' : 'MFN',
					'sales_channel'       => $sales_channel,
					'order_total'         => 0.0,
					'currency'            => (string) ( $r['currency'] ?? '' ),
					'units'               => 0,
					'is_business'         => 'true' === strtolower( (string) ( $r['is-business-order'] ?? '' ) ) ? 1 : 0,
					'is_prime'            => 0,
					'ship_country'        => substr( (string) ( $r['ship-country'] ?? '' ), 0, 2 ),
					'items_synced'        => 1,
					'is_demo'             => 0,
				);
			}
			$orders[ $id ]['order_total'] += $price + ReportParser::money( $r['shipping-price'] ?? 0 );
			$orders[ $id ]['units']       += $qty;
			if ( $api_owned[ $id ] ) {
				$n++;
				continue;
			}
			Db::upsert( 'order_items', array(
				'market'          => $market,
				'amazon_order_id' => $id,
				'order_item_id'   => 'ff-' . md5( $id . '|' . ( $r['sku'] ?? '' ) . '|' . ( $r['asin'] ?? '' ) ),
				'local_date'      => $local,
				'sku'             => (string) ( $r['sku'] ?? '' ),
				'asin'            => (string) ( $r['asin'] ?? '' ),
				'title'           => mb_substr( (string) ( $r['product-name'] ?? '' ), 0, 255 ),
				'qty'             => $qty,
				'item_price'      => $price,
				'item_tax'        => ReportParser::money( $r['item-tax'] ?? 0 ),
				'promo_discount'  => abs( ReportParser::money( $r['item-promotion-discount'] ?? 0 ) ),
				'status'          => $status,
				'is_demo'         => 0,
			) );
			$n++;
		}
		foreach ( $orders as $row ) {
			// API-sourced rows (with real OrderItemIds) win; only insert when absent.
			$exists = (int) Db::var( 'SELECT COUNT(*) FROM {t:orders} WHERE amazon_order_id = %s', array( $row['amazon_order_id'] ) );
			if ( 0 === $exists ) {
				Db::upsert( 'orders', $row );
			} else {
				Db::exec( 'UPDATE {t:orders} SET status = %s WHERE amazon_order_id = %s', array( $row['status'], $row['amazon_order_id'] ) );
			}
		}
		return $n;
	}
}
