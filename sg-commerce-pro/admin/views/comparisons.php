<?php
/**
 * View — Comparison sets.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Amazon\Marketplaces;

$marketplaces = $container->get( Marketplaces::class );

global $wpdb;
$sets = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}sg_comparisons ORDER BY updated_at DESC", ARRAY_A );
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1><?php esc_html_e( 'Comparison', 'sg-commerce' ); ?> <span><?php esc_html_e( 'tables', 'sg-commerce' ); ?></span></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Build reusable product comparison tables. Horizontal tables on desktop, stacked cards on mobile — same markup, pure CSS responsive.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
		<h2><?php esc_html_e( 'Add / update comparison set', 'sg-commerce' ); ?></h2>

		<?php wp_nonce_field( 'sg_add_comparison', AdminModule::NONCE ); ?>
		<input type="hidden" name="action" value="sg_add_comparison" />

		<div class="sg-grid-4">
			<label><?php esc_html_e( 'Slug', 'sg-commerce' ); ?> *
				<input type="text" name="slug" required placeholder="cookie-vs-mint" />
			</label>
			<label><?php esc_html_e( 'Title', 'sg-commerce' ); ?>
				<input type="text" name="title" placeholder="Cookie vs Mint" />
			</label>
			<label><?php esc_html_e( 'Market', 'sg-commerce' ); ?>
				<select name="market">
					<option value="">auto</option>
					<?php foreach ( array_keys( $marketplaces->all() ) as $code ) : ?>
						<option value="<?php echo esc_attr( $code ); ?>"><?php echo esc_html( $code ); ?></option>
					<?php endforeach; ?>
				</select>
			</label>
			<label><?php esc_html_e( 'Features (comma)', 'sg-commerce' ); ?>
				<input type="text" name="features" placeholder="image,name,price,stock,cta" />
			</label>
		</div>
		<label><?php esc_html_e( 'SKUs (comma-separated)', 'sg-commerce' ); ?> *
			<input type="text" name="skus" required placeholder="SG-COOKIE-01, SG-MINT-01, SG-CINN-01" />
		</label>

		<div class="sg-actions">
			<button class="sg-btn sg-btn-primary"><?php esc_html_e( 'Save comparison', 'sg-commerce' ); ?></button>
		</div>
	</form>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Comparison sets', 'sg-commerce' ); ?> (<?php echo count( (array) $sets ); ?>)</h2>

		<?php if ( empty( $sets ) ) : ?>
			<div class="sg-empty">
				<p><?php esc_html_e( 'No comparison sets yet. Create one above to render with', 'sg-commerce' ); ?> <code>[sg_compare slug="..."]</code>.</p>
			</div>
		<?php else : ?>
			<table class="sg-table">
				<thead><tr>
					<th><?php esc_html_e( 'Slug', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Title', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Market', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'SKUs', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Shortcode', 'sg-commerce' ); ?></th>
					<th></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $sets as $set ) :
					$skus = json_decode( (string) $set['skus'], true );
					$skus_csv = is_array( $skus ) ? implode( ', ', $skus ) : '';
					$shortcode = sprintf( '[sg_compare slug="%s"]', esc_attr( $set['slug'] ) );
				?>
					<tr>
						<td class="sg-mono"><?php echo esc_html( $set['slug'] ); ?></td>
						<td><?php echo esc_html( $set['title'] ?: '—' ); ?></td>
						<td><?php echo $set['market'] ? '<span class="sg-chip">' . esc_html( $set['market'] ) . '</span>' : '<span class="sg-muted">auto</span>'; ?></td>
						<td class="sg-mono" style="font-size:11.5px;"><?php echo esc_html( $skus_csv ); ?></td>
						<td><code class="sg-code-inline" id="sg-cmp-<?php echo (int) $set['id']; ?>"><?php echo esc_html( $shortcode ); ?></code></td>
						<td style="white-space:nowrap;">
							<button type="button" class="sg-btn sg-btn-sm" onclick="sgCopyCmp(<?php echo (int) $set['id']; ?>, this)"><?php esc_html_e( 'Copy', 'sg-commerce' ); ?></button>
							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;"
								onsubmit="return confirm('<?php echo esc_js( __( 'Delete this comparison?', 'sg-commerce' ) ); ?>');">
								<?php wp_nonce_field( 'sg_delete_comparison', AdminModule::NONCE ); ?>
								<input type="hidden" name="action" value="sg_delete_comparison" />
								<input type="hidden" name="id" value="<?php echo (int) $set['id']; ?>" />
								<button class="sg-btn-icon">×</button>
							</form>
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Inline usage', 'sg-commerce' ); ?></h2>
		<p><?php esc_html_e( 'You can also use comparison tables inline without saving a set:', 'sg-commerce' ); ?></p>
<pre class="sg-code">[sg_compare skus="SG-COOKIE-01,SG-MINT-01,SG-CINN-01"]
[sg_compare skus="..." market="DE" features="image,name,price,stock,cta"]</pre>
	</div>
</div>

<script>
function sgCopyCmp(id, btn) {
	var el = document.getElementById('sg-cmp-' + id);
	if (!el) return;
	var text = el.textContent;
	var original = btn.textContent;
	function flash() { btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = original; }, 1400); }
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(text).then(flash, function(){});
	}
}
</script>
