<?php
/**
 * BoxContentService — manage master-carton contents for inbound plans.
 *
 * Amazon requires precise per-carton data before accepting a shipping
 * plan: for each master carton we must declare:
 *
 *   - Exterior dimensions (length × width × height) in cm or inches
 *   - Weight in kg or pounds
 *   - SKU breakdown (which SKUs are in this carton and how many units)
 *
 * This data becomes the `packageGroupings` payload in
 * InboundShipmentClient::set_packing_information() which is called right
 * after confirming a packing option.
 *
 * We also persist local "carton templates" — standard carton profiles for
 * recurring shipment configurations (e.g. "Master carton of 48 × Cookie
 * 30-piece bottles, 42×32×26 cm, 8.5 kg").
 *
 * @package SevenGum\Commerce\Fulfillment\BoxContent
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Fulfillment\BoxContent;

use SevenGum\Commerce\Amazon\InboundShipment\InboundShipmentClient;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class BoxContentService {

	private const TEMPLATE_OPTION = 'sg_commerce_carton_templates';

	public function __construct(
		private InboundShipmentClient $inbound,
		private Logger $logger,
	) {}

	/**
	 * Build Amazon's packageGroupings payload from an array of cartons.
	 *
	 * @param array $cartons  Each carton:
	 *   [
	 *     'quantity'   => 3500,                    // how many of this carton type
	 *     'weight_kg'  => 8.5,
	 *     'length_cm'  => 42,
	 *     'width_cm'   => 32,
	 *     'height_cm'  => 26,
	 *     'contents'   => [['msku' => 'SG-COOKIE-01', 'quantity' => 48], ...],
	 *     'template_id'=> 'cookie-48-pack',
	 *   ]
	 */
	public function build_package_groupings( array $cartons ): array {
		$groupings = array();
		foreach ( $cartons as $c ) {
			$items = array();
			foreach ( (array) ( $c['contents'] ?? array() ) as $content ) {
				$items[] = array(
					'msku'     => (string) ( $content['msku'] ?? '' ),
					'quantity' => (int)    ( $content['quantity'] ?? 0 ),
					'expiration' => isset( $content['expiration'] ) ? (string) $content['expiration'] : null,
					'manufacturingLotCode' => isset( $content['lot'] ) ? (string) $content['lot'] : null,
				);
			}

			$groupings[] = array(
				'name'         => (string) ( $c['template_id'] ?? ( 'Carton-' . count( $groupings ) ) ),
				'packingGroupId' => (string) ( $c['packing_group_id'] ?? 'default' ),
				'boxes'        => array(
					array(
						'quantity'     => (int) ( $c['quantity'] ?? 1 ),
						'weight'       => array(
							'value' => (float) ( $c['weight_kg'] ?? 0 ),
							'unit'  => 'KG',
						),
						'dimensions'   => array(
							'length' => (float) ( $c['length_cm'] ?? 0 ),
							'width'  => (float) ( $c['width_cm']  ?? 0 ),
							'height' => (float) ( $c['height_cm'] ?? 0 ),
							'unit'   => 'CM',
						),
						'items'        => $items,
					),
				),
			);
		}
		return $groupings;
	}

	/** Push box content to Amazon for an inbound plan (Step 4 in STA flow). */
	public function push_to_amazon( string $plan_id, array $cartons, string $market ): array {
		$groupings = $this->build_package_groupings( $cartons );
		$response = $this->inbound->set_packing_information( $plan_id, $groupings, $market );
		$this->logger->info( 'Box content pushed to Amazon', array(
			'plan_id'      => $plan_id,
			'carton_types' => count( $cartons ),
			'total_units'  => array_sum( array_map( static function ( $c ) {
				return array_sum( array_column( (array) ( $c['contents'] ?? array() ), 'quantity' ) )
					* (int) ( $c['quantity'] ?? 1 );
			}, $cartons ) ),
		) );
		return $response;
	}

	/* ---------------- Local carton templates ---------------- */

	/**
	 * Persist a standard carton profile so operators don't have to re-enter
	 * dimensions for recurring shipment configurations.
	 */
	public function save_template( string $id, array $template ): void {
		$all = $this->get_templates();
		$template['id']         = $id;
		$template['updated_at'] = gmdate( 'c' );
		$all[ $id ] = $template;
		update_option( self::TEMPLATE_OPTION, $all, false );
	}

	public function get_templates(): array {
		$all = get_option( self::TEMPLATE_OPTION, array() );
		return is_array( $all ) ? $all : array();
	}

	public function get_template( string $id ): ?array {
		$all = $this->get_templates();
		return $all[ $id ] ?? null;
	}

	public function delete_template( string $id ): void {
		$all = $this->get_templates();
		unset( $all[ $id ] );
		update_option( self::TEMPLATE_OPTION, $all, false );
	}

	/**
	 * Sanity-check a template against Amazon's limits.
	 * FBA caps: max 68 kg per carton, max 63.5 × 63.5 × 63.5 cm per box
	 * (or max single dimension 150 cm).
	 */
	public function validate_template( array $template ): array {
		$errors = array();
		$w = (float) ( $template['weight_kg'] ?? 0 );
		$l = (float) ( $template['length_cm'] ?? 0 );
		$wd = (float) ( $template['width_cm'] ?? 0 );
		$h = (float) ( $template['height_cm'] ?? 0 );

		if ( $w <= 0 )       $errors[] = 'Weight must be positive.';
		if ( $w > 30 )       $errors[] = 'Weight exceeds 30kg — many FBA centers require lifting assist.';
		if ( $w > 68 )       $errors[] = 'CRITICAL: weight exceeds Amazon 68kg ceiling.';
		foreach ( array( 'length' => $l, 'width' => $wd, 'height' => $h ) as $name => $v ) {
			if ( $v <= 0 )       $errors[] = ucfirst( $name ) . ' must be positive.';
			if ( $v > 150 )      $errors[] = ucfirst( $name ) . ' exceeds 150cm ceiling.';
		}
		$contents = (array) ( $template['contents'] ?? array() );
		if ( empty( $contents ) ) $errors[] = 'Template needs at least one SKU.';
		return $errors;
	}

	/**
	 * Seed Seven Gum's known master carton template on first activation.
	 * Called from Activator so operators don't have to re-enter these
	 * physical measurements for every new inbound plan.
	 *
	 * Source: factory spec sheet (Guangzhou, Apr 2026).
	 *   - 33 × 9.5 × 22.5 cm exterior
	 *   - Net weight 1.392 kg (product only)
	 *   - Gross weight 2.1 kg (with packaging)
	 *   - Contents: 4 inner boxes × 6 packs = 24 packs per master carton
	 *   - Each pack carries the EAN-13 printed on its label.
	 */
	public static function seed_default_template(): void {
		$templates = get_option( self::TEMPLATE_OPTION, array() );
		if ( ! is_array( $templates ) ) $templates = array();
		if ( isset( $templates['sg-master-24pack'] ) ) {
			return; // Already seeded.
		}
		$templates['sg-master-24pack'] = array(
			'id'           => 'sg-master-24pack',
			'name'         => 'Seven Gum master carton — 4 inner × 6 packs',
			'length_cm'    => 33.0,
			'width_cm'     => 9.5,
			'height_cm'    => 22.5,
			'weight_kg'    => 2.1,      // gross weight (with packaging)
			'net_weight_kg'=> 1.392,    // product only
			'packs_per_carton' => 24,
			'inner_boxes'  => 4,
			'packs_per_inner_box' => 6,
			'origin'       => 'Guangzhou, CN',
			'notes'        => 'EAN-13 printed on each pack. Commingled inventory — no FNSKU labels required.',
			'created_at'   => gmdate( 'c' ),
			'updated_at'   => gmdate( 'c' ),
		);
		update_option( self::TEMPLATE_OPTION, $templates, false );
	}
}
