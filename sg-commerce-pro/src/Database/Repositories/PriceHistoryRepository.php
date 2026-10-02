<?php
/**
 * PriceHistoryRepository — append-only price snapshots.
 *
 * Every sync writes a row here with the current pricing snapshot. The
 * analytics + repricer modules read this table to chart trends and
 * detect competitor undercutting.
 *
 * @package SevenGum\Commerce\Database\Repositories
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Database\Repositories;

use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class PriceHistoryRepository {

	private string $table;

	public function __construct( private Logger $logger ) {
		global $wpdb;
		$this->table = $wpdb->prefix . 'sg_price_history';
	}

	public function record( int $product_id, array $snapshot, string $source = 'sync' ): bool {
		global $wpdb;
		$result = $wpdb->insert(
			$this->table,
			array(
				'product_id'      => $product_id,
				'recorded_at'     => current_time( 'mysql', true ),
				'my_price'        => $snapshot['my_price']        ?? null,
				'buybox_price'    => $snapshot['buybox_price']    ?? null,
				'lowest_price'    => $snapshot['lowest_price']    ?? null,
				'currency'        => (string) ( $snapshot['currency'] ?? '' ),
				'buybox_is_mine'  => (int) ( $snapshot['buybox_is_mine'] ?? 0 ),
				'fulfillable_qty' => (int) ( $snapshot['fulfillable_qty'] ?? 0 ),
				'source'          => $source,
			),
			array( '%d', '%s', '%f', '%f', '%f', '%s', '%d', '%d', '%s' )
		);
		if ( false === $result ) {
			$this->logger->error( 'price history insert failed', array( 'err' => $wpdb->last_error ) );
			return false;
		}
		return true;
	}

	/**
	 * Recent N snapshots for a product, oldest first.
	 *
	 * @return array<int, array>
	 */
	public function recent_for_product( int $product_id, int $limit = 100 ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$this->table}
				 WHERE product_id = %d
				 ORDER BY recorded_at DESC
				 LIMIT %d",
				$product_id,
				$limit
			),
			ARRAY_A
		);
		return is_array( $rows ) ? array_reverse( $rows ) : array();
	}

	/**
	 * Aggregate buybox loss events across the inventory, grouped by day.
	 * Used by the analytics dashboard.
	 */
	public function buybox_loss_by_day( int $days = 14 ): array {
		global $wpdb;
		$cutoff = gmdate( 'Y-m-d H:i:s', time() - $days * DAY_IN_SECONDS );
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT DATE(recorded_at) AS day,
						SUM(CASE WHEN buybox_is_mine = 0 THEN 1 ELSE 0 END) AS lost,
						SUM(CASE WHEN buybox_is_mine = 1 THEN 1 ELSE 0 END) AS won
				 FROM {$this->table}
				 WHERE recorded_at >= %s
				 GROUP BY DATE(recorded_at)
				 ORDER BY day ASC",
				$cutoff
			),
			ARRAY_A
		);
		return is_array( $rows ) ? $rows : array();
	}

	/** Prune snapshots older than $days to keep the table bounded. */
	public function prune_older_than( int $days ): int {
		global $wpdb;
		$cutoff = gmdate( 'Y-m-d H:i:s', time() - $days * DAY_IN_SECONDS );
		$deleted = $wpdb->query(
			$wpdb->prepare( "DELETE FROM {$this->table} WHERE recorded_at < %s", $cutoff )
		);
		return is_numeric( $deleted ) ? (int) $deleted : 0;
	}
}
