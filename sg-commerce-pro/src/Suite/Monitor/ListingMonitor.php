<?php
/**
 * ListingMonitor — hijacker, Buy Box and competitor price/BSR tracking.
 *
 *   GET /products/pricing/v0/items/{Asin}/offers?MarketplaceId=…&ItemCondition=New
 *
 * For every own ASIN (and any extra competitor ASINs) each run:
 *   - snapshot price, Buy Box price/owner, offer counts, BSR → asin_snapshots
 *     (this is the Keepa-style history chart)
 *   - track every seller on the listing → offer_sellers
 *   - alert on: a NEW third-party seller on your ASIN (hijacker),
 *     losing the Buy Box (transition only), Buy Box suppressed,
 *     a competitor price drop larger than the configured %.
 *
 * Pricing quota is 0.5 rps (burst 1); a full pass over ~20 ASINs takes
 * ~40 s, so runs are batched and resumable via a rotating cursor.
 *
 * @package SevenGum\Commerce\Suite\Monitor
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Monitor;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Suite\Support\SuiteAlerts;
use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Suite\SuiteSettings;
use SevenGum\Commerce\Suite\Support\Db;

defined( 'ABSPATH' ) || exit;

final class ListingMonitor {

	private const BATCH  = 15;
	private const CURSOR = 'sg_suite_monitor_cursor';

	public function __construct(
		private AmazonClient $client,
		private Marketplaces $marketplaces,
		private SuiteSettings $settings,
		private Logger $logger,
	) {}

	/** @return array<int, array{market:string, asin:string, mine:bool}> */
	public function watchlist(): array {
		global $wpdb;
		$out = array();
		$rows = $wpdb->get_results( "SELECT DISTINCT market, asin FROM {$wpdb->prefix}sg_products WHERE asin <> ''", ARRAY_A ) ?: array(); // phpcs:ignore
		foreach ( $rows as $r ) {
			$out[ $r['market'] . '|' . $r['asin'] ] = array( 'market' => (string) $r['market'], 'asin' => (string) $r['asin'], 'mine' => true );
		}
		$comp = $wpdb->get_results( "SELECT DISTINCT market, asin FROM {$wpdb->prefix}sg_competitors", ARRAY_A ) ?: array(); // phpcs:ignore
		foreach ( $comp as $r ) {
			$out[ $r['market'] . '|' . $r['asin'] ] ??= array( 'market' => (string) $r['market'], 'asin' => (string) $r['asin'], 'mine' => false );
		}
		$primary = $this->marketplaces->primary();
		foreach ( preg_split( '/[\s,]+/', strtoupper( $this->settings->string( 'suite_monitor_extra_asins' ) ) ) ?: array() as $a ) {
			if ( 1 === preg_match( '/^B0[A-Z0-9]{8}$/', $a ) ) {
				$out[ $primary . '|' . $a ] ??= array( 'market' => $primary, 'asin' => $a, 'mine' => false );
			}
		}
		return array_values( $out );
	}

	/** @return array{checked:int, alerts:int} */
	public function run(): array {
		$stats = array( 'checked' => 0, 'alerts' => 0 );
		if ( ! $this->client->has_credentials() ) {
			return $stats;
		}
		$list = $this->watchlist();
		if ( ! $list ) {
			return $stats;
		}
		$cursor = (int) get_option( self::CURSOR, 0 ) % count( $list );
		$batch  = array_slice( array_merge( array_slice( $list, $cursor ), array_slice( $list, 0, $cursor ) ), 0, self::BATCH );
		foreach ( $batch as $item ) {
			try {
				$mp  = $this->marketplaces->get( $item['market'] );
				$res = $this->client->request(
					'GET', $item['market'],
					'/products/pricing/v0/items/' . rawurlencode( $item['asin'] ) . '/offers',
					array( 'MarketplaceId' => (string) ( $mp['id'] ?? '' ), 'ItemCondition' => 'New' ),
					null, 'pricing.itemOffers'
				);
				$stats['alerts'] += $this->process( $item['market'], $item['asin'], $item['mine'], (array) ( $res['payload'] ?? array() ) );
				$stats['checked']++;
			} catch ( \Throwable $e ) {
				$this->logger->warning( 'Suite monitor fetch failed', array( 'asin' => $item['asin'], 'error' => $e->getMessage() ) );
				if ( str_contains( $e->getMessage(), 'Rate limit' ) || str_contains( $e->getMessage(), '429' ) ) {
					break;
				}
			}
		}
		update_option( self::CURSOR, ( $cursor + count( $batch ) ) % max( 1, count( $list ) ), false );
		return $stats;
	}

	/**
	 * Process one getItemOffers payload. Returns number of alerts raised.
	 */
	public function process( string $market, string $asin, bool $mine, array $payload, bool $demo = false, ?string $now = null ): int {
		$now     = $now ?? Db::now();
		$me      = $this->settings->seller_id();
		$offers  = (array) ( $payload['Offers'] ?? array() );
		$summary = (array) ( $payload['Summary'] ?? array() );

		$bb_price  = null;
		$bb_seller = '';
		$my_price  = null;
		$lowest    = null;
		$fba       = 0;
		$sellers   = array();
		foreach ( $offers as $o ) {
			$price  = (float) ( $o['ListingPrice']['Amount'] ?? 0 ) + (float) ( $o['Shipping']['Amount'] ?? 0 );
			$seller = (string) ( $o['SellerId'] ?? '' );
			$is_me  = ! empty( $o['MyOffer'] ) || ( '' !== $me && $seller === $me );
			if ( ! empty( $o['IsBuyBoxWinner'] ) ) {
				$bb_price  = $price;
				$bb_seller = $is_me ? ( '' !== $me ? $me : 'ME' ) : $seller;
			}
			if ( $is_me ) {
				$my_price = $price;
			}
			if ( ! empty( $o['IsFulfilledByAmazon'] ) ) {
				$fba++;
			}
			$lowest = null === $lowest ? $price : min( $lowest, $price );
			if ( '' !== $seller ) {
				$sellers[ $seller ] = array( 'is_me' => $is_me, 'fba' => ! empty( $o['IsFulfilledByAmazon'] ), 'price' => $price );
			}
		}
		if ( null === $bb_price && ! empty( $summary['BuyBoxPrices'][0] ) ) {
			$bp       = $summary['BuyBoxPrices'][0];
			$bb_price = (float) ( $bp['LandedPrice']['Amount'] ?? $bp['ListingPrice']['Amount'] ?? 0 ) ?: null;
		}
		$offer_count = 0;
		foreach ( (array) ( $summary['NumberOfOffers'] ?? array() ) as $n ) {
			$offer_count += (int) ( $n['OfferCount'] ?? 0 );
		}
		$offer_count = max( $offer_count, count( $offers ) );
		$bsr = null;
		$bsr_cat = '';
		foreach ( (array) ( $summary['SalesRankings'] ?? array() ) as $rank ) {
			$r   = (int) ( $rank['Rank'] ?? 0 );
			$cat = (string) ( $rank['ProductCategoryId'] ?? '' );
			if ( $r <= 0 ) {
				continue;
			}
			// The top-level display-group rank is the BSR shown on the detail page.
			if ( str_contains( $cat, '_display_on_website' ) ) {
				$bsr     = $r;
				$bsr_cat = $cat;
				break;
			}
			if ( null === $bsr ) {
				$bsr     = $r;
				$bsr_cat = $cat;
			}
		}
		$bb_is_mine = '' !== $bb_seller && ( $bb_seller === $me || 'ME' === $bb_seller );

		$prev = Db::row(
			'SELECT * FROM {t:asin_snapshots} WHERE market = %s AND asin = %s ORDER BY captured_at DESC LIMIT 1',
			array( $market, $asin )
		);
		Db::insert( 'asin_snapshots', array(
			'market' => $market, 'asin' => $asin, 'captured_at' => $now, 'is_mine' => $mine ? 1 : 0,
			'my_price' => $my_price, 'buybox_price' => $bb_price, 'buybox_seller' => $bb_seller, 'buybox_is_mine' => $bb_is_mine ? 1 : 0,
			'lowest_price' => $lowest, 'offer_count' => $offer_count, 'fba_offer_count' => $fba, 'bsr' => $bsr,
			'bsr_category' => mb_substr( $bsr_cat, 0, 128 ), 'is_demo' => $demo ? 1 : 0,
		) );

		$alerts = 0;
		// Seller tracking + hijacker detection.
		$known = array();
		foreach ( Db::rows( 'SELECT seller_id FROM {t:offer_sellers} WHERE market = %s AND asin = %s', array( $market, $asin ) ) as $k ) {
			$known[ (string) $k['seller_id'] ] = true;
		}
		$first_scan = ! $known;
		foreach ( $sellers as $sid => $s ) {
			Db::upsert( 'offer_sellers', array(
				'market' => $market, 'asin' => $asin, 'seller_id' => $sid, 'is_me' => $s['is_me'] ? 1 : 0,
				'is_fba' => $s['fba'] ? 1 : 0, 'last_price' => $s['price'], 'first_seen' => $now, 'last_seen' => $now,
				'active' => 1, 'is_demo' => $demo ? 1 : 0,
			), array( 'first_seen' ) );
			if ( $mine && ! $s['is_me'] && ! isset( $known[ $sid ] ) && ! $first_scan && ! $demo ) {
				SuiteAlerts::raise(
					'critical', 'suite_hijacker',
					sprintf( 'New seller on your ASIN %s: %s (%s @ %s)', $asin, $sid, $s['fba'] ? 'FBA' : 'FBM', number_format( $s['price'], 2 ) ),
					'A seller that was not on this listing before is now offering it. If you are brand-registered, verify authenticity and file a Report a Violation case; consider a test buy.',
					array( 'market' => $market, 'asin' => $asin, 'seller' => $sid )
				);
				$alerts++;
			}
		}
		if ( $sellers ) {
			Db::exec(
				'UPDATE {t:offer_sellers} SET active = 0 WHERE market = %s AND asin = %s AND seller_id NOT IN (' . Db::in( array_keys( $sellers ) ) . ')',
				array_merge( array( $market, $asin ), array_keys( $sellers ) )
			);
		}

		if ( $mine && null !== $prev && ! $demo ) {
			if ( (int) $prev['buybox_is_mine'] && ! $bb_is_mine ) {
				SuiteAlerts::raise(
					'warning', 'suite_buybox',
					'' === $bb_seller ? "Buy Box suppressed on {$asin}" : "Buy Box lost on {$asin} to {$bb_seller}",
					'' === $bb_seller ? 'No offer is winning the Buy Box — usually a price well above the reference price. Check your price vs. other channels.' : sprintf( 'Winning price now %s.', null !== $bb_price ? number_format( $bb_price, 2 ) : '?' ),
					array( 'market' => $market, 'asin' => $asin )
				);
				$alerts++;
			}
		}
		if ( ! $mine && null !== $prev && null !== $prev['lowest_price'] && null !== $lowest && ! $demo ) {
			$drop = ( (float) $prev['lowest_price'] - $lowest ) / max( 0.01, (float) $prev['lowest_price'] ) * 100;
			if ( $drop >= $this->settings->float( 'suite_monitor_price_drop_pct' ) ) {
				SuiteAlerts::raise(
					'info', 'suite_competitor',
					sprintf( 'Competitor %s dropped price %.0f%% (%s → %s)', $asin, $drop, number_format( (float) $prev['lowest_price'], 2 ), number_format( $lowest, 2 ) ),
					'', array( 'market' => $market, 'asin' => $asin )
				);
				$alerts++;
			}
		}
		return $alerts;
	}

	/** Latest snapshot per watched ASIN + seller counts. */
	public function board(): array {
		$rows = Db::rows(
			'SELECT s.* FROM {t:asin_snapshots} s
			 INNER JOIN (SELECT market, asin, MAX(captured_at) AS m FROM {t:asin_snapshots} GROUP BY market, asin) x
			   ON x.market = s.market AND x.asin = s.asin AND x.m = s.captured_at
			 ORDER BY s.is_mine DESC, s.asin'
		);
		$sellers = array();
		foreach ( Db::rows( 'SELECT market, asin, COUNT(*) AS n, SUM(CASE WHEN is_me = 0 THEN 1 ELSE 0 END) AS others FROM {t:offer_sellers} WHERE active = 1 GROUP BY market, asin' ) as $r ) {
			$sellers[ $r['market'] . '|' . $r['asin'] ] = $r;
		}
		foreach ( $rows as &$r ) {
			$k = $r['market'] . '|' . $r['asin'];
			$r['active_sellers'] = (int) ( $sellers[ $k ]['n'] ?? 0 );
			$r['other_sellers']  = (int) ( $sellers[ $k ]['others'] ?? 0 );
		}
		return $rows;
	}

	public function history( string $market, string $asin, int $days = 90 ): array {
		return Db::rows(
			'SELECT captured_at, my_price, buybox_price, lowest_price, offer_count, bsr, buybox_is_mine FROM {t:asin_snapshots}
			 WHERE market = %s AND asin = %s AND captured_at >= %s ORDER BY captured_at ASC',
			array( $market, $asin, gmdate( 'Y-m-d H:i:s', time() - $days * DAY_IN_SECONDS ) )
		);
	}

	public function sellers( string $market, string $asin ): array {
		return Db::rows( 'SELECT * FROM {t:offer_sellers} WHERE market = %s AND asin = %s ORDER BY active DESC, last_seen DESC', array( $market, $asin ) );
	}

	public function prune( int $days = 365 ): int {
		return Db::exec( 'DELETE FROM {t:asin_snapshots} WHERE captured_at < %s', array( gmdate( 'Y-m-d H:i:s', time() - $days * DAY_IN_SECONDS ) ) );
	}
}
