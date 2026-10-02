<?php
/**
 * GeotargetingModule — wires GeoResolver and plugs it into the Widget.
 *
 * Adds a filter on shortcode attributes: if `market` is set to `auto`
 * (the default when not specified), Widget uses the resolved visitor market.
 *
 * Also registers a small REST endpoint for JS clients to ask "what market
 * would you auto-pick for me right now", useful for front-end personalization.
 *
 * @package SevenGum\Commerce\Geotargeting
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Geotargeting;

use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Cache\CacheManager;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;

defined( 'ABSPATH' ) || exit;

final class GeotargetingModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'geo';
	}

	public function register(): void {
		$c = $this->container;

		$c->singleton( GeoResolver::class, static fn( Container $c ) =>
			new GeoResolver( $c->get( Marketplaces::class ), $c->get( CacheManager::class ) )
		);

		// Widget shortcode filter: resolve 'auto' market to the visitor's market.
		add_filter( 'shortcode_atts_sg_product', array( $this, 'resolve_auto_market' ), 10, 3 );
		add_filter( 'shortcode_atts_sg_compare', array( $this, 'resolve_auto_market' ), 10, 3 );

		// REST endpoint for JS clients.
		add_action( 'rest_api_init', function (): void {
			register_rest_route( 'sg-commerce/v1', '/geo', array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => array( $this, 'rest_geo' ),
			) );
		} );

		// Handle market override from query string. Sets cookie then redirects
		// back without the query arg for clean URLs.
		add_action( 'init', array( $this, 'maybe_set_override' ), 1 );
	}

	public function resolve_auto_market( array $out, array $pairs, array $atts ): array {
		$market = strtolower( (string) ( $out['market'] ?? 'auto' ) );
		if ( 'auto' === $market || '' === $market ) {
			$out['market'] = $this->container->get( GeoResolver::class )->market();
		} else {
			$out['market'] = strtoupper( (string) $out['market'] );
		}
		return $out;
	}

	public function rest_geo(): \WP_REST_Response {
		$resolver = $this->container->get( GeoResolver::class );
		return rest_ensure_response( array(
			'country'    => $resolver->country(),
			'market'     => $resolver->market(),
			'overridden' => $resolver->was_overridden(),
		) );
	}

	public function maybe_set_override(): void {
		if ( empty( $_GET['sg_market'] ) ) return; // phpcs:ignore WordPress.Security.NonceVerification
		$m = strtoupper( preg_replace( '/[^A-Z]/i', '', (string) $_GET['sg_market'] ) ); // phpcs:ignore
		if ( 2 !== strlen( $m ) ) return;
		$this->container->get( GeoResolver::class )->set_override( $m );
	}
}
