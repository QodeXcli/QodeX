<?php
/**
 * SuiteModule — Amazon Seller Suite: wiring, admin app shell, schedules.
 *
 * Registers every suite service in the container, the "Amazon Suite"
 * top-level admin page (a single-page app talking to the REST controller),
 * and three WP-Cron/Action-Scheduler cadences:
 *
 *   sg_suite_tick    every 15 min  orders (API), report polling, listing monitor
 *   sg_suite_hourly  hourly        finances, review requests
 *   sg_suite_daily   daily         report requests, Ads sync, PPC plan,
 *                                  reimbursement scan, listing audits, pruning
 *
 * @package SevenGum\Commerce\Suite
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Cache\CacheManager;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Suite\Ads\AdsClient;
use SevenGum\Commerce\Suite\Ads\AdsInsights;
use SevenGum\Commerce\Suite\Ads\AdsSync;
use SevenGum\Commerce\Suite\Demo\DemoSeeder;
use SevenGum\Commerce\Suite\Finance\FinanceSync;
use SevenGum\Commerce\Suite\Inventory\RestockPlanner;
use SevenGum\Commerce\Suite\Keywords\KeywordService;
use SevenGum\Commerce\Suite\Listings\ListingAuditor;
use SevenGum\Commerce\Suite\Monitor\ListingMonitor;
use SevenGum\Commerce\Suite\Orders\OrdersSync;
use SevenGum\Commerce\Suite\Profit\CostBook;
use SevenGum\Commerce\Suite\Profit\ProfitEngine;
use SevenGum\Commerce\Suite\Reimbursements\ReimbursementAuditor;
use SevenGum\Commerce\Suite\Reports\ReportIngestor;
use SevenGum\Commerce\Suite\Reports\ReportPipeline;
use SevenGum\Commerce\Suite\Reports\ReportsClient;
use SevenGum\Commerce\Suite\Research\ProductResearch;
use SevenGum\Commerce\Suite\Rest\SuiteController;
use SevenGum\Commerce\Suite\Reviews\ReviewRequester;
use SevenGum\Commerce\Suite\Support\Db;

defined( 'ABSPATH' ) || exit;

final class SuiteModule implements Module {

	public const PAGE  = 'sg-suite';
	public const HOOKS = array(
		'sg_suite_tick'   => 'sg_fifteen_minutes',
		'sg_suite_hourly' => 'hourly',
		'sg_suite_daily'  => 'daily',
	);

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'suite';
	}

	public function register(): void {
		$this->bind();

		add_action( 'admin_init', array( $this, 'ensure_installed' ), 2 );
		add_action( 'admin_menu', array( $this, 'menu' ), 20 );
		add_action( 'admin_enqueue_scripts', array( $this, 'assets' ) );
		add_action( 'rest_api_init', function (): void {
			$this->container->get( SuiteController::class )->routes();
		} );

		add_action( 'sg_suite_tick', array( $this, 'tick' ) );
		add_action( 'sg_suite_hourly', array( $this, 'hourly' ) );
		add_action( 'sg_suite_daily', array( $this, 'daily' ) );
		add_action( 'sg_suite_report_ingested', array( $this, 'after_report' ), 10, 3 );
	}

	private function bind(): void {
		$c = $this->container;
		$c->singleton( SuiteSettings::class, static fn( Container $c ) => new SuiteSettings( $c->get( SettingsRepository::class ) ) );
		$c->singleton( CostBook::class, static fn( Container $c ) => new CostBook( $c->get( SuiteSettings::class ) ) );
		$c->singleton( ReportsClient::class, static fn( Container $c ) => new ReportsClient( $c->get( AmazonClient::class ) ) );
		$c->singleton( OrdersSync::class, static fn( Container $c ) => new OrdersSync( $c->get( AmazonClient::class ), $c->get( Marketplaces::class ), $c->get( SuiteSettings::class ), $c->get( Logger::class ) ) );
		$c->singleton( ReportIngestor::class, static fn( Container $c ) => new ReportIngestor( $c->get( OrdersSync::class ) ) );
		$c->singleton( AdsClient::class, static fn( Container $c ) => new AdsClient( $c->get( SuiteSettings::class ), $c->get( CacheManager::class ), $c->get( Logger::class ) ) );
		$c->singleton( AdsSync::class, static fn( Container $c ) => new AdsSync( $c->get( AdsClient::class ), $c->get( SuiteSettings::class ), $c->get( Logger::class ) ) );
		$c->singleton( AdsInsights::class, static fn() => new AdsInsights() );
		$c->singleton( ReportPipeline::class, static fn( Container $c ) => new ReportPipeline(
			$c->get( ReportsClient::class ), $c->get( ReportIngestor::class ), $c->get( AdsClient::class ),
			$c->get( AdsSync::class ), $c->get( Marketplaces::class ), $c->get( Logger::class )
		) );
		$c->singleton( FinanceSync::class, static fn( Container $c ) => new FinanceSync( $c->get( AmazonClient::class ), $c->get( Marketplaces::class ), $c->get( SuiteSettings::class ), $c->get( Logger::class ) ) );
		$c->singleton( ProfitEngine::class, static fn( Container $c ) => new ProfitEngine( $c->get( CostBook::class ), $c->get( Marketplaces::class ), $c->get( SuiteSettings::class ) ) );
		$c->singleton( RestockPlanner::class, static fn( Container $c ) => new RestockPlanner( $c->get( CostBook::class ), $c->get( SuiteSettings::class ) ) );
		$c->singleton( KeywordService::class, static fn( Container $c ) => new KeywordService( $c->get( AdsClient::class ) ) );
		$c->singleton( ListingAuditor::class, static fn( Container $c ) => new ListingAuditor( $c->get( AmazonClient::class ), $c->get( SuiteSettings::class ), $c->get( Logger::class ) ) );
		$c->singleton( ListingMonitor::class, static fn( Container $c ) => new ListingMonitor( $c->get( AmazonClient::class ), $c->get( Marketplaces::class ), $c->get( SuiteSettings::class ), $c->get( Logger::class ) ) );
		$c->singleton( ReviewRequester::class, static fn( Container $c ) => new ReviewRequester( $c->get( AmazonClient::class ), $c->get( SuiteSettings::class ), $c->get( Logger::class ) ) );
		$c->singleton( ReimbursementAuditor::class, static fn() => new ReimbursementAuditor() );
		$c->singleton( ProductResearch::class, static fn( Container $c ) => new ProductResearch( $c->get( AmazonClient::class ) ) );
		$c->singleton( DemoSeeder::class, static fn( Container $c ) => new DemoSeeder( $c->get( ReimbursementAuditor::class ) ) );
		$c->singleton( SuiteController::class, static fn( Container $c ) => new SuiteController( $c ) );
	}

	/** Create tables + schedules for sites that updated without re-activating. */
	public function ensure_installed(): void {
		SuiteSchema::maybe_install();
		self::schedule();
	}

	public static function schedule(): void {
		foreach ( self::HOOKS as $hook => $recurrence ) {
			if ( ! wp_next_scheduled( $hook ) ) {
				wp_schedule_event( time() + 120, $recurrence, $hook );
			}
		}
	}

	public static function unschedule(): void {
		foreach ( array_keys( self::HOOKS ) as $hook ) {
			wp_clear_scheduled_hook( $hook );
		}
	}

	public function menu(): void {
		add_menu_page(
			'Amazon Seller Suite',
			'Amazon Suite',
			'manage_options',
			self::PAGE,
			array( $this, 'render' ),
			'dashicons-chart-area',
			57
		);
		$sections = array(
			''               => 'Dashboard',
			'profit'         => 'Profit & P&L',
			'orders'         => 'Orders',
			'restock'        => 'Inventory & Restock',
			'ppc'            => 'PPC Manager',
			'keywords'       => 'Keywords',
			'listings'       => 'Listing Optimizer',
			'monitor'        => 'Hijacker & Buy Box',
			'reviews'        => 'Review Requests',
			'reimbursements' => 'Reimbursements',
			'research'       => 'Product Research',
			'reports'        => 'Reports Center',
			'settings'       => 'Suite Settings',
		);
		foreach ( $sections as $route => $label ) {
			add_submenu_page( self::PAGE, $label, $label, 'manage_options', self::PAGE . ( '' === $route ? '' : '#/' . $route ), array( $this, 'render' ) );
		}
	}

	public function assets( string $hook ): void {
		if ( ! str_contains( $hook, self::PAGE ) ) {
			return;
		}
		wp_enqueue_style( 'sg-suite', SG_COMMERCE_URL . 'assets/css/suite.css', array(), SG_COMMERCE_VERSION );
		wp_enqueue_script( 'sg-suite', SG_COMMERCE_URL . 'assets/js/suite.js', array(), SG_COMMERCE_VERSION, true );
		$mp = $this->container->get( Marketplaces::class );
		$markets = array();
		foreach ( $mp->enabled_codes() as $code ) {
			$m = $mp->get( $code );
			$markets[] = array( 'code' => $code, 'currency' => $m['currency'] ?? 'USD', 'country' => $m['country'] ?? $code, 'tld' => $m['tld'] ?? 'com' );
		}
		wp_localize_script( 'sg-suite', 'SGSuite', array(
			'root'      => esc_url_raw( rest_url( 'sg-commerce/v1/suite' ) ),
			'nonce'     => wp_create_nonce( 'wp_rest' ),
			'markets'   => $markets,
			'primary'   => $mp->primary(),
			'connected' => $this->container->get( AmazonClient::class )->has_credentials(),
			'ads'       => $this->container->get( AdsClient::class )->is_ready(),
			'demo'      => DemoSeeder::active(),
			'version'   => SG_COMMERCE_VERSION,
			'coreUrl'   => admin_url( 'admin.php?page=sg-commerce-amazon' ),
		) );
	}

	public function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'sg-commerce' ) );
		}
		require SG_COMMERCE_DIR . 'admin/views/suite.php';
	}

	/* ------------------------------------------------------------------ */
	/* Schedules                                                          */
	/* ------------------------------------------------------------------ */

	private function can_sync(): bool {
		return $this->container->get( SuiteSettings::class )->bool( 'suite_sync_enabled' )
			&& $this->container->get( AmazonClient::class )->has_credentials();
	}

	public function tick(): void {
		$this->guard( 'pipeline', fn() => $this->container->get( ReportPipeline::class )->poll( 8 ) );
		if ( ! $this->can_sync() ) {
			return;
		}
		$this->guard( 'orders', fn() => $this->container->get( OrdersSync::class )->run() );
		if ( $this->container->get( SuiteSettings::class )->bool( 'suite_monitor_enabled' ) ) {
			$this->guard( 'monitor', fn() => $this->container->get( ListingMonitor::class )->run() );
		}
	}

	public function hourly(): void {
		if ( ! $this->can_sync() ) {
			return;
		}
		$this->guard( 'finance', fn() => $this->container->get( FinanceSync::class )->run() );
		$this->guard( 'reviews', fn() => $this->container->get( ReviewRequester::class )->run() );
	}

	public function daily(): void {
		$pipeline = $this->container->get( ReportPipeline::class );
		if ( $this->can_sync() ) {
			$this->guard( 'reports.daily', fn() => $pipeline->request_scheduled( 'daily' ) );
			$last_weekly = (int) get_option( 'sg_suite_last_weekly', 0 );
			if ( time() - $last_weekly > 6 * DAY_IN_SECONDS ) {
				$this->guard( 'reports.weekly', fn() => $pipeline->request_scheduled( 'weekly', $this->sqp_asins() ) );
				update_option( 'sg_suite_last_weekly', time(), false );
			}
			$this->guard( 'listings', fn() => $this->audit_batch( 25 ) );
		}
		$ads = $this->container->get( AdsClient::class );
		$settings = $this->container->get( SuiteSettings::class );
		if ( $settings->bool( 'suite_ads_enabled' ) && $ads->is_ready() ) {
			$sync = $this->container->get( AdsSync::class );
			$this->guard( 'ads.structure', fn() => $sync->sync_structure() );
			$this->guard( 'ads.reports', fn() => $sync->request_reports( gmdate( 'Y-m-d', time() - 8 * DAY_IN_SECONDS ), gmdate( 'Y-m-d', time() - DAY_IN_SECONDS ) ) );
		}
		$this->guard( 'reimbursements', fn() => $this->container->get( ReimbursementAuditor::class )->scan() );
		$this->guard( 'prune', function () use ( $pipeline ) {
			$pipeline->prune();
			$this->container->get( ListingMonitor::class )->prune();
			return true;
		} );
	}

	/** Re-plan PPC once the targeting/search-term data for the day lands. */
	public function after_report( string $type, string $market, int $rows ): void {
		if ( ! in_array( $type, array( 'spTargeting', 'spSearchTerm' ), true ) ) {
			return;
		}
		if ( get_transient( 'sg_suite_ads_optimized' ) ) {
			return;
		}
		set_transient( 'sg_suite_ads_optimized', 1, 6 * HOUR_IN_SECONDS );
		$this->guard( 'ads.optimize', fn() => $this->container->get( AdsSync::class )->optimize() );
	}

	/** @return array<string, string[]> market => own ASINs */
	public function sqp_asins(): array {
		global $wpdb;
		$out = array();
		$rows = $wpdb->get_results( "SELECT DISTINCT market, asin FROM {$wpdb->prefix}sg_products WHERE asin <> '' AND sku NOT LIKE 'DEMO-%'", ARRAY_A ) ?: array(); // phpcs:ignore
		foreach ( $rows as $r ) {
			$out[ (string) $r['market'] ][] = (string) $r['asin'];
		}
		return $out;
	}

	public function audit_batch( int $limit ): int {
		global $wpdb;
		$rows = $wpdb->get_results( $wpdb->prepare(
			"SELECT p.market, p.sku, p.asin FROM {$wpdb->prefix}sg_products p
			 LEFT JOIN " . SuiteSchema::table( 'listing_audits' ) . " a ON a.market = p.market AND a.sku = p.sku
			 WHERE p.sku NOT LIKE %s ORDER BY a.audited_at IS NOT NULL, a.audited_at ASC LIMIT %d",
			'DEMO-%', $limit
		), ARRAY_A ) ?: array(); // phpcs:ignore
		$auditor = $this->container->get( ListingAuditor::class );
		$n = 0;
		foreach ( $rows as $r ) {
			$kw = array_column( Db::rows( 'SELECT keyword FROM {t:keywords} WHERE market = %s AND asin = %s', array( $r['market'], $r['asin'] ) ), 'keyword' );
			try {
				$auditor->audit( (string) $r['market'], (string) $r['sku'], $kw );
				$n++;
			} catch ( \Throwable $e ) {
				$this->container->get( Logger::class )->warning( 'Listing audit failed', array( 'sku' => $r['sku'], 'error' => $e->getMessage() ) );
				if ( str_contains( $e->getMessage(), 'Seller ID' ) ) {
					break;
				}
			}
		}
		return $n;
	}

	/** Run a job, log failures, record last-run status for the Settings screen. */
	public function guard( string $job, callable $fn ): mixed {
		$status = get_option( 'sg_suite_job_status', array() );
		$status = is_array( $status ) ? $status : array();
		try {
			$result = $fn();
			$status[ $job ] = array( 'at' => time(), 'ok' => true, 'result' => is_scalar( $result ) || is_array( $result ) ? $result : null );
			update_option( 'sg_suite_job_status', $status, false );
			return $result;
		} catch ( \Throwable $e ) {
			$status[ $job ] = array( 'at' => time(), 'ok' => false, 'error' => mb_substr( $e->getMessage(), 0, 300 ) );
			update_option( 'sg_suite_job_status', $status, false );
			$this->container->get( Logger::class )->error( "Suite job {$job} failed: " . $e->getMessage() );
			return null;
		}
	}
}
