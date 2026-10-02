<?php
/**
 * View — Widgets / Shortcodes generator.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Database\Repositories\ProductRepository;

$products = $container->get( ProductRepository::class );
$result   = $products->paginate( array( 'page' => 1, 'per_page' => 200 ) );
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1><?php esc_html_e( 'Widgets &', 'sg-commerce' ); ?> <span><?php esc_html_e( 'Shortcodes', 'sg-commerce' ); ?></span></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Drop a live stock + price widget into any post or page. SSR for SEO, JS auto-refresh every 60 seconds.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<div class="sg-card">
		<h2><?php esc_html_e( 'How to use', 'sg-commerce' ); ?></h2>
		<p><?php esc_html_e( 'Paste this shortcode into any WordPress post or page. Replace sku and market with values from the table below.', 'sg-commerce' ); ?></p>
<pre class="sg-code">[sg_product sku="SG-COOKIE-01" market="US"]</pre>

		<h3><?php esc_html_e( 'Attributes', 'sg-commerce' ); ?></h3>
		<ul class="sg-attr-list">
			<li><code>sku</code> <span class="sg-muted">(required)</span> — <?php esc_html_e( 'the SKU exactly as shown below.', 'sg-commerce' ); ?></li>
			<li><code>market</code> — <?php esc_html_e( 'marketplace code (US, DE, ES, …). Defaults to your primary market.', 'sg-commerce' ); ?></li>
			<li><code>style</code> — <code>card</code> (default), <code>compact</code>, <?php esc_html_e( 'or', 'sg-commerce' ); ?> <code>default</code>.</li>
			<li><code>show</code> — <?php esc_html_e( 'comma-separated fields:', 'sg-commerce' ); ?> <code>image</code>, <code>name</code>, <code>desc</code>, <code>price</code>, <code>stock</code>, <code>cta</code>.</li>
		</ul>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Per-product shortcodes', 'sg-commerce' ); ?> (<?php echo count( $result['rows'] ); ?>)</h2>

		<?php if ( empty( $result['rows'] ) ) : ?>
			<div class="sg-empty">
				<p><?php esc_html_e( 'No products yet. Sync from Amazon or add a product manually on the', 'sg-commerce' ); ?> <a href="<?php echo esc_url( admin_url( 'admin.php?page=sg-commerce-products' ) ); ?>"><?php esc_html_e( 'Products', 'sg-commerce' ); ?></a> <?php esc_html_e( 'page.', 'sg-commerce' ); ?></p>
			</div>
		<?php else : ?>
			<table class="sg-table">
				<thead><tr>
					<th><?php esc_html_e( 'Market', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'SKU / Name', 'sg-commerce' ); ?></th>
					<th style="width:45%;"><?php esc_html_e( 'Shortcode', 'sg-commerce' ); ?></th>
					<th style="width:120px;"></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $result['rows'] as $r ) :
					$shortcode = sprintf(
						'[sg_product sku="%s" market="%s"]',
						esc_attr( (string) $r['sku'] ),
						esc_attr( (string) $r['market'] )
					);
				?>
					<tr>
						<td><span class="sg-chip"><?php echo esc_html( (string) $r['market'] ); ?></span></td>
						<td>
							<div class="sg-mono"><?php echo esc_html( (string) $r['sku'] ); ?></div>
							<div class="sg-muted" style="font-size:12px;"><?php echo esc_html( $r['product_name'] ?: '—' ); ?></div>
						</td>
						<td><code class="sg-code-inline" id="sg-sc-<?php echo (int) $r['id']; ?>"><?php echo esc_html( $shortcode ); ?></code></td>
						<td><button type="button" class="sg-btn sg-btn-sm" onclick="sgCopyShortcode(<?php echo (int) $r['id']; ?>, this)"><?php esc_html_e( 'Copy', 'sg-commerce' ); ?></button></td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'REST API', 'sg-commerce' ); ?></h2>
		<p><?php esc_html_e( 'Live product state for custom integrations:', 'sg-commerce' ); ?></p>
<pre class="sg-code">GET <?php echo esc_html( rest_url( 'sg-commerce/v1/product/{market}/{sku}' ) ); ?></pre>
	</div>
</div>

<script>
function sgCopyShortcode(id, btn) {
	var el = document.getElementById('sg-sc-' + id);
	if (!el) return;
	var text = el.textContent;
	var original = btn.textContent;
	function flash() { btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = original; }, 1400); }
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(text).then(flash, fallback);
	} else { fallback(); }
	function fallback() {
		var range = document.createRange();
		range.selectNode(el);
		window.getSelection().removeAllRanges();
		window.getSelection().addRange(range);
		try { document.execCommand('copy'); flash(); } catch (e) {}
	}
}
</script>
