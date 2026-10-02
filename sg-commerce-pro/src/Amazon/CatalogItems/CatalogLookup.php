<?php
/**
 * CatalogLookup — search Amazon catalog by EAN-13 and validate products.
 *
 * With the discovery that Seven Gum bottles carry legitimate EAN-13
 * barcodes, our flow is:
 *
 *   1. Operator enters the EAN-13 that's printed on each bottle.
 *   2. We call Catalog Items API /catalog/2022-04-01/items?identifiers=...
 *      with identifiersType=EAN to check if Amazon already has the product.
 *   3. If yes → we can list against the existing ASIN (commingled inventory,
 *      no stickering needed). If no → we create it via Listings API.
 *   4. We cache catalog metadata locally so repeated lookups are free.
 *
 * This is a major architectural win over FNSKU-based flows:
 *   - No per-bottle labels to print (saves ~$0.30 × 3500 bottles = $1,050)
 *   - No manual label application at FBA prep centers
 *   - Cartons ship directly from factory to Amazon warehouse
 *
 * @package SevenGum\Commerce\Amazon\CatalogItems
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon\CatalogItems;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Cache\CacheManager;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class CatalogLookup {

	public function __construct(
		private AmazonClient $amazon,
		private CacheManager $cache,
		private Logger $logger,
	) {}

	/**
	 * Validate an EAN-13 check digit mathematically before hitting Amazon.
	 * EAN-13 = 12 data digits + 1 check digit using mod-10 algorithm.
	 */
	public static function validate_ean13( string $ean ): bool {
		$ean = preg_replace( '/\s+/', '', $ean );
		if ( ! preg_match( '/^\d{13}$/', $ean ) ) {
			return false;
		}
		$sum = 0;
		for ( $i = 0; $i < 12; $i++ ) {
			$digit = (int) $ean[ $i ];
			$sum += ( $i % 2 === 0 ) ? $digit : $digit * 3;
		}
		$check = ( 10 - ( $sum % 10 ) ) % 10;
		return $check === (int) $ean[12];
	}

	/**
	 * Search Amazon catalog by EAN-13 in one or more markets.
	 *
	 * @return array<int, array{
	 *     asin: string,
	 *     title: string,
	 *     brand: string,
	 *     marketplace: string,
	 *     item_dimensions?: array,
	 *     package_dimensions?: array,
	 *     raw?: array
	 * }>
	 */
	public function search_by_ean( string $ean, string $market ): array {
		if ( ! self::validate_ean13( $ean ) ) {
			throw new \InvalidArgumentException( "Invalid EAN-13 checksum: {$ean}" );
		}

		$cache_key = "catalog.ean.{$market}.{$ean}";
		$cached = $this->cache->get( $cache_key );
		if ( null !== $cached ) {
			return $cached;
		}

		try {
			$response = $this->amazon->request(
				'GET',
				$market,
				'/catalog/2022-04-01/items',
				array(
					'identifiers'     => $ean,
					'identifiersType' => 'EAN',
					'includedData'    => 'attributes,dimensions,identifiers,images,productTypes,summaries',
				),
				null,
				'catalog.items.search'
			);
		} catch ( \Throwable $e ) {
			$this->logger->error( 'Catalog EAN lookup failed', array(
				'ean' => $ean, 'market' => $market, 'err' => $e->getMessage(),
			) );
			throw $e;
		}

		$items = (array) ( $response['items'] ?? $response['payload']['items'] ?? array() );
		$results = array();
		foreach ( $items as $item ) {
			$summary = (array) ( $item['summaries'][0] ?? array() );
			$dims    = (array) ( $item['dimensions'][0] ?? array() );
			$results[] = array(
				'asin'               => (string) ( $item['asin']         ?? '' ),
				'title'              => (string) ( $summary['itemName']  ?? '' ),
				'brand'              => (string) ( $summary['brandName'] ?? '' ),
				'marketplace'        => $market,
				'item_dimensions'    => (array)  ( $dims['item']    ?? array() ),
				'package_dimensions' => (array)  ( $dims['package'] ?? array() ),
				'raw'                => $item,
			);
		}

		$this->cache->set( $cache_key, $results, 12 * HOUR_IN_SECONDS );
		return $results;
	}

	/**
	 * Preflight a prospective listing: is this EAN already on Amazon?
	 *
	 * Returns:
	 *   'match'   → exact match found, list against that ASIN (best case)
	 *   'absent'  → no hit, we need to create a new product via Listings API
	 *   'ambiguous' → multiple hits, operator must pick manually
	 */
	public function preflight( string $ean, string $market ): array {
		$results = $this->search_by_ean( $ean, $market );
		if ( empty( $results ) ) {
			return array( 'status' => 'absent', 'matches' => array() );
		}
		if ( 1 === count( $results ) ) {
			return array( 'status' => 'match', 'matches' => $results );
		}
		return array( 'status' => 'ambiguous', 'matches' => $results );
	}

	/**
	 * Get catalog attributes for an ASIN — needed when composing a Listings
	 * patch (we must provide the product type + required attributes).
	 */
	public function get_by_asin( string $asin, string $market ): ?array {
		$cache_key = "catalog.asin.{$market}.{$asin}";
		$cached = $this->cache->get( $cache_key );
		if ( null !== $cached ) return $cached;

		try {
			$response = $this->amazon->request(
				'GET',
				$market,
				"/catalog/2022-04-01/items/{$asin}",
				array(
					'marketplaceIds' => '', // Filled by AmazonClient based on $market param
					'includedData'   => 'attributes,dimensions,identifiers,productTypes,relationships,summaries',
				),
				null,
				'catalog.items.get'
			);
		} catch ( \Throwable $e ) {
			$this->logger->warning( 'Catalog ASIN lookup failed', array(
				'asin' => $asin, 'err' => $e->getMessage(),
			) );
			return null;
		}

		$this->cache->set( $cache_key, $response, 12 * HOUR_IN_SECONDS );
		return $response;
	}
}
