<?php
/**
 * InboundShipmentModule — container wiring + DB table + admin handlers
 * for the v3.3 Send-to-Amazon stack.
 *
 * Registers:
 *   - CatalogLookup
 *   - ListingsClient
 *   - AplusContentClient
 *   - InboundShipmentClient
 *   - BoxContentService
 *   - LabelGenerator
 *
 * And creates a `sg_inbound_plans` table to persist plan metadata locally
 * (plan ID, status, destination market, carton counts, timestamps).
 *
 * @package SevenGum\Commerce\Amazon\InboundShipment
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon\InboundShipment;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\AplusContent\AplusContentClient;
use SevenGum\Commerce\Amazon\CatalogItems\CatalogLookup;
use SevenGum\Commerce\Amazon\Listings\ListingsClient;
use SevenGum\Commerce\Cache\CacheManager;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Fulfillment\BoxContent\BoxContentService;
use SevenGum\Commerce\Fulfillment\LabelGenerator\LabelGenerator;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class InboundShipmentModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'inbound';
	}

	public function register(): void {
		$c = $this->container;

		$c->singleton( CatalogLookup::class, static fn( Container $c ) =>
			new CatalogLookup(
				$c->get( AmazonClient::class ),
				$c->get( CacheManager::class ),
				$c->get( Logger::class )
			)
		);

		$c->singleton( ListingsClient::class, static fn( Container $c ) =>
			new ListingsClient(
				$c->get( AmazonClient::class ),
				$c->get( SettingsRepository::class ),
				$c->get( Logger::class )
			)
		);

		$c->singleton( AplusContentClient::class, static fn( Container $c ) =>
			new AplusContentClient(
				$c->get( AmazonClient::class ),
				$c->get( Logger::class )
			)
		);

		$c->singleton( InboundShipmentClient::class, static fn( Container $c ) =>
			new InboundShipmentClient(
				$c->get( AmazonClient::class ),
				$c->get( Logger::class )
			)
		);

		$c->singleton( BoxContentService::class, static fn( Container $c ) =>
			new BoxContentService(
				$c->get( InboundShipmentClient::class ),
				$c->get( Logger::class )
			)
		);

		$c->singleton( LabelGenerator::class, static fn( Container $c ) =>
			new LabelGenerator( $c->get( Logger::class ) )
		);
	}
}
