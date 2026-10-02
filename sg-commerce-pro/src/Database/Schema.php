<?php
/**
 * Schema — versioned database schema with migrations.
 *
 * Tables:
 *   {prefix}sg_products          One row per (market, sku) — the master inventory.
 *   {prefix}sg_price_history     Time-series price snapshots for analytics.
 *   {prefix}sg_descriptions      Localized AI copy keyed by (product_id, language).
 *   {prefix}sg_competitors       Competitor ASINs we track per market.
 *   {prefix}sg_rules             Automation rules (when/then JSON).
 *   {prefix}sg_alerts            Stored alerts for the admin notification feed.
 *   {prefix}sg_audit             Append-only audit log for sensitive ops.
 *
 * Migrations run via dbDelta which is idempotent and additive-safe.
 * SCHEMA_VERSION bumps trigger re-run.
 *
 * @package SevenGum\Commerce\Database
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Database;

defined( 'ABSPATH' ) || exit;

final class Schema {

	public const SCHEMA_VERSION = 6;

	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset = $wpdb->get_charset_collate();
		$prefix  = $wpdb->prefix;

		// Products — primary inventory table.
		dbDelta( "CREATE TABLE {$prefix}sg_products (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			sku VARCHAR(64) NOT NULL,
			asin VARCHAR(20) DEFAULT '' NOT NULL,
			product_name VARCHAR(255) DEFAULT '' NOT NULL,
			image_url VARCHAR(512) DEFAULT '' NOT NULL,
			fulfillable_qty INT DEFAULT 0 NOT NULL,
			reserved_qty INT DEFAULT 0 NOT NULL,
			inbound_qty INT DEFAULT 0 NOT NULL,
			buybox_price DECIMAL(10,2) DEFAULT NULL,
			buybox_currency VARCHAR(3) DEFAULT '' NOT NULL,
			buybox_is_mine TINYINT(1) DEFAULT 0 NOT NULL,
			lowest_price DECIMAL(10,2) DEFAULT NULL,
			my_price DECIMAL(10,2) DEFAULT NULL,
			cost_price DECIMAL(10,2) DEFAULT NULL,
			last_sync_at DATETIME DEFAULT NULL,
			last_priced_at DATETIME DEFAULT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
			PRIMARY KEY  (id),
			UNIQUE KEY market_sku (market, sku),
			KEY asin (asin),
			KEY market_qty (market, fulfillable_qty),
			KEY last_sync (last_sync_at)
		) {$charset};" );

		// Price history — append-only time series for analytics + repricer.
		dbDelta( "CREATE TABLE {$prefix}sg_price_history (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			product_id BIGINT UNSIGNED NOT NULL,
			recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			my_price DECIMAL(10,2) DEFAULT NULL,
			buybox_price DECIMAL(10,2) DEFAULT NULL,
			lowest_price DECIMAL(10,2) DEFAULT NULL,
			currency VARCHAR(3) DEFAULT '' NOT NULL,
			buybox_is_mine TINYINT(1) DEFAULT 0 NOT NULL,
			fulfillable_qty INT DEFAULT 0 NOT NULL,
			source VARCHAR(20) DEFAULT 'sync' NOT NULL,
			PRIMARY KEY  (id),
			KEY product_time (product_id, recorded_at),
			KEY recorded (recorded_at)
		) {$charset};" );

		// Descriptions — one row per (product_id, language).
		dbDelta( "CREATE TABLE {$prefix}sg_descriptions (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			product_id BIGINT UNSIGNED NOT NULL,
			language VARCHAR(8) NOT NULL,
			content LONGTEXT NOT NULL,
			provider VARCHAR(32) DEFAULT 'ollama' NOT NULL,
			model VARCHAR(64) DEFAULT '' NOT NULL,
			temperature DECIMAL(3,2) DEFAULT NULL,
			tokens INT DEFAULT 0 NOT NULL,
			generation_ms INT DEFAULT 0 NOT NULL,
			generated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY product_lang (product_id, language),
			KEY language (language)
		) {$charset};" );

		// Competitors — ASINs we monitor in addition to our own SKUs.
		dbDelta( "CREATE TABLE {$prefix}sg_competitors (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			asin VARCHAR(20) NOT NULL,
			seller_name VARCHAR(255) DEFAULT '' NOT NULL,
			product_name VARCHAR(255) DEFAULT '' NOT NULL,
			our_product_id BIGINT UNSIGNED DEFAULT NULL,
			last_price DECIMAL(10,2) DEFAULT NULL,
			currency VARCHAR(3) DEFAULT '' NOT NULL,
			has_buybox TINYINT(1) DEFAULT 0 NOT NULL,
			last_scanned_at DATETIME DEFAULT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY market_asin (market, asin),
			KEY our_product (our_product_id),
			KEY scanned (last_scanned_at)
		) {$charset};" );

		// Rules — automation engine.
		dbDelta( "CREATE TABLE {$prefix}sg_rules (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			name VARCHAR(120) NOT NULL,
			trigger_event VARCHAR(64) NOT NULL,
			conditions LONGTEXT NOT NULL,
			actions LONGTEXT NOT NULL,
			is_active TINYINT(1) DEFAULT 1 NOT NULL,
			run_count INT DEFAULT 0 NOT NULL,
			last_run_at DATETIME DEFAULT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
			PRIMARY KEY  (id),
			KEY trigger_active (trigger_event, is_active)
		) {$charset};" );

		// Alerts — admin notification feed.
		dbDelta( "CREATE TABLE {$prefix}sg_alerts (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			level VARCHAR(16) DEFAULT 'info' NOT NULL,
			category VARCHAR(32) NOT NULL,
			title VARCHAR(255) NOT NULL,
			message TEXT,
			context LONGTEXT,
			product_id BIGINT UNSIGNED DEFAULT NULL,
			is_read TINYINT(1) DEFAULT 0 NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			PRIMARY KEY  (id),
			KEY unread (is_read, created_at),
			KEY category (category, created_at)
		) {$charset};" );

		// Audit — append-only sensitive operation log.
		dbDelta( "CREATE TABLE {$prefix}sg_audit (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED DEFAULT 0 NOT NULL,
			action VARCHAR(64) NOT NULL,
			entity_type VARCHAR(32) DEFAULT '' NOT NULL,
			entity_id VARCHAR(64) DEFAULT '' NOT NULL,
			details LONGTEXT,
			ip_address VARCHAR(45) DEFAULT '' NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			PRIMARY KEY  (id),
			KEY user_time (user_id, created_at),
			KEY action_time (action, created_at)
		) {$charset};" );

		// MCF orders — Multi-Channel Fulfillment orders created through Amazon FBA
		// but shipped to end customers outside of Amazon (e.g. our own storefront).
		dbDelta( "CREATE TABLE {$prefix}sg_mcf_orders (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			seller_fulfillment_order_id VARCHAR(40) NOT NULL,
			amazon_order_id VARCHAR(40) DEFAULT '' NOT NULL,
			market VARCHAR(2) NOT NULL,
			displayable_order_id VARCHAR(40) DEFAULT '' NOT NULL,
			customer_name VARCHAR(200) DEFAULT '' NOT NULL,
			customer_email VARCHAR(190) DEFAULT '' NOT NULL,
			country_code VARCHAR(2) DEFAULT '' NOT NULL,
			address_line1 VARCHAR(200) DEFAULT '' NOT NULL,
			address_line2 VARCHAR(200) DEFAULT '' NOT NULL,
			city VARCHAR(100) DEFAULT '' NOT NULL,
			state_region VARCHAR(100) DEFAULT '' NOT NULL,
			postal_code VARCHAR(30) DEFAULT '' NOT NULL,
			phone VARCHAR(40) DEFAULT '' NOT NULL,
			items LONGTEXT NOT NULL,
			shipping_speed VARCHAR(20) DEFAULT 'Standard' NOT NULL,
			status VARCHAR(40) DEFAULT 'new' NOT NULL,
			amazon_status VARCHAR(60) DEFAULT '' NOT NULL,
			tracking_numbers TEXT,
			carrier_code VARCHAR(40) DEFAULT '' NOT NULL,
			estimated_delivery_date DATETIME DEFAULT NULL,
			submitted_at DATETIME DEFAULT NULL,
			shipped_at DATETIME DEFAULT NULL,
			delivered_at DATETIME DEFAULT NULL,
			error_message TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
			PRIMARY KEY  (id),
			UNIQUE KEY seller_order (seller_fulfillment_order_id),
			KEY status (status, created_at),
			KEY market (market, created_at)
		) {$charset};" );

		// Comparison sets — reusable sku bundles for comparison tables.
		dbDelta( "CREATE TABLE {$prefix}sg_comparisons (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			slug VARCHAR(60) NOT NULL,
			title VARCHAR(200) DEFAULT '' NOT NULL,
			skus LONGTEXT NOT NULL,
			market VARCHAR(2) DEFAULT '' NOT NULL,
			features LONGTEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
			PRIMARY KEY  (id),
			UNIQUE KEY slug (slug)
		) {$charset};" );

		// Injection rules — auto-link SKU mentions in post_content.
		dbDelta( "CREATE TABLE {$prefix}sg_injection_rules (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			pattern VARCHAR(200) NOT NULL,
			pattern_type VARCHAR(20) DEFAULT 'keyword' NOT NULL,
			sku VARCHAR(64) NOT NULL,
			market VARCHAR(2) DEFAULT '' NOT NULL,
			render_as VARCHAR(20) DEFAULT 'link' NOT NULL,
			priority INT DEFAULT 10 NOT NULL,
			max_per_post INT DEFAULT 1 NOT NULL,
			is_active TINYINT(1) DEFAULT 1 NOT NULL,
			hit_count INT DEFAULT 0 NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			PRIMARY KEY  (id),
			KEY active_priority (is_active, priority)
		) {$charset};" );

		// Settlements — financial events parsed from Amazon settlement reports.
		// Used by Analytics to compute TRUE profit (after real FBA storage fees,
		// referral fees, advertising, refunds, adjustments).
		dbDelta( "CREATE TABLE {$prefix}sg_settlements (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			event_date DATE DEFAULT NULL,
			event_type VARCHAR(40) NOT NULL,
			sku VARCHAR(64) DEFAULT '' NOT NULL,
			order_id VARCHAR(40) DEFAULT '' NOT NULL,
			marketplace VARCHAR(40) DEFAULT '' NOT NULL,
			amount DECIMAL(12,4) DEFAULT 0 NOT NULL,
			currency VARCHAR(5) DEFAULT '' NOT NULL,
			description VARCHAR(190) DEFAULT '' NOT NULL,
			settlement_id VARCHAR(40) DEFAULT '' NOT NULL,
			imported_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			PRIMARY KEY  (id),
			KEY date_type (event_date, event_type),
			KEY sku_date (sku, event_date),
			KEY settlement (settlement_id)
		) {$charset};" );

		// Inbound plans — Send to Amazon (STA) shipments from factory to FBA.
		// Persists local state of the multi-step workflow so operators can
		// resume a plan that's been in progress across multiple sessions.
		dbDelta( "CREATE TABLE {$prefix}sg_inbound_plans (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			amazon_plan_id VARCHAR(60) DEFAULT '' NOT NULL,
			name VARCHAR(200) NOT NULL,
			market VARCHAR(2) NOT NULL,
			status VARCHAR(40) DEFAULT 'draft' NOT NULL,
			source_address LONGTEXT,
			items LONGTEXT,
			cartons LONGTEXT,
			selected_packing_option_id VARCHAR(100) DEFAULT '' NOT NULL,
			selected_placement_option_id VARCHAR(100) DEFAULT '' NOT NULL,
			total_cartons INT DEFAULT 0 NOT NULL,
			total_units INT DEFAULT 0 NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
			confirmed_at DATETIME DEFAULT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY amazon_plan (amazon_plan_id),
			KEY status (status, updated_at)
		) {$charset};" );

		// Product EAN map — associate our SKUs with the EAN-13 on the bottle
		// AND the Amazon ASIN (if catalog lookup found a match). Populated
		// when an operator creates/imports a listing; read by LabelGenerator
		// and BoxContentService.
		dbDelta( "CREATE TABLE {$prefix}sg_product_ean (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			sku VARCHAR(64) NOT NULL,
			ean13 VARCHAR(13) NOT NULL,
			asin VARCHAR(20) DEFAULT '' NOT NULL,
			market VARCHAR(2) NOT NULL,
			product_name VARCHAR(200) DEFAULT '' NOT NULL,
			catalog_status VARCHAR(20) DEFAULT 'unknown' NOT NULL,
			listing_status VARCHAR(20) DEFAULT 'draft' NOT NULL,
			last_checked_at DATETIME DEFAULT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY sku_market (sku, market),
			KEY ean (ean13),
			KEY asin (asin)
		) {$charset};" );

		update_option( 'sg_commerce_schema_version', self::SCHEMA_VERSION, false );
	}

	public static function maybe_upgrade(): void {
		$current = (int) get_option( 'sg_commerce_schema_version', 0 );
		if ( $current < self::SCHEMA_VERSION ) {
			self::install();
		}
	}

	/** All tables we own — used by uninstall.php. */
	public static function tables(): array {
		global $wpdb;
		$prefix = $wpdb->prefix;
		return array(
			"{$prefix}sg_products",
			"{$prefix}sg_price_history",
			"{$prefix}sg_descriptions",
			"{$prefix}sg_competitors",
			"{$prefix}sg_rules",
			"{$prefix}sg_alerts",
			"{$prefix}sg_audit",
			"{$prefix}sg_mcf_orders",
			"{$prefix}sg_comparisons",
			"{$prefix}sg_injection_rules",
			"{$prefix}sg_settlements",
			"{$prefix}sg_inbound_plans",
			"{$prefix}sg_product_ean",
		);
	}
}
