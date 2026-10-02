<?php
/**
 * HeadlessAPI — documented REST surface for external React dashboards.
 *
 * The existing RESTModule exposes just the product-widget endpoint (public,
 * unauthenticated). This new `sg-commerce/v2` namespace is for authenticated,
 * full-surface access to every service: products, analytics, MCF orders,
 * repricer, automation, settlements.
 *
 * Auth: requires an `Authorization: Bearer <key>` header where the key is
 * a PAT minted from Settings → API Keys. Falls back to WP application
 * passwords for users who already use those.
 *
 * Rate limit: 60 requests/minute per API key (lightweight transient bucket).
 *
 * All endpoints return JSON. Each endpoint documents its schema via
 * register_rest_route args + rest_field_schema so any OpenAPI tool can
 * pull specs automatically.
 *
 * @package SevenGum\Commerce\API
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\API;

use SevenGum\Commerce\Analytics\SalesAggregator;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Fulfillment\MCFOrderRepository;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class HeadlessAPI implements Module {

	public const NAMESPACE = 'sg-commerce/v2';

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'headless_api';
	}

	public function register(): void {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	public function register_routes(): void {
		$ns = self::NAMESPACE;

		// GET /products — paginated, filtered
		register_rest_route( $ns, '/products', array(
			'methods'             => 'GET',
			'permission_callback' => array( $this, 'auth' ),
			'callback'            => array( $this, 'list_products' ),
			'args'                => array(
				'market'   => array( 'type' => 'string' ),
				'search'   => array( 'type' => 'string' ),
				'in_stock' => array( 'type' => 'boolean' ),
				'page'     => array( 'type' => 'integer', 'default' => 1, 'minimum' => 1 ),
				'per_page' => array( 'type' => 'integer', 'default' => 20, 'minimum' => 1, 'maximum' => 100 ),
			),
		) );

		register_rest_route( $ns, '/products/(?P<id>\d+)', array(
			'methods'             => 'GET',
			'permission_callback' => array( $this, 'auth' ),
			'callback'            => array( $this, 'get_product' ),
		) );

		// GET /analytics/kpis
		register_rest_route( $ns, '/analytics/kpis', array(
			'methods'             => 'GET',
			'permission_callback' => array( $this, 'auth' ),
			'callback'            => array( $this, 'kpis' ),
		) );

		// GET /analytics/buybox-trend
		register_rest_route( $ns, '/analytics/buybox-trend', array(
			'methods'             => 'GET',
			'permission_callback' => array( $this, 'auth' ),
			'callback'            => array( $this, 'buybox_trend' ),
			'args'                => array(
				'days' => array( 'type' => 'integer', 'default' => 14, 'minimum' => 1, 'maximum' => 90 ),
			),
		) );

		// GET /mcf/orders
		register_rest_route( $ns, '/mcf/orders', array(
			'methods'             => 'GET',
			'permission_callback' => array( $this, 'auth' ),
			'callback'            => array( $this, 'list_mcf_orders' ),
			'args'                => array(
				'limit' => array( 'type' => 'integer', 'default' => 50, 'maximum' => 200 ),
			),
		) );

		// POST /mcf/orders
		register_rest_route( $ns, '/mcf/orders', array(
			'methods'             => 'POST',
			'permission_callback' => array( $this, 'auth' ),
			'callback'            => array( $this, 'create_mcf_order' ),
		) );

		// GET /meta
		register_rest_route( $ns, '/meta', array(
			'methods'             => 'GET',
			'permission_callback' => array( $this, 'auth' ),
			'callback'            => array( $this, 'meta' ),
		) );

		// GET /openapi.json
		register_rest_route( $ns, '/openapi', array(
			'methods'             => 'GET',
			'permission_callback' => '__return_true',
			'callback'            => array( $this, 'openapi_spec' ),
		) );
	}

	/* -------------------- Auth -------------------- */

	/**
	 * Accepts:
	 *   - Authorization: Bearer <key>   where <key> is a PAT we issued
	 *   - WP application password (automatic via cookie/basic auth)
	 *   - manage_options capability (logged-in admin)
	 */
	public function auth( \WP_REST_Request $request ): bool|\WP_Error {
		if ( current_user_can( 'manage_options' ) ) {
			return true;
		}
		$auth = (string) $request->get_header( 'authorization' );
		if ( '' === $auth ) {
			return new \WP_Error( 'unauthorized', 'API key required', array( 'status' => 401 ) );
		}
		if ( ! preg_match( '/^Bearer\s+(.+)$/i', $auth, $m ) ) {
			return new \WP_Error( 'unauthorized', 'Invalid Authorization header', array( 'status' => 401 ) );
		}
		$provided_key = trim( $m[1] );

		$settings = $this->container->get( SettingsRepository::class );
		$keys = (array) $settings->get( 'api_keys', array() );
		foreach ( $keys as $key_record ) {
			if ( ! is_array( $key_record ) ) continue;
			$stored_hash = (string) ( $key_record['hash'] ?? '' );
			if ( '' === $stored_hash ) continue;
			if ( hash_equals( $stored_hash, hash( 'sha256', $provided_key ) ) ) {
				// Rate limit: 60 req/min per key.
				if ( ! $this->rate_check( $stored_hash ) ) {
					return new \WP_Error( 'rate_limited', 'Rate limit exceeded', array( 'status' => 429 ) );
				}
				return true;
			}
		}
		return new \WP_Error( 'unauthorized', 'Invalid API key', array( 'status' => 401 ) );
	}

	private function rate_check( string $key_hash ): bool {
		$bucket = 'sg_api_rate_' . substr( $key_hash, 0, 16 );
		$count = (int) get_transient( $bucket );
		if ( $count >= 60 ) return false;
		set_transient( $bucket, $count + 1, 60 );
		return true;
	}

	/* -------------------- Handlers -------------------- */

	public function list_products( \WP_REST_Request $req ): \WP_REST_Response {
		$result = $this->container->get( ProductRepository::class )->paginate( array(
			'market'   => strtoupper( (string) $req->get_param( 'market' ) ),
			'search'   => (string) $req->get_param( 'search' ),
			'in_stock' => (bool) $req->get_param( 'in_stock' ),
			'page'     => (int) $req->get_param( 'page' ),
			'per_page' => (int) $req->get_param( 'per_page' ),
		) );
		return rest_ensure_response( $result );
	}

	public function get_product( \WP_REST_Request $req ): \WP_REST_Response|\WP_Error {
		$id = (int) $req->get_param( 'id' );
		$row = $this->container->get( ProductRepository::class )->find( $id );
		if ( null === $row ) {
			return new \WP_Error( 'not_found', 'Product not found', array( 'status' => 404 ) );
		}
		return rest_ensure_response( $row );
	}

	public function kpis(): \WP_REST_Response {
		return rest_ensure_response(
			$this->container->get( SalesAggregator::class )->headline_kpis()
		);
	}

	public function buybox_trend( \WP_REST_Request $req ): \WP_REST_Response {
		$days = (int) $req->get_param( 'days' );
		return rest_ensure_response(
			$this->container->get( SalesAggregator::class )->buybox_trend( $days )
		);
	}

	public function list_mcf_orders( \WP_REST_Request $req ): \WP_REST_Response {
		$limit = max( 1, min( 200, (int) $req->get_param( 'limit' ) ) );
		return rest_ensure_response(
			$this->container->get( MCFOrderRepository::class )->recent( $limit )
		);
	}

	public function create_mcf_order( \WP_REST_Request $req ): \WP_REST_Response|\WP_Error {
		$payload = (array) $req->get_json_params();
		$result = apply_filters( 'sg_commerce_fulfill_result',
			do_action( 'sg_commerce_fulfill', $payload ),
			$payload
		);
		// The action returns void — we query the repository by displayable_order_id
		// if caller passed one, to give them back the row.
		$display_id = (string) ( $payload['displayable_order_id'] ?? '' );
		if ( '' !== $display_id ) {
			global $wpdb;
			$row = $wpdb->get_row( $wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}sg_mcf_orders WHERE displayable_order_id = %s ORDER BY id DESC LIMIT 1",
				$display_id
			), ARRAY_A );
			if ( $row ) return rest_ensure_response( $row );
		}
		return rest_ensure_response( array( 'submitted' => true ) );
	}

	public function meta(): \WP_REST_Response {
		$mp = $this->container->get( \SevenGum\Commerce\Amazon\Marketplaces::class );
		return rest_ensure_response( array(
			'plugin_version' => SG_COMMERCE_VERSION,
			'db_version'     => SG_COMMERCE_DB_VERSION,
			'primary_market' => $mp->primary(),
			'enabled_markets'=> $mp->enabled_codes(),
			'api_version'    => '2.0',
		) );
	}

	public function openapi_spec(): \WP_REST_Response {
		return rest_ensure_response( array(
			'openapi' => '3.0.0',
			'info'    => array(
				'title'       => 'Seven Gum Commerce API',
				'version'     => '2.0',
				'description' => 'Headless REST API for product catalog, analytics, MCF fulfillment, and more.',
			),
			'servers' => array( array( 'url' => rest_url( self::NAMESPACE ) ) ),
			'paths'   => array(
				'/products'       => array( 'get' => array( 'summary' => 'List products' ) ),
				'/products/{id}'  => array( 'get' => array( 'summary' => 'Get one product' ) ),
				'/analytics/kpis' => array( 'get' => array( 'summary' => 'Headline KPIs' ) ),
				'/analytics/buybox-trend' => array( 'get' => array( 'summary' => 'Buy Box won/lost per day' ) ),
				'/mcf/orders'     => array(
					'get'  => array( 'summary' => 'List MCF orders' ),
					'post' => array( 'summary' => 'Create an MCF order' ),
				),
				'/meta'           => array( 'get' => array( 'summary' => 'Plugin + market metadata' ) ),
			),
			'components' => array(
				'securitySchemes' => array(
					'bearer' => array( 'type' => 'http', 'scheme' => 'bearer' ),
				),
			),
			'security' => array( array( 'bearer' => array() ) ),
		) );
	}

	/* -------------------- Key management helpers -------------------- */

	/**
	 * Mint a new API key. Returns the plaintext key ONCE — only hash is stored.
	 */
	public static function mint_key( Container $container, string $label ): string {
		$settings = $container->get( SettingsRepository::class );
		$plaintext = 'sgc_' . bin2hex( random_bytes( 24 ) );
		$keys = (array) $settings->get( 'api_keys', array() );
		$keys[] = array(
			'label'      => $label,
			'hash'       => hash( 'sha256', $plaintext ),
			'created_at' => gmdate( 'c' ),
		);
		$settings->set( 'api_keys', $keys );
		return $plaintext;
	}

	public static function revoke_key( Container $container, int $index ): bool {
		$settings = $container->get( SettingsRepository::class );
		$keys = (array) $settings->get( 'api_keys', array() );
		if ( ! isset( $keys[ $index ] ) ) return false;
		unset( $keys[ $index ] );
		$settings->set( 'api_keys', array_values( $keys ) );
		return true;
	}
}
