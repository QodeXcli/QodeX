<?php
/**
 * AmazonModule — wires Amazon services into WordPress.
 *
 * Hooks the cron sync action and exposes the orchestrator + client
 * via the container so other modules can pull them.
 *
 * @package SevenGum\Commerce\Amazon
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon;

use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;

defined( 'ABSPATH' ) || exit;

final class AmazonModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'amazon';
	}

	public function register(): void {
		add_action( 'sg_commerce_hourly_sync', function (): void {
			$this->container->get( SyncOrchestrator::class )->cron_sync();
		} );
	}
}
