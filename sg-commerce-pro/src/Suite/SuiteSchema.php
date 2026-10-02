<?php
/**
 * SuiteSchema — tables for the Amazon Seller Suite.
 *
 * Versioned independently from the core Schema (option
 * `sg_suite_schema_version`) so the suite can migrate without touching core
 * tables. Every table is prefixed `{prefix}sg_suite_` which lets uninstall
 * drop them all with one LIKE query.
 *
 * Money is DECIMAL(14,4) — finance events carry sub-cent fee splits.
 * Every ingest table has an `is_demo` flag so demo data can be wiped
 * without touching real data.
 *
 * @package SevenGum\Commerce\Suite
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite;

defined( 'ABSPATH' ) || exit;

final class SuiteSchema {

	public const VERSION = 1;
	public const OPTION  = 'sg_suite_schema_version';

	/** Short table names (without `{prefix}sg_suite_`). */
	public const TABLES = array(
		'orders', 'order_items', 'fin_events', 'reports', 'sku_costs', 'expenses',
		'ads_campaigns', 'ads_targets', 'ads_daily', 'ads_search_terms', 'ads_actions',
		'keywords', 'keyword_metrics', 'asin_snapshots', 'offer_sellers',
		'solicitations', 'reimb_cases', 'ledger', 'reimbursements', 'returns',
		'traffic_daily', 'listing_audits', 'inventory_health', 'feedback',
	);

	public static function table( string $short ): string {
		global $wpdb;
		return $wpdb->prefix . 'sg_suite_' . $short;
	}

	public static function maybe_install(): void {
		if ( (int) get_option( self::OPTION, 0 ) < self::VERSION ) {
			self::install();
		}
	}

	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$c = $wpdb->get_charset_collate();
		$t = static fn( string $s ): string => self::table( $s );

		dbDelta( "CREATE TABLE {$t('orders')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			amazon_order_id VARCHAR(32) NOT NULL,
			purchase_date DATETIME NOT NULL,
			local_date DATE NOT NULL,
			last_update DATETIME DEFAULT NULL,
			status VARCHAR(32) DEFAULT '' NOT NULL,
			fulfillment_channel VARCHAR(8) DEFAULT '' NOT NULL,
			sales_channel VARCHAR(64) DEFAULT '' NOT NULL,
			order_total DECIMAL(14,4) DEFAULT 0 NOT NULL,
			currency VARCHAR(3) DEFAULT '' NOT NULL,
			units INT DEFAULT 0 NOT NULL,
			is_business TINYINT(1) DEFAULT 0 NOT NULL,
			is_prime TINYINT(1) DEFAULT 0 NOT NULL,
			ship_country VARCHAR(2) DEFAULT '' NOT NULL,
			earliest_delivery DATETIME DEFAULT NULL,
			latest_delivery DATETIME DEFAULT NULL,
			items_synced TINYINT(1) DEFAULT 0 NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY order_id (amazon_order_id),
			KEY market_date (market, local_date),
			KEY status (status),
			KEY items_synced (items_synced)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('order_items')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			amazon_order_id VARCHAR(32) NOT NULL,
			order_item_id VARCHAR(64) NOT NULL,
			local_date DATE NOT NULL,
			sku VARCHAR(64) DEFAULT '' NOT NULL,
			asin VARCHAR(20) DEFAULT '' NOT NULL,
			title VARCHAR(255) DEFAULT '' NOT NULL,
			qty INT DEFAULT 0 NOT NULL,
			item_price DECIMAL(14,4) DEFAULT 0 NOT NULL,
			item_tax DECIMAL(14,4) DEFAULT 0 NOT NULL,
			promo_discount DECIMAL(14,4) DEFAULT 0 NOT NULL,
			status VARCHAR(32) DEFAULT '' NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY order_item (amazon_order_id, order_item_id),
			KEY market_sku_date (market, sku, local_date),
			KEY local_date (local_date)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('fin_events')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) DEFAULT '' NOT NULL,
			event_hash CHAR(40) NOT NULL,
			posted_date DATETIME NOT NULL,
			local_date DATE NOT NULL,
			event_type VARCHAR(48) NOT NULL,
			amazon_order_id VARCHAR(32) DEFAULT '' NOT NULL,
			sku VARCHAR(64) DEFAULT '' NOT NULL,
			charge_type VARCHAR(64) DEFAULT '' NOT NULL,
			category VARCHAR(16) NOT NULL,
			amount DECIMAL(14,4) DEFAULT 0 NOT NULL,
			currency VARCHAR(3) DEFAULT '' NOT NULL,
			qty INT DEFAULT 0 NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY event_hash (event_hash),
			KEY market_date_cat (market, local_date, category),
			KEY order_id (amazon_order_id),
			KEY sku_date (sku, local_date)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('reports')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			report_type VARCHAR(96) NOT NULL,
			market VARCHAR(2) DEFAULT '' NOT NULL,
			source VARCHAR(8) DEFAULT 'sp' NOT NULL,
			remote_id VARCHAR(64) DEFAULT '' NOT NULL,
			document_id VARCHAR(128) DEFAULT '' NOT NULL,
			status VARCHAR(16) DEFAULT 'requested' NOT NULL,
			data_start DATETIME DEFAULT NULL,
			data_end DATETIME DEFAULT NULL,
			options LONGTEXT,
			rows_ingested INT DEFAULT 0 NOT NULL,
			attempts INT DEFAULT 0 NOT NULL,
			error TEXT,
			requested_at DATETIME NOT NULL,
			completed_at DATETIME DEFAULT NULL,
			PRIMARY KEY  (id),
			KEY status (status, requested_at),
			KEY type_time (report_type, requested_at)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('sku_costs')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			sku VARCHAR(64) NOT NULL,
			unit_cost DECIMAL(14,4) DEFAULT 0 NOT NULL,
			inbound_per_unit DECIMAL(14,4) DEFAULT 0 NOT NULL,
			prep_per_unit DECIMAL(14,4) DEFAULT 0 NOT NULL,
			other_per_unit DECIMAL(14,4) DEFAULT 0 NOT NULL,
			lead_time_days INT DEFAULT 0 NOT NULL,
			moq INT DEFAULT 0 NOT NULL,
			case_pack INT DEFAULT 0 NOT NULL,
			supplier VARCHAR(128) DEFAULT '' NOT NULL,
			updated_at DATETIME NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY market_sku (market, sku)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('expenses')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) DEFAULT '' NOT NULL,
			label VARCHAR(128) NOT NULL,
			category VARCHAR(32) DEFAULT 'other' NOT NULL,
			amount DECIMAL(14,4) DEFAULT 0 NOT NULL,
			recurrence VARCHAR(8) DEFAULT 'once' NOT NULL,
			start_date DATE NOT NULL,
			end_date DATE DEFAULT NULL,
			sku VARCHAR(64) DEFAULT '' NOT NULL,
			created_at DATETIME NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			KEY start_date (start_date)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('ads_campaigns')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			profile_id VARCHAR(32) NOT NULL,
			campaign_id VARCHAR(32) NOT NULL,
			name VARCHAR(255) DEFAULT '' NOT NULL,
			state VARCHAR(16) DEFAULT '' NOT NULL,
			targeting_type VARCHAR(16) DEFAULT '' NOT NULL,
			daily_budget DECIMAL(14,4) DEFAULT 0 NOT NULL,
			bidding_strategy VARCHAR(48) DEFAULT '' NOT NULL,
			start_date DATE DEFAULT NULL,
			updated_at DATETIME NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY campaign (profile_id, campaign_id)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('ads_targets')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			profile_id VARCHAR(32) NOT NULL,
			target_id VARCHAR(32) NOT NULL,
			kind VARCHAR(8) DEFAULT 'keyword' NOT NULL,
			campaign_id VARCHAR(32) NOT NULL,
			ad_group_id VARCHAR(32) DEFAULT '' NOT NULL,
			keyword_text VARCHAR(255) DEFAULT '' NOT NULL,
			match_type VARCHAR(32) DEFAULT '' NOT NULL,
			state VARCHAR(16) DEFAULT '' NOT NULL,
			bid DECIMAL(10,2) DEFAULT NULL,
			updated_at DATETIME NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY target (profile_id, target_id),
			KEY campaign (campaign_id)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('ads_daily')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			profile_id VARCHAR(32) NOT NULL,
			report_date DATE NOT NULL,
			level VARCHAR(8) NOT NULL,
			campaign_id VARCHAR(32) NOT NULL,
			ad_group_id VARCHAR(32) DEFAULT '' NOT NULL,
			target_id VARCHAR(32) DEFAULT '' NOT NULL,
			keyword_text VARCHAR(255) DEFAULT '' NOT NULL,
			match_type VARCHAR(32) DEFAULT '' NOT NULL,
			impressions INT DEFAULT 0 NOT NULL,
			clicks INT DEFAULT 0 NOT NULL,
			cost DECIMAL(14,4) DEFAULT 0 NOT NULL,
			sales DECIMAL(14,4) DEFAULT 0 NOT NULL,
			orders INT DEFAULT 0 NOT NULL,
			units INT DEFAULT 0 NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY row_key (profile_id, report_date, level, campaign_id, target_id),
			KEY date_level (report_date, level)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('ads_search_terms')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			profile_id VARCHAR(32) NOT NULL,
			row_hash CHAR(40) NOT NULL,
			report_date DATE NOT NULL,
			campaign_id VARCHAR(32) NOT NULL,
			ad_group_id VARCHAR(32) DEFAULT '' NOT NULL,
			target_id VARCHAR(32) DEFAULT '' NOT NULL,
			keyword_text VARCHAR(255) DEFAULT '' NOT NULL,
			match_type VARCHAR(32) DEFAULT '' NOT NULL,
			search_term VARCHAR(255) NOT NULL,
			impressions INT DEFAULT 0 NOT NULL,
			clicks INT DEFAULT 0 NOT NULL,
			cost DECIMAL(14,4) DEFAULT 0 NOT NULL,
			sales DECIMAL(14,4) DEFAULT 0 NOT NULL,
			orders INT DEFAULT 0 NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY row_hash (row_hash),
			KEY report_date (report_date),
			KEY term (search_term(64))
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('ads_actions')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			profile_id VARCHAR(32) DEFAULT '' NOT NULL,
			kind VARCHAR(16) NOT NULL,
			entity_id VARCHAR(64) DEFAULT '' NOT NULL,
			campaign_id VARCHAR(32) DEFAULT '' NOT NULL,
			ad_group_id VARCHAR(32) DEFAULT '' NOT NULL,
			label VARCHAR(255) DEFAULT '' NOT NULL,
			old_value VARCHAR(64) DEFAULT '' NOT NULL,
			new_value VARCHAR(64) DEFAULT '' NOT NULL,
			reason TEXT,
			payload LONGTEXT,
			status VARCHAR(12) DEFAULT 'planned' NOT NULL,
			error TEXT,
			created_at DATETIME NOT NULL,
			applied_at DATETIME DEFAULT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			KEY status (status, created_at),
			KEY kind (kind)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('keywords')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			asin VARCHAR(20) NOT NULL,
			keyword VARCHAR(190) NOT NULL,
			priority TINYINT DEFAULT 2 NOT NULL,
			source VARCHAR(16) DEFAULT 'manual' NOT NULL,
			created_at DATETIME NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY market_asin_kw (market, asin, keyword),
			KEY asin (asin)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('keyword_metrics')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			asin VARCHAR(20) NOT NULL,
			keyword VARCHAR(190) NOT NULL,
			period_start DATE NOT NULL,
			period_end DATE NOT NULL,
			query_score INT DEFAULT 0 NOT NULL,
			query_volume INT DEFAULT 0 NOT NULL,
			impressions_total INT DEFAULT 0 NOT NULL,
			impressions_asin INT DEFAULT 0 NOT NULL,
			clicks_total INT DEFAULT 0 NOT NULL,
			clicks_asin INT DEFAULT 0 NOT NULL,
			cart_adds_total INT DEFAULT 0 NOT NULL,
			cart_adds_asin INT DEFAULT 0 NOT NULL,
			purchases_total INT DEFAULT 0 NOT NULL,
			purchases_asin INT DEFAULT 0 NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY metric_key (market, asin, keyword, period_start),
			KEY period (period_start)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('asin_snapshots')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			asin VARCHAR(20) NOT NULL,
			captured_at DATETIME NOT NULL,
			is_mine TINYINT(1) DEFAULT 0 NOT NULL,
			my_price DECIMAL(14,4) DEFAULT NULL,
			buybox_price DECIMAL(14,4) DEFAULT NULL,
			buybox_seller VARCHAR(32) DEFAULT '' NOT NULL,
			buybox_is_mine TINYINT(1) DEFAULT 0 NOT NULL,
			lowest_price DECIMAL(14,4) DEFAULT NULL,
			offer_count INT DEFAULT 0 NOT NULL,
			fba_offer_count INT DEFAULT 0 NOT NULL,
			bsr INT DEFAULT NULL,
			bsr_category VARCHAR(128) DEFAULT '' NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			KEY asin_time (market, asin, captured_at),
			KEY captured (captured_at)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('offer_sellers')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			asin VARCHAR(20) NOT NULL,
			seller_id VARCHAR(32) NOT NULL,
			is_me TINYINT(1) DEFAULT 0 NOT NULL,
			is_fba TINYINT(1) DEFAULT 0 NOT NULL,
			last_price DECIMAL(14,4) DEFAULT NULL,
			first_seen DATETIME NOT NULL,
			last_seen DATETIME NOT NULL,
			active TINYINT(1) DEFAULT 1 NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY seller_asin (market, asin, seller_id),
			KEY active (active, last_seen)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('solicitations')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			amazon_order_id VARCHAR(32) NOT NULL,
			status VARCHAR(16) NOT NULL,
			message VARCHAR(255) DEFAULT '' NOT NULL,
			attempted_at DATETIME NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY order_id (amazon_order_id),
			KEY status_time (status, attempted_at)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('reimb_cases')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			case_hash CHAR(40) NOT NULL,
			kind VARCHAR(32) NOT NULL,
			market VARCHAR(2) DEFAULT '' NOT NULL,
			sku VARCHAR(64) DEFAULT '' NOT NULL,
			fnsku VARCHAR(20) DEFAULT '' NOT NULL,
			asin VARCHAR(20) DEFAULT '' NOT NULL,
			reference_id VARCHAR(64) DEFAULT '' NOT NULL,
			event_date DATE DEFAULT NULL,
			qty INT DEFAULT 0 NOT NULL,
			est_amount DECIMAL(14,4) DEFAULT 0 NOT NULL,
			currency VARCHAR(3) DEFAULT '' NOT NULL,
			status VARCHAR(16) DEFAULT 'open' NOT NULL,
			amazon_case_id VARCHAR(32) DEFAULT '' NOT NULL,
			evidence LONGTEXT,
			notes TEXT,
			created_at DATETIME NOT NULL,
			updated_at DATETIME NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY case_hash (case_hash),
			KEY status (status, kind)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('ledger')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			row_hash CHAR(40) NOT NULL,
			market VARCHAR(2) DEFAULT '' NOT NULL,
			event_date DATE NOT NULL,
			fnsku VARCHAR(20) DEFAULT '' NOT NULL,
			sku VARCHAR(64) DEFAULT '' NOT NULL,
			asin VARCHAR(20) DEFAULT '' NOT NULL,
			event_type VARCHAR(32) DEFAULT '' NOT NULL,
			reference_id VARCHAR(64) DEFAULT '' NOT NULL,
			qty INT DEFAULT 0 NOT NULL,
			fulfillment_center VARCHAR(16) DEFAULT '' NOT NULL,
			disposition VARCHAR(32) DEFAULT '' NOT NULL,
			reason VARCHAR(16) DEFAULT '' NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY row_hash (row_hash),
			KEY fnsku_date (fnsku, event_date),
			KEY type_reason (event_type, reason)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('reimbursements')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			reimbursement_id VARCHAR(32) NOT NULL,
			market VARCHAR(2) DEFAULT '' NOT NULL,
			approval_date DATE NOT NULL,
			case_id VARCHAR(32) DEFAULT '' NOT NULL,
			amazon_order_id VARCHAR(32) DEFAULT '' NOT NULL,
			reason VARCHAR(64) DEFAULT '' NOT NULL,
			sku VARCHAR(64) DEFAULT '' NOT NULL,
			fnsku VARCHAR(20) DEFAULT '' NOT NULL,
			asin VARCHAR(20) DEFAULT '' NOT NULL,
			amount DECIMAL(14,4) DEFAULT 0 NOT NULL,
			currency VARCHAR(3) DEFAULT '' NOT NULL,
			qty_cash INT DEFAULT 0 NOT NULL,
			qty_inventory INT DEFAULT 0 NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY reimb (reimbursement_id, fnsku),
			KEY order_id (amazon_order_id),
			KEY approval (approval_date)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('returns')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			row_hash CHAR(40) NOT NULL,
			market VARCHAR(2) DEFAULT '' NOT NULL,
			return_date DATE NOT NULL,
			amazon_order_id VARCHAR(32) DEFAULT '' NOT NULL,
			sku VARCHAR(64) DEFAULT '' NOT NULL,
			asin VARCHAR(20) DEFAULT '' NOT NULL,
			fnsku VARCHAR(20) DEFAULT '' NOT NULL,
			qty INT DEFAULT 0 NOT NULL,
			fulfillment_center VARCHAR(16) DEFAULT '' NOT NULL,
			disposition VARCHAR(32) DEFAULT '' NOT NULL,
			reason VARCHAR(64) DEFAULT '' NOT NULL,
			status VARCHAR(48) DEFAULT '' NOT NULL,
			comments VARCHAR(500) DEFAULT '' NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY row_hash (row_hash),
			KEY order_id (amazon_order_id),
			KEY sku_date (sku, return_date)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('traffic_daily')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			report_date DATE NOT NULL,
			asin VARCHAR(20) DEFAULT '' NOT NULL,
			sku VARCHAR(64) DEFAULT '' NOT NULL,
			sessions INT DEFAULT 0 NOT NULL,
			page_views INT DEFAULT 0 NOT NULL,
			buy_box_pct DECIMAL(6,2) DEFAULT 0 NOT NULL,
			units INT DEFAULT 0 NOT NULL,
			order_items INT DEFAULT 0 NOT NULL,
			ordered_sales DECIMAL(14,4) DEFAULT 0 NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY day_asin (market, report_date, asin),
			KEY report_date (report_date)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('listing_audits')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			sku VARCHAR(64) NOT NULL,
			asin VARCHAR(20) DEFAULT '' NOT NULL,
			score INT DEFAULT 0 NOT NULL,
			status VARCHAR(32) DEFAULT '' NOT NULL,
			content_hash CHAR(40) DEFAULT '' NOT NULL,
			findings LONGTEXT,
			snapshot LONGTEXT,
			audited_at DATETIME NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY market_sku (market, sku)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('inventory_health')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			market VARCHAR(2) NOT NULL,
			snapshot_date DATE NOT NULL,
			sku VARCHAR(64) NOT NULL,
			asin VARCHAR(20) DEFAULT '' NOT NULL,
			available INT DEFAULT 0 NOT NULL,
			age_0_90 INT DEFAULT 0 NOT NULL,
			age_91_180 INT DEFAULT 0 NOT NULL,
			age_181_270 INT DEFAULT 0 NOT NULL,
			age_271_365 INT DEFAULT 0 NOT NULL,
			age_365_plus INT DEFAULT 0 NOT NULL,
			units_t30 INT DEFAULT 0 NOT NULL,
			sell_through DECIMAL(8,2) DEFAULT NULL,
			days_of_supply INT DEFAULT NULL,
			est_storage_cost DECIMAL(14,4) DEFAULT NULL,
			recommended_action VARCHAR(64) DEFAULT '' NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY snap_sku (market, snapshot_date, sku)
		) {$c};" );

		dbDelta( "CREATE TABLE {$t('feedback')} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			row_hash CHAR(40) NOT NULL,
			market VARCHAR(2) DEFAULT '' NOT NULL,
			feedback_date DATE NOT NULL,
			rating TINYINT DEFAULT 0 NOT NULL,
			comments TEXT,
			amazon_order_id VARCHAR(32) DEFAULT '' NOT NULL,
			is_demo TINYINT(1) DEFAULT 0 NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY row_hash (row_hash),
			KEY rating_date (rating, feedback_date)
		) {$c};" );

		update_option( self::OPTION, self::VERSION, false );
	}

	/** Drop every suite table (used by uninstall + tests). */
	public static function drop_all(): void {
		global $wpdb;
		foreach ( self::TABLES as $short ) {
			$wpdb->query( 'DROP TABLE IF EXISTS ' . self::table( $short ) ); // phpcs:ignore WordPress.DB.PreparedSQL
		}
		delete_option( self::OPTION );
	}
}
