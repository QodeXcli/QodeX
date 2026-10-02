<?php
/**
 * View — API Keys (v3.2).
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\API\HeadlessAPI;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;

$settings = $container->get( SettingsRepository::class );
$keys = (array) $settings->get( 'api_keys', array() );

$new_key = get_transient( 'sg_new_api_key_' . get_current_user_id() );
if ( $new_key ) {
	delete_transient( 'sg_new_api_key_' . get_current_user_id() );
}
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1>Headless <span>API Keys</span></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Full REST API for external React dashboards. Namespace sg-commerce/v2 with bearer-token auth + OpenAPI spec.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<?php if ( $new_key ) : ?>
		<div class="sg-card" style="border-left: 4px solid #059669; background: #f0fdf4;">
			<h2 style="color:#059669;">✓ <?php esc_html_e( 'New API key created', 'sg-commerce' ); ?></h2>
			<p><strong><?php esc_html_e( 'Copy this now — it will not be shown again:', 'sg-commerce' ); ?></strong></p>
<pre class="sg-code" style="user-select:all;"><?php echo esc_html( $new_key ); ?></pre>
			<p class="sg-muted" style="font-size:12px;">
				<?php esc_html_e( 'Use it in the Authorization header:', 'sg-commerce' ); ?>
				<code>Authorization: Bearer <?php echo esc_html( $new_key ); ?></code>
			</p>
		</div>
	<?php endif; ?>

	<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
		<h2><?php esc_html_e( 'Mint new key', 'sg-commerce' ); ?></h2>

		<?php wp_nonce_field( 'sg_mint_api_key', AdminModule::NONCE ); ?>
		<input type="hidden" name="action" value="sg_mint_api_key" />

		<label><?php esc_html_e( 'Label (what is this key for?)', 'sg-commerce' ); ?>
			<input type="text" name="label" required placeholder="React Dashboard — Production" />
		</label>

		<div class="sg-actions">
			<button class="sg-btn sg-btn-primary"><?php esc_html_e( 'Create key', 'sg-commerce' ); ?></button>
		</div>
	</form>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Existing keys', 'sg-commerce' ); ?> (<?php echo count( $keys ); ?>)</h2>
		<?php if ( empty( $keys ) ) : ?>
			<div class="sg-empty"><p><?php esc_html_e( 'No keys yet.', 'sg-commerce' ); ?></p></div>
		<?php else : ?>
			<table class="sg-table">
				<thead><tr>
					<th><?php esc_html_e( 'Label', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Created', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Key hash (first 12)', 'sg-commerce' ); ?></th>
					<th></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $keys as $idx => $k ) : if ( ! is_array( $k ) ) continue; ?>
					<tr>
						<td><strong><?php echo esc_html( (string) ( $k['label'] ?? 'unlabeled' ) ); ?></strong></td>
						<td class="sg-muted" style="font-size:11.5px;"><?php echo esc_html( (string) ( $k['created_at'] ?? '' ) ); ?></td>
						<td class="sg-mono" style="font-size:11px;"><?php echo esc_html( substr( (string) ( $k['hash'] ?? '' ), 0, 12 ) . '...' ); ?></td>
						<td>
							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>"
								onsubmit="return confirm('<?php echo esc_js( __( 'Revoke this key? Applications using it will stop working.', 'sg-commerce' ) ); ?>');">
								<?php wp_nonce_field( 'sg_revoke_api_key', AdminModule::NONCE ); ?>
								<input type="hidden" name="action" value="sg_revoke_api_key" />
								<input type="hidden" name="index" value="<?php echo (int) $idx; ?>" />
								<button class="sg-btn sg-btn-sm"><?php esc_html_e( 'Revoke', 'sg-commerce' ); ?></button>
							</form>
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'API reference', 'sg-commerce' ); ?></h2>

		<h3><?php esc_html_e( 'Base URL', 'sg-commerce' ); ?></h3>
<pre class="sg-code"><?php echo esc_html( rest_url( HeadlessAPI::NAMESPACE ) ); ?></pre>

		<h3><?php esc_html_e( 'Endpoints', 'sg-commerce' ); ?></h3>
		<ul class="sg-attr-list">
			<li><code>GET /products</code> — <?php esc_html_e( 'paginated product list', 'sg-commerce' ); ?></li>
			<li><code>GET /products/{id}</code> — <?php esc_html_e( 'one product', 'sg-commerce' ); ?></li>
			<li><code>GET /analytics/kpis</code> — <?php esc_html_e( 'headline KPIs', 'sg-commerce' ); ?></li>
			<li><code>GET /analytics/buybox-trend?days=14</code> — <?php esc_html_e( 'Buy Box won/lost per day', 'sg-commerce' ); ?></li>
			<li><code>GET /mcf/orders</code> — <?php esc_html_e( 'list MCF orders', 'sg-commerce' ); ?></li>
			<li><code>POST /mcf/orders</code> — <?php esc_html_e( 'create MCF fulfillment order', 'sg-commerce' ); ?></li>
			<li><code>GET /meta</code> — <?php esc_html_e( 'plugin version + enabled markets', 'sg-commerce' ); ?></li>
			<li><code>GET /openapi</code> — <?php esc_html_e( 'OpenAPI 3.0 spec (public)', 'sg-commerce' ); ?></li>
		</ul>

		<h3><?php esc_html_e( 'Example request', 'sg-commerce' ); ?></h3>
<pre class="sg-code">curl '<?php echo esc_html( rest_url( HeadlessAPI::NAMESPACE . '/products?in_stock=true&per_page=10' ) ); ?>' \
  -H 'Authorization: Bearer sgc_YOUR_KEY_HERE'</pre>

		<p class="sg-muted" style="font-size:12px;">
			<?php esc_html_e( 'Rate limit: 60 requests per minute per key. Returns 429 if exceeded.', 'sg-commerce' ); ?>
		</p>
	</div>
</div>
