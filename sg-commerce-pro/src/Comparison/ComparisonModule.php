<?php
/**
 * ComparisonModule — [sg_compare] shortcode + asset enqueue.
 *
 * The comparison table shares widget.css (chip, price, stock styles) and
 * adds its own compare.css for the table/card responsive layout.
 *
 * @package SevenGum\Commerce\Comparison
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Comparison;

use SevenGum\Commerce\AI\Copywriter;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\ProductRepository;

defined( 'ABSPATH' ) || exit;

final class ComparisonModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'comparison';
	}

	public function register(): void {
		$c = $this->container;

		$c->singleton( ComparisonTable::class, static fn( Container $c ) =>
			new ComparisonTable(
				$c->get( ProductRepository::class ),
				$c->get( Marketplaces::class ),
				$c->get( Copywriter::class )
			)
		);

		add_shortcode( 'sg_compare', function ( $atts ): string {
			return $this->container->get( ComparisonTable::class )->render( $atts );
		} );

		add_action( 'wp_enqueue_scripts', array( $this, 'maybe_enqueue_assets' ) );
	}

	public function maybe_enqueue_assets(): void {
		global $post;
		if ( ! $post || ! has_shortcode( (string) $post->post_content, 'sg_compare' ) ) {
			return;
		}
		// Depends on widget.css for the shared chip/price styles.
		wp_enqueue_style( 'sg-commerce-widget', SG_COMMERCE_URL . 'assets/css/widget.css', array(), SG_COMMERCE_VERSION );
		wp_enqueue_style( 'sg-commerce-compare', SG_COMMERCE_URL . 'assets/css/compare.css', array( 'sg-commerce-widget' ), SG_COMMERCE_VERSION );
		wp_enqueue_script( 'sg-commerce-widget', SG_COMMERCE_URL . 'assets/js/widget.js', array(), SG_COMMERCE_VERSION, true );
		wp_localize_script( 'sg-commerce-widget', 'SG_COMMERCE', array( 'rest' => esc_url_raw( rest_url( 'sg-commerce/v1/' ) ) ) );
	}
}
