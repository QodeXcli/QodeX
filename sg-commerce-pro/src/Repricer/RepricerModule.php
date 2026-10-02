<?php
/**
 * RepricerModule — registers the repricer cron tick.
 *
 * @package SevenGum\Commerce\Repricer
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Repricer;

use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class RepricerModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'repricer';
	}

	public function register(): void {
		add_action( 'sg_commerce_repricer_tick', function (): void {
			try {
				$this->container->get( RepricerEngine::class )->tick();
			} catch ( \Throwable $e ) {
				$this->container->get( Logger::class )->error( 'repricer tick failed: ' . $e->getMessage() );
			}
		} );
	}
}
