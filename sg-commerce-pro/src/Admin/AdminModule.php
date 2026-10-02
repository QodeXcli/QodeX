<?php
/**
 * AdminModule — wp-admin UI.
 *
 * Pages:
 *   sg-commerce              Dashboard + onboarding + KPIs
 *   sg-commerce-products     Product list (paginated, searchable)
 *   sg-commerce-amazon       Amazon credentials + test
 *   sg-commerce-ai           AI provider settings + connection test + prompt preview
 *   sg-commerce-widgets      Per-product shortcode generator
 *   sg-commerce-analytics    Analytics + buy box trend
 *   sg-commerce-automation   Rules + alerts
 *   sg-commerce-repricer     Repricer config + recent activity
 *   sg-commerce-logs         Recent log lines
 *   sg-commerce-settings     General settings
 *
 * All forms POST to admin-post.php with nonces.
 *
 * @package SevenGum\Commerce\Admin
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Admin;

use SevenGum\Commerce\AI\Copywriter;
use SevenGum\Commerce\AI\Providers\OllamaProvider;
use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Amazon\SyncOrchestrator;
use SevenGum\Commerce\Analytics\SalesAggregator;
use SevenGum\Commerce\Automation\AlertDispatcher;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Repricer\RepricerEngine;

defined( 'ABSPATH' ) || exit;

final class AdminModule implements Module {

	public const MENU = 'sg-commerce';
	public const NONCE = '_sg_nonce';
	public const CAP = 'manage_options';

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'admin';
	}

	public function register(): void {
		add_action( 'admin_menu', array( $this, 'register_menu' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_assets' ) );

		// Action handlers — dispatched via admin-post.
		$handlers = array(
			'sg_save_amazon'         => 'handle_save_amazon',
			'sg_test_amazon'         => 'handle_test_amazon',
			'sg_sync_amazon'         => 'handle_sync_amazon',
			'sg_save_ai'             => 'handle_save_ai',
			'sg_test_ai'             => 'handle_test_ai',
			'sg_describe_product'    => 'handle_describe_product',
			'sg_translate_product'   => 'handle_translate_product',
			'sg_add_product'         => 'handle_add_product',
			'sg_delete_product'      => 'handle_delete_product',
			'sg_update_cost'         => 'handle_update_cost',
			'sg_save_settings'       => 'handle_save_settings',
			'sg_save_repricer'       => 'handle_save_repricer',
			'sg_run_repricer'        => 'handle_run_repricer',
			'sg_clear_secret'        => 'handle_clear_secret',
			'sg_mark_alerts_read'    => 'handle_mark_alerts_read',
			'sg_toggle_rule'         => 'handle_toggle_rule',
			// MCF
			'sg_save_mcf'            => 'handle_save_mcf',
			'sg_cancel_mcf'          => 'handle_cancel_mcf',
			'sg_refresh_mcf'         => 'handle_refresh_mcf',
			// Injection
			'sg_add_injection_rule'  => 'handle_add_injection_rule',
			'sg_toggle_injection'    => 'handle_toggle_injection',
			'sg_delete_injection'    => 'handle_delete_injection',
			'sg_save_injection_settings' => 'handle_save_injection_settings',
			// Comparisons
			'sg_add_comparison'      => 'handle_add_comparison',
			'sg_delete_comparison'   => 'handle_delete_comparison',
			// v3.2: PII
			'sg_pii_purge_now'       => 'handle_pii_purge_now',
			'sg_pii_save_settings'   => 'handle_pii_save_settings',
			'sg_pii_erase_subject'   => 'handle_pii_erase_subject',
			// v3.2: Settlements
			'sg_settlement_upload'   => 'handle_settlement_upload',
			// v3.2: API keys
			'sg_mint_api_key'        => 'handle_mint_api_key',
			'sg_revoke_api_key'      => 'handle_revoke_api_key',
			// v3.2: Sandbox + SQS
			'sg_toggle_sandbox'      => 'handle_toggle_sandbox',
			'sg_save_sqs'            => 'handle_save_sqs',
			'sg_test_sqs'            => 'handle_test_sqs',
			// v3.2: Theme bridge
			'sg_theme_resync'        => 'handle_theme_resync',
			// v3.3: Inbound plans
			'sg_inbound_create'      => 'handle_inbound_create',
		);
		foreach ( $handlers as $action => $method ) {
			add_action( "admin_post_{$action}", array( $this, $method ) );
		}
	}

	/* -------------------------------------------------- */
	/* Menu                                               */
	/* -------------------------------------------------- */

	public function register_menu(): void {
		$unread = AlertDispatcher::unread_count();
		$badge = $unread > 0 ? sprintf( ' <span class="update-plugins count-%d"><span class="plugin-count">%d</span></span>', $unread, $unread ) : '';

		add_menu_page(
			'Seven Gum Commerce',
			'Seven Gum' . $badge,
			self::CAP,
			self::MENU,
			array( $this, 'render_dashboard' ),
			'dashicons-cart',
			56
		);

		$pages = array(
			array( '',             'Dashboard',      'render_dashboard' ),
			array( '-products',    'Products',       'render_products' ),
			array( '-amazon',      'Amazon Connect', 'render_amazon' ),
			array( '-ai',          'AI (Ollama)',    'render_ai' ),
			array( '-analytics',   'Analytics',      'render_analytics' ),
			array( '-repricer',    'Repricer',       'render_repricer' ),
			array( '-automation',  'Automation',     'render_automation' ),
			array( '-fulfillment', 'Fulfillment',    'render_fulfillment' ),
			array( '-inbound',     'Inbound Plans',  'render_inbound_plans' ),
			array( '-catalog',     'Catalog Lookup', 'render_catalog_lookup' ),
			array( '-injection',   'Auto-Injection', 'render_injection' ),
			array( '-comparisons', 'Comparisons',    'render_comparisons' ),
			array( '-widgets',     'Widgets',        'render_widgets' ),
			array( '-theme-bridge','Theme Bridge',   'render_theme_bridge' ),
			array( '-pii',         'PII Compliance', 'render_pii' ),
			array( '-settlements', 'Settlements',    'render_settlements' ),
			array( '-api-keys',    'API Keys',       'render_api_keys' ),
			array( '-logs',        'Logs',           'render_logs' ),
			array( '-settings',    'Settings',       'render_settings' ),
		);
		foreach ( $pages as $p ) {
			add_submenu_page( self::MENU, $p[1], $p[1], self::CAP, self::MENU . $p[0], array( $this, $p[2] ) );
		}
	}

	public function enqueue_assets( string $hook ): void {
		if ( ! str_contains( $hook, self::MENU ) ) {
			return;
		}
		wp_enqueue_style( 'sg-commerce-admin', SG_COMMERCE_URL . 'assets/css/admin.css', array(), SG_COMMERCE_VERSION );
		wp_enqueue_script( 'sg-commerce-admin', SG_COMMERCE_URL . 'assets/js/admin.js', array( 'jquery' ), SG_COMMERCE_VERSION, true );
	}

	/* -------------------------------------------------- */
	/* Views — each delegates to a partial                */
	/* -------------------------------------------------- */

	public function render_dashboard(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/dashboard.php';
	}
	public function render_products(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/products.php';
	}
	public function render_amazon(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/amazon.php';
	}
	public function render_ai(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/ai.php';
	}
	public function render_analytics(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/analytics.php';
	}
	public function render_repricer(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/repricer.php';
	}
	public function render_automation(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/automation.php';
	}
	public function render_widgets(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/widgets.php';
	}
	public function render_fulfillment(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/fulfillment.php';
	}
	public function render_injection(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/injection.php';
	}
	public function render_comparisons(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/comparisons.php';
	}
	public function render_theme_bridge(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/theme-bridge.php';
	}
	public function render_pii(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/pii.php';
	}
	public function render_settlements(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/settlements.php';
	}
	public function render_api_keys(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/api-keys.php';
	}
	public function render_inbound_plans(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/inbound-plans.php';
	}
	public function render_catalog_lookup(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/catalog-lookup.php';
	}
	public function render_logs(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/logs.php';
	}
	public function render_settings(): void {
		$container = $this->container;
		require SG_COMMERCE_DIR . 'admin/views/settings.php';
	}

	/* -------------------------------------------------- */
	/* Handlers                                           */
	/* -------------------------------------------------- */

	public function handle_save_amazon(): void {
		$this->verify( 'sg_save_amazon' );
		$settings = $this->container->get( SettingsRepository::class );

		if ( ! empty( $_POST['amazon_client_id'] ) ) {
			$settings->set( 'amazon_client_id', sanitize_text_field( wp_unslash( (string) $_POST['amazon_client_id'] ) ) );
		}
		if ( ! empty( $_POST['amazon_client_secret'] ) ) {
			$settings->set( 'amazon_client_secret', wp_unslash( (string) $_POST['amazon_client_secret'] ) );
		}
		if ( ! empty( $_POST['amazon_refresh_token'] ) ) {
			$settings->set( 'amazon_refresh_token', wp_unslash( (string) $_POST['amazon_refresh_token'] ) );
		}
		if ( isset( $_POST['amazon_seller_id'] ) ) {
			$settings->set( 'amazon_seller_id', sanitize_text_field( wp_unslash( (string) $_POST['amazon_seller_id'] ) ) );
		}
		$primary = strtoupper( sanitize_text_field( wp_unslash( (string) ( $_POST['amazon_primary_market'] ?? 'US' ) ) ) );
		$markets = isset( $_POST['amazon_enabled_markets'] ) && is_array( $_POST['amazon_enabled_markets'] )
			? array_map( 'sanitize_text_field', wp_unslash( (array) $_POST['amazon_enabled_markets'] ) )
			: array( 'US' );

		$settings->update_many( array(
			'amazon_primary_market'  => $primary,
			'amazon_enabled_markets' => array_values( array_unique( $markets ) ),
		) );

		$this->container->get( \SevenGum\Commerce\Amazon\LWATokenManager::class )->clear_cache();
		$this->flash( 'success', __( 'Amazon credentials saved.', 'sg-commerce' ) );
		$this->redirect( 'amazon' );
	}

	public function handle_test_amazon(): void {
		$this->verify( 'sg_test_amazon' );
		try {
			$result = $this->container->get( AmazonClient::class )->test_connection();
			$this->flash( 'success', sprintf(
				__( 'Amazon accepted us. Seller account participates in %d marketplace(s).', 'sg-commerce' ),
				(int) $result['participations']
			) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', $e->getMessage() );
		}
		$this->redirect( 'amazon' );
	}

	public function handle_sync_amazon(): void {
		$this->verify( 'sg_sync_amazon' );
		$market = strtoupper( sanitize_text_field( wp_unslash( (string) ( $_POST['market'] ?? '' ) ) ) );
		try {
			$orchestrator = $this->container->get( SyncOrchestrator::class );
			if ( '' === $market ) {
				$result = $orchestrator->sync_all();
				$msg = sprintf(
					__( 'Synced %d products across %d markets.', 'sg-commerce' ),
					(int) $result['total'],
					count( $result['by_market'] )
				);
				if ( ! empty( $result['errors'] ) ) {
					$msg .= ' ' . __( 'Errors:', 'sg-commerce' ) . ' ' . implode( '; ', array_map(
						static fn( $m, $e ) => "{$m}: {$e}",
						array_keys( $result['errors'] ),
						array_values( $result['errors'] )
					) );
				}
			} else {
				$summary = $orchestrator->sync_market( $market );
				$msg = sprintf( __( 'Synced %d products from %s.', 'sg-commerce' ), (int) $summary['rows'], $market );
			}
			$this->flash( 'success', $msg );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', __( 'Sync failed:', 'sg-commerce' ) . ' ' . $e->getMessage() );
		}
		$this->redirect( 'products' );
	}

	public function handle_save_ai(): void {
		$this->verify( 'sg_save_ai' );
		$settings = $this->container->get( SettingsRepository::class );

		$settings->update_many( array(
			'ai_provider'      => sanitize_text_field( wp_unslash( (string) ( $_POST['ai_provider'] ?? 'ollama' ) ) ),
			'ollama_url'       => esc_url_raw( wp_unslash( (string) ( $_POST['ollama_url'] ?? 'http://127.0.0.1:11434' ) ) ),
			'ollama_model'     => sanitize_text_field( wp_unslash( (string) ( $_POST['ollama_model'] ?? 'llama3.1:8b' ) ) ),
			'ai_temperature'   => max( 0.0, min( 2.0, (float) ( $_POST['ai_temperature'] ?? 0.7 ) ) ),
			'ai_brand_voice'   => sanitize_textarea_field( wp_unslash( (string) ( $_POST['ai_brand_voice'] ?? '' ) ) ),
		) );

		if ( ! empty( $_POST['ollama_auth_token'] ) ) {
			$settings->set( 'ollama_auth_token', wp_unslash( (string) $_POST['ollama_auth_token'] ) );
		}

		$this->flash( 'success', __( 'AI settings saved.', 'sg-commerce' ) );
		$this->redirect( 'ai' );
	}

	public function handle_test_ai(): void {
		$this->verify( 'sg_test_ai' );
		try {
			$models = $this->container->get( OllamaProvider::class )->list_models();
			$names = array_map( static fn( $m ) => $m['name'], $models );
			$this->flash( 'success', sprintf(
				__( 'Ollama is reachable. %d model(s) installed: %s', 'sg-commerce' ),
				count( $names ),
				'' !== implode( ', ', $names ) ? implode( ', ', $names ) : '(none — run: ollama pull llama3.1:8b)'
			) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', $e->getMessage() );
		}
		$this->redirect( 'ai' );
	}

	public function handle_describe_product(): void {
		$this->verify( 'sg_describe_product' );
		$id = (int) ( $_POST['id'] ?? 0 );
		try {
			$this->container->get( Copywriter::class )->describe( $id );
			$this->flash( 'success', sprintf( __( 'Generated English description for product #%d.', 'sg-commerce' ), $id ) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', __( 'AI failed:', 'sg-commerce' ) . ' ' . $e->getMessage() );
		}
		$this->redirect( 'products' );
	}

	public function handle_translate_product(): void {
		$this->verify( 'sg_translate_product' );
		$id     = (int) ( $_POST['id'] ?? 0 );
		$market = strtoupper( sanitize_text_field( wp_unslash( (string) ( $_POST['target_market'] ?? '' ) ) ) );
		try {
			$this->container->get( Copywriter::class )->translate( $id, $market );
			$this->flash( 'success', sprintf( __( 'Translated product #%d for market %s.', 'sg-commerce' ), $id, $market ) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', __( 'Translation failed:', 'sg-commerce' ) . ' ' . $e->getMessage() );
		}
		$this->redirect( 'products' );
	}

	public function handle_add_product(): void {
		$this->verify( 'sg_add_product' );
		$sku = strtoupper( preg_replace( '/[^A-Z0-9_\-\.]/i', '', wp_unslash( (string) ( $_POST['sku'] ?? '' ) ) ) );
		if ( '' === $sku ) {
			$this->flash( 'error', __( 'SKU is required.', 'sg-commerce' ) );
			$this->redirect( 'products' );
			return;
		}
		try {
			$this->container->get( ProductRepository::class )->add_manual( array(
				'market'       => sanitize_text_field( wp_unslash( (string) ( $_POST['market'] ?? 'US' ) ) ),
				'sku'          => $sku,
				'asin'         => preg_replace( '/[^A-Z0-9]/', '', wp_unslash( (string) ( $_POST['asin'] ?? '' ) ) ),
				'product_name' => sanitize_text_field( wp_unslash( (string) ( $_POST['product_name'] ?? '' ) ) ),
				'image_url'    => esc_url_raw( wp_unslash( (string) ( $_POST['image_url'] ?? '' ) ) ),
				'cost_price'   => isset( $_POST['cost_price'] ) && '' !== $_POST['cost_price'] ? (float) $_POST['cost_price'] : null,
			) );
			$this->flash( 'success', __( 'Product added.', 'sg-commerce' ) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', $e->getMessage() );
		}
		$this->redirect( 'products' );
	}

	public function handle_delete_product(): void {
		$this->verify( 'sg_delete_product' );
		$id = (int) ( $_POST['id'] ?? 0 );
		if ( $id > 0 ) {
			$this->container->get( ProductRepository::class )->delete( $id );
			$this->flash( 'success', __( 'Product removed.', 'sg-commerce' ) );
		}
		$this->redirect( 'products' );
	}

	public function handle_update_cost(): void {
		$this->verify( 'sg_update_cost' );
		$id   = (int) ( $_POST['id'] ?? 0 );
		$cost = (float) ( $_POST['cost'] ?? 0 );
		if ( $id > 0 && $cost > 0 ) {
			$this->container->get( ProductRepository::class )->update_cost( $id, $cost );
			$this->flash( 'success', __( 'Cost updated.', 'sg-commerce' ) );
		}
		$this->redirect( 'products' );
	}

	public function handle_save_settings(): void {
		$this->verify( 'sg_save_settings' );
		$settings = $this->container->get( SettingsRepository::class );
		$settings->update_many( array(
			'log_level'              => sanitize_text_field( wp_unslash( (string) ( $_POST['log_level'] ?? 'info' ) ) ),
			'log_retention_days'     => max( 1, (int) ( $_POST['log_retention_days'] ?? 30 ) ),
			'sync_pages_per_run'     => max( 1, min( 50, (int) ( $_POST['sync_pages_per_run'] ?? 5 ) ) ),
			'referral_fee_pct'       => max( 0.0, min( 50.0, (float) ( $_POST['referral_fee_pct'] ?? 15.0 ) ) ),
			'fba_pick_pack_fee'      => max( 0.0, (float) ( $_POST['fba_pick_pack_fee'] ?? 3.0 ) ),
		) );
		$this->flash( 'success', __( 'Settings saved.', 'sg-commerce' ) );
		$this->redirect( 'settings' );
	}

	public function handle_save_repricer(): void {
		$this->verify( 'sg_save_repricer' );
		$settings = $this->container->get( SettingsRepository::class );
		$settings->update_many( array(
			'repricer_enabled'           => ! empty( $_POST['repricer_enabled'] ),
			'repricer_strategy'          => sanitize_text_field( wp_unslash( (string) ( $_POST['repricer_strategy'] ?? 'match_buybox' ) ) ),
			'repricer_dry_run'           => ! empty( $_POST['repricer_dry_run'] ),
			'repricer_cents_below_buybox'=> max( 0.0, (float) ( $_POST['repricer_cents_below_buybox'] ?? 0.01 ) ),
			'repricer_min_margin_pct'    => max( 0.0, min( 100.0, (float) ( $_POST['repricer_min_margin_pct'] ?? 15.0 ) ) ),
		) );
		$this->flash( 'success', __( 'Repricer settings saved.', 'sg-commerce' ) );
		$this->redirect( 'repricer' );
	}

	public function handle_run_repricer(): void {
		$this->verify( 'sg_run_repricer' );
		try {
			$result = $this->container->get( RepricerEngine::class )->tick();
			$this->flash( 'success', sprintf(
				__( 'Repricer ran. Adjusted %d, skipped %d (margin floor).', 'sg-commerce' ),
				(int) ( $result['adjusted'] ?? 0 ),
				(int) ( $result['skipped_floor'] ?? 0 )
			) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', $e->getMessage() );
		}
		$this->redirect( 'repricer' );
	}

	public function handle_clear_secret(): void {
		$this->verify( 'sg_clear_secret' );
		$key = sanitize_key( (string) ( $_POST['secret'] ?? '' ) );
		if ( '' !== $key ) {
			$this->container->get( SettingsRepository::class )->delete( $key );
			$this->flash( 'success', __( 'Secret cleared.', 'sg-commerce' ) );
		}
		$page = sanitize_key( (string) ( $_POST['return'] ?? 'amazon' ) );
		$this->redirect( $page );
	}

	public function handle_mark_alerts_read(): void {
		$this->verify( 'sg_mark_alerts_read' );
		$count = AlertDispatcher::mark_all_read();
		$this->flash( 'success', sprintf( __( '%d alert(s) marked as read.', 'sg-commerce' ), $count ) );
		$this->redirect( 'automation' );
	}

	public function handle_toggle_rule(): void {
		$this->verify( 'sg_toggle_rule' );
		$id = (int) ( $_POST['id'] ?? 0 );
		if ( $id > 0 ) {
			global $wpdb;
			$wpdb->query( $wpdb->prepare(
				"UPDATE {$wpdb->prefix}sg_rules SET is_active = 1 - is_active WHERE id = %d",
				$id
			) );
		}
		$this->redirect( 'automation' );
	}

	/* -------------------- MCF handlers -------------------- */

	public function handle_save_mcf(): void {
		$this->verify( 'sg_save_mcf' );
		$this->container->get( \SevenGum\Commerce\Database\Repositories\SettingsRepository::class )->update_many( array(
			'mcf_auto_wc'        => ! empty( $_POST['mcf_auto_wc'] ),
			'mcf_default_market' => strtoupper( sanitize_text_field( wp_unslash( (string) ( $_POST['mcf_default_market'] ?? 'US' ) ) ) ),
			'mcf_default_speed'  => sanitize_text_field( wp_unslash( (string) ( $_POST['mcf_default_speed'] ?? 'Standard' ) ) ),
		) );
		$this->flash( 'success', __( 'Fulfillment settings saved.', 'sg-commerce' ) );
		$this->redirect( 'fulfillment' );
	}

	public function handle_cancel_mcf(): void {
		$this->verify( 'sg_cancel_mcf' );
		$id = (int) ( $_POST['id'] ?? 0 );
		try {
			$repo = $this->container->get( \SevenGum\Commerce\Fulfillment\MCFOrderRepository::class );
			$row = $repo->find( $id );
			if ( null === $row ) throw new \RuntimeException( 'MCF order not found.' );
			$this->container->get( \SevenGum\Commerce\Fulfillment\MCFClient::class )
				->cancel( (string) $row['market'], (string) $row['seller_fulfillment_order_id'] );
			global $wpdb;
			$wpdb->update( $wpdb->prefix . 'sg_mcf_orders', array( 'status' => 'cancelled' ), array( 'id' => $id ) );
			$this->flash( 'success', __( 'MCF order cancellation requested.', 'sg-commerce' ) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', $e->getMessage() );
		}
		$this->redirect( 'fulfillment' );
	}

	public function handle_refresh_mcf(): void {
		$this->verify( 'sg_refresh_mcf' );
		try {
			$fulfillment = $this->container->get( \SevenGum\Commerce\Fulfillment\FulfillmentModule::class );
			$fulfillment->refresh_pending_tracking();
			$this->flash( 'success', __( 'MCF tracking refreshed.', 'sg-commerce' ) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', $e->getMessage() );
		}
		$this->redirect( 'fulfillment' );
	}

	/* -------------------- Injection handlers -------------------- */

	public function handle_add_injection_rule(): void {
		$this->verify( 'sg_add_injection_rule' );
		global $wpdb;
		$pattern = sanitize_text_field( wp_unslash( (string) ( $_POST['pattern'] ?? '' ) ) );
		$sku     = sanitize_text_field( wp_unslash( (string) ( $_POST['sku'] ?? '' ) ) );
		if ( '' === $pattern || '' === $sku ) {
			$this->flash( 'error', __( 'Pattern and SKU are required.', 'sg-commerce' ) );
			$this->redirect( 'injection' );
			return;
		}
		$result = $wpdb->insert( $wpdb->prefix . 'sg_injection_rules', array(
			'pattern'      => $pattern,
			'pattern_type' => in_array( (string) ( $_POST['pattern_type'] ?? 'keyword' ), array( 'keyword', 'regex' ), true )
				? (string) $_POST['pattern_type'] : 'keyword',
			'sku'          => $sku,
			'market'       => strtoupper( sanitize_text_field( wp_unslash( (string) ( $_POST['market'] ?? '' ) ) ) ),
			'render_as'    => in_array( (string) ( $_POST['render_as'] ?? 'link' ), array( 'link', 'widget', 'tooltip' ), true )
				? (string) $_POST['render_as'] : 'link',
			'priority'     => max( 1, (int) ( $_POST['priority'] ?? 10 ) ),
			'max_per_post' => max( 1, (int) ( $_POST['max_per_post'] ?? 1 ) ),
			'is_active'    => 1,
			'created_at'   => current_time( 'mysql', true ),
		), array( '%s', '%s', '%s', '%s', '%s', '%d', '%d', '%d', '%s' ) );
		if ( false === $result ) {
			$this->flash( 'error', __( 'Could not save rule.', 'sg-commerce' ) );
		} else {
			$this->flash( 'success', __( 'Injection rule added.', 'sg-commerce' ) );
		}
		$this->redirect( 'injection' );
	}

	public function handle_toggle_injection(): void {
		$this->verify( 'sg_toggle_injection' );
		$id = (int) ( $_POST['id'] ?? 0 );
		if ( $id > 0 ) {
			global $wpdb;
			$wpdb->query( $wpdb->prepare(
				"UPDATE {$wpdb->prefix}sg_injection_rules SET is_active = 1 - is_active WHERE id = %d",
				$id
			) );
		}
		$this->redirect( 'injection' );
	}

	public function handle_delete_injection(): void {
		$this->verify( 'sg_delete_injection' );
		$id = (int) ( $_POST['id'] ?? 0 );
		if ( $id > 0 ) {
			global $wpdb;
			$wpdb->delete( $wpdb->prefix . 'sg_injection_rules', array( 'id' => $id ), array( '%d' ) );
			$this->flash( 'success', __( 'Rule removed.', 'sg-commerce' ) );
		}
		$this->redirect( 'injection' );
	}

	public function handle_save_injection_settings(): void {
		$this->verify( 'sg_save_injection_settings' );
		$this->container->get( \SevenGum\Commerce\Database\Repositories\SettingsRepository::class )
			->set( 'injection_enabled', ! empty( $_POST['injection_enabled'] ) );
		$this->flash( 'success', __( 'Injection settings saved. Note: re-enable may require a plugin reload.', 'sg-commerce' ) );
		$this->redirect( 'injection' );
	}

	/* -------------------- Comparisons handlers -------------------- */

	public function handle_add_comparison(): void {
		$this->verify( 'sg_add_comparison' );
		global $wpdb;
		$slug  = sanitize_key( (string) ( $_POST['slug'] ?? '' ) );
		$title = sanitize_text_field( wp_unslash( (string) ( $_POST['title'] ?? '' ) ) );
		$skus_raw = (string) ( $_POST['skus'] ?? '' );
		$skus = array_filter( array_map( 'trim', explode( ',', $skus_raw ) ) );
		if ( '' === $slug || empty( $skus ) ) {
			$this->flash( 'error', __( 'Slug and at least one SKU required.', 'sg-commerce' ) );
			$this->redirect( 'comparisons' );
			return;
		}
		$now = current_time( 'mysql', true );
		$wpdb->query( $wpdb->prepare(
			"INSERT INTO {$wpdb->prefix}sg_comparisons (slug, title, skus, market, features, created_at, updated_at)
			 VALUES (%s, %s, %s, %s, %s, %s, %s)
			 ON DUPLICATE KEY UPDATE
				title = VALUES(title),
				skus  = VALUES(skus),
				market = VALUES(market),
				features = VALUES(features),
				updated_at = VALUES(updated_at)",
			$slug,
			$title,
			wp_json_encode( array_values( $skus ) ),
			strtoupper( sanitize_text_field( wp_unslash( (string) ( $_POST['market'] ?? '' ) ) ) ),
			sanitize_text_field( wp_unslash( (string) ( $_POST['features'] ?? '' ) ) ),
			$now, $now
		) );
		$this->flash( 'success', __( 'Comparison saved.', 'sg-commerce' ) );
		$this->redirect( 'comparisons' );
	}

	public function handle_delete_comparison(): void {
		$this->verify( 'sg_delete_comparison' );
		$id = (int) ( $_POST['id'] ?? 0 );
		if ( $id > 0 ) {
			global $wpdb;
			$wpdb->delete( $wpdb->prefix . 'sg_comparisons', array( 'id' => $id ), array( '%d' ) );
			$this->flash( 'success', __( 'Comparison removed.', 'sg-commerce' ) );
		}
		$this->redirect( 'comparisons' );
	}

	/* -------------------- PII handlers (v3.2) -------------------- */

	public function handle_pii_purge_now(): void {
		$this->verify( 'sg_pii_purge_now' );
		try {
			$count = $this->container->get( \SevenGum\Commerce\Security\PIIManager\PIIManager::class )->purge_expired();
			$this->flash( 'success', sprintf( __( 'Anonymized %d expired orders.', 'sg-commerce' ), $count ) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', $e->getMessage() );
		}
		$this->redirect( 'pii' );
	}

	public function handle_pii_save_settings(): void {
		$this->verify( 'sg_pii_save_settings' );
		$days = max( 1, min( 3650, (int) ( $_POST['pii_retention_days'] ?? 30 ) ) );
		$this->container->get( \SevenGum\Commerce\Database\Repositories\SettingsRepository::class )
			->set( 'pii_retention_days', $days );
		$this->flash( 'success', __( 'PII retention updated.', 'sg-commerce' ) );
		$this->redirect( 'pii' );
	}

	public function handle_pii_erase_subject(): void {
		$this->verify( 'sg_pii_erase_subject' );
		$email = sanitize_email( wp_unslash( (string) ( $_POST['email'] ?? '' ) ) );
		if ( '' === $email ) {
			$this->flash( 'error', __( 'Email required.', 'sg-commerce' ) );
			$this->redirect( 'pii' );
			return;
		}
		try {
			$count = $this->container->get( \SevenGum\Commerce\Security\PIIManager\PIIManager::class )->erase_subject_data( $email );
			$this->flash( 'success', sprintf( __( 'Erased PII for %d orders.', 'sg-commerce' ), $count ) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', $e->getMessage() );
		}
		$this->redirect( 'pii' );
	}

	/* -------------------- Settlement handlers (v3.2) -------------------- */

	public function handle_settlement_upload(): void {
		$this->verify( 'sg_settlement_upload' );
		if ( empty( $_FILES['settlement_file']['tmp_name'] ) ) {
			$this->flash( 'error', __( 'No file uploaded.', 'sg-commerce' ) );
			$this->redirect( 'settlements' );
			return;
		}
		$tmp = (string) $_FILES['settlement_file']['tmp_name'];
		if ( ! is_uploaded_file( $tmp ) ) {
			$this->flash( 'error', __( 'Invalid upload.', 'sg-commerce' ) );
			$this->redirect( 'settlements' );
			return;
		}
		$max_size = 20 * MB_IN_BYTES;
		if ( filesize( $tmp ) > $max_size ) {
			$this->flash( 'error', __( 'File too large (max 20MB).', 'sg-commerce' ) );
			$this->redirect( 'settlements' );
			return;
		}
		try {
			$content = (string) file_get_contents( $tmp );
			$parser  = new \SevenGum\Commerce\Amazon\ReportsParser\SettlementsParser();
			$events  = $parser->parse( $content );

			$settlement_id = sanitize_text_field( wp_unslash( (string) ( $_POST['settlement_id'] ?? 'MANUAL-' . gmdate( 'YmdHis' ) ) ) );

			global $wpdb;
			$table = $wpdb->prefix . 'sg_settlements';
			$imported = 0;
			foreach ( $events as $e ) {
				$result = $wpdb->insert( $table, array(
					'event_date'    => $e['date'] ? gmdate( 'Y-m-d', strtotime( $e['date'] ) ) : null,
					'event_type'    => $e['type'],
					'sku'           => $e['sku'],
					'order_id'      => $e['order_id'],
					'marketplace'   => $e['marketplace'],
					'amount'        => $e['amount'],
					'currency'      => $e['currency'],
					'description'   => substr( $e['description'], 0, 190 ),
					'settlement_id' => $settlement_id,
					'imported_at'   => current_time( 'mysql', true ),
				), array( '%s', '%s', '%s', '%s', '%s', '%f', '%s', '%s', '%s', '%s' ) );
				if ( false !== $result ) $imported++;
			}
			$this->flash( 'success', sprintf( __( 'Imported %1$d of %2$d events.', 'sg-commerce' ), $imported, count( $events ) ) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', $e->getMessage() );
		}
		$this->redirect( 'settlements' );
	}

	/* -------------------- API key handlers (v3.2) -------------------- */

	public function handle_mint_api_key(): void {
		$this->verify( 'sg_mint_api_key' );
		$label = sanitize_text_field( wp_unslash( (string) ( $_POST['label'] ?? 'Dashboard' ) ) );
		$key = \SevenGum\Commerce\API\HeadlessAPI::mint_key( $this->container, $label );
		// Flash the raw key once so the page shows it.
		set_transient( 'sg_new_api_key_' . get_current_user_id(), $key, 60 );
		$this->flash( 'success', __( 'API key minted. Copy it from the page — it will only be shown once.', 'sg-commerce' ) );
		$this->redirect( 'api-keys' );
	}

	public function handle_revoke_api_key(): void {
		$this->verify( 'sg_revoke_api_key' );
		$index = (int) ( $_POST['index'] ?? -1 );
		\SevenGum\Commerce\API\HeadlessAPI::revoke_key( $this->container, $index );
		$this->flash( 'success', __( 'API key revoked.', 'sg-commerce' ) );
		$this->redirect( 'api-keys' );
	}

	/* -------------------- Sandbox + SQS handlers (v3.2) -------------------- */

	public function handle_toggle_sandbox(): void {
		$this->verify( 'sg_toggle_sandbox' );
		if ( \SevenGum\Commerce\Testing\Sandbox::is_enabled() ) {
			\SevenGum\Commerce\Testing\Sandbox::disable();
			$this->flash( 'success', __( 'Sandbox mode disabled.', 'sg-commerce' ) );
		} else {
			\SevenGum\Commerce\Testing\Sandbox::enable();
			$this->flash( 'success', __( 'Sandbox mode enabled — SP-API calls return mocked data.', 'sg-commerce' ) );
		}
		$this->redirect( 'settings' );
	}

	public function handle_save_sqs(): void {
		$this->verify( 'sg_save_sqs' );
		$settings = $this->container->get( \SevenGum\Commerce\Database\Repositories\SettingsRepository::class );
		$enc      = $this->container->get( \SevenGum\Commerce\Security\Encryption::class );

		$settings->set( 'sqs_enabled',    ! empty( $_POST['sqs_enabled'] ) );
		$settings->set( 'sqs_region',     sanitize_text_field( wp_unslash( (string) ( $_POST['sqs_region']    ?? 'us-east-1' ) ) ) );
		$settings->set( 'sqs_queue_url',  esc_url_raw(       wp_unslash( (string) ( $_POST['sqs_queue_url'] ?? '' ) ) ) );
		$settings->set( 'sqs_access_key', sanitize_text_field( wp_unslash( (string) ( $_POST['sqs_access_key'] ?? '' ) ) ) );

		$new_secret = (string) ( $_POST['sqs_secret_key'] ?? '' );
		if ( '' !== $new_secret ) {
			$settings->set( 'sqs_secret_key_enc', $enc->encrypt( $new_secret ) );
		}

		// Toggle cron based on enabled state.
		if ( ! empty( $_POST['sqs_enabled'] ) ) {
			if ( ! wp_next_scheduled( 'sg_commerce_sqs_poll' ) ) {
				wp_schedule_event( time() + 60, 'sg_five_minutes', 'sg_commerce_sqs_poll' );
			}
		} else {
			wp_clear_scheduled_hook( 'sg_commerce_sqs_poll' );
		}

		$this->flash( 'success', __( 'SQS settings saved.', 'sg-commerce' ) );
		$this->redirect( 'settings' );
	}

	public function handle_test_sqs(): void {
		$this->verify( 'sg_test_sqs' );
		try {
			$processed = $this->container->get( \SevenGum\Commerce\Amazon\SQSConsumer\SQSConsumer::class )->poll();
			$this->flash( 'success', sprintf( __( 'SQS poll test: %d messages processed.', 'sg-commerce' ), $processed ) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', $e->getMessage() );
		}
		$this->redirect( 'settings' );
	}

	/* -------------------- Theme bridge handlers (v3.2) -------------------- */

	public function handle_theme_resync(): void {
		$this->verify( 'sg_theme_resync' );
		try {
			$this->container->get( \SevenGum\Commerce\Integration\ThemeBridge::class )->on_sync_completed( array() );
			$this->flash( 'success', __( 'Theme resync complete. Every mapped product got fresh price + URL.', 'sg-commerce' ) );
		} catch ( \Throwable $e ) {
			$this->flash( 'error', $e->getMessage() );
		}
		$this->redirect( 'theme-bridge' );
	}

	/* -------------------- Inbound plan handlers (v3.3) -------------------- */

	public function handle_inbound_create(): void {
		$this->verify( 'sg_inbound_create' );

		$name   = sanitize_text_field( wp_unslash( (string) ( $_POST['plan_name'] ?? '' ) ) );
		$market = strtoupper( sanitize_text_field( wp_unslash( (string) ( $_POST['market'] ?? 'US' ) ) ) );
		$msku   = sanitize_text_field( wp_unslash( (string) ( $_POST['msku'] ?? '' ) ) );
		$packs_per_carton = max( 1, (int) ( $_POST['packs_per_carton'] ?? 24 ) );
		$carton_count = max( 1, (int) ( $_POST['carton_count'] ?? 0 ) );
		$label_owner = in_array( (string) ( $_POST['label_owner'] ?? 'NONE' ), array( 'NONE', 'SELLER', 'AMAZON' ), true )
			? (string) $_POST['label_owner'] : 'NONE';

		if ( '' === $name || '' === $msku || $carton_count < 1 ) {
			$this->flash( 'error', __( 'Plan name, MSKU, and carton count are required.', 'sg-commerce' ) );
			$this->redirect( 'inbound' );
			return;
		}

		$source_address = array(
			'name'         => sanitize_text_field( wp_unslash( (string) ( $_POST['src_name']     ?? '' ) ) ),
			'address1'     => sanitize_text_field( wp_unslash( (string) ( $_POST['src_address1'] ?? '' ) ) ),
			'city'         => sanitize_text_field( wp_unslash( (string) ( $_POST['src_city']     ?? '' ) ) ),
			'state'        => sanitize_text_field( wp_unslash( (string) ( $_POST['src_state']    ?? '' ) ) ),
			'postal_code'  => sanitize_text_field( wp_unslash( (string) ( $_POST['src_postal']   ?? '' ) ) ),
			'country_code' => strtoupper( sanitize_text_field( wp_unslash( (string) ( $_POST['src_country'] ?? 'CN' ) ) ) ),
			'phone'        => sanitize_text_field( wp_unslash( (string) ( $_POST['src_phone']    ?? '' ) ) ),
		);

		$total_units = $carton_count * $packs_per_carton;

		// Persist as draft — operator can then advance through STA steps.
		global $wpdb;
		$inserted = $wpdb->insert( $wpdb->prefix . 'sg_inbound_plans', array(
			'amazon_plan_id' => '',
			'name'           => $name,
			'market'         => $market,
			'status'         => 'draft',
			'source_address' => wp_json_encode( $source_address ),
			'items'          => wp_json_encode( array(
				array(
					'msku'        => $msku,
					'quantity'    => $total_units,
					'prep_owner'  => 'SELLER',
					'label_owner' => $label_owner,
				),
			) ),
			'cartons'        => wp_json_encode( array(
				array(
					'template_id' => 'sg-master-24pack',
					'quantity'    => $carton_count,
					'contents'    => array( array( 'msku' => $msku, 'quantity' => $packs_per_carton ) ),
				),
			) ),
			'total_cartons'  => $carton_count,
			'total_units'    => $total_units,
			'created_at'     => current_time( 'mysql', true ),
		), array( '%s','%s','%s','%s','%s','%s','%s','%d','%d','%s' ) );

		if ( false === $inserted ) {
			$this->flash( 'error', __( 'Could not persist plan. DB error:', 'sg-commerce' ) . ' ' . $wpdb->last_error );
		} else {
			$this->flash( 'success', sprintf(
				/* translators: %1$d cartons, %2$d units */
				__( 'Draft plan saved (%1$d cartons = %2$d units). Next step: advance to Amazon via WP-CLI or admin workflow.', 'sg-commerce' ),
				$carton_count, $total_units
			) );
		}
		$this->redirect( 'inbound' );
	}

	/* -------------------------------------------------- */
	/* Helpers                                            */
	/* -------------------------------------------------- */

	private function verify( string $action ): void {
		if ( ! current_user_can( self::CAP ) ) {
			wp_die( esc_html__( 'Insufficient permissions.', 'sg-commerce' ) );
		}
		check_admin_referer( $action, self::NONCE );
	}

	private function redirect( string $page ): void {
		$slug = self::MENU . ( '' !== $page && 'dashboard' !== $page ? '-' . $page : '' );
		wp_safe_redirect( admin_url( 'admin.php?page=' . $slug ) );
		exit;
	}

	public function flash( string $type, string $message ): void {
		set_transient( 'sg_commerce_notice_' . get_current_user_id(), array( 'type' => $type, 'msg' => $message ), 60 );
	}

	public static function render_flash(): void {
		$key = 'sg_commerce_notice_' . get_current_user_id();
		$notice = get_transient( $key );
		if ( ! is_array( $notice ) ) return;
		delete_transient( $key );
		printf(
			'<div class="notice notice-%s is-dismissible"><p>%s</p></div>',
			esc_attr( (string) $notice['type'] ),
			esc_html( (string) $notice['msg'] )
		);
	}
}
