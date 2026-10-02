<?php
/**
 * MCFOrderRequest — typed value object for an MCF fulfillment request.
 *
 * Immutable data container. Has builders for the two SP-API payload shapes
 * (preview vs create) so the client code stays clean.
 *
 * @package SevenGum\Commerce\Fulfillment
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Fulfillment;

defined( 'ABSPATH' ) || exit;

final class MCFOrderRequest {

	/**
	 * @param string $seller_fulfillment_order_id  Unique id we generate (becomes idempotency key).
	 * @param string $displayable_order_id         Shows on the shipment paperwork.
	 * @param string $market                       Marketplace code (US, DE, ...).
	 * @param array  $customer                     name, email, phone
	 * @param array  $address                      line1, line2, city, state_region, postal_code, country_code
	 * @param array  $items                        [ ['sku'=>..., 'quantity'=>...], ... ]
	 * @param string $shipping_speed               'Standard' | 'Expedited' | 'Priority'
	 * @param string $comment                      Shows on packing slip.
	 * @param string $notification_email           Amazon pushes shipment events here.
	 */
	public function __construct(
		public readonly string $seller_fulfillment_order_id,
		public readonly string $displayable_order_id,
		public readonly string $market,
		public readonly array  $customer,
		public readonly array  $address,
		public readonly array  $items,
		public readonly string $shipping_speed = 'Standard',
		public readonly string $comment = '',
		public readonly string $notification_email = '',
	) {}

	/** Payload for the /preview endpoint — no seller_order_id required. */
	public function to_preview_payload(): array {
		return array(
			'marketplaceId' => '', // AmazonClient fills via marketplace routing
			'address'       => $this->address_block(),
			'items'         => $this->items_block( 'preview' ),
			'shippingSpeedCategories' => array( $this->shipping_speed ),
		);
	}

	public function to_create_payload(): array {
		$payload = array(
			'sellerFulfillmentOrderId'      => $this->seller_fulfillment_order_id,
			'displayableOrderId'            => $this->displayable_order_id,
			'displayableOrderDate'          => gmdate( 'c' ),
			'displayableOrderComment'       => $this->comment ?: 'Thank you for your order.',
			'shippingSpeedCategory'         => $this->shipping_speed,
			'destinationAddress'            => $this->address_block(),
			'items'                         => $this->items_block( 'create' ),
			'notificationEmails'            => array_values( array_filter( array( $this->notification_email, $this->customer['email'] ?? '' ) ) ),
		);
		return $payload;
	}

	private function address_block(): array {
		return array(
			'name'              => (string) ( $this->customer['name'] ?? '' ),
			'addressLine1'      => (string) ( $this->address['line1'] ?? '' ),
			'addressLine2'      => (string) ( $this->address['line2'] ?? '' ),
			'city'              => (string) ( $this->address['city'] ?? '' ),
			'stateOrRegion'     => (string) ( $this->address['state_region'] ?? '' ),
			'postalCode'        => (string) ( $this->address['postal_code'] ?? '' ),
			'countryCode'       => (string) ( $this->address['country_code'] ?? '' ),
			'phone'             => (string) ( $this->customer['phone'] ?? '' ),
		);
	}

	private function items_block( string $mode ): array {
		$out = array();
		foreach ( $this->items as $i => $item ) {
			$sku = (string) ( $item['sku'] ?? '' );
			$qty = (int)    ( $item['quantity'] ?? 1 );
			if ( '' === $sku || $qty < 1 ) continue;
			$entry = array(
				'sellerSku' => $sku,
				'quantity'  => $qty,
			);
			if ( 'create' === $mode ) {
				$entry['sellerFulfillmentOrderItemId'] = (string) ( $item['item_id'] ?? ( $sku . '-' . $i ) );
				$entry['displayableComment']           = (string) ( $item['comment'] ?? '' );
			} else {
				$entry['sellerFulfillmentOrderItemId'] = (string) ( $item['item_id'] ?? ( $sku . '-' . $i ) );
			}
			$out[] = $entry;
		}
		return $out;
	}
}
