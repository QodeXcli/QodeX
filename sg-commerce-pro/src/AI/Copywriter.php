<?php
/**
 * Copywriter — the high-level "describe" / "translate" use cases.
 *
 * Combines:
 *   ProductRepository  — load source data, find existing copy
 *   PromptRegistry     — build the prompt
 *   ProviderInterface  — execute the generation
 *   wp_sg_descriptions — persist the result keyed by (product_id, language)
 *
 * @package SevenGum\Commerce\AI
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\AI;

use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class Copywriter {

	public function __construct(
		private ProviderInterface $provider,
		private PromptRegistry $prompts,
		private ProductRepository $products,
		private Marketplaces $marketplaces,
		private Logger $logger,
	) {}

	/**
	 * Generate the English description for a product. Persists to
	 * wp_sg_descriptions and returns the generated text.
	 */
	public function describe( int $product_id ): string {
		$product = $this->products->find( $product_id );
		if ( null === $product ) {
			throw new \RuntimeException( "Product #{$product_id} not found." );
		}

		$prompt = $this->prompts->describe_product( $product );
		$result = $this->provider->generate( $prompt, array(
			'system'      => $this->prompts->brand_system(),
			'temperature' => 0.8,
			'max_tokens'  => 220,
		) );

		$this->save_description( $product_id, 'en', $result );
		$this->logger->info( 'Described product', array(
			'product_id' => $product_id,
			'tokens'     => $result['tokens'],
			'duration'   => $result['duration_ms'],
		) );
		return $result['text'];
	}

	/**
	 * Translate the English description into the language of $target_market.
	 * If no English description exists, generates one first.
	 */
	public function translate( int $product_id, string $target_market ): string {
		$mp = $this->marketplaces->get( $target_market );
		if ( null === $mp ) {
			throw new \RuntimeException( "Unknown marketplace: {$target_market}" );
		}
		$lang_code = (string) $mp['language'];

		$english = $this->find_description( $product_id, 'en' );
		if ( null === $english ) {
			// Auto-generate the English source first.
			$english = $this->describe( $product_id );
		}

		if ( 'en' === $lang_code ) {
			// Target market is English-speaking; English copy is the answer.
			$this->save_description( $product_id, 'en', array(
				'text'        => $english,
				'provider'    => $this->provider->id(),
				'model'       => '-',
				'tokens'      => 0,
				'duration_ms' => 0,
			) );
			return $english;
		}

		$prompt = $this->prompts->translate( $english, $this->prompts->language_name( $lang_code ) );
		$result = $this->provider->generate( $prompt, array(
			'system'      => $this->prompts->brand_system(),
			'temperature' => 0.4,
			'max_tokens'  => 260,
		) );

		$this->save_description( $product_id, $lang_code, $result );
		$this->logger->info( 'Translated product', array(
			'product_id' => $product_id,
			'language'   => $lang_code,
			'tokens'     => $result['tokens'],
		) );
		return $result['text'];
	}

	/** Look up the stored description for a product+language. */
	public function find_description( int $product_id, string $language ): ?string {
		global $wpdb;
		$row = $wpdb->get_var( $wpdb->prepare(
			"SELECT content FROM {$wpdb->prefix}sg_descriptions WHERE product_id = %d AND language = %s LIMIT 1",
			$product_id,
			$language
		) );
		return is_string( $row ) ? $row : null;
	}

	/** All stored descriptions for a product, keyed by language code. */
	public function descriptions_for( int $product_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results( $wpdb->prepare(
			"SELECT language, content, provider, model, generated_at
			 FROM {$wpdb->prefix}sg_descriptions
			 WHERE product_id = %d
			 ORDER BY language ASC",
			$product_id
		), ARRAY_A );
		$out = array();
		foreach ( (array) $rows as $r ) {
			$out[ (string) $r['language'] ] = $r;
		}
		return $out;
	}

	private function save_description( int $product_id, string $language, array $result ): void {
		global $wpdb;
		$wpdb->query( $wpdb->prepare(
			"INSERT INTO {$wpdb->prefix}sg_descriptions
				(product_id, language, content, provider, model, temperature, tokens, generation_ms, generated_at)
			 VALUES (%d, %s, %s, %s, %s, %f, %d, %d, %s)
			 ON DUPLICATE KEY UPDATE
				content       = VALUES(content),
				provider      = VALUES(provider),
				model         = VALUES(model),
				temperature   = VALUES(temperature),
				tokens        = VALUES(tokens),
				generation_ms = VALUES(generation_ms),
				generated_at  = VALUES(generated_at)",
			$product_id,
			$language,
			(string) $result['text'],
			(string) ( $result['provider'] ?? '' ),
			(string) ( $result['model'] ?? '' ),
			0.0,
			(int) ( $result['tokens'] ?? 0 ),
			(int) ( $result['duration_ms'] ?? 0 ),
			current_time( 'mysql', true )
		) );
	}
}
