<?php
/**
 * View — Theme Bridge (v3.2).
 *
 * Shows every `products` CPT post and the Amazon SKU it's mapped to.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Integration\ThemeBridge;

$marketplaces = $container->get( Marketplaces::class );
$products     = $container->get( ProductRepository::class );

$theme_slug = get_stylesheet();
$theme_active = ( 'sevengum' === $theme_slug || 'sevengum' === get_template() );

$theme_posts = get_posts( array(
	'post_type'      => 'products',
	'post_status'    => array( 'publish', 'draft' ),
	'posts_per_page' => -1,
	'orderby'        => 'title',
	'order'          => 'ASC',
) );

$mapped = 0;
$unmapped = 0;
$rows = array();
foreach ( (array) $theme_posts as $p ) {
	$sku    = (string) get_post_meta( $p->ID, ThemeBridge::META_SKU, true );
	$market = (string) get_post_meta( $p->ID, ThemeBridge::META_MARKET, true ) ?: $marketplaces->primary();
	$last   = (string) get_post_meta( $p->ID, ThemeBridge::META_LAST_SYNC, true );
	$stock  = (int)    get_post_meta( $p->ID, ThemeBridge::META_STOCK_CACHE, true );
	$price  = (string) get_post_meta( $p->ID, '_sevengum_price', true );
	$theme_mod = (string) get_theme_mod( 'sg_amazon_' . $p->post_name, '' );
	$amazon_row = '' !== $sku ? $products->find_by_sku( $market, $sku ) : null;

	if ( '' !== $sku ) $mapped++; else $unmapped++;

	$rows[] = array(
		'post'      => $p,
		'sku'       => $sku,
		'market'    => $market,
		'last'      => $last,
		'stock'     => $stock,
		'price'     => $price,
		'theme_mod' => $theme_mod,
		'row'       => $amazon_row,
	);
}
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1>Theme <span>Bridge</span></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Direct integration with the Seven Gum theme (no WooCommerce). Live Amazon prices and Buy URLs flow into your theme CTAs automatically.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<?php if ( ! $theme_active ) : ?>
		<div class="sg-card" style="border-left: 4px solid #b45309;">
			<h2><?php esc_html_e( 'Seven Gum theme not active', 'sg-commerce' ); ?></h2>
			<p>
				<?php printf(
					esc_html__( 'Current theme: %s. Theme Bridge is designed specifically for the Seven Gum theme (products CPT + sg_amazon_* theme mods). It will activate automatically once you switch to it.', 'sg-commerce' ),
					'<code>' . esc_html( $theme_slug ) . '</code>'
				); ?>
			</p>
		</div>
	<?php endif; ?>

	<section class="sg-stats">
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Theme posts', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo (int) ( $mapped + $unmapped ); ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'products CPT', 'sg-commerce' ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Mapped to SKU', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo (int) $mapped; ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'linked to Amazon', 'sg-commerce' ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Unmapped', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value" style="color: <?php echo $unmapped > 0 ? '#b45309' : '#059669'; ?>;"><?php echo (int) $unmapped; ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'need SKU assignment', 'sg-commerce' ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Active theme', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value sg-stat-value-text"><?php echo esc_html( $theme_slug ); ?></p>
			<p class="sg-stat-meta">
				<?php echo $theme_active
					? '<span style="color:#059669;">✓ ' . esc_html__( 'compatible', 'sg-commerce' ) . '</span>'
					: '<span style="color:#b45309;">⚠ ' . esc_html__( 'incompatible', 'sg-commerce' ) . '</span>'; ?>
			</p>
		</div>
	</section>

	<div class="sg-grid-2">
		<div class="sg-card">
			<h2><?php esc_html_e( 'How it works', 'sg-commerce' ); ?></h2>
			<ol class="sg-attr-list">
				<li><?php esc_html_e( 'Edit a product in wp-admin → Products.', 'sg-commerce' ); ?></li>
				<li><?php esc_html_e( 'In the right-hand "Amazon link" meta box, pick the market and SKU.', 'sg-commerce' ); ?></li>
				<li><?php esc_html_e( 'After every sync (hourly cron or manual), we push:', 'sg-commerce' ); ?>
					<ul style="margin-top:6px; padding-left:20px;">
						<li>Buy Box price → <code>_sevengum_price</code> post meta</li>
						<li>Amazon URL   → <code>theme_mod['sg_amazon_{slug}']</code></li>
						<li>Stock count  → <code>_sg_amazon_stock</code> post meta</li>
					</ul>
				</li>
				<li><?php esc_html_e( 'Theme templates (single-products.php, front-page.php) pick up the fresh values automatically via existing sg_get_buy_url() helper.', 'sg-commerce' ); ?></li>
			</ol>
		</div>

		<div class="sg-card">
			<h2><?php esc_html_e( 'Shortcodes for theme', 'sg-commerce' ); ?></h2>
			<p><?php esc_html_e( 'Use these anywhere in your theme templates or post content:', 'sg-commerce' ); ?></p>
<pre class="sg-code">[sg_theme_price slug="cookie"]
[sg_theme_buy slug="cookie" label="Buy Cookie Gum"]</pre>
			<p class="sg-muted" style="font-size:12px;">
				<?php esc_html_e( 'The buy button is geotargeted: a visitor from Germany sees amazon.de pricing and URL.', 'sg-commerce' ); ?>
			</p>

			<hr />

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<?php wp_nonce_field( 'sg_theme_resync', AdminModule::NONCE ); ?>
				<input type="hidden" name="action" value="sg_theme_resync" />
				<div class="sg-actions">
					<button class="sg-btn"><?php esc_html_e( 'Force resync now', 'sg-commerce' ); ?></button>
				</div>
			</form>
		</div>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Mapping overview', 'sg-commerce' ); ?> (<?php echo (int) ( $mapped + $unmapped ); ?>)</h2>

		<?php if ( empty( $rows ) ) : ?>
			<div class="sg-empty"><p><?php esc_html_e( 'No products CPT posts found. Create a product first.', 'sg-commerce' ); ?></p></div>
		<?php else : ?>
			<div class="sg-table-wrap">
				<table class="sg-table">
					<thead><tr>
						<th><?php esc_html_e( 'Post', 'sg-commerce' ); ?></th>
						<th><?php esc_html_e( 'Slug', 'sg-commerce' ); ?></th>
						<th><?php esc_html_e( 'Amazon SKU', 'sg-commerce' ); ?></th>
						<th><?php esc_html_e( 'Market', 'sg-commerce' ); ?></th>
						<th style="text-align:right;"><?php esc_html_e( 'Stock', 'sg-commerce' ); ?></th>
						<th style="text-align:right;"><?php esc_html_e( 'Price', 'sg-commerce' ); ?></th>
						<th><?php esc_html_e( 'Buy URL', 'sg-commerce' ); ?></th>
						<th><?php esc_html_e( 'Last sync', 'sg-commerce' ); ?></th>
					</tr></thead>
					<tbody>
					<?php foreach ( $rows as $r ) : ?>
						<tr>
							<td>
								<strong><a href="<?php echo esc_url( get_edit_post_link( $r['post']->ID ) ); ?>"><?php echo esc_html( $r['post']->post_title ); ?></a></strong>
								<span class="sg-chip sg-chip-muted" style="margin-left:4px; font-size:10px;"><?php echo esc_html( $r['post']->post_status ); ?></span>
							</td>
							<td class="sg-mono"><?php echo esc_html( $r['post']->post_name ); ?></td>
							<td>
								<?php if ( '' === $r['sku'] ) : ?>
									<span class="sg-chip sg-chip-warn"><?php esc_html_e( 'unmapped', 'sg-commerce' ); ?></span>
								<?php else : ?>
									<code><?php echo esc_html( $r['sku'] ); ?></code>
									<?php if ( null === $r['row'] ) : ?>
										<br /><span style="color:#b91c1c; font-size:11px;">⚠ <?php esc_html_e( 'not in Amazon data', 'sg-commerce' ); ?></span>
									<?php endif; ?>
								<?php endif; ?>
							</td>
							<td><span class="sg-chip"><?php echo esc_html( $r['market'] ); ?></span></td>
							<td style="text-align:right;" class="sg-mono">
								<?php if ( '' === $r['sku'] ) : ?>
									<span class="sg-muted">—</span>
								<?php elseif ( $r['stock'] > 5 ) : ?>
									<span class="sg-chip sg-chip-ok"><?php echo (int) $r['stock']; ?></span>
								<?php elseif ( $r['stock'] > 0 ) : ?>
									<span class="sg-chip sg-chip-warn"><?php echo (int) $r['stock']; ?></span>
								<?php else : ?>
									<span class="sg-chip sg-chip-err">0</span>
								<?php endif; ?>
							</td>
							<td style="text-align:right;" class="sg-mono">
								<?php echo '' !== $r['price'] ? esc_html( number_format( (float) $r['price'], 2 ) ) : '<span class="sg-muted">—</span>'; ?>
							</td>
							<td>
								<?php if ( '' !== $r['theme_mod'] ) : ?>
									<span class="sg-chip sg-chip-ok" title="<?php echo esc_attr( $r['theme_mod'] ); ?>">✓</span>
								<?php else : ?>
									<span class="sg-muted">—</span>
								<?php endif; ?>
							</td>
							<td class="sg-muted" style="font-size:11.5px;">
								<?php echo '' !== $r['last'] ? esc_html( human_time_diff( strtotime( (string) $r['last'] ), time() ) . ' ago' ) : '—'; ?>
							</td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
			</div>
		<?php endif; ?>
	</div>
</div>
