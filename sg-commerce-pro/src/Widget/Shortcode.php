<?php
/**
 * Shortcode — [sg_product] frontend widget renderer.
 *
 * @package SevenGum\Commerce\Widget
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Widget;

use SevenGum\Commerce\AI\Copywriter;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Database\Repositories\ProductRepository;

defined( 'ABSPATH' ) || exit;

final class Shortcode {

	/** Per-request cache so repeat shortcodes on a page hit DB once. */
	private array $cache = array();

	public function __construct(
		private ProductRepository $products,
		private Marketplaces $marketplaces,
		private Copywriter $copywriter,
	) {}

	public function render( $atts ): string {
		$atts = shortcode_atts(
			array(
				'sku'    => '',
				'market' => 'auto', // Geotargeting module resolves 'auto' to visitor's market.
				'show'   => 'image,name,desc,price,stock,cta',
				'style'  => 'card',
			),
			is_array( $atts ) ? $atts : array(),
			'sg_product'
		);

		$sku    = sanitize_text_field( (string) $atts['sku'] );
		$market = strtoupper( sanitize_text_field( (string) $atts['market'] ) );
		if ( 'AUTO' === $market || '' === $market ) {
			// Geotargeting filter didn't resolve (module disabled) — fall back to primary.
			$market = $this->marketplaces->primary();
		}

		if ( '' === $sku ) {
			return '<div class="sg-widget sg-widget--error">[sg_product] requires a sku attribute.</div>';
		}
		if ( ! $this->marketplaces->exists( $market ) ) {
			return sprintf(
				'<div class="sg-widget sg-widget--error">Invalid market code: %s</div>',
				esc_html( $market )
			);
		}

		$data = $this->fetch( $sku, $market );
		if ( null === $data ) {
			return sprintf(
				'<div class="sg-widget sg-widget--error">Product %s not found in our catalog.</div>',
				esc_html( $sku )
			);
		}

		return $this->render_html( $data, $atts );
	}

	private function fetch( string $sku, string $market ): ?array {
		$key = $market . '|' . $sku;
		if ( array_key_exists( $key, $this->cache ) ) {
			return $this->cache[ $key ];
		}
		$row = $this->products->find_by_sku( $market, $sku );
		if ( null === $row ) {
			$this->cache[ $key ] = null;
			return null;
		}
		$mp = $this->marketplaces->get( $market );
		$lang = (string) ( $mp['language'] ?? 'en' );

		// Prefer the localized AI description, fall back to English.
		$description = $this->copywriter->find_description( (int) $row['id'], $lang )
			?? $this->copywriter->find_description( (int) $row['id'], 'en' )
			?? '';

		$data = array(
			'id'          => (int) $row['id'],
			'sku'         => (string) $row['sku'],
			'asin'        => (string) $row['asin'],
			'market'      => (string) $row['market'],
			'name'        => (string) $row['product_name'],
			'image_url'   => (string) $row['image_url'],
			'stock'       => (int) $row['fulfillable_qty'],
			'in_stock'    => (int) $row['fulfillable_qty'] > 0,
			'price'       => null !== $row['buybox_price'] ? (float) $row['buybox_price'] : null,
			'currency'    => (string) $row['buybox_currency'] ?: ( $mp['currency'] ?? '' ),
			'description' => $description,
			'amazon_url'  => '' !== $row['asin'] ? $this->marketplaces->product_url( (string) $row['asin'], $market ) : '',
		);
		$this->cache[ $key ] = $data;
		return $data;
	}

	private function render_html( array $d, array $atts ): string {
		$show  = array_map( 'trim', explode( ',', (string) $atts['show'] ) );
		$style = in_array( $atts['style'], array( 'default', 'compact', 'card' ), true ) ? $atts['style'] : 'card';

		ob_start();
		?>
		<div class="sg-widget sg-widget--<?php echo esc_attr( $style ); ?>"
			data-sku="<?php echo esc_attr( $d['sku'] ); ?>"
			data-market="<?php echo esc_attr( $d['market'] ); ?>">

			<?php if ( in_array( 'image', $show, true ) && '' !== $d['image_url'] ) : ?>
				<div class="sg-widget__image">
					<img src="<?php echo esc_url( $d['image_url'] ); ?>"
						alt="<?php echo esc_attr( $d['name'] ); ?>" loading="lazy" />
				</div>
			<?php endif; ?>

			<div class="sg-widget__body">
				<?php if ( in_array( 'name', $show, true ) && '' !== $d['name'] ) : ?>
					<h3 class="sg-widget__name"><?php echo esc_html( $d['name'] ); ?></h3>
				<?php endif; ?>

				<?php if ( in_array( 'desc', $show, true ) && '' !== $d['description'] ) : ?>
					<p class="sg-widget__desc"><?php echo esc_html( $d['description'] ); ?></p>
				<?php endif; ?>

				<div class="sg-widget__meta">
					<?php if ( in_array( 'price', $show, true ) && null !== $d['price'] ) : ?>
						<span class="sg-widget__price" data-role="price">
							<?php echo esc_html( number_format( $d['price'], 2 ) ); ?>
							<small><?php echo esc_html( $d['currency'] ); ?></small>
						</span>
					<?php endif; ?>

					<?php if ( in_array( 'stock', $show, true ) ) : ?>
						<span class="sg-widget__stock <?php echo $d['in_stock'] ? 'sg-widget__stock--ok' : 'sg-widget__stock--out'; ?>" data-role="stock">
							<?php echo $d['in_stock'] ? esc_html__( 'In stock', 'sg-commerce' ) : esc_html__( 'Out of stock', 'sg-commerce' ); ?>
						</span>
					<?php endif; ?>
				</div>

				<?php if ( in_array( 'cta', $show, true ) && '' !== $d['amazon_url'] ) : ?>
					<a href="<?php echo esc_url( $d['amazon_url'] ); ?>" class="sg-widget__cta" target="_blank" rel="noopener noreferrer">
						<?php echo esc_html__( 'Buy on Amazon →', 'sg-commerce' ); ?>
					</a>
				<?php endif; ?>
			</div>
		</div>
		<?php
		return (string) ob_get_clean();
	}
}
