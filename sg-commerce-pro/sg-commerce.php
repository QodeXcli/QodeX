<?php
/**
 * Plugin Name:       Seven Gum Commerce Pro
 * Plugin URI:        https://sevengum.com/commerce
 * Description:       Enterprise Amazon SP-API + AI commerce engine. Inventory sync, AI copywriting, automated repricing, competitor monitoring, profit analytics, multi-marketplace support.
 * Version:           3.3.1
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Author:            Seven Gum Engineering
 * License:           GPL-2.0-or-later
 * Text Domain:       sg-commerce
 * Domain Path:       /languages
 *
 * @package SevenGum\Commerce
 *
 * ============================================================================
 * ARCHITECTURE OVERVIEW (v3.0)
 * ============================================================================
 *
 * This is a full rewrite as a service-container-driven enterprise plugin.
 *
 * Layers (each in src/):
 *
 *   Core/         Container, Plugin, Module interfaces, lifecycle
 *   Database/     Schema versioning, migrations, repository pattern
 *   Security/     Encryption (envelope), key rotation, capability checks
 *   Logging/      PSR-3 compatible structured logger
 *   Cache/        Multi-tier (memory → object cache → transient)
 *   Queue/        Action Scheduler-based async job processing
 *   Events/       Domain events (PSR-14 inspired) for cross-module decoupling
 *
 *   Amazon/       SP-API client with retry, circuit breaker, rate limiter,
 *                 LWA token manager, sync orchestrator, repricer, reports
 *   AI/           Multi-provider abstraction (Ollama, OpenAI, Claude),
 *                 prompt registry, RAG (brand corpus), generation queue
 *   Analytics/    Sales aggregation, profit margin calc, competitor tracking
 *   Automation/   Rules engine (when X then Y), alert dispatcher
 *   Repricer/     Auto-repricing with multiple strategies
 *   Widget/       Frontend shortcode + Gutenberg block + REST
 *   Admin/        wp-admin pages, controllers, view rendering
 *   REST/         Public REST API namespace
 *   CLI/          WP-CLI commands for bulk ops
 *
 * Dependency injection via the Container ensures testability and lets us
 * swap implementations (e.g. Ollama vs OpenAI) without touching call sites.
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/* -------------------------------------------------------------------------
 * Constants — all guarded to prevent redeclaration conflicts.
 * ------------------------------------------------------------------------- */
defined( 'SG_COMMERCE_VERSION' )    || define( 'SG_COMMERCE_VERSION', '3.3.1' );
defined( 'SG_COMMERCE_DB_VERSION' ) || define( 'SG_COMMERCE_DB_VERSION', 6 );
defined( 'SG_COMMERCE_FILE' )       || define( 'SG_COMMERCE_FILE', __FILE__ );
defined( 'SG_COMMERCE_DIR' )        || define( 'SG_COMMERCE_DIR', plugin_dir_path( __FILE__ ) );
defined( 'SG_COMMERCE_URL' )        || define( 'SG_COMMERCE_URL', plugin_dir_url(  __FILE__ ) );
defined( 'SG_COMMERCE_BASENAME' )   || define( 'SG_COMMERCE_BASENAME', plugin_basename( __FILE__ ) );
defined( 'SG_COMMERCE_SLUG' )       || define( 'SG_COMMERCE_SLUG', 'sg-commerce' );
defined( 'SG_COMMERCE_MIN_PHP' )    || define( 'SG_COMMERCE_MIN_PHP', '8.1.0' );
defined( 'SG_COMMERCE_MIN_WP' )     || define( 'SG_COMMERCE_MIN_WP', '6.4' );

/* -------------------------------------------------------------------------
 * PSR-4 Autoloader.
 *
 * Maps SevenGum\Commerce\Foo\Bar  →  src/Foo/Bar.php
 * Files use StudlyCase (e.g. Container.php, AmazonClient.php), classes
 * match filenames exactly. No class-foo-bar.php prefixes.
 * ------------------------------------------------------------------------- */
spl_autoload_register( static function ( string $class ): void {
	$prefix = 'SevenGum\\Commerce\\';
	if ( ! str_starts_with( $class, $prefix ) ) {
		return;
	}
	$relative = substr( $class, strlen( $prefix ) );
	$file     = SG_COMMERCE_DIR . 'src/' . str_replace( '\\', '/', $relative ) . '.php';
	if ( is_readable( $file ) ) {
		require_once $file;
	}
} );

/* -------------------------------------------------------------------------
 * Activation / Deactivation / Uninstall hooks.
 *
 * Activation: run environment check, install schema, seed defaults.
 * Deactivation: clear scheduled jobs (don't drop data — uninstall.php owns that).
 * Uninstall: separate file, owns destruction.
 * ------------------------------------------------------------------------- */
register_activation_hook( __FILE__, static function ( bool $network_wide = false ): void {
	require_once SG_COMMERCE_DIR . 'src/Core/Activator.php';
	\SevenGum\Commerce\Core\Activator::activate( $network_wide );
} );

register_deactivation_hook( __FILE__, static function ( bool $network_wide = false ): void {
	require_once SG_COMMERCE_DIR . 'src/Core/Activator.php';
	\SevenGum\Commerce\Core\Activator::deactivate( $network_wide );
} );

/* -------------------------------------------------------------------------
 * Translations — must hook on `init` (WordPress 6.7+ requirement).
 * ------------------------------------------------------------------------- */
add_action( 'init', static function (): void {
	load_plugin_textdomain( 'sg-commerce', false, dirname( SG_COMMERCE_BASENAME ) . '/languages' );
}, 5 );

/* -------------------------------------------------------------------------
 * Boot the plugin.
 *
 * The Plugin class owns the Container and orchestrates module registration.
 * Boots on `plugins_loaded` priority 10 to give other plugins a chance to
 * register filters/services we depend on.
 * ------------------------------------------------------------------------- */
add_action( 'plugins_loaded', static function (): void {
	try {
		\SevenGum\Commerce\Core\Plugin::instance()->boot();
	} catch ( \Throwable $e ) {
		error_log( '[SG Commerce] Boot failure: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine() );
		add_action( 'admin_notices', static function () use ( $e ): void {
			if ( ! current_user_can( 'manage_options' ) ) return;
			printf(
				'<div class="notice notice-error"><p><strong>Seven Gum Commerce:</strong> %s</p></div>',
				esc_html( $e->getMessage() )
			);
		} );
	}
}, 10 );
