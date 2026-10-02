<?php
/**
 * ThemeBridge — native integration with the Seven Gum theme (no WooCommerce).
 *
 * The theme stores products as a `products` custom post type. Prices go in
 * the `_sevengum_price` post meta. Buy links are Customizer `theme_mod`
 * values like `sg_amazon_cookie`, `sg_amazon_store`, `sg_amazon_discovery_box`.
 *
 * This bridge:
 *
 *   1. Maps theme flavor slugs (cookie, sour-green-apple, ...) to our
 *      Amazon SKUs stored in wp_sg_products. Uses post_meta on the
 *      `products` CPT for the mapping, so editors can edit it.
 *
 *   2. After every SP-API sync, pushes the Buy Box price into
 *      `_sevengum_price` and the Amazon URL into the Customizer theme_mod
 *      — so theme CTAs always show live price + correct regional Amazon URL.
 *
 *   3. Adds a meta box on the products edit screen showing the synced data
 *      (stock, last sync time, BB owner) — read-only, no clutter.
 *
 *   4. Attaches to the `sync.completed` domain event so price updates
 *      happen automatically after every hourly cron run.
 *
 * @package SevenGum\Commerce\Integration
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Integration;

use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Events\EventDispatcher;
use SevenGum\Commerce\Geotargeting\GeoResolver;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class ThemeBridge {

	public const META_SKU         = '_sg_amazon_sku';
	public const META_MARKET      = '_sg_amazon_market';
	public const META_LAST_SYNC   = '_sg_amazon_last_sync';
	public const META_STOCK_CACHE = '_sg_amazon_stock';

	public const CPT = 'products';

	public function __construct(
		private ProductRepository $products,
		private Marketplaces $marketplaces,
		private GeoResolver $geo,
		private Logger $logger,
	) {}

	/**
	 * After a completed sync, sweep every products CPT post and update its
	 * theme-facing meta + theme_mods. Called by EventDispatcher listener.
	 */
	public function on_sync_completed( array $payload ): array {
		$theme_active = ( 'sevengum' === get_stylesheet() || 'sevengum' === get_template() );
		if ( ! $theme_active ) {
			$this->logger->debug( 'ThemeBridge skipped: active theme is not sevengum' );
			return $payload;
		}

		$post_ids = get_posts( array(
			'post_type'      => self::CPT,
			'post_status'    => array( 'publish', 'draft' ),
			'posts_per_page' => -1,
			'fields'         => 'ids',
			'no_found_rows'  => true,
		) );

		$updated = 0;
		foreach ( (array) $post_ids as $post_id ) {
			if ( $this->sync_post( (int) $post_id ) ) {
				$updated++;
			}
		}
		$this->logger->info( 'ThemeBridge updated theme posts', array( 'updated' => $updated, 'total' => count( $post_ids ) ) );
		return $payload;
	}

	/**
	 * Sync one CPT post's theme-facing data from its mapped Amazon SKU.
	 * Returns true if any field changed.
	 */
	public function sync_post( int $post_id ): bool {
		$sku = (string) get_post_meta( $post_id, self::META_SKU, true );
		if ( '' === $sku ) {
			return false;
		}

		// Market: use the one stored on the post, else primary.
		$market = (string) get_post_meta( $post_id, self::META_MARKET, true );
		if ( '' === $market ) {
			$market = $this->marketplaces->primary();
		}

		$amazon_row = $this->products->find_by_sku( $market, $sku );
		if ( null === $amazon_row ) {
			return false;
		}

		$changed = false;

		// 1. Price → _sevengum_price
		if ( null !== $amazon_row['buybox_price'] ) {
			$new_price = (string) round( (float) $amazon_row['buybox_price'], 2 );
			$old_price = (string) get_post_meta( $post_id, '_sevengum_price', true );
			if ( $new_price !== $old_price ) {
				update_post_meta( $post_id, '_sevengum_price', $new_price );
				$changed = true;
			}
		}

		// 2. Buy URL → theme_mod (uses the post slug which maps to flavor slug)
		$slug = get_post_field( 'post_name', $post_id );
		if ( '' !== $slug && '' !== $amazon_row['asin'] ) {
			$buy_url = $this->marketplaces->product_url( (string) $amazon_row['asin'], $market );
			$old_url = (string) get_theme_mod( 'sg_amazon_' . $slug, '' );
			if ( $buy_url !== $old_url ) {
				set_theme_mod( 'sg_amazon_' . $slug, $buy_url );
				$changed = true;
			}
		}

		// 3. Stock cache meta (used by theme to hide sold-out CTAs if desired)
		update_post_meta( $post_id, self::META_STOCK_CACHE, (int) $amazon_row['fulfillable_qty'] );
		update_post_meta( $post_id, self::META_LAST_SYNC, current_time( 'mysql', true ) );

		return $changed;
	}

	/**
	 * Register meta box on the products edit screen that lets editors:
	 *   - Pick which Amazon SKU + market this post is mapped to
	 *   - See read-only sync status (last sync, stock, BB status)
	 */
	public function register_meta_box(): void {
		add_meta_box(
			'sg_commerce_amazon_link',
			__( 'Amazon link (Seven Gum Commerce)', 'sg-commerce' ),
			array( $this, 'render_meta_box' ),
			self::CPT,
			'side',
			'default'
		);
		add_action( 'save_post_' . self::CPT, array( $this, 'save_meta_box' ), 10, 2 );
	}

	public function render_meta_box( \WP_Post $post ): void {
		wp_nonce_field( 'sg_theme_bridge_save', '_sg_tb_nonce' );

		$current_sku    = (string) get_post_meta( $post->ID, self::META_SKU, true );
		$current_market = (string) get_post_meta( $post->ID, self::META_MARKET, true );
		$last_sync      = (string) get_post_meta( $post->ID, self::META_LAST_SYNC, true );
		$stock          = (int)    get_post_meta( $post->ID, self::META_STOCK_CACHE, true );

		if ( '' === $current_market ) {
			$current_market = $this->marketplaces->primary();
		}

		// Suggest SKUs: all SKUs we have for the chosen market.
		$suggestions = array();
		global $wpdb;
		$rows = $wpdb->get_results( $wpdb->prepare(
			"SELECT sku, product_name FROM {$wpdb->prefix}sg_products WHERE market = %s ORDER BY sku ASC LIMIT 50",
			$current_market
		), ARRAY_A );
		foreach ( (array) $rows as $r ) {
			$suggestions[ $r['sku'] ] = $r['product_name'] ?: $r['sku'];
		}

		$mapped_row = '' !== $current_sku ? $this->products->find_by_sku( $current_market, $current_sku ) : null;
		?>
		<p>
			<label for="sg_tb_market"><strong><?php esc_html_e( 'Amazon market', 'sg-commerce' ); ?></strong></label>
			<select name="_sg_amazon_market" id="sg_tb_market" style="width:100%;">
				<?php foreach ( $this->marketplaces->enabled_codes() as $code ) : ?>
					<option value="<?php echo esc_attr( $code ); ?>" <?php selected( $current_market, $code ); ?>>
						<?php echo esc_html( $code ); ?>
					</option>
				<?php endforeach; ?>
			</select>
		</p>
		<p>
			<label for="sg_tb_sku"><strong><?php esc_html_e( 'Amazon SKU', 'sg-commerce' ); ?></strong></label>
			<input type="text" name="_sg_amazon_sku" id="sg_tb_sku"
				value="<?php echo esc_attr( $current_sku ); ?>"
				list="sg_tb_sku_list" style="width:100%;" autocomplete="off" />
			<datalist id="sg_tb_sku_list">
				<?php foreach ( $suggestions as $s => $n ) : ?>
					<option value="<?php echo esc_attr( $s ); ?>"><?php echo esc_attr( $n ); ?></option>
				<?php endforeach; ?>
			</datalist>
		</p>

		<?php if ( null !== $mapped_row ) : ?>
			<div style="background:#f3f4f6; padding:10px 12px; border-radius:6px; font-size:12px; line-height:1.6;">
				<div><strong><?php esc_html_e( 'Status', 'sg-commerce' ); ?>:</strong> <span style="color:#059669;">✓ <?php esc_html_e( 'Mapped', 'sg-commerce' ); ?></span></div>
				<div><strong><?php esc_html_e( 'Stock', 'sg-commerce' ); ?>:</strong> <?php echo (int) $mapped_row['fulfillable_qty']; ?></div>
				<?php if ( null !== $mapped_row['buybox_price'] ) : ?>
					<div><strong><?php esc_html_e( 'Buy Box', 'sg-commerce' ); ?>:</strong>
						<?php echo esc_html( number_format( (float) $mapped_row['buybox_price'], 2 ) . ' ' . ( $mapped_row['buybox_currency'] ?: '' ) ); ?>
						<?php if ( ! (int) $mapped_row['buybox_is_mine'] ) : ?>
							<span style="color:#b45309;"> — <?php esc_html_e( 'lost', 'sg-commerce' ); ?></span>
						<?php endif; ?>
					</div>
				<?php endif; ?>
				<?php if ( '' !== $last_sync ) : ?>
					<div style="color:#6b7280;"><?php esc_html_e( 'Last theme sync', 'sg-commerce' ); ?>: <?php echo esc_html( human_time_diff( strtotime( $last_sync ), time() ) ); ?> <?php esc_html_e( 'ago', 'sg-commerce' ); ?></div>
				<?php endif; ?>
			</div>
			<p class="description" style="margin-top:8px;">
				<?php printf(
					esc_html__( 'This post\'s %1$s_sevengum_price%2$s and %1$ssg_amazon_%3$s%2$s theme mod will auto-update after every sync.', 'sg-commerce' ),
					'<code>', '</code>', esc_html( $post->post_name )
				); ?>
			</p>
		<?php elseif ( '' !== $current_sku ) : ?>
			<p style="color:#b91c1c; font-size:12px;">
				<?php esc_html_e( '⚠ SKU not found in synced Amazon data. Check spelling or run a sync.', 'sg-commerce' ); ?>
			</p>
		<?php endif; ?>
		<?php
	}

	public function save_meta_box( int $post_id, \WP_Post $post ): void {
		if ( ! isset( $_POST['_sg_tb_nonce'] ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( (string) $_POST['_sg_tb_nonce'] ) ), 'sg_theme_bridge_save' ) ) {
			return;
		}
		if ( ! current_user_can( 'edit_post', $post_id ) ) return;
		if ( wp_is_post_autosave( $post_id ) || wp_is_post_revision( $post_id ) ) return;

		$sku    = sanitize_text_field( wp_unslash( (string) ( $_POST['_sg_amazon_sku']    ?? '' ) ) );
		$market = strtoupper( sanitize_text_field( wp_unslash( (string) ( $_POST['_sg_amazon_market'] ?? '' ) ) ) );

		if ( '' === $sku ) {
			delete_post_meta( $post_id, self::META_SKU );
		} else {
			update_post_meta( $post_id, self::META_SKU, $sku );
		}
		if ( '' === $market ) {
			delete_post_meta( $post_id, self::META_MARKET );
		} else {
			update_post_meta( $post_id, self::META_MARKET, $market );
		}

		// Immediately sync this post.
		$this->sync_post( $post_id );
	}

	/**
	 * Shortcode: [sg_theme_price slug="cookie"] — used by the theme itself
	 * if it wants to show the live price with currency.
	 */
	public function shortcode_price( $atts ): string {
		$atts = shortcode_atts( array( 'slug' => '', 'post_id' => 0 ), is_array( $atts ) ? $atts : array(), 'sg_theme_price' );
		$post_id = (int) $atts['post_id'];
		if ( 0 === $post_id && '' !== (string) $atts['slug'] ) {
			$post = get_page_by_path( (string) $atts['slug'], OBJECT, self::CPT );
			if ( $post ) $post_id = $post->ID;
		}
		if ( 0 === $post_id ) return '';
		$sku    = (string) get_post_meta( $post_id, self::META_SKU, true );
		$market = (string) get_post_meta( $post_id, self::META_MARKET, true ) ?: $this->geo->market();
		if ( '' === $sku ) return '';
		$row = $this->products->find_by_sku( $market, $sku );
		if ( null === $row || null === $row['buybox_price'] ) return '';
		$currency = $row['buybox_currency'] ?: ( $this->marketplaces->get( $market )['currency'] ?? '' );
		return sprintf(
			'<span class="sg-theme-price">%s <small>%s</small></span>',
			esc_html( number_format( (float) $row['buybox_price'], 2 ) ),
			esc_html( $currency )
		);
	}

	/**
	 * Shortcode: [sg_theme_buy slug="cookie"] — geotargeted Amazon button
	 * that also updates in place via the widget auto-refresh JS.
	 */
	public function shortcode_buy( $atts ): string {
		$atts = shortcode_atts(
			array( 'slug' => '', 'post_id' => 0, 'label' => '' ),
			is_array( $atts ) ? $atts : array(),
			'sg_theme_buy'
		);
		$post_id = (int) $atts['post_id'];
		if ( 0 === $post_id && '' !== (string) $atts['slug'] ) {
			$post = get_page_by_path( (string) $atts['slug'], OBJECT, self::CPT );
			if ( $post ) $post_id = $post->ID;
		}
		if ( 0 === $post_id ) return '';

		$sku = (string) get_post_meta( $post_id, self::META_SKU, true );
		if ( '' === $sku ) return '';

		// Geotargeted: use visitor's market, not the mapped one.
		$market = $this->geo->market();
		$row    = $this->products->find_by_sku( $market, $sku );

		// Fallback: if we don't have this SKU in visitor's market, fall back to
		// the mapped market.
		if ( null === $row ) {
			$mapped_market = (string) get_post_meta( $post_id, self::META_MARKET, true );
			if ( '' !== $mapped_market ) {
				$row = $this->products->find_by_sku( $mapped_market, $sku );
				if ( null !== $row ) $market = $mapped_market;
			}
		}

		if ( null === $row || '' === $row['asin'] ) return '';

		$url = $this->marketplaces->product_url( (string) $row['asin'], $market );
		$currency = $row['buybox_currency'] ?: ( $this->marketplaces->get( $market )['currency'] ?? '' );
		$price_str = null !== $row['buybox_price']
			? number_format( (float) $row['buybox_price'], 2 ) . ' ' . $currency
			: '';

		$default_label = '' !== $price_str
			? sprintf( /* translators: %s: price */ __( 'Buy on Amazon — %s', 'sg-commerce' ), $price_str )
			: __( 'Buy on Amazon', 'sg-commerce' );
		$label = (string) $atts['label'] !== '' ? (string) $atts['label'] : $default_label;

		return sprintf(
			'<a href="%s" class="sg-theme-buy" target="_blank" rel="noopener noreferrer sponsored" data-sku="%s" data-market="%s">🛒 %s</a>',
			esc_url( $url ),
			esc_attr( $sku ),
			esc_attr( $market ),
			esc_html( $label )
		);
	}
}
