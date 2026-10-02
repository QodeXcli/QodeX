<?php
/**
 * FulfillmentModule — MCF service wiring + integrations.
 *
 * Responsibilities:
 *   1. Bind MCFClient + MCFOrderRepository in the container.
 *   2. Cron hook `sg_commerce_mcf_refresh` — poll pending orders and update
 *      their tracking info from Amazon.
 *   3. WooCommerce integration: when a WC order hits 'processing', try to
 *      auto-fulfill via MCF (if feature enabled in settings).
 *   4. Action `sg_commerce_fulfill` that any plugin can fire to hand a
 *      custom order off to Amazon.
 *
 * @package SevenGum\Commerce\Fulfillment
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Fulfillment;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class FulfillmentModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'fulfillment';
	}

	public function register(): void {
		$c = $this->container;

		$c->singleton( MCFOrderRepository::class, static fn( Container $c ) =>
			new MCFOrderRepository( $c->get( Logger::class ) )
		);
		$c->singleton( MCFClient::class, static fn( Container $c ) =>
			new MCFClient(
				$c->get( AmazonClient::class ),
				$c->get( Marketplaces::class ),
				$c->get( Logger::class )
			)
		);

		// Cron: refresh tracking for pending MCF orders.
		add_action( 'sg_commerce_mcf_refresh', array( $this, 'refresh_pending_tracking' ) );

		// Register a 10-minute cron if not already.
		if ( ! wp_next_scheduled( 'sg_commerce_mcf_refresh' ) ) {
			wp_schedule_event( time() + 300, 'sg_fifteen_minutes', 'sg_commerce_mcf_refresh' );
		}

		// Public action other plugins can fire.
		add_action( 'sg_commerce_fulfill', array( $this, 'handle_fulfill_action' ), 10, 1 );

		// WooCommerce integration — only attaches if WC is active AND auto-fulfill is on.
		add_action( 'woocommerce_order_status_processing', array( $this, 'maybe_fulfill_wc_order' ), 10, 1 );
	}

	public function refresh_pending_tracking(): void {
		if ( ! $this->container->get( AmazonClient::class )->has_credentials() ) {
			return;
		}
		$repo   = $this->container->get( MCFOrderRepository::class );
		$client = $this->container->get( MCFClient::class );
		$logger = $this->container->get( Logger::class );

		foreach ( $repo->pending_tracking_refresh() as $row ) {
			try {
				$info = $client->get( (string) $row['market'], (string) $row['seller_fulfillment_order_id'] );
				$repo->update_tracking( (int) $row['id'], $info );
			} catch ( \Throwable $e ) {
				$logger->warning( 'MCF tracking refresh failed', array(
					'id'  => (int) $row['id'],
					'err' => $e->getMessage(),
				) );
			}
		}
	}

	/**
	 * Generic action entry. Payload shape:
	 *   [
	 *     'displayable_order_id' => 'WEB-12345',
	 *     'market'    => 'US',
	 *     'customer'  => ['name'=>..., 'email'=>..., 'phone'=>...],
	 *     'address'   => ['line1'=>..., 'city'=>..., 'country_code'=>...],
	 *     'items'     => [ ['sku'=>..., 'quantity'=>...], ... ],
	 *     'shipping_speed' => 'Standard',
	 *     'comment'   => '',
	 *   ]
	 */
	public function handle_fulfill_action( array $payload ): ?array {
		try {
			$repo   = $this->container->get( MCFOrderRepository::class );
			$client = $this->container->get( MCFClient::class );

			$seller_order_id = 'SG-' . wp_generate_uuid4();
			$request = new MCFOrderRequest(
				seller_fulfillment_order_id: $seller_order_id,
				displayable_order_id:        (string) ( $payload['displayable_order_id'] ?? $seller_order_id ),
				market:                      (string) ( $payload['market'] ?? 'US' ),
				customer:                    (array)  ( $payload['customer'] ?? array() ),
				address:                     (array)  ( $payload['address']  ?? array() ),
				items:                       (array)  ( $payload['items']    ?? array() ),
				shipping_speed:              (string) ( $payload['shipping_speed'] ?? 'Standard' ),
				comment:                     (string) ( $payload['comment'] ?? '' ),
				notification_email:          (string) ( $payload['notification_email'] ?? get_option( 'admin_email', '' ) ),
			);

			$id = $repo->insert( $request );
			try {
				$client->create( $request );
				$repo->mark_submitted( $id );
				return array( 'id' => $id, 'seller_order_id' => $seller_order_id );
			} catch ( \Throwable $e ) {
				$repo->mark_failed( $id, $e->getMessage() );
				throw $e;
			}
		} catch ( \Throwable $e ) {
			$this->container->get( Logger::class )->error( 'MCF fulfillment failed: ' . $e->getMessage() );
			return null;
		}
	}

	/**
	 * WooCommerce: when a WC order moves to processing, optionally submit
	 * to Amazon MCF. Only active when the `mcf_auto_wc` setting is on.
	 */
	public function maybe_fulfill_wc_order( int $order_id ): void {
		$settings = $this->container->get( SettingsRepository::class );
		if ( ! $settings->get( 'mcf_auto_wc', false ) ) {
			return;
		}
		if ( ! function_exists( 'wc_get_order' ) ) {
			return;
		}
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			return;
		}

		// Avoid duplicate fulfillment.
		if ( $order->get_meta( '_sg_mcf_order_id' ) ) {
			return;
		}

		$items = array();
		foreach ( $order->get_items() as $line ) {
			$product = $line->get_product();
			if ( ! $product ) continue;
			$items[] = array(
				'sku'      => (string) $product->get_sku(),
				'quantity' => (int) $line->get_quantity(),
			);
		}

		$payload = array(
			'displayable_order_id' => 'WC-' . $order_id,
			'market'               => (string) $settings->get( 'mcf_default_market', 'US' ),
			'customer'             => array(
				'name'  => trim( $order->get_shipping_first_name() . ' ' . $order->get_shipping_last_name() ),
				'email' => (string) $order->get_billing_email(),
				'phone' => (string) $order->get_billing_phone(),
			),
			'address' => array(
				'line1'        => (string) $order->get_shipping_address_1(),
				'line2'        => (string) $order->get_shipping_address_2(),
				'city'         => (string) $order->get_shipping_city(),
				'state_region' => (string) $order->get_shipping_state(),
				'postal_code'  => (string) $order->get_shipping_postcode(),
				'country_code' => (string) $order->get_shipping_country(),
			),
			'items'          => $items,
			'shipping_speed' => (string) $settings->get( 'mcf_default_speed', 'Standard' ),
			'comment'        => 'Order from ' . get_bloginfo( 'name' ),
		);

		$result = $this->handle_fulfill_action( $payload );
		if ( null !== $result ) {
			$order->update_meta_data( '_sg_mcf_order_id', $result['id'] );
			$order->update_meta_data( '_sg_mcf_seller_order_id', $result['seller_order_id'] );
			$order->add_order_note( sprintf( 'Seven Gum MCF: submitted to Amazon as %s', $result['seller_order_id'] ) );
			$order->save();
		} else {
			$order->add_order_note( 'Seven Gum MCF: submission failed — check logs.' );
		}
	}
}
