<?php
/**
 * PromptRegistry — centralized prompt templates.
 *
 * All prompts live here so admin can preview them and so we don't sprinkle
 * brand voice strings across the codebase. Each template is a small builder
 * that takes contextual data and returns the final prompt string.
 *
 * @package SevenGum\Commerce\AI
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\AI;

use SevenGum\Commerce\Database\Repositories\SettingsRepository;

defined( 'ABSPATH' ) || exit;

final class PromptRegistry {

	public function __construct( private SettingsRepository $settings ) {}

	/** Brand context block prepended to most prompts. */
	public function brand_system(): string {
		$voice = (string) $this->settings->get( 'ai_brand_voice', 'modern, clean, playful but confident' );
		return "You are a senior copywriter for Seven Gum, a premium sugar-free chewing gum brand sold internationally.\n"
			. "Product line: nine flavors including Cookie, Mint, Cinnamon, fruit varieties.\n"
			. "Brand voice: {$voice}. Never cheesy or salesy.\n"
			. "Focus on sensory experience (taste, texture, freshness) and lifestyle (on-the-go, post-meal, after coffee).";
	}

	public function describe_product( array $product ): string {
		$sku   = (string) ( $product['sku']   ?? '' );
		$asin  = (string) ( $product['asin']  ?? '' );
		$name  = (string) ( $product['product_name'] ?? '' );
		$market = (string) ( $product['market'] ?? '' );

		return "Write a product description for this Amazon listing:\n"
			. "  - SKU: {$sku}\n"
			. ( '' !== $asin ? "  - ASIN: {$asin}\n" : '' )
			. "  - Product name: " . ( '' !== $name ? $name : '(unknown — infer from SKU if possible)' ) . "\n"
			. "  - Market: {$market}\n"
			. "\n"
			. "Requirements:\n"
			. "  - 60-80 words\n"
			. "  - Lead with the flavor experience\n"
			. "  - Mention 'sugar-free' once, naturally\n"
			. "  - End with a short, confident call-to-action\n"
			. "  - Output ONLY the description. No headings, no markdown, no preamble.";
	}

	public function translate( string $english, string $target_language_name ): string {
		return "Translate this product description from English to {$target_language_name}.\n"
			. "Keep the same brand voice (modern, clean, confident) and the same approximate length.\n"
			. "Localize idioms — never word-for-word.\n"
			. "Output ONLY the translation. No preamble, no notes.\n"
			. "\n"
			. "English source:\n"
			. $english;
	}

	public function competitor_summary( array $competitor_data ): string {
		$asin   = (string) ( $competitor_data['asin']         ?? '' );
		$name   = (string) ( $competitor_data['product_name'] ?? '' );
		$price  = (string) ( $competitor_data['last_price']   ?? '' );
		$seller = (string) ( $competitor_data['seller_name']  ?? '' );

		return "Summarize this competing Amazon listing in 2-3 sentences for a sales briefing:\n"
			. "  - ASIN: {$asin}\n"
			. "  - Product: {$name}\n"
			. "  - Seller: {$seller}\n"
			. "  - Price: {$price}\n"
			. "\n"
			. "Focus on positioning differences vs Seven Gum (premium sugar-free gum). "
			. "Output ONLY the summary, no headings.";
	}

	/** Map ISO language codes to readable names for the translate prompt. */
	public function language_name( string $code ): string {
		return match ( $code ) {
			'en' => 'English',
			'de' => 'German',
			'fr' => 'French',
			'es' => 'Spanish',
			'it' => 'Italian',
			'nl' => 'Dutch',
			'sv' => 'Swedish',
			'pl' => 'Polish',
			'tr' => 'Turkish',
			'fa' => 'Persian (Farsi)',
			'ar' => 'Arabic',
			'pt' => 'Portuguese',
			'ja' => 'Japanese',
			default => $code,
		};
	}
}
