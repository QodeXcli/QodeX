<?php
/**
 * Activator — runs on plugin activation/deactivation.
 *
 * Responsibilities:
 *   - Validate the runtime environment (PHP version, WP version, extensions)
 *   - Install/migrate the database schema via Schema class
 *   - Seed default options on first install
 *   - Schedule cron events
 *   - Self-deactivate with a clear error if environment is wrong
 *
 * @package SevenGum\Commerce\Core
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Core;

use SevenGum\Commerce\Database\Schema;

defined( 'ABSPATH' ) || exit;

final class Activator {

	private const REQUIRED_EXTENSIONS = array( 'openssl', 'curl', 'json', 'mbstring' );

	public static function activate( bool $network_wide = false ): void {
		self::check_environment();

		require_once SG_COMMERCE_DIR . 'src/Database/Schema.php';
		Schema::install();

		self::seed_defaults();
		self::seed_carton_templates();
		self::schedule_cron();

		if ( ! get_option( 'sg_commerce_installed_at' ) ) {
			update_option( 'sg_commerce_installed_at', time(), false );
		}
		update_option( 'sg_commerce_activated_at', time(), false );
	}

	public static function deactivate( bool $network_wide = false ): void {
		// Clear scheduled events. Don't drop data — uninstall.php owns that.
		$hooks = array(
			'sg_commerce_hourly_sync',
			'sg_commerce_daily_analytics',
			'sg_commerce_repricer_tick',
			'sg_commerce_competitor_scan',
			'sg_commerce_ai_queue_process',
			'sg_commerce_mcf_refresh',
			'sg_commerce_pii_purge',
			'sg_commerce_sqs_poll',
		);
		foreach ( $hooks as $hook ) {
			wp_clear_scheduled_hook( $hook );
		}
	}

	/**
	 * Hard environment check. If anything fails we self-deactivate to avoid
	 * leaving the site in a broken state.
	 */
	private static function check_environment(): void {
		$errors = array();

		if ( version_compare( PHP_VERSION, SG_COMMERCE_MIN_PHP, '<' ) ) {
			$errors[] = sprintf( 'PHP %s or higher required (you have %s).', SG_COMMERCE_MIN_PHP, PHP_VERSION );
		}

		global $wp_version;
		if ( version_compare( $wp_version, SG_COMMERCE_MIN_WP, '<' ) ) {
			$errors[] = sprintf( 'WordPress %s or higher required (you have %s).', SG_COMMERCE_MIN_WP, $wp_version );
		}

		foreach ( self::REQUIRED_EXTENSIONS as $ext ) {
			if ( ! extension_loaded( $ext ) ) {
				$errors[] = sprintf( 'PHP extension "%s" is required but not loaded.', $ext );
			}
		}

		// We need at least one of the WordPress AUTH constants for our key derivation.
		if ( ! defined( 'AUTH_KEY' ) && ! defined( 'SECURE_AUTH_KEY' ) && ! defined( 'LOGGED_IN_KEY' ) ) {
			$errors[] = 'wp-config.php must define AUTH_KEY (regenerate from https://api.wordpress.org/secret-key/1.1/salt/).';
		}

		if ( ! empty( $errors ) ) {
			deactivate_plugins( SG_COMMERCE_BASENAME );
			wp_die(
				'<h1>Seven Gum Commerce: activation blocked</h1><ul><li>' . esc_html( implode( '</li><li>', $errors ) ) . '</li></ul>',
				'Plugin activation failed',
				array( 'back_link' => true )
			);
		}
	}

	private static function seed_defaults(): void {
		$defaults = array(
			'sg_commerce_settings' => array(
				'amazon_primary_market'   => 'US',
				'amazon_enabled_markets'  => array( 'US' ),
				'ai_provider'             => 'ollama',
				'ai_default_locale'       => 'en',
				'ai_temperature'          => 0.7,
				'ai_brand_voice'          => 'modern, clean, playful but confident',
				'ollama_url'              => 'http://127.0.0.1:11434',
				'ollama_model'            => 'llama3.1:8b',
				'sync_frequency'          => 'hourly',
				'sync_pages_per_run'      => 5,
				'analytics_enabled'       => true,
				'repricer_enabled'        => false,
				'repricer_strategy'       => 'match_buybox',
				'repricer_min_margin_pct' => 15.0,
				'log_level'               => 'info',
				'log_retention_days'      => 30,
				// Fulfillment (MCF)
				'mcf_auto_wc'             => false,
				'mcf_default_market'      => 'US',
				'mcf_default_speed'       => 'Standard',
				// Injection
				'injection_enabled'       => true,
				// Geotargeting
				'geotargeting_enabled'    => true,
				// Theme bridge (v3.2)
				'theme_bridge_enabled'    => true,
				// PII compliance (v3.2)
				'pii_retention_days'      => 30,
				// SQS real-time consumer (v3.2)
				'sqs_enabled'             => false,
				'sqs_region'              => 'us-east-1',
				'sqs_queue_url'           => '',
				'sqs_access_key'          => '',
				'sqs_secret_key_enc'      => '',
				// Headless API keys (v3.2)
				'api_keys'                => array(),
				// Sandbox (v3.2)
				'sandbox_enabled'         => false,
			),
		);
		foreach ( $defaults as $key => $value ) {
			if ( false === get_option( $key, false ) ) {
				add_option( $key, $value, '', false );
			}
		}
	}

	/**
	 * Seed Seven Gum's master-carton template so operators don't have to
	 * re-enter physical measurements. Called once at activation.
	 */
	private static function seed_carton_templates(): void {
		if ( class_exists( '\\SevenGum\\Commerce\\Fulfillment\\BoxContent\\BoxContentService' ) ) {
			\SevenGum\Commerce\Fulfillment\BoxContent\BoxContentService::seed_default_template();
		}
	}

	private static function schedule_cron(): void {
		$jobs = array(
			'sg_commerce_hourly_sync'      => 'hourly',
			'sg_commerce_daily_analytics'  => 'daily',
			'sg_commerce_repricer_tick'    => 'sg_fifteen_minutes',
			'sg_commerce_competitor_scan'  => 'sg_six_hours',
			'sg_commerce_ai_queue_process' => 'sg_five_minutes',
			'sg_commerce_mcf_refresh'      => 'sg_fifteen_minutes',
			'sg_commerce_pii_purge'        => 'daily',
			'sg_commerce_sqs_poll'         => 'sg_five_minutes',
		);
		foreach ( $jobs as $hook => $recurrence ) {
			if ( ! wp_next_scheduled( $hook ) ) {
				wp_schedule_event( time() + 600, $recurrence, $hook );
			}
		}
	}
}
