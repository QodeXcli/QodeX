<?php
/**
 * AnalyticsModule — wires analytics services and prune cron.
 *
 * @package SevenGum\Commerce\Analytics
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Analytics;

use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\PriceHistoryRepository;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;

defined( 'ABSPATH' ) || exit;

final class AnalyticsModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'analytics';
	}

	public function register(): void {
		// Daily: prune old price-history rows according to retention setting.
		add_action( 'sg_commerce_daily_analytics', function (): void {
			$retain = (int) $this->container->get( SettingsRepository::class )->get( 'log_retention_days', 90 );
			if ( $retain > 0 ) {
				$this->container->get( PriceHistoryRepository::class )->prune_older_than( $retain );
			}
		} );
	}
}
