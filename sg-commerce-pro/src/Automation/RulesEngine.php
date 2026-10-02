<?php
/**
 * RulesEngine — operator-defined automation rules.
 *
 * Each rule:
 *   trigger_event   one of our domain events (e.g. 'product.synced')
 *   conditions      JSON: list of {field, op, value} clauses, AND'ed
 *   actions         JSON: list of {type, params} to execute
 *
 * Supported actions in v3.0:
 *   create_alert        push a row into wp_sg_alerts
 *   email_admin         send wp_mail to the configured address
 *   queue_describe      enqueue an AI describe job
 *   queue_translate     enqueue an AI translate job for given market
 *
 * Operator UI for creating rules ships in v3.1 — for v3.0 we ship the
 * engine + a few seed rules (low stock alert, lost buybox alert).
 *
 * @package SevenGum\Commerce\Automation
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Automation;

use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Events\EventDispatcher;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class RulesEngine {

	public function __construct(
		private SettingsRepository $settings,
		private EventDispatcher $events,
		private Logger $logger,
	) {}

	public function attach_listeners(): void {
		// Listen on product.synced for stock + buybox rules.
		$this->events->after( 'product.synced', function ( array $payload ): void {
			$this->run_for_event( 'product.synced', $payload );
		} );
	}

	private function run_for_event( string $event, array $payload ): void {
		global $wpdb;
		$rules = $wpdb->get_results( $wpdb->prepare(
			"SELECT * FROM {$wpdb->prefix}sg_rules WHERE trigger_event = %s AND is_active = 1",
			$event
		), ARRAY_A );
		if ( empty( $rules ) ) {
			return;
		}

		// Hydrate the product if the event references an id.
		$product = null;
		if ( ! empty( $payload['product_id'] ) ) {
			$product = $wpdb->get_row( $wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}sg_products WHERE id = %d",
				(int) $payload['product_id']
			), ARRAY_A );
		}

		foreach ( $rules as $rule ) {
			$conditions = json_decode( (string) $rule['conditions'], true ) ?: array();
			if ( ! $this->conditions_match( $conditions, $product ?? array() ) ) {
				continue;
			}
			$actions = json_decode( (string) $rule['actions'], true ) ?: array();
			foreach ( $actions as $action ) {
				$this->execute_action( $action, $product ?? array(), (int) $rule['id'] );
			}
			$wpdb->query( $wpdb->prepare(
				"UPDATE {$wpdb->prefix}sg_rules SET run_count = run_count + 1, last_run_at = %s WHERE id = %d",
				current_time( 'mysql', true ),
				(int) $rule['id']
			) );
		}
	}

	private function conditions_match( array $conditions, array $product ): bool {
		foreach ( $conditions as $c ) {
			$field = (string) ( $c['field'] ?? '' );
			$op    = (string) ( $c['op']    ?? '=' );
			$value = $c['value'] ?? null;
			$actual = $product[ $field ] ?? null;
			$pass = match ( $op ) {
				'='  => (string) $actual === (string) $value,
				'!=' => (string) $actual !== (string) $value,
				'<'  => is_numeric( $actual ) && $actual < $value,
				'<=' => is_numeric( $actual ) && $actual <= $value,
				'>'  => is_numeric( $actual ) && $actual > $value,
				'>=' => is_numeric( $actual ) && $actual >= $value,
				default => false,
			};
			if ( ! $pass ) return false;
		}
		return true;
	}

	private function execute_action( array $action, array $product, int $rule_id ): void {
		$type = (string) ( $action['type'] ?? '' );
		$params = (array) ( $action['params'] ?? array() );
		try {
			match ( $type ) {
				'create_alert'    => $this->action_create_alert( $params, $product ),
				'email_admin'     => $this->action_email( $params, $product ),
				'queue_describe'  => $this->action_queue_describe( $product ),
				'queue_translate' => $this->action_queue_translate( $params, $product ),
				default => $this->logger->warning( "unknown rule action: {$type}" ),
			};
		} catch ( \Throwable $e ) {
			$this->logger->error( "rule action {$type} failed: " . $e->getMessage(), array( 'rule_id' => $rule_id ) );
		}
	}

	private function action_create_alert( array $params, array $product ): void {
		AlertDispatcher::create(
			(string) ( $params['level']    ?? 'info' ),
			(string) ( $params['category'] ?? 'rule' ),
			(string) ( $params['title']    ?? 'Rule fired' ),
			(string) ( $params['message']  ?? '' ),
			$product,
			isset( $product['id'] ) ? (int) $product['id'] : null
		);
	}

	private function action_email( array $params, array $product ): void {
		$to = (string) ( $params['to'] ?? get_option( 'admin_email' ) );
		$subject = (string) ( $params['subject'] ?? 'Seven Gum Commerce alert' );
		$body = (string) ( $params['body'] ?? '' );
		// Simple {{field}} placeholder substitution.
		foreach ( $product as $k => $v ) {
			if ( is_scalar( $v ) ) {
				$body = str_replace( '{{' . $k . '}}', (string) $v, $body );
				$subject = str_replace( '{{' . $k . '}}', (string) $v, $subject );
			}
		}
		wp_mail( $to, $subject, $body );
	}

	private function action_queue_describe( array $product ): void {
		if ( empty( $product['id'] ) ) return;
		wp_schedule_single_event( time() + 5, 'sg_commerce_ai_describe', array( array( 'product_id' => (int) $product['id'] ) ) );
	}

	private function action_queue_translate( array $params, array $product ): void {
		if ( empty( $product['id'] ) || empty( $params['market'] ) ) return;
		wp_schedule_single_event( time() + 10, 'sg_commerce_ai_translate', array( array(
			'product_id' => (int) $product['id'],
			'market'     => (string) $params['market'],
		) ) );
	}
}
