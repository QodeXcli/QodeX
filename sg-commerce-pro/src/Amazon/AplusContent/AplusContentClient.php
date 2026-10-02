<?php
/**
 * AplusContentClient — upload rich A+ Content to Amazon product detail pages.
 *
 * A+ Content (formerly "Enhanced Brand Content") lets brand-registered
 * sellers enrich their product page with image+text modules — the big
 * comparison tables, lifestyle photos, brand story you see on premium
 * Amazon listings. Significantly boosts conversion (+3-10% per Amazon's
 * own data).
 *
 * Seven Gum is brand-registered, so we can push custom A+ for every
 * flavor's detail page via SP-API /aplus/2020-11-01.
 *
 * Flow:
 *   1. createContentDocument with a payload containing up to 7 modules
 *      (standard headline, product description, single image hotspot,
 *      four-image-quadrant, comparison table, etc.)
 *   2. Amazon validates asynchronously — we poll status via
 *      getContentDocument.
 *   3. publishContentDocument ties the document to specific ASINs and
 *      marketplaces.
 *
 * For v3.3 we implement create/get/publish and a few module builders.
 * Image upload itself uses the standard Amazon image hosting (you paste
 * URLs of assets you've already uploaded).
 *
 * @package SevenGum\Commerce\Amazon\AplusContent
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon\AplusContent;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class AplusContentClient {

	public function __construct(
		private AmazonClient $amazon,
		private Logger $logger,
	) {}

	/**
	 * Create a new A+ content document.
	 *
	 * @param string $name     Human-readable name (seen in Seller Central).
	 * @param array  $modules  Array of module blocks — use build_* helpers.
	 * @param string $market   Marketplace code.
	 * @param string $locale   Content language (en_US, de_DE, ...).
	 */
	public function create( string $name, array $modules, string $market, string $locale = 'en_US' ): array {
		$body = array(
			'name'            => $name,
			'contentType'     => 'EBC',
			'contentSubType'  => 'EBC',
			'locale'          => $locale,
			'contentModuleList' => $modules,
		);
		$response = $this->amazon->request(
			'POST',
			$market,
			'/aplus/2020-11-01/contentDocuments',
			array(),
			$body,
			'aplus.create'
		);
		$this->logger->info( 'A+ content document created', array(
			'name' => $name, 'ref' => $response['contentReferenceKey'] ?? null,
		) );
		return $response;
	}

	public function get( string $content_reference_key, string $market ): array {
		return $this->amazon->request(
			'GET',
			$market,
			"/aplus/2020-11-01/contentDocuments/{$content_reference_key}",
			array( 'includedDataSet' => 'CONTENTS' ),
			null,
			'aplus.get'
		);
	}

	public function update( string $content_reference_key, array $document, string $market ): array {
		return $this->amazon->request(
			'POST',
			$market,
			"/aplus/2020-11-01/contentDocuments/{$content_reference_key}",
			array(),
			array( 'contentDocument' => $document ),
			'aplus.update'
		);
	}

	/**
	 * Publish a content document against specific ASINs in a market.
	 *
	 * @param string[] $asins
	 */
	public function publish( string $content_reference_key, array $asins, string $market ): array {
		$records = array_map( static fn( $asin ) => array( 'asin' => (string) $asin ), $asins );
		return $this->amazon->request(
			'POST',
			$market,
			"/aplus/2020-11-01/contentDocuments/{$content_reference_key}/asins",
			array(),
			array( 'asinSet' => $records ),
			'aplus.publish'
		);
	}

	/* ---------------- Module builders ---------------- */
	/*
	 * These return structured arrays matching Amazon's module schemas.
	 * Use them to compose a modules array passed to create().
	 */

	public static function build_standard_headline( string $headline, string $body_text = '' ): array {
		return array(
			'contentModuleType' => 'STANDARD_HEADER_IMAGE_TEXT',
			'standardHeaderImageTextModule' => array(
				'headline' => array(
					'value'           => $headline,
					'decoratorSet'    => array(),
				),
				'body' => array(
					'textList' => array(
						array( 'text' => array( 'value' => $body_text ) ),
					),
				),
			),
		);
	}

	public static function build_product_description( string $body_text ): array {
		return array(
			'contentModuleType' => 'STANDARD_PRODUCT_DESCRIPTION',
			'standardProductDescriptionModule' => array(
				'body' => array(
					'textList' => array( array( 'text' => array( 'value' => $body_text ) ) ),
				),
			),
		);
	}

	public static function build_four_image_quadrant(
		string $headline,
		array $quadrants
	): array {
		$blocks = array();
		foreach ( array_slice( $quadrants, 0, 4 ) as $q ) {
			$blocks[] = array(
				'image' => array(
					'uploadDestinationId' => (string) ( $q['image_id'] ?? '' ),
					'imageCropSpecification' => array(
						'size' => array( 'width' => array( 'value' => 300, 'units' => 'pixels' ),
							'height' => array( 'value' => 300, 'units' => 'pixels' ) ),
					),
					'altText' => (string) ( $q['alt'] ?? '' ),
				),
				'headline' => array( 'value' => (string) ( $q['headline'] ?? '' ) ),
				'body'     => array(
					'textList' => array( array( 'text' => array( 'value' => (string) ( $q['body'] ?? '' ) ) ) ),
				),
			);
		}
		return array(
			'contentModuleType' => 'STANDARD_FOUR_IMAGE_TEXT_QUADRANT',
			'standardFourImageTextQuadrantModule' => array(
				'block1' => $blocks[0] ?? null,
				'block2' => $blocks[1] ?? null,
				'block3' => $blocks[2] ?? null,
				'block4' => $blocks[3] ?? null,
			),
		);
	}

	public static function build_comparison_table( array $products, array $metrics ): array {
		$columns = array();
		foreach ( array_slice( $products, 0, 6 ) as $p ) {
			$metric_row = array();
			foreach ( $metrics as $mkey ) {
				$metric_row[] = array( 'value' => (string) ( $p['metrics'][ $mkey ] ?? '' ) );
			}
			$columns[] = array(
				'position'      => count( $columns ) + 1,
				'image' => array(
					'uploadDestinationId' => (string) ( $p['image_id'] ?? '' ),
					'altText' => (string) ( $p['name'] ?? '' ),
				),
				'title'         => (string) ( $p['name'] ?? '' ),
				'asin'          => (string) ( $p['asin'] ?? '' ),
				'highlight'     => (bool)   ( $p['highlight'] ?? false ),
				'descriptionValues' => $metric_row,
			);
		}
		return array(
			'contentModuleType' => 'STANDARD_COMPARISON_TABLE',
			'standardComparisonTableModule' => array(
				'productColumns'  => $columns,
				'metricRowLabels' => array_map( static fn( $m ) => array( 'value' => (string) $m ), $metrics ),
			),
		);
	}
}
