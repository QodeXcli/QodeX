<?php
/**
 * ContentInjector — scans post content and auto-injects product refs.
 *
 * Three modes (render_as column on rules):
 *   'link'     Turn matched keyword into an <a href="..."> to Amazon via our geotargeted
 *              redirect. Lightest touch. Good for SEO-heavy content where you don't
 *              want chunky widgets breaking the flow.
 *   'widget'   Insert the full [sg_product] widget ABOVE the paragraph containing the match.
 *              Higher conversion but heavier.
 *   'tooltip'  Turn keyword into an inline span with JS-driven hovercard showing price/stock.
 *
 * Scans only the main content on singular views. Never modifies excerpts,
 * admin, RSS, or feed contexts. First match per rule per post, capped by
 * rule.max_per_post.
 *
 * @package SevenGum\Commerce\Injection
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Injection;

use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Geotargeting\GeoResolver;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class ContentInjector {

	/** In-request cache of active rules. */
	private ?array $rules_cache = null;

	public function __construct(
		private ProductRepository $products,
		private Marketplaces $marketplaces,
		private GeoResolver $geo,
		private Logger $logger,
	) {}

	/**
	 * Main hook — replaces matched keywords in post HTML.
	 *
	 * Applied on `the_content` priority 20 (after wpautop, so paragraph
	 * boundaries are known). Only touches singular posts/pages.
	 */
	public function inject( string $content ): string {
		if ( is_admin() || is_feed() || ! is_singular() ) {
			return $content;
		}
		if ( '' === trim( $content ) ) {
			return $content;
		}

		$rules = $this->load_rules();
		if ( empty( $rules ) ) {
			return $content;
		}

		$market = $this->geo->market();
		$hits_per_rule = array();

		foreach ( $rules as $rule ) {
			$rule_id  = (int) $rule['id'];
			$pattern  = (string) $rule['pattern'];
			$ptype    = (string) $rule['pattern_type']; // 'keyword' | 'regex'
			$sku      = (string) $rule['sku'];
			$render   = (string) $rule['render_as'];
			$rule_mkt = (string) $rule['market'];
			$max      = max( 1, (int) $rule['max_per_post'] );

			$effective_market = '' !== $rule_mkt ? $rule_mkt : $market;
			$product = $this->products->find_by_sku( $effective_market, $sku );
			if ( null === $product ) {
				continue;
			}

			$hits_per_rule[ $rule_id ] = 0;

			$callback = function ( array $m ) use ( $product, $render, $rule_id, $max, &$hits_per_rule, $effective_market ): string {
				if ( $hits_per_rule[ $rule_id ] >= $max ) {
					return $m[0];
				}
				// Don't match inside existing HTML tags (belt-and-braces — we also split HTML below).
				$hits_per_rule[ $rule_id ]++;
				return $this->render_replacement( $m[0], $product, $render, $effective_market );
			};

			if ( 'regex' === $ptype ) {
				// Caller-supplied regex — wrap in delimiters + ui flags. Rejected if un-compilable.
				$regex = '~' . str_replace( '~', '\\~', $pattern ) . '~ui';
				$valid = false !== @preg_match( $regex, '' );
				if ( ! $valid ) continue;
			} else {
				$regex = '~\b(' . preg_quote( $pattern, '~' ) . ')\b~ui';
			}

			$content = $this->replace_outside_tags( $content, $regex, $callback );

			if ( $hits_per_rule[ $rule_id ] > 0 ) {
				$this->increment_hit( $rule_id, $hits_per_rule[ $rule_id ] );
			}
		}

		return $content;
	}

	/** Apply a regex callback only to text nodes, never to HTML tag internals. */
	private function replace_outside_tags( string $html, string $regex, callable $cb ): string {
		// Split on tags while keeping them.
		$parts = preg_split( '/(<[^>]+>)/', $html, -1, PREG_SPLIT_DELIM_CAPTURE );
		if ( false === $parts ) return $html;

		$in_skip = 0; // depth counter for anchor/script/style
		$skip_tags = array( 'a', 'script', 'style', 'code', 'pre', 'textarea' );

		foreach ( $parts as $i => $part ) {
			if ( '' === $part ) continue;
			if ( '<' === $part[0] ) {
				// Tag — adjust depth if it's a skip tag.
				if ( preg_match( '~^<(/?)([a-zA-Z][a-zA-Z0-9]*)~', $part, $tm ) ) {
					$is_close = '/' === $tm[1];
					$tag = strtolower( $tm[2] );
					if ( in_array( $tag, $skip_tags, true ) ) {
						$in_skip = $is_close ? max( 0, $in_skip - 1 ) : $in_skip + 1;
					}
				}
				continue;
			}
			if ( $in_skip > 0 ) continue;
			$parts[ $i ] = preg_replace_callback( $regex, $cb, $part );
		}
		return implode( '', $parts );
	}

	private function render_replacement( string $matched, array $product, string $render, string $market ): string {
		switch ( $render ) {
			case 'widget':
				return sprintf(
					'%s<div class="sg-injected-widget">%s</div>',
					$matched,
					do_shortcode( sprintf(
						'[sg_product sku="%s" market="%s" style="compact"]',
						esc_attr( $product['sku'] ),
						esc_attr( $market )
					) )
				);

			case 'tooltip':
				$url = '' !== $product['asin']
					? $this->marketplaces->product_url( (string) $product['asin'], $market )
					: '#';
				return sprintf(
					'<a href="%s" class="sg-injected-tooltip" data-sku="%s" data-market="%s" target="_blank" rel="noopener nofollow sponsored">%s</a>',
					esc_url( $url ),
					esc_attr( $product['sku'] ),
					esc_attr( $market ),
					esc_html( $matched )
				);

			case 'link':
			default:
				$url = '' !== $product['asin']
					? $this->marketplaces->product_url( (string) $product['asin'], $market )
					: home_url( '/?sg_go=' . urlencode( $product['sku'] ) );
				return sprintf(
					'<a href="%s" class="sg-injected-link" target="_blank" rel="noopener nofollow sponsored">%s</a>',
					esc_url( $url ),
					esc_html( $matched )
				);
		}
	}

	private function load_rules(): array {
		if ( null !== $this->rules_cache ) {
			return $this->rules_cache;
		}
		global $wpdb;
		$rows = $wpdb->get_results(
			"SELECT * FROM {$wpdb->prefix}sg_injection_rules
			 WHERE is_active = 1
			 ORDER BY priority ASC, id ASC",
			ARRAY_A
		);
		$this->rules_cache = is_array( $rows ) ? $rows : array();
		return $this->rules_cache;
	}

	private function increment_hit( int $rule_id, int $count ): void {
		global $wpdb;
		$wpdb->query( $wpdb->prepare(
			"UPDATE {$wpdb->prefix}sg_injection_rules SET hit_count = hit_count + %d WHERE id = %d",
			$count,
			$rule_id
		) );
	}
}
