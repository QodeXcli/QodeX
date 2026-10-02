<?php
/**
 * AutomationModule — registers rule listeners and seeds defaults.
 *
 * @package SevenGum\Commerce\Automation
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Automation;

use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;

defined( 'ABSPATH' ) || exit;

final class AutomationModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'automation';
	}

	public function register(): void {
		$this->container->get( RulesEngine::class )->attach_listeners();
		add_action( 'init', array( $this, 'seed_default_rules' ), 20 );
	}

	public function seed_default_rules(): void {
		if ( get_option( 'sg_commerce_default_rules_seeded' ) ) {
			return;
		}
		global $wpdb;
		$now = current_time( 'mysql', true );

		$wpdb->insert( $wpdb->prefix . 'sg_rules', array(
			'name'          => 'Low stock alert',
			'trigger_event' => 'product.synced',
			'conditions'    => wp_json_encode( array(
				array( 'field' => 'fulfillable_qty', 'op' => '<=', 'value' => 5 ),
			) ),
			'actions'       => wp_json_encode( array(
				array( 'type' => 'create_alert', 'params' => array(
					'level'    => 'warning',
					'category' => 'stock',
					'title'    => 'Low stock',
					'message'  => 'A product has 5 or fewer units left.',
				) ),
			) ),
			'is_active'  => 1,
			'created_at' => $now,
			'updated_at' => $now,
		) );

		$wpdb->insert( $wpdb->prefix . 'sg_rules', array(
			'name'          => 'Lost Buy Box',
			'trigger_event' => 'product.synced',
			'conditions'    => wp_json_encode( array(
				array( 'field' => 'buybox_is_mine', 'op' => '=', 'value' => 0 ),
			) ),
			'actions'       => wp_json_encode( array(
				array( 'type' => 'create_alert', 'params' => array(
					'level'    => 'warning',
					'category' => 'buybox',
					'title'    => 'Lost Buy Box',
					'message'  => 'A competitor took the Buy Box.',
				) ),
			) ),
			'is_active'  => 0, // off by default — too noisy to enable for everyone
			'created_at' => $now,
			'updated_at' => $now,
		) );

		update_option( 'sg_commerce_default_rules_seeded', time(), false );
	}
}
