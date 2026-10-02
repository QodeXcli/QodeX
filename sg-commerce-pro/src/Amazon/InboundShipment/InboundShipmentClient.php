<?php
/**
 * InboundShipmentClient — create shipping plans via Send to Amazon (STA).
 *
 * Replaces the legacy Inbound Shipments v0 flow. STA (2024+) uses a unified
 * `/fba/inbound/2024-03-20` namespace with a multi-step workflow:
 *
 *   1. POST /inboundPlans                       create plan with items
 *   2. GET  /inboundPlans/{planId}              poll status
 *   3. POST /inboundPlans/{planId}/packingOptions/generate  ask Amazon for options
 *   4. POST /inboundPlans/{planId}/packingOptions/{id}/confirm  pick one
 *   5. POST /inboundPlans/{planId}/placementOptions/generate   warehouse options
 *   6. POST /inboundPlans/{planId}/placementOptions/{id}/confirm  confirm warehouse
 *   7. POST /inboundPlans/{planId}/shipments/{shipmentId}/transportationOptions/generate
 *   8. POST /inboundPlans/{planId}/shipments/{shipmentId}/transportationOptions/{id}/confirm
 *   9. POST /inboundPlans/{planId}/confirm      LOCKS — bar no longer editable
 *
 * For Seven Gum's ex-China flow (3500 master cartons from Guangzhou to
 * Amazon FBA), what matters most is:
 *   - Items ship AS-IS in master cartons (no per-unit labels, EAN on bottle)
 *   - BoxContent API provides per-carton dimensions/weight (mandatory)
 *   - LabelGenerator produces the FBA Box ID labels for each master carton
 *
 * This client exposes each step — orchestration is left to the caller so
 * operators can inject manual review between steps (especially step 6,
 * warehouse placement, because Amazon may split the shipment across
 * multiple warehouses which has huge cost implications).
 *
 * @package SevenGum\Commerce\Amazon\InboundShipment
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon\InboundShipment;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class InboundShipmentClient {

	private const BASE = '/fba/inbound/2024-03-20';

	public function __construct(
		private AmazonClient $amazon,
		private Logger $logger,
	) {}

	/**
	 * Step 1 — create an inbound plan.
	 *
	 * @param array $items     Array of ['msku'=>, 'quantity'=>, 'prep_owner'=>'SELLER'|'AMAZON']
	 * @param array $source    Source address ['name','address1','city','state','postal_code','country_code']
	 * @param string $market   Destination marketplace (US, DE, UK, ...)
	 * @param string $name     Operator-visible plan name
	 */
	public function create_plan( array $items, array $source, string $market, string $name ): array {
		$body = array(
			'destinationMarketplaces' => array( $this->marketplace_id( $market ) ),
			'sourceAddress'           => $this->address_block( $source ),
			'name'                    => $name,
			'items'                   => array_map( static function ( $i ) {
				return array(
					'msku'            => (string) ( $i['msku'] ?? '' ),
					'quantity'        => (int)    ( $i['quantity'] ?? 0 ),
					'prepOwner'       => (string) ( $i['prep_owner'] ?? 'SELLER' ),
					'labelOwner'      => (string) ( $i['label_owner'] ?? 'NONE' ), // NONE = use manufacturer barcode (EAN)
				);
			}, $items ),
		);

		$response = $this->amazon->request( 'POST', $market, self::BASE . '/inboundPlans',
			array(), $body, 'inbound.create' );

		$this->logger->info( 'Inbound plan created', array(
			'plan_id' => $response['inboundPlanId'] ?? null,
			'items'   => count( $items ),
		) );
		return $response;
	}

	public function get_plan( string $plan_id, string $market ): array {
		return $this->amazon->request( 'GET', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ),
			array(), null, 'inbound.get' );
	}

	/** Step 3 — ask Amazon how we can pack this plan. */
	public function generate_packing_options( string $plan_id, string $market ): array {
		return $this->amazon->request( 'POST', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ) . '/packingOptions',
			array(), null, 'inbound.packing.generate' );
	}

	public function list_packing_options( string $plan_id, string $market ): array {
		return $this->amazon->request( 'GET', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ) . '/packingOptions',
			array(), null, 'inbound.packing.list' );
	}

	public function confirm_packing_option( string $plan_id, string $packing_option_id, string $market ): array {
		return $this->amazon->request( 'POST', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ) .
			'/packingOptions/' . rawurlencode( $packing_option_id ) . '/confirmation',
			array(), null, 'inbound.packing.confirm' );
	}

	/** Step 4 — update box content (dimensions, weight, items-per-box). */
	public function set_packing_information( string $plan_id, array $packages, string $market ): array {
		return $this->amazon->request( 'POST', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ) . '/packingInformation',
			array(), array( 'packageGroupings' => $packages ), 'inbound.packing.info' );
	}

	/** Step 5 — ask Amazon which warehouse(s) to ship to. */
	public function generate_placement_options( string $plan_id, string $market ): array {
		return $this->amazon->request( 'POST', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ) . '/placementOptions',
			array(), null, 'inbound.placement.generate' );
	}

	public function list_placement_options( string $plan_id, string $market ): array {
		return $this->amazon->request( 'GET', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ) . '/placementOptions',
			array(), null, 'inbound.placement.list' );
	}

	public function confirm_placement_option( string $plan_id, string $placement_option_id, string $market ): array {
		return $this->amazon->request( 'POST', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ) .
			'/placementOptions/' . rawurlencode( $placement_option_id ) . '/confirmation',
			array(), null, 'inbound.placement.confirm' );
	}

	/** Step 7 — get transport options (carrier, cost, pickup date). */
	public function generate_transport_options( string $plan_id, string $shipment_id, string $market ): array {
		return $this->amazon->request( 'POST', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ) .
			'/shipments/' . rawurlencode( $shipment_id ) . '/transportationOptions',
			array(), null, 'inbound.transport.generate' );
	}

	public function confirm_transport_option( string $plan_id, string $shipment_id, string $transport_option_id, string $market ): array {
		return $this->amazon->request( 'POST', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ) .
			'/shipments/' . rawurlencode( $shipment_id ) .
			'/transportationOptions/' . rawurlencode( $transport_option_id ) . '/confirmation',
			array(), null, 'inbound.transport.confirm' );
	}

	/** Final — lock everything, generate labels. */
	public function confirm_plan( string $plan_id, string $market ): array {
		return $this->amazon->request( 'POST', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ) . '/confirmation',
			array(), null, 'inbound.confirm' );
	}

	/** Retrieve confirmed box labels for printing. */
	public function get_labels( string $plan_id, string $shipment_id, string $market, string $page_type = 'PackageLabel_Letter_6' ): array {
		return $this->amazon->request( 'GET', $market,
			self::BASE . '/inboundPlans/' . rawurlencode( $plan_id ) .
			'/shipments/' . rawurlencode( $shipment_id ) . '/deliveryChallan',
			array( 'pageType' => $page_type ), null, 'inbound.labels' );
	}

	private function marketplace_id( string $market ): string {
		return (string) ( $this->amazon->marketplace_info( $market )['id'] ?? '' );
	}

	private function address_block( array $a ): array {
		return array(
			'name'         => (string) ( $a['name']         ?? '' ),
			'addressLine1' => (string) ( $a['address1']     ?? '' ),
			'addressLine2' => (string) ( $a['address2']     ?? '' ),
			'city'         => (string) ( $a['city']         ?? '' ),
			'stateOrProvinceCode' => (string) ( $a['state'] ?? '' ),
			'postalCode'   => (string) ( $a['postal_code']  ?? '' ),
			'countryCode'  => (string) ( $a['country_code'] ?? '' ),
			'email'        => (string) ( $a['email']        ?? '' ),
			'phoneNumber'  => (string) ( $a['phone']        ?? '' ),
			'companyName'  => (string) ( $a['company']      ?? '' ),
		);
	}
}
