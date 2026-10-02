<?php
/**
 * RestockPlanner — demand forecasting & reorder planning (SoStocked-style).
 *
 * Velocity = weighted blend of trailing 7/30/90-day unit sales
 *            (0.5 / 0.3 / 0.2), with stock-out days excluded from the
 *            denominator so a SKU that was out of stock isn't under-forecast.
 *
 * For each SKU:
 *   supply          = fulfillable + reserved(FC transfer) + inbound
 *   days_of_cover   = supply / velocity
 *   reorder_point   = velocity × (lead_time + safety_days)
 *   order_qty       = velocity × (lead_time + target_cover) − supply,
 *                     rounded UP to case pack and ≥ MOQ
 *   stockout_date   = today + fulfillable / velocity
 *   reorder_by      = stockout_date − lead_time − safety_days
 *
 * Status: out_of_stock | critical | stockout_risk | reorder_now | reorder_soon | healthy | overstock | no_sales
 *   (stockout_risk = enough total supply, but sellable units run out before inbound is received)
 *
 * `plan()` is pure — `build()` gathers the inputs from the database.
 *
 * @package SevenGum\Commerce\Suite\Inventory
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Inventory;

use SevenGum\Commerce\Suite\Profit\CostBook;
use SevenGum\Commerce\Suite\SuiteSettings;
use SevenGum\Commerce\Suite\Support\Db;
use SevenGum\Commerce\Suite\Support\SuiteTime;

defined( 'ABSPATH' ) || exit;

final class RestockPlanner {

	public function __construct(
		private CostBook $costs,
		private SuiteSettings $settings,
	) {}

	public function build( string $market ): array {
		global $wpdb;
		$today = SuiteTime::today( $market );
		$stock = $wpdb->get_results( $wpdb->prepare(
			"SELECT sku, asin, product_name, fulfillable_qty, reserved_qty, inbound_qty, my_price, buybox_price
			 FROM {$wpdb->prefix}sg_products WHERE market = %s", $market
		), ARRAY_A ) ?: array(); // phpcs:ignore

		$sales = array();
		foreach ( array( 7, 30, 90 ) as $w ) {
			$rows = Db::rows(
				"SELECT sku, SUM(qty) AS units, COUNT(DISTINCT local_date) AS active_days FROM {t:order_items}
				 WHERE market = %s AND local_date BETWEEN %s AND %s AND status <> 'Canceled' GROUP BY sku",
				array( $market, SuiteTime::shift( $today, -$w ), SuiteTime::shift( $today, -1 ) )
			);
			foreach ( $rows as $r ) {
				$sales[ (string) $r['sku'] ][ $w ] = (int) $r['units'];
			}
		}
		// Days each SKU was out of stock in the last 30 days, from price-history snapshots.
		$oos = array();
		$oos_rows = $wpdb->get_results( $wpdb->prepare(
			"SELECT p.sku, COUNT(DISTINCT DATE(h.recorded_at)) AS d FROM {$wpdb->prefix}sg_price_history h
			 INNER JOIN {$wpdb->prefix}sg_products p ON p.id = h.product_id
			 WHERE p.market = %s AND h.fulfillable_qty = 0 AND h.recorded_at >= %s GROUP BY p.sku",
			$market, gmdate( 'Y-m-d', strtotime( $today . ' -30 days' ) )
		), ARRAY_A ) ?: array(); // phpcs:ignore
		foreach ( $oos_rows as $r ) {
			$oos[ (string) $r['sku'] ] = (int) $r['d'];
		}

		$inputs = array();
		foreach ( $stock as $s ) {
			$sku  = (string) $s['sku'];
			$cost = $this->costs->row( $market, $sku );
			$inputs[] = array(
				'sku'          => $sku,
				'asin'         => (string) $s['asin'],
				'title'        => (string) $s['product_name'],
				'fulfillable'  => (int) $s['fulfillable_qty'],
				'reserved'     => (int) $s['reserved_qty'],
				'inbound'      => (int) $s['inbound_qty'],
				'units_7'      => $sales[ $sku ][7] ?? 0,
				'units_30'     => $sales[ $sku ][30] ?? 0,
				'units_90'     => $sales[ $sku ][90] ?? 0,
				'oos_days_30'  => $oos[ $sku ] ?? 0,
				'lead_time'    => ( $cost['lead_time_days'] ?? 0 ) ?: $this->settings->int( 'suite_lead_time_days' ),
				'moq'          => (int) ( $cost['moq'] ?? 0 ),
				'case_pack'    => (int) ( $cost['case_pack'] ?? 0 ),
				'unit_cost'    => $this->costs->landed( $market, $sku ),
				'price'        => (float) ( $s['my_price'] ?? $s['buybox_price'] ?? 0 ),
			);
		}
		return self::plan( $inputs, $today, array(
			'safety_days'    => $this->settings->int( 'suite_safety_days' ),
			'target_cover'   => $this->settings->int( 'suite_target_cover_days' ),
			'overstock_days' => $this->settings->int( 'suite_overstock_days' ),
		) );
	}

	public static function plan( array $inputs, string $today, array $cfg ): array {
		$cfg += array( 'safety_days' => 14, 'target_cover' => 60, 'overstock_days' => 180 );
		$rows = array();
		$summary = array( 'skus' => 0, 'reorder' => 0, 'out_of_stock' => 0, 'overstock' => 0, 'order_units' => 0, 'order_value' => 0.0, 'lost_sales_per_day' => 0.0 );

		foreach ( $inputs as $in ) {
			$v7  = $in['units_7'] / 7;
			$v30 = $in['units_30'] / max( 1, 30 - min( 29, (int) ( $in['oos_days_30'] ?? 0 ) ) );
			$v90 = $in['units_90'] / 90;
			$velocity = round( 0.5 * $v7 + 0.3 * $v30 + 0.2 * $v90, 3 );
			$trend    = $v30 > 0 ? round( ( $v7 - $v30 ) / $v30 * 100, 1 ) : null;

			$fulfillable = max( 0, (int) $in['fulfillable'] );
			$supply      = $fulfillable + max( 0, (int) $in['reserved'] ) + max( 0, (int) $in['inbound'] );
			$lead        = max( 1, (int) $in['lead_time'] );
			$safety      = (int) $cfg['safety_days'];

			$cover = $velocity > 0 ? $supply / $velocity : null;
			$days_fulfillable = $velocity > 0 ? $fulfillable / $velocity : null;
			$reorder_point = (int) ceil( $velocity * ( $lead + $safety ) );
			$need = $velocity * ( $lead + (int) $cfg['target_cover'] ) - $supply;
			$qty  = $need > 0 ? (int) ceil( $need ) : 0;
			if ( $qty > 0 && $in['case_pack'] > 0 ) {
				$qty = (int) ( ceil( $qty / $in['case_pack'] ) * $in['case_pack'] );
			}
			if ( $qty > 0 && $in['moq'] > 0 ) {
				$qty = max( $qty, (int) $in['moq'] );
			}

			$stockout   = null !== $days_fulfillable ? SuiteTime::shift( $today, (int) floor( $days_fulfillable ) ) : null;
			$reorder_by = null !== $cover ? SuiteTime::shift( $today, (int) floor( $cover ) - $lead - $safety ) : null;

			if ( $velocity <= 0 ) {
				$status = $supply > 0 ? 'no_sales' : 'out_of_stock';
				$qty    = 0;
			} elseif ( 0 === $fulfillable && 0 === $supply ) {
				$status = 'out_of_stock';
			} elseif ( $cover <= $lead ) {
				// Runs out before (or exactly when) a PO placed today would arrive.
				$status = 'critical';
			} elseif ( $supply <= $reorder_point ) {
				$status = 'reorder_now';
			} elseif ( $cover < $lead + $safety + 14 ) {
				$status = 'reorder_soon';
			} elseif ( $cover > (int) $cfg['overstock_days'] ) {
				$status = 'overstock';
			} else {
				$status = 'healthy';
			}
			if ( 0 === $fulfillable && $velocity > 0 && 'out_of_stock' !== $status ) {
				$status = 'out_of_stock';
			}
			// Total supply looks fine but sellable units run out before inbound stock is likely
			// to be received (FBA check-in typically takes 1–2 weeks) → a stock-out gap.
			if ( in_array( $status, array( 'healthy', 'reorder_soon', 'overstock' ), true ) && null !== $days_fulfillable
				&& $days_fulfillable < 10 && (int) $in['inbound'] > 0 ) {
				$status = 'stockout_risk';
			}

			$lost = 'out_of_stock' === $status ? $velocity * (float) $in['price'] : 0.0;
			$rows[] = array(
				'sku'            => $in['sku'],
				'asin'           => $in['asin'],
				'title'          => $in['title'],
				'fulfillable'    => $fulfillable,
				'reserved'       => (int) $in['reserved'],
				'inbound'        => (int) $in['inbound'],
				'supply'         => $supply,
				'units_7'        => (int) $in['units_7'],
				'units_30'       => (int) $in['units_30'],
				'units_90'       => (int) $in['units_90'],
				'velocity'       => $velocity,
				'trend_pct'      => $trend,
				'days_of_cover'  => null !== $cover ? (int) floor( $cover ) : null,
				'stockout_date'  => $stockout,
				'reorder_by'     => $reorder_by,
				'reorder_point'  => $reorder_point,
				'lead_time'      => $lead,
				'order_qty'      => $qty,
				'order_value'    => round( $qty * (float) $in['unit_cost'], 2 ),
				'status'         => $status,
				'lost_sales_day' => round( $lost, 2 ),
			);
			$summary['skus']++;
			if ( in_array( $status, array( 'critical', 'reorder_now', 'stockout_risk' ), true ) || ( 'out_of_stock' === $status && $velocity > 0 ) ) {
				$summary['reorder']++;
			}
			if ( 'out_of_stock' === $status ) {
				$summary['out_of_stock']++;
			}
			if ( 'overstock' === $status ) {
				$summary['overstock']++;
			}
			$summary['order_units'] += $qty;
			$summary['order_value'] += $qty * (float) $in['unit_cost'];
			$summary['lost_sales_per_day'] += $lost;
		}
		$rank = array( 'out_of_stock' => 0, 'critical' => 1, 'stockout_risk' => 2, 'reorder_now' => 3, 'reorder_soon' => 4, 'overstock' => 5, 'healthy' => 6, 'no_sales' => 7 );
		usort( $rows, static fn( $a, $b ) => array( $rank[ $a['status'] ], $a['days_of_cover'] ?? PHP_INT_MAX ) <=> array( $rank[ $b['status'] ], $b['days_of_cover'] ?? PHP_INT_MAX ) );
		$summary['order_value']        = round( $summary['order_value'], 2 );
		$summary['lost_sales_per_day'] = round( $summary['lost_sales_per_day'], 2 );
		return array( 'today' => $today, 'summary' => $summary, 'rows' => $rows );
	}
}
