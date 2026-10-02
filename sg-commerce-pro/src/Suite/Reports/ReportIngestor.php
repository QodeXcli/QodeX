<?php
/**
 * ReportIngestor — maps each supported SP-API report into suite tables.
 *
 * Every write is an idempotent upsert keyed on a natural key or row hash,
 * because Amazon restates recent rows (returns get dispositions, ledger
 * adjustments get reconciled) and we re-request overlapping windows.
 *
 * PII discipline: buyer emails/names/addresses that appear in some flat
 * files (feedback "rater-email", orders "buyer-*", "ship-address-*") are
 * never read into the database.
 *
 * @package SevenGum\Commerce\Suite\Reports
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Reports;

use SevenGum\Commerce\Suite\Support\SuiteAlerts;
use SevenGum\Commerce\Suite\Orders\OrdersSync;
use SevenGum\Commerce\Suite\Support\Db;

defined( 'ABSPATH' ) || exit;

final class ReportIngestor {

	public function __construct( private OrdersSync $orders ) {}

	/**
	 * @param array $meta  The `reports` row (data_start etc.)
	 * @return int rows ingested
	 */
	public function ingest( string $type, string $market, string $raw, array $meta = array(), bool $demo = false ): int {
		return match ( $type ) {
			'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
			'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL' => $this->orders->ingest_flat_file( $raw, $market ),
			'GET_SALES_AND_TRAFFIC_REPORT'                        => $this->traffic( $raw, $market, $meta, $demo ),
			'GET_LEDGER_DETAIL_VIEW_DATA'                         => $this->ledger( $raw, $market, $demo ),
			'GET_FBA_REIMBURSEMENTS_DATA'                         => $this->reimbursements( $raw, $market, $demo ),
			'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'           => $this->returns( $raw, $market, $demo ),
			'GET_FBA_INVENTORY_PLANNING_DATA'                     => $this->inventory_health( $raw, $market, $demo ),
			'GET_SELLER_FEEDBACK_DATA'                            => $this->feedback( $raw, $market, $demo ),
			'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT' => $this->sqp( $raw, $market, $demo ),
			default                                               => count( ReportParser::tsv( $raw ) ),
		};
	}

	public function traffic( string $raw, string $market, array $meta, bool $demo = false ): int {
		$doc = ReportParser::json( $raw );
		$n   = 0;
		foreach ( (array) ( $doc['salesAndTrafficByDate'] ?? array() ) as $d ) {
			$date = substr( (string) ( $d['date'] ?? '' ), 0, 10 );
			if ( '' === $date ) {
				continue;
			}
			Db::upsert( 'traffic_daily', array(
				'market'        => $market,
				'report_date'   => $date,
				'asin'          => '',
				'sku'           => '',
				'sessions'      => (int) ( $d['trafficByDate']['sessions'] ?? 0 ),
				'page_views'    => (int) ( $d['trafficByDate']['pageViews'] ?? 0 ),
				'buy_box_pct'   => (float) ( $d['trafficByDate']['buyBoxPercentage'] ?? 0 ),
				'units'         => (int) ( $d['salesByDate']['unitsOrdered'] ?? 0 ),
				'order_items'   => (int) ( $d['salesByDate']['totalOrderItems'] ?? 0 ),
				'ordered_sales' => (float) ( $d['salesByDate']['orderedProductSales']['amount'] ?? 0 ),
				'is_demo'       => $demo ? 1 : 0,
			) );
			$n++;
		}
		// By-ASIN rows are aggregated over the whole report window; we request one day per report.
		$day = substr( (string) ( $meta['data_start'] ?? ( $doc['reportSpecification']['dataStartTime'] ?? '' ) ), 0, 10 );
		if ( '' !== $day ) {
			foreach ( (array) ( $doc['salesAndTrafficByAsin'] ?? array() ) as $a ) {
				$asin = (string) ( $a['childAsin'] ?? $a['parentAsin'] ?? '' );
				if ( '' === $asin ) {
					continue;
				}
				Db::upsert( 'traffic_daily', array(
					'market'        => $market,
					'report_date'   => $day,
					'asin'          => $asin,
					'sku'           => (string) ( $a['sku'] ?? '' ),
					'sessions'      => (int) ( $a['trafficByAsin']['sessions'] ?? 0 ),
					'page_views'    => (int) ( $a['trafficByAsin']['pageViews'] ?? 0 ),
					'buy_box_pct'   => (float) ( $a['trafficByAsin']['buyBoxPercentage'] ?? 0 ),
					'units'         => (int) ( $a['salesByAsin']['unitsOrdered'] ?? 0 ),
					'order_items'   => (int) ( $a['salesByAsin']['totalOrderItems'] ?? 0 ),
					'ordered_sales' => (float) ( $a['salesByAsin']['orderedProductSales']['amount'] ?? 0 ),
					'is_demo'       => $demo ? 1 : 0,
				) );
				$n++;
			}
		}
		return $n;
	}

	public function ledger( string $raw, string $market, bool $demo = false ): int {
		$n = 0;
		foreach ( ReportParser::tsv( $raw ) as $r ) {
			$date = self::date( $r['date'] ?? '' );
			if ( null === $date ) {
				continue;
			}
			Db::upsert( 'ledger', array(
				'row_hash'           => sha1( wp_json_encode( array( $market, $r['date'] ?? '', $r['fnsku'] ?? '', $r['event-type'] ?? '', $r['reference-id'] ?? '', $r['quantity'] ?? '', $r['fulfillment-center'] ?? '', $r['disposition'] ?? '', $r['reason'] ?? '' ) ) ),
				'market'             => $market,
				'event_date'         => $date,
				'fnsku'              => (string) ( $r['fnsku'] ?? '' ),
				'sku'                => (string) ( $r['msku'] ?? $r['sku'] ?? '' ),
				'asin'               => (string) ( $r['asin'] ?? '' ),
				'event_type'         => (string) ( $r['event-type'] ?? '' ),
				'reference_id'       => (string) ( $r['reference-id'] ?? '' ),
				'qty'                => (int) ( $r['quantity'] ?? 0 ),
				'fulfillment_center' => (string) ( $r['fulfillment-center'] ?? '' ),
				'disposition'        => (string) ( $r['disposition'] ?? '' ),
				'reason'             => (string) ( $r['reason'] ?? '' ),
				'is_demo'            => $demo ? 1 : 0,
			) );
			$n++;
		}
		return $n;
	}

	public function reimbursements( string $raw, string $market, bool $demo = false ): int {
		$n = 0;
		foreach ( ReportParser::tsv( $raw ) as $r ) {
			$id = (string) ( $r['reimbursement-id'] ?? '' );
			if ( '' === $id ) {
				continue;
			}
			Db::upsert( 'reimbursements', array(
				'reimbursement_id' => $id,
				'market'           => $market,
				'approval_date'    => self::date( $r['approval-date'] ?? '' ) ?? gmdate( 'Y-m-d' ),
				'case_id'          => (string) ( $r['case-id'] ?? '' ),
				'amazon_order_id'  => (string) ( $r['amazon-order-id'] ?? '' ),
				'reason'           => (string) ( $r['reason'] ?? '' ),
				'sku'              => (string) ( $r['sku'] ?? '' ),
				'fnsku'            => (string) ( $r['fnsku'] ?? '' ),
				'asin'             => (string) ( $r['asin'] ?? '' ),
				'amount'           => ReportParser::money( $r['amount-total'] ?? 0 ),
				'currency'         => (string) ( $r['currency-unit'] ?? '' ),
				'qty_cash'         => (int) ( $r['quantity-reimbursed-cash'] ?? 0 ),
				'qty_inventory'    => (int) ( $r['quantity-reimbursed-inventory'] ?? 0 ),
				'is_demo'          => $demo ? 1 : 0,
			) );
			$n++;
		}
		return $n;
	}

	public function returns( string $raw, string $market, bool $demo = false ): int {
		$n = 0;
		foreach ( ReportParser::tsv( $raw ) as $r ) {
			$date = self::date( $r['return-date'] ?? '' );
			if ( null === $date ) {
				continue;
			}
			Db::upsert( 'returns', array(
				'row_hash'           => sha1( wp_json_encode( array( $market, $r['order-id'] ?? '', $r['fnsku'] ?? '', $r['license-plate-number'] ?? '', $r['return-date'] ?? '' ) ) ),
				'market'             => $market,
				'return_date'        => $date,
				'amazon_order_id'    => (string) ( $r['order-id'] ?? '' ),
				'sku'                => (string) ( $r['sku'] ?? '' ),
				'asin'               => (string) ( $r['asin'] ?? '' ),
				'fnsku'              => (string) ( $r['fnsku'] ?? '' ),
				'qty'                => (int) ( $r['quantity'] ?? 0 ),
				'fulfillment_center' => (string) ( $r['fulfillment-center-id'] ?? '' ),
				'disposition'        => (string) ( $r['detailed-disposition'] ?? '' ),
				'reason'             => (string) ( $r['reason'] ?? '' ),
				'status'             => (string) ( $r['status'] ?? '' ),
				'comments'           => mb_substr( (string) ( $r['customer-comments'] ?? '' ), 0, 500 ),
				'is_demo'            => $demo ? 1 : 0,
			) );
			$n++;
		}
		return $n;
	}

	public function inventory_health( string $raw, string $market, bool $demo = false ): int {
		$n = 0;
		foreach ( ReportParser::tsv( $raw ) as $r ) {
			$sku = (string) ( $r['sku'] ?? '' );
			if ( '' === $sku ) {
				continue;
			}
			$over_365 = 0;
			foreach ( $r as $k => $v ) {
				if ( 1 === preg_match( '/^inv-age-(365-plus|366|4\d\d|5\d\d|6\d\d|7\d\d)/', $k ) ) {
					$over_365 += (int) $v;
				}
			}
			Db::upsert( 'inventory_health', array(
				'market'             => $market,
				'snapshot_date'      => self::date( $r['snapshot-date'] ?? '' ) ?? gmdate( 'Y-m-d' ),
				'sku'                => $sku,
				'asin'               => (string) ( $r['asin'] ?? '' ),
				'available'          => (int) ( $r['available'] ?? 0 ),
				'age_0_90'           => (int) ( $r['inv-age-0-to-90-days'] ?? 0 ),
				'age_91_180'         => (int) ( $r['inv-age-91-to-180-days'] ?? 0 ),
				'age_181_270'        => (int) ( $r['inv-age-181-to-270-days'] ?? 0 ),
				'age_271_365'        => (int) ( $r['inv-age-271-to-365-days'] ?? 0 ),
				'age_365_plus'       => $over_365,
				'units_t30'          => (int) ( $r['units-shipped-t30'] ?? 0 ),
				'sell_through'       => isset( $r['sell-through'] ) && '' !== $r['sell-through'] ? ReportParser::money( $r['sell-through'] ) : null,
				'days_of_supply'     => isset( $r['days-of-supply'] ) && '' !== $r['days-of-supply'] ? (int) $r['days-of-supply'] : null,
				'est_storage_cost'   => isset( $r['estimated-storage-cost-next-month'] ) && '' !== $r['estimated-storage-cost-next-month'] ? ReportParser::money( $r['estimated-storage-cost-next-month'] ) : null,
				'recommended_action' => mb_substr( (string) ( $r['recommended-action'] ?? '' ), 0, 64 ),
				'is_demo'            => $demo ? 1 : 0,
			) );
			$n++;
		}
		return $n;
	}

	public function feedback( string $raw, string $market, bool $demo = false ): int {
		$n = 0;
		foreach ( ReportParser::tsv( $raw ) as $r ) {
			$date = self::date( $r['date'] ?? '' );
			if ( null === $date ) {
				continue;
			}
			$order  = (string) ( $r['order-id'] ?? '' );
			$rating = (int) ( $r['rating'] ?? 0 );
			$hash   = sha1( $market . '|' . $order . '|' . $date . '|' . $rating );
			$is_new = 0 === (int) Db::var( 'SELECT COUNT(*) FROM {t:feedback} WHERE row_hash = %s', array( $hash ) );
			Db::upsert( 'feedback', array(
				'row_hash'        => $hash,
				'market'          => $market,
				'feedback_date'   => $date,
				'rating'          => $rating,
				'comments'        => mb_substr( (string) ( $r['comments'] ?? '' ), 0, 2000 ),
				'amazon_order_id' => $order,
				'is_demo'         => $demo ? 1 : 0,
			) );
			if ( $is_new && $rating > 0 && $rating <= 2 && ! $demo ) {
				SuiteAlerts::raise( 'warning', 'suite_feedback', sprintf( 'Negative seller feedback (%d★) on order %s', $rating, $order ), mb_substr( (string) ( $r['comments'] ?? '' ), 0, 300 ), array( 'market' => $market ) );
			}
			$n++;
		}
		return $n;
	}

	public function sqp( string $raw, string $market, bool $demo = false ): int {
		$doc = ReportParser::json( $raw );
		$n   = 0;
		foreach ( (array) ( $doc['dataByAsin'] ?? array() ) as $r ) {
			$kw = mb_substr( strtolower( (string) ( $r['searchQueryData']['searchQuery'] ?? '' ) ), 0, 190 );
			if ( '' === $kw || empty( $r['asin'] ) ) {
				continue;
			}
			Db::upsert( 'keyword_metrics', array(
				'market'            => $market,
				'asin'              => (string) $r['asin'],
				'keyword'           => $kw,
				'period_start'      => substr( (string) ( $r['startDate'] ?? '' ), 0, 10 ),
				'period_end'        => substr( (string) ( $r['endDate'] ?? '' ), 0, 10 ),
				'query_score'       => (int) ( $r['searchQueryData']['searchQueryScore'] ?? 0 ),
				'query_volume'      => (int) ( $r['searchQueryData']['searchQueryVolume'] ?? 0 ),
				'impressions_total' => (int) ( $r['impressionData']['totalQueryImpressionCount'] ?? 0 ),
				'impressions_asin'  => (int) ( $r['impressionData']['asinImpressionCount'] ?? 0 ),
				'clicks_total'      => (int) ( $r['clickData']['totalClickCount'] ?? 0 ),
				'clicks_asin'       => (int) ( $r['clickData']['asinClickCount'] ?? 0 ),
				'cart_adds_total'   => (int) ( $r['cartAddData']['totalCartAddCount'] ?? 0 ),
				'cart_adds_asin'    => (int) ( $r['cartAddData']['asinCartAddCount'] ?? 0 ),
				'purchases_total'   => (int) ( $r['purchaseData']['totalPurchaseCount'] ?? 0 ),
				'purchases_asin'    => (int) ( $r['purchaseData']['asinPurchaseCount'] ?? 0 ),
				'is_demo'           => $demo ? 1 : 0,
			) );
			$n++;
		}
		return $n;
	}

	/** Accepts ISO-8601, Y-m-d, and US m/d/Y. */
	public static function date( string $v ): ?string {
		$v = trim( $v );
		if ( '' === $v ) {
			return null;
		}
		if ( 1 === preg_match( '/^(\d{4})-(\d{2})-(\d{2})/', $v, $m ) ) {
			return "{$m[1]}-{$m[2]}-{$m[3]}";
		}
		if ( 1 === preg_match( '#^(\d{1,2})/(\d{1,2})/(\d{2,4})#', $v, $m ) ) {
			$y = strlen( $m[3] ) === 2 ? '20' . $m[3] : $m[3];
			return sprintf( '%04d-%02d-%02d', (int) $y, (int) $m[1], (int) $m[2] );
		}
		$ts = strtotime( $v );
		return false === $ts ? null : gmdate( 'Y-m-d', $ts );
	}
}
