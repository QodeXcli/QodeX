<?php
/**
 * MCFClient — Multi-Channel Fulfillment via SP-API /mfn/v0.
 *
 * MCF lets you use Amazon's FBA warehouses to ship orders that come from
 * channels OTHER than Amazon — your own website, Shopify, eBay, phone orders.
 * Customer pays on sevengum.com; we tell Amazon to pick, pack, and ship from
 * FBA inventory.
 *
 * Endpoints used:
 *   POST  /mfn/v0/fulfillmentOrders                    create
 *   GET   /mfn/v0/fulfillmentOrders/{orderId}          status + tracking
 *   PUT   /mfn/v0/fulfillmentOrders/{orderId}/cancel   cancel
 *   POST  /mfn/v0/fulfillmentOrders/preview            preview fees before commit
 *
 * Rate limit: ~2 req/s per endpoint. We reuse AmazonClient so retry,
 * circuit breaker, and rate limiting are handled uniformly.
 *
 * @package SevenGum\Commerce\Fulfillment
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Fulfillment;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class MCFClient {

	public function __construct(
		private AmazonClient $amazon,
		private Marketplaces $marketplaces,
		private Logger $logger,
	) {}

	/**
	 * Preview fees and availability for a prospective MCF order. Doesn't
	 * create the order — use this to show "Ships by X date, $Y shipping"
	 * at checkout before the customer commits.
	 *
	 * @return array{feasible:bool, preview_id?:string, estimated_fees?:array, ship_date?:string, errors?:array}
	 */
	public function preview( MCFOrderRequest $request ): array {
		$body = $request->to_preview_payload();
		try {
			$response = $this->amazon->request(
				'POST',
				$request->market,
				'/mfn/v0/fulfillmentOrders/preview',
				array(),
				$body,
				'mcf.preview'
			);
		} catch ( \Throwable $e ) {
			$this->logger->error( 'MCF preview failed', array( 'err' => $e->getMessage() ) );
			return array( 'feasible' => false, 'errors' => array( $e->getMessage() ) );
		}

		$previews = $response['payload']['fulfillmentPreviews'] ?? array();
		foreach ( (array) $previews as $p ) {
			if ( empty( $p['isFulfillable'] ) ) {
				continue;
			}
			return array(
				'feasible'       => true,
				'preview_id'     => (string) ( $p['marketplaceId'] ?? '' ),
				'shipping_speed' => (string) ( $p['shippingSpeedCategory'] ?? '' ),
				'estimated_fees' => array_map(
					static fn( $f ) => array(
						'name'     => (string) ( $f['name'] ?? '' ),
						'amount'   => (float)  ( $f['amount']['value'] ?? 0 ),
						'currency' => (string) ( $f['amount']['currencyCode'] ?? '' ),
					),
					(array) ( $p['estimatedFees'] ?? array() )
				),
				'ship_date'      => (string) ( $p['estimatedShippingWeight']['value'] ?? '' ),
			);
		}
		return array(
			'feasible' => false,
			'errors'   => array( 'No fulfillable preview returned. SKU may be out of stock at requested speed.' ),
		);
	}

	/**
	 * Create a fulfillment order. Returns the seller fulfillment order id
	 * (which we chose client-side) on success.
	 *
	 * @throws \RuntimeException on failure
	 */
	public function create( MCFOrderRequest $request ): string {
		$body = $request->to_create_payload();
		$this->amazon->request(
			'POST',
			$request->market,
			'/mfn/v0/fulfillmentOrders',
			array(),
			$body,
			'mcf.create'
		);
		$this->logger->info( 'MCF order submitted', array(
			'seller_order_id' => $request->seller_fulfillment_order_id,
			'market'          => $request->market,
			'items'           => count( $request->items ),
		) );
		return $request->seller_fulfillment_order_id;
	}

	/**
	 * Fetch current status + tracking for an existing MCF order.
	 */
	public function get( string $market, string $seller_order_id ): array {
		$response = $this->amazon->request(
			'GET',
			$market,
			'/mfn/v0/fulfillmentOrders/' . rawurlencode( $seller_order_id ),
			array(),
			null,
			'mcf.get'
		);
		$payload = $response['payload'] ?? array();
		$status  = (string) ( $payload['fulfillmentOrder']['fulfillmentOrderStatus'] ?? '' );

		$tracking_numbers = array();
		$carrier = '';
		$shipped_at = null;
		$delivered_at = null;

		foreach ( (array) ( $payload['fulfillmentShipments'] ?? array() ) as $shipment ) {
			foreach ( (array) ( $shipment['fulfillmentShipmentPackage'] ?? array() ) as $pkg ) {
				if ( ! empty( $pkg['trackingNumber'] ) ) {
					$tracking_numbers[] = (string) $pkg['trackingNumber'];
				}
				if ( ! empty( $pkg['carrierCode'] ) && '' === $carrier ) {
					$carrier = (string) $pkg['carrierCode'];
				}
			}
			if ( ! empty( $shipment['shippingDate'] ) && null === $shipped_at ) {
				$shipped_at = (string) $shipment['shippingDate'];
			}
			if ( ! empty( $shipment['estimatedArrivalDate'] ) && null === $delivered_at ) {
				$delivered_at = (string) $shipment['estimatedArrivalDate'];
			}
		}

		return array(
			'amazon_status'    => $status,
			'tracking_numbers' => $tracking_numbers,
			'carrier_code'     => $carrier,
			'shipped_at'       => $shipped_at,
			'delivered_at'     => $delivered_at,
		);
	}

	public function cancel( string $market, string $seller_order_id ): void {
		$this->amazon->request(
			'PUT',
			$market,
			'/mfn/v0/fulfillmentOrders/' . rawurlencode( $seller_order_id ) . '/cancel',
			array(),
			null,
			'mcf.cancel'
		);
		$this->logger->info( 'MCF order cancelled', array( 'seller_order_id' => $seller_order_id ) );
	}
}
