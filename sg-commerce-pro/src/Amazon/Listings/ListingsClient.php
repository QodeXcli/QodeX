<?php
/**
 * ListingsClient — create or update a listing on Amazon.
 *
 * Uses SP-API /listings/2021-08-01/items endpoint which is the modern
 * successor to the old Feeds-based product creation flow.
 *
 * Flow for a new Seven Gum SKU with an EAN already on the bottle:
 *
 *   1. CatalogLookup::preflight($ean, $market) → decides if product exists
 *   2a. If match: call patch() with productType+attributes → associates our
 *       seller account with that ASIN. Amazon uses EAN to identify the item
 *       in the warehouse (commingled inventory). NO per-bottle labels.
 *   2b. If absent: call put() with full attribute payload → Amazon creates
 *       a new catalog entry keyed by our EAN.
 *
 * The `externallyAssignedProductIdentifiers` array with type=EAN is the
 * key that tells Amazon "this product is already barcoded, don't make us
 * apply FNSKU stickers".
 *
 * @package SevenGum\Commerce\Amazon\Listings
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon\Listings;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class ListingsClient {

	public function __construct(
		private AmazonClient $amazon,
		private SettingsRepository $settings,
		private Logger $logger,
	) {}

	/**
	 * Create OR completely replace a listing (idempotent PUT).
	 *
	 * $attributes should follow the Product Type Definition for FOOD or
	 * CHEWING_GUM — typical minimum fields:
	 *   item_name, brand, manufacturer, product_description,
	 *   list_price, item_package_quantity, number_of_items,
	 *   external_product_id (EAN), external_product_id_type.
	 *
	 * @param string $sku          Your internal seller SKU.
	 * @param string $market       Marketplace code (US, DE, UK, ...).
	 * @param string $ean          The EAN-13 printed on the bottle.
	 * @param string $product_type Amazon product type (e.g. "CHEWING_GUM").
	 * @param array  $attributes   Product attributes per PT definition.
	 */
	public function put(
		string $sku,
		string $market,
		string $ean,
		string $product_type,
		array  $attributes
	): array {
		$seller_id = (string) $this->settings->get( 'amazon_seller_id', '' );
		if ( '' === $seller_id ) {
			throw new \RuntimeException( 'amazon_seller_id must be set before creating listings.' );
		}

		// Ensure the EAN identifier is present in attributes.
		$attributes = $this->inject_ean_identifier( $attributes, $ean, $market );

		$body = array(
			'productType' => $product_type,
			'requirements' => 'LISTING',
			'attributes'  => $attributes,
		);

		$path = sprintf(
			'/listings/2021-08-01/items/%s/%s',
			rawurlencode( $seller_id ),
			rawurlencode( $sku )
		);

		$response = $this->amazon->request(
			'PUT',
			$market,
			$path,
			array(), // marketplace ids are injected by AmazonClient
			$body,
			'listings.put'
		);

		$this->logger->info( 'Listing created/replaced', array(
			'sku' => $sku, 'market' => $market, 'ean' => $ean,
			'submission_id' => $response['submissionId'] ?? null,
		) );
		return $response;
	}

	/**
	 * Partial update — JSON Patch of individual attributes (e.g. just
	 * adjust price or quantity without re-sending full payload).
	 */
	public function patch( string $sku, string $market, string $product_type, array $patches ): array {
		$seller_id = (string) $this->settings->get( 'amazon_seller_id', '' );
		if ( '' === $seller_id ) {
			throw new \RuntimeException( 'amazon_seller_id must be set.' );
		}

		$body = array(
			'productType' => $product_type,
			'patches'     => $patches,
		);

		$path = sprintf(
			'/listings/2021-08-01/items/%s/%s',
			rawurlencode( $seller_id ),
			rawurlencode( $sku )
		);

		return $this->amazon->request( 'PATCH', $market, $path, array(), $body, 'listings.patch' );
	}

	public function delete( string $sku, string $market ): array {
		$seller_id = (string) $this->settings->get( 'amazon_seller_id', '' );
		$path = sprintf(
			'/listings/2021-08-01/items/%s/%s',
			rawurlencode( $seller_id ),
			rawurlencode( $sku )
		);
		return $this->amazon->request( 'DELETE', $market, $path, array(), null, 'listings.delete' );
	}

	public function get( string $sku, string $market ): array {
		$seller_id = (string) $this->settings->get( 'amazon_seller_id', '' );
		$path = sprintf(
			'/listings/2021-08-01/items/%s/%s',
			rawurlencode( $seller_id ),
			rawurlencode( $sku )
		);
		return $this->amazon->request( 'GET', $market, $path, array(
			'includedData' => 'summaries,attributes,issues,offers,fulfillmentAvailability',
		), null, 'listings.get' );
	}

	/**
	 * Ensure the `externally_assigned_product_identifier` with EAN type is
	 * present in the attributes array. This is the magic that tells Amazon
	 * we use the printed EAN-13 instead of FNSKU.
	 */
	private function inject_ean_identifier( array $attributes, string $ean, string $market ): array {
		$marketplace_id = $this->marketplace_id_for( $market );

		$attributes['externally_assigned_product_identifier'] = array(
			array(
				'type'          => 'ean',
				'value'         => $ean,
				'marketplace_id'=> $marketplace_id,
			),
		);

		// Also tell Amazon "use manufacturer barcode" (commingled inventory).
		$attributes['merchant_suggested_asin'] = $attributes['merchant_suggested_asin'] ?? array();

		return $attributes;
	}

	private function marketplace_id_for( string $market ): string {
		$mp = $this->amazon->marketplace_info( $market );
		return (string) ( $mp['id'] ?? '' );
	}

	/**
	 * Convenience helper — build a "minimum viable" attribute set for a new
	 * Seven Gum SKU. Caller can override any field before passing to put().
	 */
	public static function build_attributes( array $input, string $market ): array {
		$required_marketplace = array( 'marketplace_id' => self::marketplace_id_static( $market ) );

		return array(
			'item_name'             => array( array_merge( $required_marketplace, array( 'value' => (string) ( $input['name'] ?? '' ) ) ) ),
			'brand'                 => array( array_merge( $required_marketplace, array( 'value' => (string) ( $input['brand'] ?? 'Seven Gum' ) ) ) ),
			'manufacturer'          => array( array_merge( $required_marketplace, array( 'value' => (string) ( $input['manufacturer'] ?? 'Seven Gum' ) ) ) ),
			'product_description'   => array( array_merge( $required_marketplace, array( 'value' => (string) ( $input['description'] ?? '' ) ) ) ),
			'item_package_quantity' => array( array_merge( $required_marketplace, array( 'value' => (int) ( $input['pieces'] ?? 30 ) ) ) ),
			'number_of_items'       => array( array_merge( $required_marketplace, array( 'value' => 1 ) ) ),
			'list_price'            => array( array_merge( $required_marketplace, array(
				'value'    => (float) ( $input['price'] ?? 0 ),
				'currency' => (string) ( $input['currency'] ?? 'USD' ),
			) ) ),
			'supplier_declared_has_product_identifier_exemption' => array( array_merge( $required_marketplace, array( 'value' => false ) ) ),
			'country_of_origin'     => array( array_merge( $required_marketplace, array( 'value' => (string) ( $input['origin'] ?? 'CN' ) ) ) ),
		);
	}

	private static function marketplace_id_static( string $market ): string {
		// Compact inline mapping — full list lives in Marketplaces::all().
		$map = array(
			'US' => 'ATVPDKIKX0DER', 'CA' => 'A2EUQ1WTGCTBG2', 'MX' => 'A1AM78C64UM0Y8', 'BR' => 'A2Q3Y263D00KWC',
			'UK' => 'A1F83G8C2ARO7P', 'DE' => 'A1PA6795UKMFR9', 'FR' => 'A13V1IB3VIYZZH', 'IT' => 'APJ6JRA9NG5V4',
			'ES' => 'A1RKKUPIHCS9HS', 'NL' => 'A1805IZSGTT6HS', 'SE' => 'A2NODRKZP88ZB9', 'PL' => 'A1C3SOZRARQ6R3',
			'BE' => 'AMEN7PMS3EDWL', 'IE' => 'A28R8C7NBKEWEA', 'TR' => 'A33AVAJ2PDY3EV',
			'AE' => 'A2VIGQ35RCS4UG', 'SA' => 'A17E79C6D8DWNP',
			'AU' => 'A39IBJ37TRP1C6', 'JP' => 'A1VC38T7YXB528', 'SG' => 'A19VAU5U5O7RUS', 'IN' => 'A21TJRUUN4KGV',
		);
		return $map[ $market ] ?? 'ATVPDKIKX0DER';
	}
}
