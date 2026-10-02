<?php
/**
 * WidgetModule — registers the shortcode, frontend assets, and REST.
 *
 * @package SevenGum\Commerce\Widget
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Widget;

use SevenGum\Commerce\AI\Copywriter;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\ProductRepository;

defined( 'ABSPATH' ) || exit;

final class WidgetModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'widget';
	}

	public function register(): void {
		$c = $this->container;

		$c->singleton( Shortcode::class, static fn( Container $c ) =>
			new Shortcode(
				$c->get( ProductRepository::class ),
				$c->get( Marketplaces::class ),
				$c->get( Copywriter::class )
			)
		);

		add_shortcode( 'sg_product', function ( $atts ): string {
			return $this->container->get( Shortcode::class )->render( $atts );
		} );

		add_action( 'wp_enqueue_scripts', array( $this, 'maybe_enqueue_assets' ) );
	}

	public function maybe_enqueue_assets(): void {
		global $post;
		// Only load on pages containing our shortcode.
		if ( ! $post || ! has_shortcode( (string) $post->post_content, 'sg_product' ) ) {
			return;
		}
		wp_enqueue_style(
			'sg-commerce-widget',
			SG_COMMERCE_URL . 'assets/css/widget.css',
			array(),
			SG_COMMERCE_VERSION
		);
		wp_enqueue_script(
			'sg-commerce-widget',
			SG_COMMERCE_URL . 'assets/js/widget.js',
			array(),
			SG_COMMERCE_VERSION,
			true
		);
		wp_localize_script(
			'sg-commerce-widget',
			'SG_COMMERCE',
			array( 'rest' => esc_url_raw( rest_url( 'sg-commerce/v1/' ) ) )
		);
	}
}
