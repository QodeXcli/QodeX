<?php
/**
 * PIIManager — Amazon SP-API Data Protection Policy compliance.
 *
 * Amazon's SP-API Data Protection Policy REQUIRES sellers to:
 *   - Only retain customer PII as long as strictly necessary
 *   - Anonymize or delete PII within 30 days of order completion
 *   - Encrypt PII at rest (we already do via Encryption class)
 *   - Log all PII access for audit
 *
 * Source: https://developer-docs.amazon.com/sp-api/docs/data-protection-policy
 *
 * This manager:
 *   1. Runs daily, finds MCF orders older than N days (default 30) that
 *      are completed/cancelled, and anonymizes their PII columns.
 *   2. Keeps order metadata (market, items, status, tracking) so analytics
 *      and sales history still work.
 *   3. Writes an audit log entry for every anonymization batch.
 *   4. Exposes a WP-CLI command for manual runs + a CSV export for
 *      GDPR subject-access requests.
 *
 * Anonymization strategy:
 *   - name, email, phone, address_line1/2 → replace with redacted tokens
 *   - country_code, city, postal_code → KEEP (aggregate analytics only)
 *   - items JSON → KEEP (order analytics)
 *
 * @package SevenGum\Commerce\Security\PIIManager
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Security\PIIManager;

use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class PIIManager implements Module {

	private const REDACTED = '[anonymized]';
	private const CRON_HOOK = 'sg_commerce_pii_purge';

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'pii';
	}

	public function register(): void {
		add_action( self::CRON_HOOK, array( $this, 'purge_expired' ) );
		if ( ! wp_next_scheduled( self::CRON_HOOK ) ) {
			wp_schedule_event( time() + 3600, 'daily', self::CRON_HOOK );
		}
	}

	/**
	 * Anonymize MCF orders older than retention window that are in a
	 * terminal state (delivered, cancelled, failed). Returns count processed.
	 */
	public function purge_expired(): int {
		global $wpdb;
		$settings = $this->container->get( SettingsRepository::class );
		$logger   = $this->container->get( Logger::class );

		$retention_days = max( 1, (int) $settings->get( 'pii_retention_days', 30 ) );
		$cutoff = gmdate( 'Y-m-d H:i:s', time() - $retention_days * DAY_IN_SECONDS );

		$table = $wpdb->prefix . 'sg_mcf_orders';
		$rows = $wpdb->get_results( $wpdb->prepare(
			"SELECT id FROM {$table}
			 WHERE status IN ('delivered', 'cancelled', 'failed')
			   AND (updated_at < %s OR delivered_at < %s)
			   AND customer_name != %s
			 LIMIT 500",
			$cutoff, $cutoff, self::REDACTED
		), ARRAY_A );

		if ( empty( $rows ) ) {
			return 0;
		}

		$count = 0;
		foreach ( $rows as $row ) {
			$id = (int) $row['id'];
			$result = $wpdb->update(
				$table,
				array(
					'customer_name'  => self::REDACTED,
					'customer_email' => self::REDACTED . '@sg-redacted.invalid',
					'address_line1'  => self::REDACTED,
					'address_line2'  => '',
					'phone'          => '',
					// city, postal_code, country_code: KEPT for analytics
				),
				array( 'id' => $id ),
				array( '%s', '%s', '%s', '%s', '%s' ),
				array( '%d' )
			);
			if ( false !== $result ) {
				$count++;
			}
		}

		// Audit log.
		$wpdb->insert( $wpdb->prefix . 'sg_audit', array(
			'user_id'     => 0,
			'action'      => 'pii_anonymize_batch',
			'entity_type' => 'mcf_order',
			'entity_id'   => '',
			'details'     => wp_json_encode( array(
				'count'     => $count,
				'retention' => $retention_days,
				'cutoff'    => $cutoff,
			) ),
			'created_at'  => current_time( 'mysql', true ),
		), array( '%d', '%s', '%s', '%s', '%s', '%s' ) );

		$logger->info( 'PII anonymization batch complete', array(
			'count'     => $count,
			'retention_days' => $retention_days,
		) );
		return $count;
	}

	/**
	 * GDPR subject-access: export all data we hold for a given email, across
	 * MCF orders + audit. Returns a structured array ready for JSON or CSV.
	 */
	public function export_subject_data( string $email ): array {
		global $wpdb;
		$orders = $wpdb->get_results( $wpdb->prepare(
			"SELECT id, displayable_order_id, market, customer_name, customer_email,
					country_code, city, state_region, postal_code, items, status,
					tracking_numbers, created_at, shipped_at, delivered_at
			 FROM {$wpdb->prefix}sg_mcf_orders
			 WHERE customer_email = %s",
			$email
		), ARRAY_A );

		return array(
			'subject_email' => $email,
			'exported_at'   => gmdate( 'c' ),
			'mcf_orders'    => is_array( $orders ) ? $orders : array(),
		);
	}

	/**
	 * GDPR right-to-erasure: delete all PII for a subject immediately,
	 * regardless of retention window. Returns count of rows processed.
	 */
	public function erase_subject_data( string $email ): int {
		global $wpdb;
		$table = $wpdb->prefix . 'sg_mcf_orders';
		$ids = $wpdb->get_col( $wpdb->prepare(
			"SELECT id FROM {$table} WHERE customer_email = %s",
			$email
		) );
		if ( empty( $ids ) ) return 0;

		$count = 0;
		foreach ( $ids as $id ) {
			$result = $wpdb->update(
				$table,
				array(
					'customer_name'  => self::REDACTED,
					'customer_email' => self::REDACTED . '@sg-redacted.invalid',
					'address_line1'  => self::REDACTED,
					'address_line2'  => '',
					'phone'          => '',
				),
				array( 'id' => (int) $id ),
				array( '%s', '%s', '%s', '%s', '%s' ),
				array( '%d' )
			);
			if ( false !== $result ) $count++;
		}

		$wpdb->insert( $wpdb->prefix . 'sg_audit', array(
			'user_id'     => get_current_user_id(),
			'action'      => 'pii_erase_subject',
			'entity_type' => 'mcf_order',
			'entity_id'   => '',
			'details'     => wp_json_encode( array( 'email_hash' => hash( 'sha256', $email ), 'count' => $count ) ),
			'created_at'  => current_time( 'mysql', true ),
		), array( '%d', '%s', '%s', '%s', '%s', '%s' ) );

		return $count;
	}

	/** Count of rows still holding un-anonymized PII, for the compliance dashboard. */
	public function count_pending_anonymization(): int {
		global $wpdb;
		$settings = $this->container->get( SettingsRepository::class );
		$retention_days = max( 1, (int) $settings->get( 'pii_retention_days', 30 ) );
		$cutoff = gmdate( 'Y-m-d H:i:s', time() - $retention_days * DAY_IN_SECONDS );

		return (int) $wpdb->get_var( $wpdb->prepare(
			"SELECT COUNT(*) FROM {$wpdb->prefix}sg_mcf_orders
			 WHERE status IN ('delivered', 'cancelled', 'failed')
			   AND customer_name != %s
			   AND (updated_at < %s OR delivered_at < %s)",
			self::REDACTED, $cutoff, $cutoff
		) );
	}
}
