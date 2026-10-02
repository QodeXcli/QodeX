<?php
/**
 * SalesAggregator — read-only aggregations powering the dashboard charts.
 *
 * Operates on price_history + products. SP-API order data integration is
 * planned but not in v3.0 — for now we work from inventory + pricing
 * trajectories which are the most actionable signals anyway.
 *
 * @package SevenGum\Commerce\Analytics
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Analytics;

use SevenGum\Commerce\Database\Repositories\PriceHistoryRepository;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class SalesAggregator {

	public function __construct(
		private ProductRepository $products,
		private PriceHistoryRepository $price_history,
		private Logger $logger,
	) {}

	/**
	 * Top-line metrics for the dashboard hero strip.
	 *
	 * @return array{
	 *   products_total:int,
	 *   products_in_stock:int,
	 *   products_winning_buybox:int,
	 *   buybox_win_rate:float,
	 *   stockout_rate:float,
	 *   markets:int,
	 * }
	 */
	public function headline_kpis(): array {
		$total    = $this->products->count_total();
		$in_stock = $this->products->count_in_stock();
		$winning  = $this->products->count_winning_buybox();
		$markets  = count( $this->products->counts_by_market() );

		return array(
			'products_total'          => $total,
			'products_in_stock'       => $in_stock,
			'products_winning_buybox' => $winning,
			'buybox_win_rate'         => $total > 0 ? round( $winning / $total * 100, 1 ) : 0.0,
			'stockout_rate'           => $total > 0 ? round( ( $total - $in_stock ) / $total * 100, 1 ) : 0.0,
			'markets'                 => $markets,
		);
	}

	/**
	 * Daily Buy Box win/loss counts for the last 14 days.
	 * Returns rows keyed by date with 'won' and 'lost' integers.
	 */
	public function buybox_trend( int $days = 14 ): array {
		return $this->price_history->buybox_loss_by_day( $days );
	}

	/** Top-N products at risk: low stock or losing buybox. */
	public function at_risk( int $limit = 10 ): array {
		global $wpdb;
		$table = $wpdb->prefix . 'sg_products';
		$rows = $wpdb->get_results( $wpdb->prepare(
			"SELECT id, market, sku, product_name, fulfillable_qty, buybox_price, buybox_is_mine
			 FROM {$table}
			 WHERE fulfillable_qty <= 10 OR (buybox_is_mine = 0 AND buybox_price IS NOT NULL)
			 ORDER BY fulfillable_qty ASC, buybox_is_mine ASC
			 LIMIT %d",
			$limit
		), ARRAY_A );
		return is_array( $rows ) ? $rows : array();
	}
}
