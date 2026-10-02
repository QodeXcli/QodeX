<?php
/**
 * Sandbox — mock Amazon SP-API responses for dry-run testing.
 *
 * When Settings → Sandbox is ON, AmazonClient intercepts every request
 * and returns a deterministic mock response. This lets you:
 *
 *   - Demo the plugin to stakeholders without connecting a real account
 *   - Run integration tests in CI with predictable data
 *   - Develop locally without burning real API quota
 *
 * Usage (in AmazonClient): if Sandbox::is_enabled(), return
 * Sandbox::mock($method, $path). Otherwise fall through to real HTTP.
 *
 * @package SevenGum\Commerce\Testing
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Testing;

defined( 'ABSPATH' ) || exit;

final class Sandbox {

	public static function is_enabled(): bool {
		return (bool) get_option( 'sg_commerce_sandbox_enabled', false );
	}

	public static function enable(): void {
		update_option( 'sg_commerce_sandbox_enabled', true );
	}

	public static function disable(): void {
		update_option( 'sg_commerce_sandbox_enabled', false );
	}

	/**
	 * Return a mocked SP-API response for a given endpoint + method.
	 * Matches by path prefix.
	 */
	public static function mock( string $method, string $path ): array {
		// Marketplace participations.
		if ( str_contains( $path, '/sellers/v1/marketplaceParticipations' ) ) {
			return array(
				'payload' => array(
					array(
						'marketplace' => array(
							'id'          => 'ATVPDKIKX0DER',
							'name'        => 'Amazon.com',
							'countryCode' => 'US',
							'domainName'  => 'www.amazon.com',
						),
						'participation' => array(
							'isParticipating'       => true,
							'hasSuspendedListings'  => false,
						),
					),
				),
			);
		}

		// FBA inventory.
		if ( str_contains( $path, '/fba/inventory/v1/summaries' ) ) {
			return array(
				'payload' => array(
					'inventorySummaries' => self::mock_inventory_rows(),
				),
			);
		}

		// Competitive pricing.
		if ( str_contains( $path, '/products/pricing/v0/items/' ) && str_contains( $path, '/offers' ) ) {
			return array(
				'payload' => self::mock_offers_response(),
			);
		}

		// MCF preview.
		if ( str_contains( $path, '/mfn/v0/fulfillmentOrders/preview' ) ) {
			return array(
				'payload' => array(
					'fulfillmentPreviews' => array(
						array(
							'isFulfillable'         => true,
							'marketplaceId'         => 'ATVPDKIKX0DER',
							'shippingSpeedCategory' => 'Standard',
							'estimatedFees'         => array(
								array( 'name' => 'FBAPerUnitFulfillmentFee',
									'amount' => array( 'value' => 3.22, 'currencyCode' => 'USD' ) ),
							),
						),
					),
				),
			);
		}

		// MCF create.
		if ( 'POST' === $method && str_contains( $path, '/mfn/v0/fulfillmentOrders' ) && ! str_contains( $path, 'preview' ) ) {
			return array( 'payload' => array() );
		}

		// MCF get.
		if ( 'GET' === $method && str_contains( $path, '/mfn/v0/fulfillmentOrders/' ) ) {
			return array(
				'payload' => array(
					'fulfillmentOrder' => array(
						'fulfillmentOrderStatus' => 'COMPLETE',
					),
					'fulfillmentShipments' => array(
						array(
							'shippingDate' => gmdate( 'c', time() - DAY_IN_SECONDS ),
							'estimatedArrivalDate' => gmdate( 'c', time() + DAY_IN_SECONDS ),
							'fulfillmentShipmentPackage' => array(
								array( 'trackingNumber' => 'SANDBOX-TRK-' . mt_rand( 10000, 99999 ),
									'carrierCode' => 'UPS' ),
							),
						),
					),
				),
			);
		}

		// Default empty.
		return array( 'payload' => array() );
	}

	private static function mock_inventory_rows(): array {
		$flavors = array( 'cookie', 'mint', 'cinnamon', 'ginger', 'blueberry', 'pineapple' );
		$out = array();
		foreach ( $flavors as $i => $f ) {
			$out[] = array(
				'asin'            => 'B0SG' . str_pad( (string) ( $i * 111 ), 6, '0', STR_PAD_LEFT ),
				'sellerSku'       => 'SG-' . strtoupper( $f ) . '-01',
				'productName'     => 'Seven Gum ' . ucfirst( $f ) . ' 30-pc',
				'totalQuantity'   => 50 + ( $i * 10 ),
				'fulfillableQuantity' => 40 + ( $i * 8 ),
			);
		}
		return $out;
	}

	private static function mock_offers_response(): array {
		return array(
			'Summary' => array(
				'BuyBoxPrices' => array(
					array(
						'ListingPrice' => array( 'Amount' => 4.99, 'CurrencyCode' => 'USD' ),
					),
				),
				'NumberOfOffers' => array( array( 'OfferCount' => 3 ) ),
			),
			'Offers' => array(
				array(
					'SellerId' => 'A1SELLER',
					'IsBuyBoxWinner' => true,
					'ListingPrice' => array( 'Amount' => 4.99, 'CurrencyCode' => 'USD' ),
				),
			),
		);
	}
}
