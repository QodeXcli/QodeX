<?php
/**
 * IntegrationModule — wires ThemeBridge into WordPress.
 *
 * Listens to `sync.completed` domain event to push updates into the theme.
 * Registers meta box on products CPT so editors can pick which Amazon SKU
 * each flavor maps to. Registers 2 shortcodes the theme can use.
 *
 * Designed to be a no-op when the sevengum theme is not active — we still
 * register the module but the sync listener checks active theme.
 *
 * @package SevenGum\Commerce\Integration
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Integration;

use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Events\EventDispatcher;
use SevenGum\Commerce\Geotargeting\GeoResolver;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class IntegrationModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'integration';
	}

	public function register(): void {
		$c = $this->container;

		$c->singleton( ThemeBridge::class, static fn( Container $c ) =>
			new ThemeBridge(
				$c->get( ProductRepository::class ),
				$c->get( Marketplaces::class ),
				$c->get( GeoResolver::class ),
				$c->get( Logger::class )
			)
		);

		// Listen to sync completion.
		$events = $c->get( EventDispatcher::class );
		$events->on( 'sync.completed', function ( array $payload ): array {
			return $this->container->get( ThemeBridge::class )->on_sync_completed( $payload );
		} );

		// Also listen to individual product syncs for low-latency theme updates.
		$events->after( 'product.synced', function ( array $payload ): void {
			if ( empty( $payload['product_id'] ) ) return;
			$row = $this->container->get( ProductRepository::class )->find( (int) $payload['product_id'] );
			if ( null === $row ) return;
			// Find the WP post mapped to this SKU and sync it.
			$post_id = $this->find_post_for_sku( (string) $row['sku'], (string) $row['market'] );
			if ( $post_id > 0 ) {
				$this->container->get( ThemeBridge::class )->sync_post( $post_id );
			}
		} );

		// Meta box + shortcodes (admin + frontend).
		add_action( 'add_meta_boxes', function (): void {
			$this->container->get( ThemeBridge::class )->register_meta_box();
		} );

		add_shortcode( 'sg_theme_price', function ( $atts ): string {
			return $this->container->get( ThemeBridge::class )->shortcode_price( $atts );
		} );
		add_shortcode( 'sg_theme_buy', function ( $atts ): string {
			return $this->container->get( ThemeBridge::class )->shortcode_buy( $atts );
		} );
	}

	private function find_post_for_sku( string $sku, string $market ): int {
		global $wpdb;
		$post_id = $wpdb->get_var( $wpdb->prepare(
			"SELECT p.ID FROM {$wpdb->posts} p
			 INNER JOIN {$wpdb->postmeta} m1 ON m1.post_id = p.ID AND m1.meta_key = %s AND m1.meta_value = %s
			 LEFT JOIN {$wpdb->postmeta} m2 ON m2.post_id = p.ID AND m2.meta_key = %s
			 WHERE p.post_type = %s
			   AND (m2.meta_value = %s OR m2.meta_value IS NULL OR m2.meta_value = '')
			 LIMIT 1",
			ThemeBridge::META_SKU, $sku,
			ThemeBridge::META_MARKET,
			ThemeBridge::CPT,
			$market
		) );
		return (int) $post_id;
	}
}
