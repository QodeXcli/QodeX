<?php
/**
 * RESTModule — registers the sg-commerce/v1 REST namespace.
 *
 * Public:
 *   GET  /product/{market}/{sku}        live product state for widgets
 * Admin (requires manage_options):
 *   POST /sync/{market}                 manually trigger a sync
 *   POST /describe/{id}                 generate AI description
 *   POST /translate/{id}/{market}       translate to a market language
 *
 * @package SevenGum\Commerce\REST
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\REST;

use SevenGum\Commerce\AI\Copywriter;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Amazon\SyncOrchestrator;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\ProductRepository;

defined( 'ABSPATH' ) || exit;

final class RESTModule implements Module {

	public const NAMESPACE = 'sg-commerce/v1';

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'rest';
	}

	public function register(): void {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	public function register_routes(): void {
		register_rest_route( self::NAMESPACE, '/product/(?P<market>[A-Z]{2})/(?P<sku>[A-Za-z0-9_\-\.]+)', array(
			'methods'             => 'GET',
			'permission_callback' => '__return_true',
			'callback'            => array( $this, 'route_get_product' ),
		) );
		register_rest_route( self::NAMESPACE, '/sync/(?P<market>[A-Z]{2})', array(
			'methods'             => 'POST',
			'permission_callback' => function () { return current_user_can( 'manage_options' ); },
			'callback'            => array( $this, 'route_sync' ),
		) );
		register_rest_route( self::NAMESPACE, '/describe/(?P<id>\d+)', array(
			'methods'             => 'POST',
			'permission_callback' => function () { return current_user_can( 'manage_options' ); },
			'callback'            => array( $this, 'route_describe' ),
		) );
		register_rest_route( self::NAMESPACE, '/translate/(?P<id>\d+)/(?P<market>[A-Z]{2})', array(
			'methods'             => 'POST',
			'permission_callback' => function () { return current_user_can( 'manage_options' ); },
			'callback'            => array( $this, 'route_translate' ),
		) );
	}

	public function route_get_product( \WP_REST_Request $req ): \WP_REST_Response | \WP_Error {
		$market = strtoupper( (string) $req['market'] );
		$sku    = (string) $req['sku'];
		$products = $this->container->get( ProductRepository::class );
		$row = $products->find_by_sku( $market, $sku );
		if ( null === $row ) {
			return new \WP_Error( 'not_found', 'Product not found', array( 'status' => 404 ) );
		}
		$marketplaces = $this->container->get( Marketplaces::class );
		$mp = $marketplaces->get( $market );
		return rest_ensure_response( array(
			'sku'        => (string) $row['sku'],
			'asin'       => (string) $row['asin'],
			'market'     => (string) $row['market'],
			'name'       => (string) $row['product_name'],
			'image_url'  => (string) $row['image_url'],
			'in_stock'   => (int) $row['fulfillable_qty'] > 0,
			'stock'      => (int) $row['fulfillable_qty'],
			'price'      => null !== $row['buybox_price'] ? (float) $row['buybox_price'] : null,
			'currency'   => (string) $row['buybox_currency'] ?: ( $mp['currency'] ?? '' ),
			'amazon_url' => '' !== $row['asin'] ? $marketplaces->product_url( (string) $row['asin'], $market ) : '',
		) );
	}

	public function route_sync( \WP_REST_Request $req ): \WP_REST_Response | \WP_Error {
		try {
			$result = $this->container->get( SyncOrchestrator::class )->sync_market( strtoupper( (string) $req['market'] ) );
			return rest_ensure_response( $result );
		} catch ( \Throwable $e ) {
			return new \WP_Error( 'sync_failed', $e->getMessage(), array( 'status' => 500 ) );
		}
	}

	public function route_describe( \WP_REST_Request $req ): \WP_REST_Response | \WP_Error {
		try {
			$text = $this->container->get( Copywriter::class )->describe( (int) $req['id'] );
			return rest_ensure_response( array( 'ok' => true, 'description' => $text ) );
		} catch ( \Throwable $e ) {
			return new \WP_Error( 'ai_failed', $e->getMessage(), array( 'status' => 500 ) );
		}
	}

	public function route_translate( \WP_REST_Request $req ): \WP_REST_Response | \WP_Error {
		try {
			$text = $this->container->get( Copywriter::class )->translate(
				(int) $req['id'],
				strtoupper( (string) $req['market'] )
			);
			return rest_ensure_response( array( 'ok' => true, 'description' => $text ) );
		} catch ( \Throwable $e ) {
			return new \WP_Error( 'ai_failed', $e->getMessage(), array( 'status' => 500 ) );
		}
	}
}
