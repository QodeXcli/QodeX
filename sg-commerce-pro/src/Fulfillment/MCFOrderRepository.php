<?php
/**
 * MCFOrderRepository — CRUD for wp_sg_mcf_orders.
 *
 * @package SevenGum\Commerce\Fulfillment
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Fulfillment;

use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class MCFOrderRepository {

	private string $table;

	public function __construct( private Logger $logger ) {
		global $wpdb;
		$this->table = $wpdb->prefix . 'sg_mcf_orders';
	}

	public function insert( MCFOrderRequest $req ): int {
		global $wpdb;
		$now = current_time( 'mysql', true );
		$result = $wpdb->insert( $this->table, array(
			'seller_fulfillment_order_id' => $req->seller_fulfillment_order_id,
			'displayable_order_id'        => $req->displayable_order_id,
			'market'                      => $req->market,
			'customer_name'               => (string) ( $req->customer['name']  ?? '' ),
			'customer_email'              => (string) ( $req->customer['email'] ?? '' ),
			'country_code'                => (string) ( $req->address['country_code'] ?? '' ),
			'address_line1'               => (string) ( $req->address['line1'] ?? '' ),
			'address_line2'               => (string) ( $req->address['line2'] ?? '' ),
			'city'                        => (string) ( $req->address['city']  ?? '' ),
			'state_region'                => (string) ( $req->address['state_region'] ?? '' ),
			'postal_code'                 => (string) ( $req->address['postal_code']  ?? '' ),
			'phone'                       => (string) ( $req->customer['phone'] ?? '' ),
			'items'                       => wp_json_encode( $req->items ),
			'shipping_speed'              => $req->shipping_speed,
			'status'                      => 'new',
			'created_at'                  => $now,
		), array( '%s','%s','%s','%s','%s','%s','%s','%s','%s','%s','%s','%s','%s','%s','%s','%s' ) );

		if ( false === $result ) {
			$this->logger->error( 'MCF order insert failed', array( 'err' => $wpdb->last_error ) );
			throw new \RuntimeException( 'Could not persist MCF order: ' . $wpdb->last_error );
		}
		return (int) $wpdb->insert_id;
	}

	public function mark_submitted( int $id ): void {
		global $wpdb;
		$wpdb->update( $this->table, array(
			'status'       => 'submitted',
			'submitted_at' => current_time( 'mysql', true ),
		), array( 'id' => $id ), array( '%s', '%s' ), array( '%d' ) );
	}

	public function mark_failed( int $id, string $error ): void {
		global $wpdb;
		$wpdb->update( $this->table, array(
			'status'        => 'failed',
			'error_message' => $error,
		), array( 'id' => $id ), array( '%s', '%s' ), array( '%d' ) );
	}

	public function update_tracking( int $id, array $tracking ): void {
		global $wpdb;
		$wpdb->update( $this->table, array(
			'amazon_status'    => (string) ( $tracking['amazon_status'] ?? '' ),
			'tracking_numbers' => wp_json_encode( $tracking['tracking_numbers'] ?? array() ),
			'carrier_code'     => (string) ( $tracking['carrier_code'] ?? '' ),
			'shipped_at'       => $tracking['shipped_at']   ?: null,
			'delivered_at'     => $tracking['delivered_at'] ?: null,
			'status'           => $this->derive_local_status( $tracking ),
		), array( 'id' => $id ), array( '%s','%s','%s','%s','%s','%s' ), array( '%d' ) );
	}

	private function derive_local_status( array $tracking ): string {
		$amz = strtoupper( (string) ( $tracking['amazon_status'] ?? '' ) );
		if ( str_contains( $amz, 'COMPLETE' ) || $tracking['delivered_at'] ) return 'delivered';
		if ( $tracking['shipped_at'] || str_contains( $amz, 'SHIP' ) )       return 'shipped';
		if ( str_contains( $amz, 'CANCEL' ) )                                 return 'cancelled';
		if ( str_contains( $amz, 'PLAN' ) || str_contains( $amz, 'RECEIVED' ) ) return 'processing';
		return 'submitted';
	}

	public function find( int $id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$this->table} WHERE id = %d", $id ), ARRAY_A );
		return $row ?: null;
	}

	public function find_by_seller_order( string $seller_order_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$this->table} WHERE seller_fulfillment_order_id = %s", $seller_order_id ),
			ARRAY_A
		);
		return $row ?: null;
	}

	public function recent( int $limit = 50 ): array {
		global $wpdb;
		$rows = $wpdb->get_results( $wpdb->prepare(
			"SELECT * FROM {$this->table} ORDER BY created_at DESC LIMIT %d", $limit
		), ARRAY_A );
		return is_array( $rows ) ? $rows : array();
	}

	public function pending_tracking_refresh(): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			"SELECT * FROM {$this->table}
			 WHERE status IN ('submitted', 'processing', 'shipped')
			   AND updated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)
			 ORDER BY updated_at ASC
			 LIMIT 50",
			ARRAY_A
		);
		return is_array( $rows ) ? $rows : array();
	}

	public function count_by_status(): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			"SELECT status, COUNT(*) c FROM {$this->table} GROUP BY status", ARRAY_A
		);
		$out = array();
		foreach ( (array) $rows as $r ) $out[ (string) $r['status'] ] = (int) $r['c'];
		return $out;
	}
}
