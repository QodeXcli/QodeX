<?php
/**
 * DemoSeeder — realistic, deterministic demo account for the 7 SEVEN
 * catalog (19 SKUs: P1 singles, P4 4-packs, P9 variety packs).
 *
 * Lets the owner explore every screen before connecting SP-API / Ads API.
 * Everything it writes is flagged `is_demo = 1` (or SKU-prefixed `DEMO-`
 * in core tables) and `clear()` removes exactly that — real data is never
 * touched.
 *
 * @package SevenGum\Commerce\Suite\Demo
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Demo;

use SevenGum\Commerce\Automation\AlertDispatcher;
use SevenGum\Commerce\Suite\Ads\AdsSync;
use SevenGum\Commerce\Suite\Listings\ListingAuditor;
use SevenGum\Commerce\Suite\Reimbursements\ReimbursementAuditor;
use SevenGum\Commerce\Suite\SuiteSchema;
use SevenGum\Commerce\Suite\Support\Db;
use SevenGum\Commerce\Suite\Support\SuiteTime;

defined( 'ABSPATH' ) || exit;

final class DemoSeeder {

	public const OPTION = 'sg_suite_demo_active';
	private const DAYS  = 90;

	private string $market;
	private string $today;
	private int $seq = 0;

	public function __construct(
		private ReimbursementAuditor $auditor,
		private AdsSync $ads,
	) {}

	public static function active(): bool {
		return (bool) get_option( self::OPTION, false );
	}

	/** @return array<string, int> counts per table */
	public function seed( string $market = 'US' ): array {
		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( 300 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
		}
		$this->clear();
		mt_srand( 7777 );
		$this->market = $market;
		$this->today  = SuiteTime::today( $market );
		$catalog      = $this->catalog();
		$counts       = array();

		$counts['products']   = $this->products( $catalog );
		$counts['orders']     = $this->orders_and_finance( $catalog );
		$counts['account']    = $this->account_fees();
		$counts['ads']        = $this->ads();
		$counts['traffic']    = $this->traffic( $catalog );
		$counts['keywords']   = $this->keywords( $catalog );
		$counts['monitor']    = $this->monitor( $catalog );
		$counts['ledger']     = $this->ledger( $catalog );
		$counts['health']     = $this->inventory_health( $catalog );
		$counts['feedback']   = $this->feedback();
		$counts['listings']   = $this->listings( $catalog );
		$counts['reviews']    = $this->solicitations();
		$counts['expenses']   = $this->expenses();

		$max_case = (int) Db::var( 'SELECT COALESCE(MAX(id),0) FROM {t:reimb_cases}' );
		$this->auditor->scan();
		Db::exec( 'UPDATE {t:reimb_cases} SET is_demo = 1 WHERE id > %d', array( $max_case ) );
		$counts['reimb_cases'] = (int) Db::var( 'SELECT COUNT(*) FROM {t:reimb_cases} WHERE is_demo = 1' );

		$counts['alerts'] = $this->alerts();

		// Build a PPC plan so the Optimizer has reviewable recommendations straight away.
		$counts['ppc_actions'] = array_sum( $this->ads->optimize( $this->today ) );

		update_option( self::OPTION, 1, false );
		return $counts;
	}

	public function clear(): void {
		global $wpdb;
		foreach ( SuiteSchema::TABLES as $t ) {
			if ( in_array( $t, array( 'reports', 'sku_costs' ), true ) ) {
				continue;
			}
			Db::exec( "DELETE FROM {t:{$t}} WHERE is_demo = 1" );
		}
		Db::exec( 'DELETE FROM {t:sku_costs} WHERE sku LIKE %s', array( 'DEMO-%' ) );
		$ids = $wpdb->get_col( $wpdb->prepare( "SELECT id FROM {$wpdb->prefix}sg_products WHERE sku LIKE %s", 'DEMO-%' ) ); // phpcs:ignore
		if ( $ids ) {
			$in = implode( ',', array_map( 'intval', $ids ) );
			$wpdb->query( "DELETE FROM {$wpdb->prefix}sg_price_history WHERE product_id IN ({$in})" ); // phpcs:ignore
			$wpdb->query( "DELETE FROM {$wpdb->prefix}sg_products WHERE id IN ({$in})" ); // phpcs:ignore
		}
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->prefix}sg_alerts WHERE context LIKE %s", '%' . $wpdb->esc_like( '"demo":true' ) . '%' ) ); // phpcs:ignore
		delete_option( self::OPTION );
	}

	private function alerts(): int {
		$ctx = array( 'demo' => true, 'market' => $this->market );
		AlertDispatcher::create( 'critical', 'suite_hijacker', 'New seller on your ASIN B0DEMO0006: A3HIJACK9DEMO (FBM @ 4.49)', 'A seller that was not on this listing before is now offering it. If you are brand-registered, verify authenticity and file a Report a Violation case; consider a test buy.', $ctx );
		AlertDispatcher::create( 'warning', 'suite_buybox', 'Buy Box lost on B0DEMO0006 to A3HIJACK9DEMO', 'Winning price now 4.49.', $ctx );
		AlertDispatcher::create( 'warning', 'suite_feedback', 'Negative seller feedback (1★) on a recent order', 'Never received my order.', $ctx );
		AlertDispatcher::create( 'warning', 'suite_listing', 'Listing content changed: DEMO-P1-STRAWBERRY (B0DEMO0005)', 'Title, bullets, description or images differ from the last audit. If you did not make this change, check for a catalog contribution from Amazon or another seller.', $ctx );
		AlertDispatcher::create( 'info', 'suite_competitor', 'Competitor B0COMP0002 dropped price 18% (15.99 → 13.11)', '', $ctx );
		return 5;
	}

	/* ------------------------------------------------------------------ */

	private function catalog(): array {
		$flavors = array( 'Spearmint', 'Peppermint', 'Cinnamon', 'Watermelon', 'Strawberry', 'Blueberry', 'Lemon', 'Cool Mint' );
		$out = array();
		$i   = 1;
		foreach ( $flavors as $f ) {
			$slug = strtoupper( str_replace( ' ', '', $f ) );
			$out[] = array( 'sku' => "DEMO-P1-{$slug}", 'asin' => sprintf( 'B0DEMO%04d', $i++ ), 'title' => "7 SEVEN Sugar-Free Gum, {$f}, 50 Pieces (1 Bottle)", 'price' => 4.99, 'cost' => 1.10, 'fba' => 3.22, 'demand' => 'Spearmint' === $f ? 9.0 : ( in_array( $f, array( 'Peppermint', 'Watermelon' ), true ) ? 5.5 : 2.6 ), 'pack' => 'P1' );
		}
		foreach ( $flavors as $f ) {
			$slug = strtoupper( str_replace( ' ', '', $f ) );
			$out[] = array( 'sku' => "DEMO-P4-{$slug}", 'asin' => sprintf( 'B0DEMO%04d', $i++ ), 'title' => "7 SEVEN Sugar-Free Gum, {$f}, 50 Pieces (Pack of 4)", 'price' => 16.99, 'cost' => 4.20, 'fba' => 4.02, 'demand' => 'Spearmint' === $f ? 6.5 : ( in_array( $f, array( 'Peppermint', 'Cinnamon' ), true ) ? 3.4 : 1.4 ), 'pack' => 'P4' );
		}
		foreach ( array( 'Fruit Variety', 'Mint Variety', 'Ultimate Variety' ) as $f ) {
			$slug = strtoupper( str_replace( ' ', '', $f ) );
			$out[] = array( 'sku' => "DEMO-P9-{$slug}", 'asin' => sprintf( 'B0DEMO%04d', $i++ ), 'title' => "7 SEVEN Sugar-Free Gum {$f} Pack, 9 Bottles x 50 Pieces", 'price' => 34.99, 'cost' => 9.50, 'fba' => 5.34, 'demand' => 'Ultimate Variety' === $f ? 3.8 : 1.7, 'pack' => 'P9' );
		}
		return $out;
	}

	private function products( array $catalog ): int {
		global $wpdb;
		$stock_profile = array( 0 => 640, 1 => 35, 2 => 0, 3 => 410, 4 => 2600, 8 => 88, 16 => 140 );
		foreach ( $catalog as $i => $p ) {
			$fulfillable = $stock_profile[ $i ] ?? (int) ( $p['demand'] * mt_rand( 35, 120 ) );
			$wpdb->insert( "{$wpdb->prefix}sg_products", array(
				'market' => $this->market, 'sku' => $p['sku'], 'asin' => $p['asin'], 'product_name' => $p['title'],
				'fulfillable_qty' => $fulfillable, 'reserved_qty' => (int) ( $fulfillable * 0.06 ), 'inbound_qty' => 1 === $i ? 600 : ( 0 === $i % 5 ? 240 : 0 ),
				'buybox_price' => $p['price'], 'buybox_currency' => 'USD', 'buybox_is_mine' => 5 === $i ? 0 : 1, 'lowest_price' => $p['price'],
				'my_price' => $p['price'], 'cost_price' => $p['cost'], 'last_sync_at' => Db::now(),
			) );
			$pid = (int) $wpdb->insert_id;
			if ( 2 === $i ) {
				// Out of stock for the last 9 days — drives the lost-sales and OOS-aware velocity logic.
				for ( $d = 0; $d < 9; $d++ ) {
					$wpdb->insert( "{$wpdb->prefix}sg_price_history", array( 'product_id' => $pid, 'recorded_at' => gmdate( 'Y-m-d 12:00:00', time() - $d * DAY_IN_SECONDS ), 'my_price' => $p['price'], 'fulfillable_qty' => 0, 'currency' => 'USD', 'source' => 'demo' ) );
				}
			}
			Db::upsert( 'sku_costs', array(
				'market' => $this->market, 'sku' => $p['sku'], 'unit_cost' => $p['cost'], 'inbound_per_unit' => round( $p['cost'] * 0.12, 2 ),
				'prep_per_unit' => 'P1' === $p['pack'] ? 0.10 : 0.25, 'other_per_unit' => 0.0, 'lead_time_days' => 'P9' === $p['pack'] ? 45 : 35,
				'moq' => 'P1' === $p['pack'] ? 500 : 200, 'case_pack' => 'P1' === $p['pack'] ? 48 : ( 'P4' === $p['pack'] ? 24 : 12 ),
				'supplier' => 'Seven Gum Factory', 'updated_at' => Db::now(),
			) );
		}
		return count( $catalog );
	}

	private function orders_and_finance( array $catalog ): int {
		$orders = array();
		$items  = array();
		$fin    = array();
		$returns = array();
		$n = 0;
		for ( $back = self::DAYS; $back >= 0; $back-- ) {
			$date   = SuiteTime::shift( $this->today, -$back );
			$dow    = (int) ( new \DateTimeImmutable( $date ) )->format( 'N' );
			$season = 1 + 0.25 * sin( ( self::DAYS - $back ) / 9 ) + ( $dow >= 6 ? 0.12 : 0 ) + ( self::DAYS - $back ) * 0.004;
			foreach ( $catalog as $i => $p ) {
				if ( 2 === $i && $back < 9 ) {
					continue; // out of stock
				}
				$units = $this->poisson( $p['demand'] * $season * ( 0 === $back ? 0.45 : 1 ) );
				while ( $units > 0 ) {
					$qty = $units >= 2 && mt_rand( 1, 10 ) <= 2 ? 2 : 1;
					$units -= $qty;
					$oid = sprintf( '1%02d-%07d-%07d', mt_rand( 10, 99 ), ++$this->seq, mt_rand( 1000000, 9999999 ) );
					$hour = mt_rand( 0, 23 );
					$purchase_local = new \DateTimeImmutable( sprintf( '%s %02d:%02d:00', $date, $hour, mt_rand( 0, 59 ) ), SuiteTime::tz( $this->market ) );
					$purchase = $purchase_local->setTimezone( new \DateTimeZone( 'UTC' ) )->format( 'Y-m-d H:i:s' );
					$status = 0 === $back ? ( mt_rand( 1, 3 ) === 1 ? 'Pending' : 'Unshipped' ) : ( mt_rand( 1, 100 ) === 1 ? 'Canceled' : 'Shipped' );
					$promo  = mt_rand( 1, 100 ) <= 8 ? round( $p['price'] * $qty * 0.15, 2 ) : 0.0;
					$sales  = round( $p['price'] * $qty, 2 );
					$deliv  = gmdate( 'Y-m-d H:i:s', strtotime( $purchase . ' +' . mt_rand( 2, 4 ) . ' days' ) );
					$orders[] = array(
						'market' => $this->market, 'amazon_order_id' => $oid, 'purchase_date' => $purchase, 'local_date' => $date,
						'last_update' => $purchase, 'status' => $status, 'fulfillment_channel' => 'AFN', 'sales_channel' => 'Amazon.com',
						'order_total' => $sales - $promo, 'currency' => 'USD', 'units' => $qty, 'is_business' => mt_rand( 1, 30 ) === 1 ? 1 : 0,
						'is_prime' => mt_rand( 1, 10 ) <= 8 ? 1 : 0, 'ship_country' => 'US', 'earliest_delivery' => $deliv, 'latest_delivery' => $deliv,
						'items_synced' => 1, 'is_demo' => 1,
					);
					$items[] = array(
						'market' => $this->market, 'amazon_order_id' => $oid, 'order_item_id' => 'demo-' . $this->seq, 'local_date' => $date,
						'sku' => $p['sku'], 'asin' => $p['asin'], 'title' => $p['title'], 'qty' => $qty, 'item_price' => $sales,
						'item_tax' => round( $sales * 0.0725, 2 ), 'promo_discount' => $promo, 'status' => $status, 'is_demo' => 1,
					);
					$n++;
					// Settlement lags shipment by ~2 days.
					if ( 'Shipped' === $status && $back >= 2 ) {
						$posted = gmdate( 'Y-m-d H:i:s', strtotime( $purchase . ' +' . mt_rand( 1, 2 ) . ' days' ) );
						$referral = round( $sales * ( $p['price'] <= 15 ? 0.08 : 0.15 ), 2 );
						$fin[] = $this->fin( $posted, 'Shipment', $oid, $p['sku'], 'Principal', 'revenue', $sales, $qty );
						$fin[] = $this->fin( $posted, 'Shipment', $oid, $p['sku'], 'Tax', 'tax', round( $sales * 0.0725, 2 ), 0 );
						$fin[] = $this->fin( $posted, 'Shipment', $oid, $p['sku'], 'Withheld:Tax', 'tax', -round( $sales * 0.0725, 2 ), 0 );
						$fin[] = $this->fin( $posted, 'Shipment', $oid, $p['sku'], 'Commission', 'fee', -$referral, 0 );
						$fin[] = $this->fin( $posted, 'Shipment', $oid, $p['sku'], 'FBAPerUnitFulfillmentFee', 'fee', -round( ( $back < 25 && 4 === $i ? $p['fba'] * 1.32 : $p['fba'] ) * $qty, 2 ), 0 );
						if ( $promo > 0 ) {
							$fin[] = $this->fin( $posted, 'Shipment', $oid, $p['sku'], 'Promotion:PromotionMetaDataDefinitionValue', 'promo', -$promo, 0 );
						}
						// ~2.5 % refunded 5–20 days later.
						if ( mt_rand( 1, 1000 ) <= 25 && $back > 6 ) {
							$rposted = gmdate( 'Y-m-d H:i:s', strtotime( $posted . ' +' . mt_rand( 5, 20 ) . ' days' ) );
							if ( $rposted <= gmdate( 'Y-m-d H:i:s' ) ) {
								$fin[] = $this->fin( $rposted, 'Refund', $oid, $p['sku'], 'Principal', 'refund', -$sales, -$qty );
								$fin[] = $this->fin( $rposted, 'Refund', $oid, $p['sku'], 'Commission', 'fee', round( $referral * 0.8, 2 ), 0 );
								$fin[] = $this->fin( $rposted, 'Refund', $oid, $p['sku'], 'RefundCommission', 'fee', -round( min( 5, $referral * 0.2 ), 2 ), 0 );
								if ( mt_rand( 1, 10 ) <= 7 ) {
									$returns[] = array(
										'row_hash' => sha1( 'demo-ret-' . $oid ), 'market' => $this->market, 'return_date' => substr( $rposted, 0, 10 ),
										'amazon_order_id' => $oid, 'sku' => $p['sku'], 'asin' => $p['asin'], 'fnsku' => 'X00' . substr( $p['asin'], -7 ),
										'qty' => $qty, 'fulfillment_center' => array( 'PHX7', 'ONT8', 'MDW2', 'BFI4' )[ mt_rand( 0, 3 ) ],
										'disposition' => mt_rand( 1, 10 ) <= 6 ? 'SELLABLE' : 'CUSTOMER_DAMAGED',
										'reason' => array( 'NOT_AS_DESCRIBED', 'UNWANTED_ITEM', 'DEFECTIVE', 'ORDERED_WRONG_ITEM', 'TASTE' )[ mt_rand( 0, 4 ) ],
										'status' => 'Unit returned to inventory', 'comments' => array( '', 'flavor too strong', 'arrived opened', 'bought by mistake', 'lost freshness' )[ mt_rand( 0, 4 ) ],
										'is_demo' => 1,
									);
								}
							}
						}
					}
				}
			}
		}
		$this->bulk( 'orders', $orders );
		$this->bulk( 'order_items', $items );
		$this->bulk( 'fin_events', $fin );
		$this->bulk( 'returns', $returns );
		return $n;
	}

	private function account_fees(): int {
		$fin = array();
		for ( $m = 0; $m < 3; $m++ ) {
			$first = ( new \DateTimeImmutable( $this->today ) )->modify( "first day of -{$m} month" );
			if ( $first->format( 'Y-m-d' ) > $this->today ) {
				continue;
			}
			$fin[] = $this->fin( $first->format( 'Y-m-d 08:00:00' ), 'ServiceFee', '', '', 'Subscription', 'fee', -39.99, 0 );
			$storage = $first->modify( '+6 days' );
			if ( $storage->format( 'Y-m-d' ) <= $this->today ) {
				$fin[] = $this->fin( $storage->format( 'Y-m-d 08:00:00' ), 'ServiceFee', '', '', 'FBAStorageFee', 'fee', -round( mt_rand( 9000, 16000 ) / 100, 2 ), 0 );
			}
			$reimb = $first->modify( '+14 days' );
			if ( $reimb->format( 'Y-m-d' ) <= $this->today ) {
				$fin[] = $this->fin( $reimb->format( 'Y-m-d 08:00:00' ), 'Adjustment', '', 'DEMO-P4-SPEARMINT', 'WAREHOUSE_LOST', 'reimbursement', 22.40, 2 );
			}
		}
		$this->bulk( 'fin_events', $fin );
		return count( $fin );
	}

	private function ads(): int {
		$campaigns = array(
			array( 'C-AUTO', 'SP | Auto | All Gum', 'AUTO', 60 ),
			array( 'C-EXACT', 'SP | Exact | Hero Keywords', 'MANUAL', 45 ),
			array( 'C-PHRASE', 'SP | Phrase | Sugar Free Gum', 'MANUAL', 30 ),
			array( 'C-BROAD', 'SP | Broad | Discovery', 'MANUAL', 25 ),
			array( 'C-PAT', 'SP | PAT | Competitor ASINs', 'MANUAL', 20 ),
			array( 'C-BRAND', 'SP | Exact | Brand Defense', 'MANUAL', 2.5 ),
		);
		$now = Db::now();
		// Brand defense is profitable and starved for budget → triggers the "raise budget" rule.
		foreach ( $campaigns as [ $id, $name, $type, $budget ] ) {
			Db::upsert( 'ads_campaigns', array( 'profile_id' => 'DEMO', 'campaign_id' => $id, 'name' => $name, 'state' => 'ENABLED', 'targeting_type' => $type, 'daily_budget' => (float) $budget, 'bidding_strategy' => 'LEGACY_FOR_SALES', 'start_date' => SuiteTime::shift( $this->today, -120 ), 'updated_at' => $now, 'is_demo' => 1 ) );
		}
		// keyword, campaign, match, bid, ctr, cvr, cpc-factor
		$kws = array(
			array( 'sugar free gum', 'C-EXACT', 'EXACT', 1.45, 0.009, 0.14 ),
			array( 'spearmint gum', 'C-EXACT', 'EXACT', 1.10, 0.012, 0.17 ),
			array( 'chewing gum', 'C-EXACT', 'EXACT', 1.80, 0.006, 0.07 ),
			array( 'xylitol gum', 'C-EXACT', 'EXACT', 0.95, 0.010, 0.15 ),
			array( 'gum bulk', 'C-EXACT', 'EXACT', 1.25, 0.007, 0.05 ),
			array( 'mint gum', 'C-EXACT', 'EXACT', 0.85, 0.011, 0.13 ),
			array( 'cinnamon gum', 'C-EXACT', 'EXACT', 0.70, 0.010, 0.11 ),
			array( 'sugar free gum', 'C-PHRASE', 'PHRASE', 1.05, 0.006, 0.09 ),
			array( 'gum variety pack', 'C-PHRASE', 'PHRASE', 0.90, 0.008, 0.10 ),
			array( 'fruit gum', 'C-PHRASE', 'PHRASE', 0.75, 0.007, 0.06 ),
			array( 'gum', 'C-BROAD', 'BROAD', 0.65, 0.004, 0.04 ),
			array( 'breath freshener', 'C-BROAD', 'BROAD', 0.60, 0.003, 0.02 ),
			array( 'healthy snacks', 'C-BROAD', 'BROAD', 0.55, 0.002, 0.00 ),
			array( '7 seven gum', 'C-BRAND', 'EXACT', 0.45, 0.045, 0.32 ),
			array( 'seven gum', 'C-BRAND', 'EXACT', 0.40, 0.040, 0.28 ),
		);
		$targets = array();
		foreach ( $kws as $k => [ $text, $camp, $match, $bid ] ) {
			$targets[] = array( 'profile_id' => 'DEMO', 'target_id' => 'K' . ( 1000 + $k ), 'kind' => 'keyword', 'campaign_id' => $camp, 'ad_group_id' => 'AG-' . $camp, 'keyword_text' => $text, 'match_type' => $match, 'state' => 'ENABLED', 'bid' => $bid, 'updated_at' => $now, 'is_demo' => 1 );
		}
		$targets[] = array( 'profile_id' => 'DEMO', 'target_id' => 'T2001', 'kind' => 'target', 'campaign_id' => 'C-AUTO', 'ad_group_id' => 'AG-C-AUTO', 'keyword_text' => 'close-match', 'match_type' => 'AUTO', 'state' => 'ENABLED', 'bid' => 0.85, 'updated_at' => $now, 'is_demo' => 1 );
		$targets[] = array( 'profile_id' => 'DEMO', 'target_id' => 'T2002', 'kind' => 'target', 'campaign_id' => 'C-AUTO', 'ad_group_id' => 'AG-C-AUTO', 'keyword_text' => 'loose-match', 'match_type' => 'AUTO', 'state' => 'ENABLED', 'bid' => 0.70, 'updated_at' => $now, 'is_demo' => 1 );
		$targets[] = array( 'profile_id' => 'DEMO', 'target_id' => 'T2003', 'kind' => 'target', 'campaign_id' => 'C-PAT', 'ad_group_id' => 'AG-C-PAT', 'keyword_text' => 'asin=B0COMP0001', 'match_type' => 'MANUAL', 'state' => 'ENABLED', 'bid' => 0.95, 'updated_at' => $now, 'is_demo' => 1 );
		$targets[] = array( 'profile_id' => 'DEMO', 'target_id' => 'T2004', 'kind' => 'target', 'campaign_id' => 'C-PAT', 'ad_group_id' => 'AG-C-PAT', 'keyword_text' => 'asin=B0COMP0002', 'match_type' => 'MANUAL', 'state' => 'ENABLED', 'bid' => 0.80, 'updated_at' => $now, 'is_demo' => 1 );
		$this->bulk( 'ads_targets', $targets );

		$perf = array_merge( $kws, array(
			array( 'close-match', 'C-AUTO', 'AUTO', 0.85, 0.005, 0.10, 'T2001' ),
			array( 'loose-match', 'C-AUTO', 'AUTO', 0.70, 0.003, 0.05, 'T2002' ),
			array( 'asin=B0COMP0001', 'C-PAT', 'MANUAL', 0.95, 0.004, 0.08, 'T2003' ),
			array( 'asin=B0COMP0002', 'C-PAT', 'MANUAL', 0.80, 0.003, 0.03, 'T2004' ),
		) );
		$daily = array();
		$camp_day = array();
		for ( $back = 60; $back >= 2; $back-- ) {
			$date = SuiteTime::shift( $this->today, -$back );
			foreach ( $perf as $k => $row ) {
				[ $text, $camp, $match, $bid, $ctr, $cvr ] = $row;
				$tid  = $row[6] ?? 'K' . ( 1000 + $k );
				$impr = (int) ( mt_rand( 300, 1600 ) * ( 'C-BROAD' === $camp ? 1.8 : 1 ) * ( 'C-BRAND' === $camp ? 0.15 : 1 ) );
				$clk  = $this->poisson( $impr * $ctr );
				$cost = round( $clk * $bid * mt_rand( 70, 95 ) / 100, 2 );
				$ord  = 0;
				for ( $c = 0; $c < $clk; $c++ ) {
					$ord += mt_rand( 1, 1000 ) <= (int) ( $cvr * 1000 ) ? 1 : 0;
				}
				$sales = round( $ord * array( 4.99, 16.99, 16.99, 34.99 )[ mt_rand( 0, 3 ) ], 2 );
				$daily[] = array( 'profile_id' => 'DEMO', 'report_date' => $date, 'level' => 'target', 'campaign_id' => $camp, 'ad_group_id' => 'AG-' . $camp, 'target_id' => $tid, 'keyword_text' => $text, 'match_type' => $match, 'impressions' => $impr, 'clicks' => $clk, 'cost' => $cost, 'sales' => $sales, 'orders' => $ord, 'units' => $ord, 'is_demo' => 1 );
				$key = $date . '|' . $camp;
				$camp_day[ $key ] ??= array( 'profile_id' => 'DEMO', 'report_date' => $date, 'level' => 'campaign', 'campaign_id' => $camp, 'ad_group_id' => '', 'target_id' => '', 'keyword_text' => '', 'match_type' => '', 'impressions' => 0, 'clicks' => 0, 'cost' => 0.0, 'sales' => 0.0, 'orders' => 0, 'units' => 0, 'is_demo' => 1 );
				foreach ( array( 'impressions', 'clicks', 'cost', 'sales', 'orders', 'units' ) as $m ) {
					$camp_day[ $key ][ $m ] += $daily[ count( $daily ) - 1 ][ $m ];
				}
			}
		}
		// Make the exact campaign budget-capped & profitable so the budget rule fires.
		foreach ( $camp_day as &$cd ) {
			$cd['keyword_text'] = '';
			if ( 'C-EXACT' === $cd['campaign_id'] ) {
				$cd['cost'] = max( $cd['cost'], 44.0 );
			}
			$cd['cost'] = round( $cd['cost'], 2 );
		}
		unset( $cd );
		$this->bulk( 'ads_daily', array_merge( $daily, array_values( $camp_day ) ) );

		$terms = array(
			array( 'sugar free spearmint gum', 'C-AUTO', 'close-match', 9, 2.1 ),
			array( 'xylitol chewing gum bulk', 'C-AUTO', 'close-match', 6, 1.6 ),
			array( 'gum for kids', 'C-BROAD', 'gum', 0, 0 ),
			array( 'nicotine gum', 'C-BROAD', 'gum', 0, 0 ),
			array( 'bubble gum machine', 'C-BROAD', 'gum', 0, 0 ),
			array( 'cinnamon sugar free gum', 'C-PHRASE', 'sugar free gum', 5, 1.4 ),
			array( 'b0comp0003', 'C-AUTO', 'loose-match', 4, 1.2 ),
			array( 'keto gum', 'C-BROAD', 'gum', 3, 0.9 ),
			array( 'fresh breath gum long lasting', 'C-AUTO', 'loose-match', 4, 1.0 ),
			array( 'gum variety pack sugar free', 'C-PHRASE', 'gum variety pack', 7, 1.8 ),
			array( 'cbd gum', 'C-BROAD', 'gum', 0, 0 ),
			array( 'healthy snacks for adults', 'C-BROAD', 'healthy snacks', 0, 0 ),
		);
		$st = array();
		for ( $back = 30; $back >= 2; $back-- ) {
			$date = SuiteTime::shift( $this->today, -$back );
			foreach ( $terms as $ti => [ $term, $camp, $kw, $orders, $w ] ) {
				$clk = max( 0, (int) round( ( $orders > 0 ? 1.2 : 0.8 ) + mt_rand( -1, 1 ) ) );
				$o   = $orders > 0 && mt_rand( 1, 30 ) <= $orders ? 1 : 0;
				$st[] = array( 'profile_id' => 'DEMO', 'row_hash' => sha1( "demo-st-{$date}-{$ti}" ), 'report_date' => $date, 'campaign_id' => $camp, 'ad_group_id' => 'AG-' . $camp, 'target_id' => 'X', 'keyword_text' => $kw, 'match_type' => 'C-AUTO' === $camp ? 'TARGETING_EXPRESSION_PREDEFINED' : ( 'C-PHRASE' === $camp ? 'PHRASE' : 'BROAD' ), 'search_term' => $term, 'impressions' => mt_rand( 40, 300 ), 'clicks' => $clk, 'cost' => round( $clk * 0.78, 2 ), 'sales' => round( $o * 16.99, 2 ), 'orders' => $o, 'is_demo' => 1 );
			}
		}
		$this->bulk( 'ads_search_terms', $st );
		return count( $daily ) + count( $st );
	}

	private function traffic( array $catalog ): int {
		$rows = array();
		$units = array();
		foreach ( Db::rows( 'SELECT local_date, asin, sku, SUM(qty) AS u, SUM(item_price) AS s, COUNT(*) AS n FROM {t:order_items} WHERE is_demo = 1 AND local_date < %s GROUP BY local_date, asin, sku', array( $this->today ) ) as $r ) {
			$units[ $r['local_date'] ][] = $r;
		}
		foreach ( $units as $date => $list ) {
			$tot = array( 'sessions' => 0, 'page_views' => 0, 'units' => 0, 'order_items' => 0, 'ordered_sales' => 0.0 );
			foreach ( $list as $r ) {
				$sessions = (int) round( (int) $r['u'] / ( mt_rand( 9, 16 ) / 100 ) );
				$row = array( 'market' => $this->market, 'report_date' => $date, 'asin' => $r['asin'], 'sku' => $r['sku'], 'sessions' => $sessions, 'page_views' => (int) round( $sessions * 1.35 ), 'buy_box_pct' => 'B0DEMO0006' === $r['asin'] ? 71.0 : (float) mt_rand( 94, 100 ), 'units' => (int) $r['u'], 'order_items' => (int) $r['n'], 'ordered_sales' => (float) $r['s'], 'is_demo' => 1 );
				$rows[] = $row;
				foreach ( $tot as $k => $v ) {
					$tot[ $k ] += $row[ $k ];
				}
			}
			$rows[] = array( 'market' => $this->market, 'report_date' => $date, 'asin' => '', 'sku' => '', 'buy_box_pct' => 96.5, 'is_demo' => 1 ) + $tot;
		}
		$this->bulk( 'traffic_daily', $rows );
		return count( $rows );
	}

	private function keywords( array $catalog ): int {
		$hero = array( $catalog[0]['asin'], $catalog[8]['asin'], $catalog[18]['asin'] );
		$kw = array(
			array( 'sugar free gum', 1, 410000 ), array( 'spearmint gum', 1, 52000 ), array( 'chewing gum', 1, 380000 ),
			array( 'xylitol gum', 2, 61000 ), array( 'gum bulk', 2, 88000 ), array( 'mint gum', 2, 47000 ),
			array( 'gum variety pack', 2, 23000 ), array( 'cinnamon gum', 3, 31000 ), array( 'fruit gum', 3, 19000 ),
			array( 'keto gum', 3, 9000 ), array( 'long lasting gum', 3, 15000 ), array( 'seven gum', 1, 2100 ),
		);
		$rows = array();
		$metrics = array();
		$sat = new \DateTimeImmutable( 'last saturday' );
		foreach ( $kw as $ki => [ $k, $prio, $vol ] ) {
			$asin = $hero[ $ki % 3 ];
			$rows[] = array( 'market' => $this->market, 'asin' => $asin, 'keyword' => $k, 'priority' => $prio, 'source' => 'demo', 'created_at' => Db::now(), 'is_demo' => 1 );
			for ( $w = 7; $w >= 0; $w-- ) {
				$end   = $sat->modify( '-' . ( 7 * $w ) . ' days' );
				$start = $end->modify( '-6 days' );
				$weekly = (int) ( $vol / 4.3 * ( 1 + mt_rand( -10, 10 ) / 100 ) );
				$share = max( 0.2, ( 'seven gum' === $k ? 72 : ( 12 - $ki * 0.7 ) ) + ( 7 - $w ) * 0.35 + mt_rand( -10, 10 ) / 10 ) / 100;
				$imp_t = $weekly * 18;
				$clk_t = (int) ( $weekly * 0.9 );
				$cart_t = (int) ( $clk_t * 0.16 );
				$pur_t = (int) ( $clk_t * 0.08 );
				$metrics[] = array(
					'market' => $this->market, 'asin' => $asin, 'keyword' => $k, 'period_start' => $start->format( 'Y-m-d' ), 'period_end' => $end->format( 'Y-m-d' ),
					'query_score' => $ki + 1, 'query_volume' => $weekly, 'impressions_total' => $imp_t, 'impressions_asin' => (int) ( $imp_t * $share ),
					'clicks_total' => $clk_t, 'clicks_asin' => (int) ( $clk_t * $share * 0.9 ), 'cart_adds_total' => $cart_t, 'cart_adds_asin' => (int) ( $cart_t * $share ),
					'purchases_total' => $pur_t, 'purchases_asin' => (int) ( $pur_t * $share * 1.1 ), 'is_demo' => 1,
				);
			}
		}
		$this->bulk( 'keywords', $rows );
		$this->bulk( 'keyword_metrics', $metrics );
		return count( $rows );
	}

	private function monitor( array $catalog ): int {
		$snaps = array();
		$sellers = array();
		$competitors = array( 'B0COMP0001' => 5.49, 'B0COMP0002' => 15.99, 'B0COMP0003' => 29.99, 'B0COMP0004' => 4.29 );
		for ( $back = 60; $back >= 0; $back-- ) {
			$ts = gmdate( 'Y-m-d 10:00:00', strtotime( $this->today . " -{$back} days" ) );
			foreach ( $catalog as $i => $p ) {
				$hijacked = 5 === $i && $back <= 3;
				$bsr = (int) ( 9000 / max( 0.4, $p['demand'] ) * ( 1 + mt_rand( -15, 15 ) / 100 ) * ( 2 === $i && $back < 9 ? 3 + ( 9 - $back ) * 0.5 : 1 ) );
				$snaps[] = array( 'market' => $this->market, 'asin' => $p['asin'], 'captured_at' => $ts, 'is_mine' => 1, 'my_price' => $p['price'], 'buybox_price' => $hijacked ? round( $p['price'] - 0.50, 2 ) : $p['price'], 'buybox_seller' => $hijacked ? 'A3HIJACK9DEMO' : 'ME', 'buybox_is_mine' => $hijacked ? 0 : 1, 'lowest_price' => $hijacked ? round( $p['price'] - 0.50, 2 ) : $p['price'], 'offer_count' => $hijacked ? 2 : 1, 'fba_offer_count' => 1, 'bsr' => $bsr, 'bsr_category' => 'grocery_display_on_website', 'is_demo' => 1 );
			}
			foreach ( array_keys( $competitors ) as $ci => $asin ) {
				$price = $competitors[ $asin ] * ( 'B0COMP0002' === $asin && $back < 5 ? 0.82 : 1 ) * ( 1 + mt_rand( -3, 3 ) / 100 );
				$snaps[] = array( 'market' => $this->market, 'asin' => $asin, 'captured_at' => $ts, 'is_mine' => 0, 'my_price' => null, 'buybox_price' => round( $price, 2 ), 'buybox_seller' => 'ACOMPETITOR' . $ci, 'buybox_is_mine' => 0, 'lowest_price' => round( $price * 0.97, 2 ), 'offer_count' => mt_rand( 2, 9 ), 'fba_offer_count' => mt_rand( 1, 4 ), 'bsr' => mt_rand( 800, 25000 ), 'bsr_category' => 'grocery_display_on_website', 'is_demo' => 1 );
			}
		}
		$now = Db::now();
		foreach ( $catalog as $i => $p ) {
			$sellers[] = array( 'market' => $this->market, 'asin' => $p['asin'], 'seller_id' => 'ADEMOSELLERME', 'is_me' => 1, 'is_fba' => 1, 'last_price' => $p['price'], 'first_seen' => gmdate( 'Y-m-d H:i:s', time() - 200 * DAY_IN_SECONDS ), 'last_seen' => $now, 'active' => 1, 'is_demo' => 1 );
			if ( 5 === $i ) {
				$sellers[] = array( 'market' => $this->market, 'asin' => $p['asin'], 'seller_id' => 'A3HIJACK9DEMO', 'is_me' => 0, 'is_fba' => 0, 'last_price' => round( $p['price'] - 0.5, 2 ), 'first_seen' => gmdate( 'Y-m-d H:i:s', time() - 3 * DAY_IN_SECONDS ), 'last_seen' => $now, 'active' => 1, 'is_demo' => 1 );
			}
		}
		$this->bulk( 'asin_snapshots', $snaps );
		$this->bulk( 'offer_sellers', $sellers );
		return count( $snaps );
	}

	private function ledger( array $catalog ): int {
		$rows = array();
		$reimb = array();
		foreach ( array( 0, 3, 8, 11, 18 ) as $k => $i ) {
			$p = $catalog[ $i ];
			$fnsku = 'X00' . substr( $p['asin'], -7 );
			$d = SuiteTime::shift( $this->today, -( 40 + $k * 9 ) );
			$lost = 2 + $k;
			$rows[] = array( 'row_hash' => sha1( "demo-led-m-{$i}" ), 'market' => $this->market, 'event_date' => $d, 'fnsku' => $fnsku, 'sku' => $p['sku'], 'asin' => $p['asin'], 'event_type' => 'Adjustments', 'reference_id' => 'DEMO' . $i, 'qty' => -$lost, 'fulfillment_center' => 'PHX7', 'disposition' => 'SELLABLE', 'reason' => 'M', 'is_demo' => 1 );
			if ( 0 === $k % 2 ) {
				$rows[] = array( 'row_hash' => sha1( "demo-led-f-{$i}" ), 'market' => $this->market, 'event_date' => SuiteTime::shift( $d, 6 ), 'fnsku' => $fnsku, 'sku' => $p['sku'], 'asin' => $p['asin'], 'event_type' => 'Adjustments', 'reference_id' => 'DEMOF' . $i, 'qty' => 1, 'fulfillment_center' => 'PHX7', 'disposition' => 'SELLABLE', 'reason' => 'F', 'is_demo' => 1 );
			}
			if ( $k >= 2 ) {
				$rows[] = array( 'row_hash' => sha1( "demo-led-e-{$i}" ), 'market' => $this->market, 'event_date' => SuiteTime::shift( $d, 3 ), 'fnsku' => $fnsku, 'sku' => $p['sku'], 'asin' => $p['asin'], 'event_type' => 'Adjustments', 'reference_id' => 'DEMOE' . $i, 'qty' => -( $k ), 'fulfillment_center' => 'ONT8', 'disposition' => 'WAREHOUSE_DAMAGED', 'reason' => 'E', 'is_demo' => 1 );
			}
			if ( 1 === $k ) {
				$reimb[] = array( 'reimbursement_id' => 'DEMOR' . $i, 'market' => $this->market, 'approval_date' => SuiteTime::shift( $d, 20 ), 'case_id' => '', 'amazon_order_id' => '', 'reason' => 'Lost_Warehouse', 'sku' => $p['sku'], 'fnsku' => $fnsku, 'asin' => $p['asin'], 'amount' => round( $p['price'] * 0.7 * 2, 2 ), 'currency' => 'USD', 'qty_cash' => 2, 'qty_inventory' => 0, 'is_demo' => 1 );
			}
		}
		$this->bulk( 'ledger', $rows );
		$this->bulk( 'reimbursements', $reimb );
		return count( $rows );
	}

	private function inventory_health( array $catalog ): int {
		$rows = array();
		$stock = array();
		global $wpdb;
		foreach ( $wpdb->get_results( $wpdb->prepare( "SELECT sku, fulfillable_qty FROM {$wpdb->prefix}sg_products WHERE sku LIKE %s", 'DEMO-%' ), ARRAY_A ) as $r ) { // phpcs:ignore
			$stock[ $r['sku'] ] = (int) $r['fulfillable_qty'];
		}
		foreach ( $catalog as $p ) {
			$a = $stock[ $p['sku'] ] ?? 0;
			$old = 'DEMO-P1-STRAWBERRY' === $p['sku'] ? (int) ( $a * 0.55 ) : (int) ( $a * mt_rand( 0, 12 ) / 100 );
			$rows[] = array( 'market' => $this->market, 'snapshot_date' => $this->today, 'sku' => $p['sku'], 'asin' => $p['asin'], 'available' => $a, 'age_0_90' => $a - $old, 'age_91_180' => (int) ( $old * 0.6 ), 'age_181_270' => (int) ( $old * 0.3 ), 'age_271_365' => (int) ( $old * 0.1 ), 'age_365_plus' => 0, 'units_t30' => (int) ( $p['demand'] * 30 ), 'sell_through' => round( $p['demand'] * 30 / max( 1, $a ), 2 ), 'days_of_supply' => $p['demand'] > 0 ? (int) ( $a / $p['demand'] ) : null, 'est_storage_cost' => round( $a * 0.012, 2 ), 'recommended_action' => $old > 300 ? 'Create removal order or run a promotion' : 'No action required', 'is_demo' => 1 );
		}
		$this->bulk( 'inventory_health', $rows );
		return count( $rows );
	}

	private function feedback(): int {
		$rows = array();
		$comments = array( 5 => 'Fast shipping, great gum!', 4 => 'Good product, arrived quickly.', 3 => 'OK but box was dented.', 2 => 'Bottle arrived opened.', 1 => 'Never received my order.' );
		$all = Db::rows( "SELECT amazon_order_id, local_date FROM {t:orders} WHERE is_demo = 1 AND status = 'Shipped'" );
		$orders = array();
		for ( $i = 0; $i < 40 && $all; $i++ ) {
			$orders[] = $all[ mt_rand( 0, count( $all ) - 1 ) ];
		}
		$orders = array_values( array_unique( $orders, SORT_REGULAR ) );
		foreach ( $orders as $i => $o ) {
			$rating = $i < 3 ? array( 2, 1, 3 )[ $i ] : ( mt_rand( 1, 10 ) <= 8 ? 5 : 4 );
			$rows[] = array( 'row_hash' => sha1( 'demo-fb-' . $o['amazon_order_id'] ), 'market' => $this->market, 'feedback_date' => SuiteTime::shift( (string) $o['local_date'], 6 ), 'rating' => $rating, 'comments' => $comments[ $rating ], 'amazon_order_id' => $o['amazon_order_id'], 'is_demo' => 1 );
		}
		$this->bulk( 'feedback', $rows );
		return count( $rows );
	}

	private function listings( array $catalog ): int {
		$n = 0;
		foreach ( $catalog as $i => $p ) {
			$content = array(
				'asin'        => $p['asin'],
				'title'       => 0 === $i % 6 ? str_replace( 'Sugar-Free Gum', 'Sugar Free Gum!! Best Seller Gum Gum', $p['title'] ) : $p['title'] . ' | Xylitol, Aspartame-Free, Long-Lasting Flavor, Vegan & Keto Friendly',
				'brand'       => '7 SEVEN',
				'bullets'     => array_slice( array(
					'LONG-LASTING FLAVOR — Our slow-release flavor beads keep every piece fresh for up to 45 minutes, so one piece covers your whole commute or meeting.',
					'SWEETENED WITH XYLITOL — Zero sugar and no aspartame. Xylitol is a natural sweetener that helps fight cavities and keeps your breath clean.',
					'CLEAN INGREDIENTS — Vegan, keto-friendly, gluten-free and non-GMO. Nothing artificial you can not pronounce.',
					'RESEALABLE BOTTLE — The travel bottle fits every car cup holder and keeps 50 pieces fresh and protected in your bag or desk drawer.',
					'7 SEVEN PROMISE — Designed for people who want a modern, clean chew. Questions? Our team answers every message within 24 hours.',
				), 0, 3 === $i % 4 ? 3 : 5 ),
				'description' => 2 === $i % 5 ? '' : str_repeat( '7 SEVEN gum is crafted for a clean, confident chew with long-lasting flavor and xylitol sweetness. ', 12 ),
				'backend'     => 1 === $i % 4 ? '' : 'xylitol gum aspartame free keto vegan breath freshener office travel bottle sugarless candy mints',
				'images'      => array_fill( 0, 3 === $i % 3 ? 4 : ( 0 === $i % 3 ? 5 : 7 ), 'https://m.media-amazon.com/images/I/demo.jpg' ),
				'status'      => 7 === $i ? array( 'DISCOVERABLE' ) : array( 'BUYABLE', 'DISCOVERABLE' ),
				'issues'      => 7 === $i ? array( array( 'code' => '90220', 'severity' => 'ERROR', 'message' => "'item_package_weight' is required but not supplied." ) ) : array(),
				'product_type'=> 'CHEWING_GUM',
			);
			$kw = array_column( Db::rows( 'SELECT keyword FROM {t:keywords} WHERE asin = %s', array( $p['asin'] ) ), 'keyword' );
			ListingAuditor::store( $this->market, $p['sku'], $content, ListingAuditor::score( $content, $kw ), true );
			$n++;
		}
		return $n;
	}

	private function solicitations(): int {
		$rows = array();
		foreach ( Db::rows( "SELECT amazon_order_id, purchase_date FROM {t:orders} WHERE is_demo = 1 AND status = 'Shipped' AND local_date < %s ORDER BY purchase_date", array( SuiteTime::shift( $this->today, -12 ) ) ) as $i => $o ) {
			$rows[] = array( 'market' => $this->market, 'amazon_order_id' => $o['amazon_order_id'], 'status' => 0 === $i % 17 ? 'ineligible' : 'sent', 'message' => 0 === $i % 17 ? 'Already requested in Seller Central.' : '', 'attempted_at' => gmdate( 'Y-m-d H:i:s', strtotime( $o['purchase_date'] . ' +10 days' ) ), 'is_demo' => 1 );
		}
		$this->bulk( 'solicitations', $rows );
		return count( $rows );
	}

	private function expenses(): int {
		$rows = array(
			array( 'market' => '', 'label' => 'Helium-style tools & software', 'category' => 'software', 'amount' => 97.0, 'recurrence' => 'monthly', 'start_date' => SuiteTime::shift( $this->today, -200 ), 'end_date' => null, 'sku' => '', 'created_at' => Db::now(), 'is_demo' => 1 ),
			array( 'market' => '', 'label' => 'Virtual assistant', 'category' => 'staff', 'amount' => 600.0, 'recurrence' => 'monthly', 'start_date' => SuiteTime::shift( $this->today, -200 ), 'end_date' => null, 'sku' => '', 'created_at' => Db::now(), 'is_demo' => 1 ),
			array( 'market' => '', 'label' => 'Product photography (P9 relaunch)', 'category' => 'marketing', 'amount' => 450.0, 'recurrence' => 'once', 'start_date' => SuiteTime::shift( $this->today, -21 ), 'end_date' => null, 'sku' => '', 'created_at' => Db::now(), 'is_demo' => 1 ),
		);
		$this->bulk( 'expenses', $rows );
		return count( $rows );
	}

	/* ------------------------------------------------------------------ */

	private function fin( string $posted, string $type, string $order, string $sku, string $charge, string $cat, float $amount, int $qty ): array {
		static $n = 0;
		return array(
			'market' => $this->market, 'event_hash' => sha1( 'demo-fin-' . ( ++$n ) . '-' . $order . $charge ), 'posted_date' => $posted,
			'local_date' => SuiteTime::local_date( $posted, $this->market ), 'event_type' => $type, 'amazon_order_id' => $order, 'sku' => $sku,
			'charge_type' => $charge, 'category' => $cat, 'amount' => round( $amount, 4 ), 'currency' => 'USD', 'qty' => $qty, 'is_demo' => 1,
		);
	}

	private function poisson( float $lambda ): int {
		if ( $lambda <= 0 ) {
			return 0;
		}
		$l = exp( -$lambda );
		$k = 0;
		$p = 1.0;
		do {
			$k++;
			$p *= mt_rand() / mt_getrandmax();
		} while ( $p > $l && $k < 500 );
		return $k - 1;
	}

	/** Multi-row INSERT in chunks (seeding thousands of rows one-by-one is too slow on shared hosting). */
	private function bulk( string $short, array $rows ): void {
		global $wpdb;
		if ( ! $rows ) {
			return;
		}
		$table = SuiteSchema::table( $short );
		$cols  = array_keys( $rows[0] );
		foreach ( array_chunk( $rows, 200 ) as $chunk ) {
			$values = array();
			foreach ( $chunk as $r ) {
				$cells = array();
				foreach ( $cols as $c ) {
					$v = $r[ $c ] ?? null;
					$cells[] = null === $v ? 'NULL' : ( is_int( $v ) ? (string) $v : $wpdb->prepare( '%s', is_float( $v ) ? Db::num( $v ) : (string) $v ) );
				}
				$values[] = '(' . implode( ',', $cells ) . ')';
			}
			$wpdb->query( "INSERT IGNORE INTO {$table} (`" . implode( '`,`', $cols ) . '`) VALUES ' . implode( ',', $values ) ); // phpcs:ignore
		}
	}
}
