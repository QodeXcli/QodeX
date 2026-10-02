<?php
/**
 * uninstall.php — runs when the plugin is deleted (not deactivated).
 *
 * Drops every table the plugin owns, deletes every option (including
 * encrypted secrets), and clears every scheduled cron event.
 *
 * Multisite-safe: iterates every site if WP is multisite.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

global $wpdb;

function sg_commerce_uninstall_one_site(): void {
	global $wpdb;

	$tables = array(
		"{$wpdb->prefix}sg_products",
		"{$wpdb->prefix}sg_price_history",
		"{$wpdb->prefix}sg_descriptions",
		"{$wpdb->prefix}sg_competitors",
		"{$wpdb->prefix}sg_rules",
		"{$wpdb->prefix}sg_alerts",
		"{$wpdb->prefix}sg_audit",
		"{$wpdb->prefix}sg_mcf_orders",
		"{$wpdb->prefix}sg_comparisons",
		"{$wpdb->prefix}sg_injection_rules",
		"{$wpdb->prefix}sg_settlements",
	);
	foreach ( $tables as $t ) {
		$wpdb->query( "DROP TABLE IF EXISTS {$t}" );
	}

	$option_keys = array(
		'sg_commerce_settings',
		'sg_commerce_schema_version',
		'sg_commerce_installed_at',
		'sg_commerce_activated_at',
		'sg_commerce_default_rules_seeded',
		'sg_commerce_last_cron_sync',
	);
	foreach ( $option_keys as $key ) {
		delete_option( $key );
	}

	// Encrypted secrets — one option each.
	$secret_keys = array(
		'amazon_client_id',
		'amazon_client_secret',
		'amazon_refresh_token',
		'amazon_seller_id',
		'openai_api_key',
		'anthropic_api_key',
		'ollama_auth_token',
	);
	foreach ( $secret_keys as $sk ) {
		delete_option( 'sg_commerce_secret_' . $sk );
	}

	// Transients.
	$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '_transient_sg_commerce/%' OR option_name LIKE '_transient_timeout_sg_commerce/%'" );

	// Cron.
	$crons = array(
		'sg_commerce_hourly_sync',
		'sg_commerce_daily_analytics',
		'sg_commerce_repricer_tick',
		'sg_commerce_competitor_scan',
		'sg_commerce_ai_queue_process',
		'sg_commerce_mcf_refresh',
		'sg_commerce_pii_purge',
		'sg_commerce_sqs_poll',
		'sg_commerce_ai_describe',
		'sg_commerce_ai_translate',
	);
	foreach ( $crons as $hook ) {
		wp_clear_scheduled_hook( $hook );
	}

	// Log directory.
	$uploads = wp_upload_dir( null, false );
	if ( ! empty( $uploads['basedir'] ) ) {
		$log_dir = trailingslashit( $uploads['basedir'] ) . 'sg-commerce-logs';
		if ( is_dir( $log_dir ) ) {
			array_map( 'unlink', glob( $log_dir . '/*' ) ?: array() );
			@rmdir( $log_dir );
		}
	}
}

if ( is_multisite() ) {
	$sites = get_sites( array( 'fields' => 'ids', 'number' => 0 ) );
	foreach ( (array) $sites as $blog_id ) {
		switch_to_blog( (int) $blog_id );
		sg_commerce_uninstall_one_site();
		restore_current_blog();
	}
} else {
	sg_commerce_uninstall_one_site();
}
