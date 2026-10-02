<?php
/**
 * InjectionModule — registers the content filter + short-link handler.
 *
 * Respects settings flag `injection_enabled` so operator can disable in one click.
 *
 * Also registers `sg_go` query param that redirects to Amazon via geotargeting:
 *   /?sg_go=SG-COOKIE-01  →  https://www.amazon.de/dp/B0XXXX   (if visitor is DE)
 *
 * @package SevenGum\Commerce\Injection
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Injection;

use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Geotargeting\GeoResolver;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class InjectionModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'injection';
	}

	public function register(): void {
		$c = $this->container;

		$c->singleton( ContentInjector::class, static fn( Container $c ) =>
			new ContentInjector(
				$c->get( ProductRepository::class ),
				$c->get( Marketplaces::class ),
				$c->get( GeoResolver::class ),
				$c->get( Logger::class )
			)
		);

		$settings = $c->get( SettingsRepository::class );
		if ( $settings->get( 'injection_enabled', true ) ) {
			// priority 20 — after wpautop, before shortcode rendering (priority 11).
			// We DO want our injected [sg_product] shortcodes to expand, so run BEFORE
			// do_shortcode which is at 11... except do_shortcode runs at 11 by default
			// so we need to be earlier. Use priority 10 and run shortcodes ourselves.
			add_filter( 'the_content', array( $this, 'filter_content' ), 10 );
		}

		// Short-link redirect handler.
		add_action( 'init', array( $this, 'handle_short_link' ), 20 );
	}

	public function filter_content( string $content ): string {
		try {
			return $this->container->get( ContentInjector::class )->inject( $content );
		} catch ( \Throwable $e ) {
			$this->container->get( Logger::class )->error( 'Content injection failed: ' . $e->getMessage() );
			return $content;
		}
	}

	public function handle_short_link(): void {
		if ( empty( $_GET['sg_go'] ) ) return; // phpcs:ignore WordPress.Security.NonceVerification
		$sku = sanitize_text_field( wp_unslash( (string) $_GET['sg_go'] ) ); // phpcs:ignore
		$market = $this->container->get( GeoResolver::class )->market();
		$product = $this->container->get( ProductRepository::class )->find_by_sku( $market, $sku );

		// If this SKU isn't tracked in the visitor's market, try any market we have.
		if ( null === $product ) {
			$enabled = $this->container->get( Marketplaces::class )->enabled_codes();
			foreach ( $enabled as $m ) {
				if ( $m === $market ) continue;
				$product = $this->container->get( ProductRepository::class )->find_by_sku( $m, $sku );
				if ( null !== $product ) { $market = $m; break; }
			}
		}

		if ( null !== $product && '' !== $product['asin'] ) {
			$url = $this->container->get( Marketplaces::class )->product_url( (string) $product['asin'], $market );
			wp_safe_redirect( $url, 302 );
			exit;
		}

		// Fallback — home page.
		wp_safe_redirect( home_url(), 302 );
		exit;
	}
}
