<?php
/**
 * ProductRepository — data access for the {prefix}sg_products table.
 *
 * All queries flow through here. Prepares all input via $wpdb->prepare,
 * checks return values, logs errors, and uses an in-request cache to
 * coalesce duplicate fetches on the same page-render cycle.
 *
 * @package SevenGum\Commerce\Database\Repositories
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Database\Repositories;

use SevenGum\Commerce\Cache\CacheManager;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class ProductRepository {

	private string $table;

	/** Per-request cache keyed by id or "{market}|{sku}". */
	private array $by_id = array();
	private array $by_market_sku = array();

	public function __construct(
		private CacheManager $cache,
		private Logger $logger,
	) {
		global $wpdb;
		$this->table = $wpdb->prefix . 'sg_products';
	}

	public function find( int $id ): ?array {
		if ( isset( $this->by_id[ $id ] ) ) {
			return $this->by_id[ $id ];
		}
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$this->table} WHERE id = %d", $id ),
			ARRAY_A
		);
		if ( null === $row ) {
			return null;
		}
		$this->by_id[ $id ] = $row;
		$this->by_market_sku[ $row['market'] . '|' . $row['sku'] ] = $row;
		return $row;
	}

	public function find_by_sku( string $market, string $sku ): ?array {
		$key = $market . '|' . $sku;
		if ( isset( $this->by_market_sku[ $key ] ) ) {
			return $this->by_market_sku[ $key ];
		}
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT * FROM {$this->table} WHERE market = %s AND sku = %s LIMIT 1",
				$market,
				$sku
			),
			ARRAY_A
		);
		if ( null === $row ) {
			return null;
		}
		$this->by_market_sku[ $key ] = $row;
		$this->by_id[ (int) $row['id'] ] = $row;
		return $row;
	}

	/**
	 * Paginated query with filtering & search.
	 *
	 * @param array{
	 *   market?: string,
	 *   search?: string,
	 *   has_buybox?: bool,
	 *   in_stock?: bool,
	 *   per_page?: int,
	 *   page?: int,
	 *   orderby?: string,
	 *   order?: string,
	 * } $args
	 *
	 * @return array{rows: array<int, array>, total: int, pages: int}
	 */
	public function paginate( array $args = array() ): array {
		global $wpdb;

		$market    = isset( $args['market'] ) ? (string) $args['market'] : '';
		$search    = isset( $args['search'] ) ? trim( (string) $args['search'] ) : '';
		$per_page  = max( 1, min( 200, (int) ( $args['per_page'] ?? 25 ) ) );
		$page      = max( 1, (int) ( $args['page'] ?? 1 ) );
		$offset    = ( $page - 1 ) * $per_page;

		$allowed_orderby = array( 'id', 'market', 'sku', 'product_name', 'fulfillable_qty', 'buybox_price', 'last_sync_at', 'updated_at' );
		$orderby = in_array( $args['orderby'] ?? '', $allowed_orderby, true ) ? $args['orderby'] : 'updated_at';
		$order   = ( strtoupper( (string) ( $args['order'] ?? 'DESC' ) ) === 'ASC' ) ? 'ASC' : 'DESC';

		$where = array( '1=1' );
		$params = array();
		if ( '' !== $market ) {
			$where[] = 'market = %s';
			$params[] = $market;
		}
		if ( '' !== $search ) {
			$where[] = '(sku LIKE %s OR asin LIKE %s OR product_name LIKE %s)';
			$like = '%' . $wpdb->esc_like( $search ) . '%';
			$params[] = $like;
			$params[] = $like;
			$params[] = $like;
		}
		if ( ! empty( $args['has_buybox'] ) ) {
			$where[] = 'buybox_is_mine = 1';
		}
		if ( ! empty( $args['in_stock'] ) ) {
			$where[] = 'fulfillable_qty > 0';
		}

		$where_sql = implode( ' AND ', $where );

		// Total count.
		$count_sql = "SELECT COUNT(*) FROM {$this->table} WHERE {$where_sql}";
		$total = (int) $wpdb->get_var(
			empty( $params ) ? $count_sql : $wpdb->prepare( $count_sql, ...$params )
		);

		// Page query.
		$page_sql = "SELECT * FROM {$this->table} WHERE {$where_sql} ORDER BY {$orderby} {$order} LIMIT %d OFFSET %d";
		$page_params = array_merge( $params, array( $per_page, $offset ) );
		$rows = $wpdb->get_results(
			$wpdb->prepare( $page_sql, ...$page_params ),
			ARRAY_A
		);
		if ( ! is_array( $rows ) ) {
			$this->logger->error( 'paginate query failed', array( 'last_error' => $wpdb->last_error ) );
			$rows = array();
		}

		// Hydrate the in-request cache.
		foreach ( $rows as $r ) {
			$this->by_id[ (int) $r['id'] ] = $r;
			$this->by_market_sku[ $r['market'] . '|' . $r['sku'] ] = $r;
		}

		return array(
			'rows'  => $rows,
			'total' => $total,
			'pages' => (int) max( 1, ceil( $total / $per_page ) ),
		);
	}

	/**
	 * Upsert from a sync payload. Returns the row id.
	 *
	 * @throws \RuntimeException  on DB error.
	 */
	public function upsert_from_sync( array $data ): int {
		global $wpdb;
		$now = current_time( 'mysql', true );

		$market = (string) ( $data['market'] ?? '' );
		$sku    = (string) ( $data['sku'] ?? '' );
		if ( '' === $market || '' === $sku ) {
			throw new \RuntimeException( 'upsert_from_sync requires market and sku.' );
		}

		$result = $wpdb->query(
			$wpdb->prepare(
				"INSERT INTO {$this->table}
					(market, sku, asin, product_name, image_url, fulfillable_qty, reserved_qty, inbound_qty,
					 buybox_price, buybox_currency, buybox_is_mine, lowest_price, my_price,
					 last_sync_at, last_priced_at)
				 VALUES (%s, %s, %s, %s, %s, %d, %d, %d, %s, %s, %d, %s, %s, %s, %s)
				 ON DUPLICATE KEY UPDATE
					asin            = VALUES(asin),
					product_name    = IF(VALUES(product_name) = '', product_name, VALUES(product_name)),
					image_url       = IF(VALUES(image_url) = '', image_url, VALUES(image_url)),
					fulfillable_qty = VALUES(fulfillable_qty),
					reserved_qty    = VALUES(reserved_qty),
					inbound_qty     = VALUES(inbound_qty),
					buybox_price    = COALESCE(VALUES(buybox_price), buybox_price),
					buybox_currency = IF(VALUES(buybox_currency) = '', buybox_currency, VALUES(buybox_currency)),
					buybox_is_mine  = VALUES(buybox_is_mine),
					lowest_price    = COALESCE(VALUES(lowest_price), lowest_price),
					my_price        = COALESCE(VALUES(my_price), my_price),
					last_sync_at    = VALUES(last_sync_at),
					last_priced_at  = COALESCE(VALUES(last_priced_at), last_priced_at)",
				$market,
				$sku,
				(string) ( $data['asin'] ?? '' ),
				(string) ( $data['product_name'] ?? '' ),
				(string) ( $data['image_url'] ?? '' ),
				(int) ( $data['fulfillable_qty'] ?? 0 ),
				(int) ( $data['reserved_qty'] ?? 0 ),
				(int) ( $data['inbound_qty'] ?? 0 ),
				isset( $data['buybox_price'] ) ? (string) $data['buybox_price'] : null,
				(string) ( $data['buybox_currency'] ?? '' ),
				(int) ( $data['buybox_is_mine'] ?? 0 ),
				isset( $data['lowest_price'] ) ? (string) $data['lowest_price'] : null,
				isset( $data['my_price'] ) ? (string) $data['my_price'] : null,
				$now,
				isset( $data['buybox_price'] ) ? $now : null
			)
		);

		if ( false === $result ) {
			$err = $wpdb->last_error;
			$this->logger->error( 'upsert_from_sync DB error', array( 'sku' => $sku, 'market' => $market, 'err' => $err ) );
			throw new \RuntimeException( "DB upsert failed: {$err}" );
		}

		// Reset cache for this row.
		unset( $this->by_market_sku[ $market . '|' . $sku ] );
		$row = $this->find_by_sku( $market, $sku );
		return $row ? (int) $row['id'] : 0;
	}

	public function add_manual( array $data ): int {
		global $wpdb;
		$now = current_time( 'mysql', true );
		$market = strtoupper( (string) ( $data['market'] ?? 'US' ) );
		$sku = (string) ( $data['sku'] ?? '' );
		if ( '' === $sku ) {
			throw new \RuntimeException( 'SKU required.' );
		}
		$result = $wpdb->query(
			$wpdb->prepare(
				"INSERT INTO {$this->table}
					(market, sku, asin, product_name, image_url, cost_price, fulfillable_qty, last_sync_at)
				 VALUES (%s, %s, %s, %s, %s, %s, 0, %s)
				 ON DUPLICATE KEY UPDATE
					asin = VALUES(asin),
					product_name = VALUES(product_name),
					image_url = VALUES(image_url),
					cost_price = VALUES(cost_price)",
				$market,
				$sku,
				(string) ( $data['asin'] ?? '' ),
				(string) ( $data['product_name'] ?? '' ),
				(string) ( $data['image_url'] ?? '' ),
				isset( $data['cost_price'] ) ? (string) $data['cost_price'] : null,
				$now
			)
		);
		if ( false === $result ) {
			throw new \RuntimeException( 'add_manual DB error: ' . $wpdb->last_error );
		}
		unset( $this->by_market_sku[ $market . '|' . $sku ] );
		$row = $this->find_by_sku( $market, $sku );
		return $row ? (int) $row['id'] : 0;
	}

	public function update_cost( int $id, float $cost ): bool {
		global $wpdb;
		$result = $wpdb->update( $this->table, array( 'cost_price' => $cost ), array( 'id' => $id ), array( '%f' ), array( '%d' ) );
		unset( $this->by_id[ $id ] );
		return false !== $result;
	}

	public function update_my_price( int $id, float $price ): bool {
		global $wpdb;
		$now = current_time( 'mysql', true );
		$result = $wpdb->update(
			$this->table,
			array( 'my_price' => $price, 'last_priced_at' => $now ),
			array( 'id' => $id ),
			array( '%f', '%s' ),
			array( '%d' )
		);
		unset( $this->by_id[ $id ] );
		return false !== $result;
	}

	public function delete( int $id ): bool {
		global $wpdb;
		$row = $this->find( $id );
		$result = $wpdb->delete( $this->table, array( 'id' => $id ), array( '%d' ) );
		if ( $row ) {
			unset( $this->by_id[ $id ], $this->by_market_sku[ $row['market'] . '|' . $row['sku'] ] );
		}
		return false !== $result;
	}

	/* -------- Aggregates for dashboard -------- */

	public function count_total(): int {
		global $wpdb;
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$this->table}" );
	}

	public function count_in_stock(): int {
		global $wpdb;
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$this->table} WHERE fulfillable_qty > 0" );
	}

	public function count_winning_buybox(): int {
		global $wpdb;
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$this->table} WHERE buybox_is_mine = 1" );
	}

	public function last_sync_at(): ?string {
		global $wpdb;
		$v = $wpdb->get_var( "SELECT MAX(last_sync_at) FROM {$this->table}" );
		return $v ? (string) $v : null;
	}

	public function counts_by_market(): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			"SELECT market, COUNT(*) AS c FROM {$this->table} GROUP BY market ORDER BY market",
			ARRAY_A
		);
		$out = array();
		foreach ( (array) $rows as $r ) {
			$out[ $r['market'] ] = (int) $r['c'];
		}
		return $out;
	}
}
