<?php
/**
 * ComparisonTable — [sg_compare] shortcode.
 *
 * Usage:
 *   [sg_compare skus="SG-COOKIE-01,SG-MINT-01,SG-CINN-01"]
 *   [sg_compare skus="..." market="auto" features="flavor,price,stock,calories"]
 *   [sg_compare slug="summer-flavors"]   (loads from wp_sg_comparisons)
 *
 * Rendering:
 *   Desktop (>= 768px): horizontal table, feature rows × product columns
 *   Mobile (< 768px):   stacked cards, one per product, features as dt/dd
 *
 * The breakpoint is handled in CSS — server always emits the same HTML.
 * Both layouts are included in the markup so it's a pure CSS toggle.
 *
 * Each product block has a `data-sku` / `data-market` so the widget's
 * auto-refresh JS picks it up and keeps price + stock live.
 *
 * @package SevenGum\Commerce\Comparison
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Comparison;

use SevenGum\Commerce\AI\Copywriter;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Database\Repositories\ProductRepository;

defined( 'ABSPATH' ) || exit;

final class ComparisonTable {

	/**
	 * Default feature rows if the `features` attribute isn't set. These map
	 * to keys we pull from the product row or compute.
	 */
	private const DEFAULT_FEATURES = array( 'image', 'name', 'price', 'stock', 'cta' );

	public function __construct(
		private ProductRepository $products,
		private Marketplaces $marketplaces,
		private Copywriter $copywriter,
	) {}

	public function render( $atts ): string {
		$atts = shortcode_atts(
			array(
				'skus'     => '',
				'slug'     => '',
				'market'   => 'auto', // Geotargeting filter turns 'auto' into visitor's market.
				'features' => implode( ',', self::DEFAULT_FEATURES ),
				'title'    => '',
			),
			is_array( $atts ) ? $atts : array(),
			'sg_compare'
		);

		$skus    = array();
		$market  = strtoupper( (string) $atts['market'] );
		$title   = sanitize_text_field( (string) $atts['title'] );

		// Load from stored comparison set by slug.
		if ( '' !== (string) $atts['slug'] ) {
			global $wpdb;
			$set = $wpdb->get_row( $wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}sg_comparisons WHERE slug = %s",
				sanitize_key( (string) $atts['slug'] )
			), ARRAY_A );
			if ( $set ) {
				$decoded = json_decode( (string) $set['skus'], true );
				if ( is_array( $decoded ) ) $skus = $decoded;
				if ( '' === $title ) $title = (string) $set['title'];
				if ( '' !== (string) $set['market'] && 'AUTO' === $market ) {
					$market = (string) $set['market'];
				}
			}
		} else {
			$skus = array_filter( array_map( 'trim', explode( ',', (string) $atts['skus'] ) ) );
		}

		if ( empty( $skus ) ) {
			return '<div class="sg-compare sg-compare--error">[sg_compare] requires either <code>skus</code> or a <code>slug</code>.</div>';
		}
		if ( ! $this->marketplaces->exists( $market ) ) {
			return sprintf( '<div class="sg-compare sg-compare--error">Invalid market: %s</div>', esc_html( $market ) );
		}

		$feature_keys = array_filter( array_map( 'trim', explode( ',', (string) $atts['features'] ) ) );
		if ( empty( $feature_keys ) ) $feature_keys = self::DEFAULT_FEATURES;

		// Resolve products.
		$resolved = array();
		foreach ( $skus as $sku ) {
			$row = $this->products->find_by_sku( $market, (string) $sku );
			if ( $row ) {
				$resolved[] = $this->build_vm( $row, $market );
			}
		}

		if ( empty( $resolved ) ) {
			return '<div class="sg-compare sg-compare--error">No matching products found in ' . esc_html( $market ) . '.</div>';
		}

		return $this->render_html( $resolved, $feature_keys, $title, $market );
	}

	private function build_vm( array $row, string $market ): array {
		$mp = $this->marketplaces->get( $market );
		$currency = (string) $row['buybox_currency'] ?: ( $mp['currency'] ?? '' );
		$lang = (string) ( $mp['language'] ?? 'en' );

		$description = $this->copywriter->find_description( (int) $row['id'], $lang )
			?? $this->copywriter->find_description( (int) $row['id'], 'en' )
			?? '';

		return array(
			'id'          => (int) $row['id'],
			'sku'         => (string) $row['sku'],
			'asin'        => (string) $row['asin'],
			'name'        => (string) $row['product_name'],
			'image_url'   => (string) $row['image_url'],
			'stock'       => (int) $row['fulfillable_qty'],
			'in_stock'    => (int) $row['fulfillable_qty'] > 0,
			'price'       => null !== $row['buybox_price'] ? (float) $row['buybox_price'] : null,
			'currency'    => $currency,
			'description' => $description,
			'amazon_url'  => '' !== $row['asin'] ? $this->marketplaces->product_url( (string) $row['asin'], $market ) : '',
		);
	}

	/**
	 * Emits both desktop (table) and mobile (cards) markup in one HTML block.
	 * CSS toggles visibility at 768px breakpoint.
	 */
	private function render_html( array $items, array $features, string $title, string $market ): string {
		ob_start();
		?>
		<div class="sg-compare" data-market="<?php echo esc_attr( $market ); ?>">
			<?php if ( '' !== $title ) : ?>
				<h3 class="sg-compare__title"><?php echo esc_html( $title ); ?></h3>
			<?php endif; ?>

			<!-- DESKTOP: table -->
			<div class="sg-compare__table-wrap">
				<table class="sg-compare__table">
					<thead>
						<tr>
							<th><?php esc_html_e( 'Feature', 'sg-commerce' ); ?></th>
							<?php foreach ( $items as $p ) : ?>
								<th scope="col">
									<div class="sg-compare__col-head">
										<?php if ( '' !== $p['image_url'] ) : ?>
											<img src="<?php echo esc_url( $p['image_url'] ); ?>" alt="<?php echo esc_attr( $p['name'] ); ?>" loading="lazy" />
										<?php endif; ?>
										<strong><?php echo esc_html( $p['name'] ?: $p['sku'] ); ?></strong>
									</div>
								</th>
							<?php endforeach; ?>
						</tr>
					</thead>
					<tbody>
						<?php foreach ( $features as $feature ) : if ( 'image' === $feature || 'name' === $feature ) continue; ?>
							<tr>
								<th scope="row"><?php echo esc_html( $this->feature_label( $feature ) ); ?></th>
								<?php foreach ( $items as $p ) : ?>
									<td data-sku="<?php echo esc_attr( $p['sku'] ); ?>" data-market="<?php echo esc_attr( $market ); ?>">
										<?php echo $this->feature_cell( $feature, $p ); // phpcs:ignore ?>
									</td>
								<?php endforeach; ?>
							</tr>
						<?php endforeach; ?>
					</tbody>
				</table>
			</div>

			<!-- MOBILE: stacked cards -->
			<div class="sg-compare__cards">
				<?php foreach ( $items as $p ) : ?>
					<div class="sg-compare__card" data-sku="<?php echo esc_attr( $p['sku'] ); ?>" data-market="<?php echo esc_attr( $market ); ?>">
						<?php if ( in_array( 'image', $features, true ) && '' !== $p['image_url'] ) : ?>
							<div class="sg-compare__card-image">
								<img src="<?php echo esc_url( $p['image_url'] ); ?>" alt="<?php echo esc_attr( $p['name'] ); ?>" loading="lazy" />
							</div>
						<?php endif; ?>
						<h4 class="sg-compare__card-title"><?php echo esc_html( $p['name'] ?: $p['sku'] ); ?></h4>

						<dl class="sg-compare__dl">
							<?php foreach ( $features as $feature ) :
								if ( in_array( $feature, array( 'image', 'name', 'cta' ), true ) ) continue;
							?>
								<dt><?php echo esc_html( $this->feature_label( $feature ) ); ?></dt>
								<dd><?php echo $this->feature_cell( $feature, $p ); // phpcs:ignore ?></dd>
							<?php endforeach; ?>
						</dl>

						<?php if ( in_array( 'cta', $features, true ) && '' !== $p['amazon_url'] ) : ?>
							<a href="<?php echo esc_url( $p['amazon_url'] ); ?>"
								class="sg-compare__cta"
								target="_blank" rel="noopener noreferrer sponsored">
								<?php esc_html_e( 'Buy on Amazon →', 'sg-commerce' ); ?>
							</a>
						<?php endif; ?>
					</div>
				<?php endforeach; ?>
			</div>
		</div>
		<?php
		return (string) ob_get_clean();
	}

	private function feature_label( string $key ): string {
		return match ( $key ) {
			'price'       => __( 'Price', 'sg-commerce' ),
			'stock'       => __( 'Availability', 'sg-commerce' ),
			'description' => __( 'Description', 'sg-commerce' ),
			'cta'         => __( 'Buy', 'sg-commerce' ),
			'sku'         => 'SKU',
			'asin'        => 'ASIN',
			default       => ucfirst( str_replace( '_', ' ', $key ) ),
		};
	}

	private function feature_cell( string $feature, array $p ): string {
		switch ( $feature ) {
			case 'price':
				if ( null === $p['price'] ) return '<span class="sg-muted">—</span>';
				return '<span class="sg-compare__price" data-role="price">'
					. esc_html( number_format( $p['price'], 2 ) )
					. ' <small>' . esc_html( $p['currency'] ) . '</small></span>';
			case 'stock':
				return $p['in_stock']
					? '<span class="sg-compare__badge sg-compare__badge--ok" data-role="stock">' . esc_html__( 'In stock', 'sg-commerce' ) . '</span>'
					: '<span class="sg-compare__badge sg-compare__badge--out" data-role="stock">' . esc_html__( 'Out of stock', 'sg-commerce' ) . '</span>';
			case 'description':
				return $p['description'] !== ''
					? esc_html( $p['description'] )
					: '<span class="sg-muted">—</span>';
			case 'cta':
				return '' !== $p['amazon_url']
					? '<a class="sg-compare__cta-small" href="' . esc_url( $p['amazon_url'] ) . '" target="_blank" rel="noopener noreferrer sponsored">' . esc_html__( 'Buy →', 'sg-commerce' ) . '</a>'
					: '<span class="sg-muted">—</span>';
			case 'sku':
				return '<code>' . esc_html( $p['sku'] ) . '</code>';
			case 'asin':
				return $p['asin'] ? '<code>' . esc_html( $p['asin'] ) . '</code>' : '<span class="sg-muted">—</span>';
			default:
				// Allow arbitrary keys from the row.
				return isset( $p[ $feature ] ) ? esc_html( (string) $p[ $feature ] ) : '<span class="sg-muted">—</span>';
		}
	}
}
