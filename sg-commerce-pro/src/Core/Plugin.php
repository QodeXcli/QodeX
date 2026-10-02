<?php
/**
 * Plugin — main orchestrator.
 *
 * This class:
 *   1. Owns the singleton Container instance
 *   2. Wires every service binding (Logger, Cache, Encryption, Repositories,
 *      Amazon client, AI providers, Analytics, Repricer, Admin, etc.)
 *   3. Instantiates and registers every Module
 *   4. Adds custom cron schedules
 *   5. Wires global cron + WP-CLI entry points
 *
 * @package SevenGum\Commerce\Core
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Core;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\AI\AIModule;
use SevenGum\Commerce\AI\Providers\OllamaProvider;
use SevenGum\Commerce\AI\PromptRegistry;
use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\AmazonModule;
use SevenGum\Commerce\Amazon\CircuitBreaker;
use SevenGum\Commerce\Amazon\InboundShipment\InboundShipmentModule;
use SevenGum\Commerce\Amazon\LWATokenManager;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Amazon\RateLimiter;
use SevenGum\Commerce\Amazon\SyncOrchestrator;
use SevenGum\Commerce\Amazon\SQSConsumer\SQSConsumer;
use SevenGum\Commerce\Analytics\AnalyticsModule;
use SevenGum\Commerce\Analytics\ProfitCalculator;
use SevenGum\Commerce\Analytics\SalesAggregator;
use SevenGum\Commerce\API\HeadlessAPI;
use SevenGum\Commerce\Automation\AutomationModule;
use SevenGum\Commerce\Automation\RulesEngine;
use SevenGum\Commerce\Cache\CacheManager;
use SevenGum\Commerce\Comparison\ComparisonModule;
use SevenGum\Commerce\Database\Repositories\PriceHistoryRepository;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Events\EventDispatcher;
use SevenGum\Commerce\Fulfillment\FulfillmentModule;
use SevenGum\Commerce\Geotargeting\GeotargetingModule;
use SevenGum\Commerce\Injection\InjectionModule;
use SevenGum\Commerce\Integration\IntegrationModule;
use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Queue\JobQueue;
use SevenGum\Commerce\REST\RESTModule;
use SevenGum\Commerce\Repricer\RepricerEngine;
use SevenGum\Commerce\Repricer\RepricerModule;
use SevenGum\Commerce\Security\Encryption;
use SevenGum\Commerce\Security\PIIManager\PIIManager;
use SevenGum\Commerce\Widget\WidgetModule;

defined( 'ABSPATH' ) || exit;

final class Plugin {

	private static ?self $instance = null;
	private Container $container;
	/** @var Module[] */
	private array $modules = array();
	private bool $booted = false;

	public static function instance(): self {
		return self::$instance ??= new self();
	}

	private function __construct() {
		$this->container = new Container();
	}

	public function container(): Container {
		return $this->container;
	}

	/**
	 * Main entrypoint. Idempotent — multiple calls are safe.
	 */
	public function boot(): void {
		if ( $this->booted ) {
			return;
		}
		$this->booted = true;

		$this->register_cron_schedules();
		$this->register_services();
		$this->register_modules();
		$this->register_global_hooks();

		// Auto-migrate schema when the plugin is updated without re-activation
		// (e.g. FTP upload, git pull). Runs on admin_init so it only fires
		// once an admin hits wp-admin — safe and cheap.
		add_action( 'admin_init', array( $this, 'maybe_upgrade_schema' ), 1 );
	}

	public function maybe_upgrade_schema(): void {
		$stored = (int) get_option( 'sg_commerce_schema_version', 0 );
		if ( $stored < \SevenGum\Commerce\Database\Schema::SCHEMA_VERSION ) {
			\SevenGum\Commerce\Database\Schema::install();
			// Also seed any new defaults/templates that v3.3 introduced.
			if ( class_exists( '\\SevenGum\\Commerce\\Fulfillment\\BoxContent\\BoxContentService' ) ) {
				\SevenGum\Commerce\Fulfillment\BoxContent\BoxContentService::seed_default_template();
			}
			$this->container->get( Logger::class )->info( 'Schema auto-upgraded', array(
				'from' => $stored,
				'to'   => \SevenGum\Commerce\Database\Schema::SCHEMA_VERSION,
			) );
		}
	}

	/* ------------------------------------------------------------------ */
	/* Cron schedules                                                     */
	/* ------------------------------------------------------------------ */

	private function register_cron_schedules(): void {
		// NOTE: `cron_schedules` fires VERY early in the request, sometimes
		// before `init`. Using __() here triggers WP 6.7+ "textdomain loaded
		// too early" notice. These display labels are admin-only polish, so
		// we use plain English strings — the functional "interval" values
		// are what actually matters.
		add_filter( 'cron_schedules', static function ( array $schedules ): array {
			$schedules['sg_five_minutes'] = array(
				'interval' => 5 * MINUTE_IN_SECONDS,
				'display'  => 'Every 5 minutes (Seven Gum)',
			);
			$schedules['sg_fifteen_minutes'] = array(
				'interval' => 15 * MINUTE_IN_SECONDS,
				'display'  => 'Every 15 minutes (Seven Gum)',
			);
			$schedules['sg_six_hours'] = array(
				'interval' => 6 * HOUR_IN_SECONDS,
				'display'  => 'Every 6 hours (Seven Gum)',
			);
			return $schedules;
		} );
	}

	/* ------------------------------------------------------------------ */
	/* Service bindings                                                   */
	/* ------------------------------------------------------------------ */

	private function register_services(): void {
		$c = $this->container;

		// Foundational singletons.
		$c->singleton( Logger::class, static fn() => new Logger() );
		$c->singleton( Encryption::class, static fn() => new Encryption() );
		$c->singleton( CacheManager::class, static fn() => new CacheManager() );
		$c->singleton( EventDispatcher::class, static fn() => new EventDispatcher() );
		$c->singleton( JobQueue::class, static fn( Container $c ) =>
			new JobQueue( $c->get( Logger::class ) )
		);

		// Repositories — share a single $wpdb-backed instance.
		$c->singleton( SettingsRepository::class, static fn( Container $c ) =>
			new SettingsRepository( $c->get( Encryption::class ), $c->get( Logger::class ) )
		);
		$c->singleton( ProductRepository::class, static fn( Container $c ) =>
			new ProductRepository( $c->get( CacheManager::class ), $c->get( Logger::class ) )
		);
		$c->singleton( PriceHistoryRepository::class, static fn( Container $c ) =>
			new PriceHistoryRepository( $c->get( Logger::class ) )
		);

		// Amazon stack.
		$c->singleton( Marketplaces::class, static fn() => new Marketplaces() );
		$c->singleton( RateLimiter::class, static fn( Container $c ) =>
			new RateLimiter( $c->get( CacheManager::class ) )
		);
		$c->singleton( CircuitBreaker::class, static fn( Container $c ) =>
			new CircuitBreaker( $c->get( CacheManager::class ), $c->get( Logger::class ) )
		);
		$c->singleton( LWATokenManager::class, static fn( Container $c ) =>
			new LWATokenManager(
				$c->get( SettingsRepository::class ),
				$c->get( CacheManager::class ),
				$c->get( Logger::class )
			)
		);
		$c->singleton( AmazonClient::class, static fn( Container $c ) =>
			new AmazonClient(
				$c->get( LWATokenManager::class ),
				$c->get( Marketplaces::class ),
				$c->get( RateLimiter::class ),
				$c->get( CircuitBreaker::class ),
				$c->get( Logger::class )
			)
		);
		$c->singleton( SyncOrchestrator::class, static fn( Container $c ) =>
			new SyncOrchestrator(
				$c->get( AmazonClient::class ),
				$c->get( Marketplaces::class ),
				$c->get( ProductRepository::class ),
				$c->get( PriceHistoryRepository::class ),
				$c->get( EventDispatcher::class ),
				$c->get( Logger::class )
			)
		);

		// AI stack.
		$c->singleton( PromptRegistry::class, static fn( Container $c ) =>
			new PromptRegistry( $c->get( SettingsRepository::class ) )
		);
		$c->singleton( OllamaProvider::class, static fn( Container $c ) =>
			new OllamaProvider(
				$c->get( SettingsRepository::class ),
				$c->get( CacheManager::class ),
				$c->get( Logger::class )
			)
		);

		// Analytics.
		$c->singleton( SalesAggregator::class, static fn( Container $c ) =>
			new SalesAggregator(
				$c->get( ProductRepository::class ),
				$c->get( PriceHistoryRepository::class ),
				$c->get( Logger::class )
			)
		);
		$c->singleton( ProfitCalculator::class, static fn( Container $c ) =>
			new ProfitCalculator( $c->get( SettingsRepository::class ) )
		);

		// Automation + Repricer.
		$c->singleton( RulesEngine::class, static fn( Container $c ) =>
			new RulesEngine(
				$c->get( SettingsRepository::class ),
				$c->get( EventDispatcher::class ),
				$c->get( Logger::class )
			)
		);
		$c->singleton( RepricerEngine::class, static fn( Container $c ) =>
			new RepricerEngine(
				$c->get( ProductRepository::class ),
				$c->get( SettingsRepository::class ),
				$c->get( ProfitCalculator::class ),
				$c->get( Logger::class )
			)
		);
	}

	/* ------------------------------------------------------------------ */
	/* Modules                                                            */
	/* ------------------------------------------------------------------ */

	private function register_modules(): void {
		$module_classes = apply_filters(
			'sg_commerce_modules',
			array(
				AmazonModule::class,
				AIModule::class,
				AnalyticsModule::class,
				AutomationModule::class,
				RepricerModule::class,
				FulfillmentModule::class,
				InboundShipmentModule::class,
				GeotargetingModule::class,
				InjectionModule::class,
				ComparisonModule::class,
				IntegrationModule::class,
				PIIManager::class,
				SQSConsumer::class,
				HeadlessAPI::class,
				WidgetModule::class,
				RESTModule::class,
				AdminModule::class,
			)
		);

		foreach ( $module_classes as $cls ) {
			if ( ! class_exists( $cls ) ) {
				continue;
			}
			try {
				/** @var Module $module */
				$module = new $cls( $this->container );
				$module->register();
				$this->modules[ $module->id() ] = $module;
				$this->container->instance( 'module.' . $module->id(), $module );
				// CRITICAL: also bind under the FQCN so admin views and CLI
				// commands can resolve the module directly via $container->get($cls::class).
				$this->container->instance( $cls, $module );
			} catch ( \Throwable $e ) {
				$this->container->get( Logger::class )->error(
					sprintf( 'Module %s failed to register: %s', $cls, $e->getMessage() )
				);
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Global hooks                                                       */
	/* ------------------------------------------------------------------ */

	private function register_global_hooks(): void {
		// CLI registration deferred to inside the if-block to avoid loading
		// the CLI namespace when WP-CLI isn't running.
		if ( defined( 'WP_CLI' ) && WP_CLI && class_exists( '\\WP_CLI' ) ) {
			\WP_CLI::add_command( 'sg-commerce', \SevenGum\Commerce\CLI\CommandRegistry::class );
		}

		// Admin row links.
		add_filter( 'plugin_action_links_' . SG_COMMERCE_BASENAME, static function ( array $links ): array {
			$settings_link = sprintf(
				'<a href="%s">%s</a>',
				esc_url( admin_url( 'admin.php?page=sg-commerce' ) ),
				esc_html__( 'Dashboard', 'sg-commerce' )
			);
			array_unshift( $links, $settings_link );
			return $links;
		} );
	}

	/** @return Module[] */
	public function modules(): array {
		return $this->modules;
	}
}
