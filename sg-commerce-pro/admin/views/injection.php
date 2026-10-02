<?php
/**
 * View — Auto-Injection rules.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;

$marketplaces = $container->get( Marketplaces::class );
$settings     = $container->get( SettingsRepository::class );
$enabled      = (bool) $settings->get( 'injection_enabled', true );

global $wpdb;
$rules = $wpdb->get_results(
	"SELECT * FROM {$wpdb->prefix}sg_injection_rules ORDER BY priority ASC, id ASC",
	ARRAY_A
);
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1>Auto-<span>Injection</span></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Auto-link keyword mentions in your blog posts to Amazon. Write naturally — the plugin adds affiliate links, live widgets, or hover tooltips for matched SKUs.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
		<?php wp_nonce_field( 'sg_save_injection_settings', AdminModule::NONCE ); ?>
		<input type="hidden" name="action" value="sg_save_injection_settings" />

		<h2><?php esc_html_e( 'Global toggle', 'sg-commerce' ); ?></h2>
		<label class="sg-inline" style="margin:12px 0 8px;">
			<input type="checkbox" name="injection_enabled" value="1" <?php checked( $enabled ); ?> />
			<strong><?php esc_html_e( 'Enable auto-injection', 'sg-commerce' ); ?></strong>
		</label>
		<p class="sg-muted" style="font-size:12px;">
			<?php esc_html_e( 'When off, no rules run regardless of individual rule state. Affects singular post/page content only — never admin, feeds, or excerpts.', 'sg-commerce' ); ?>
		</p>
		<div class="sg-actions">
			<button class="sg-btn"><?php esc_html_e( 'Save', 'sg-commerce' ); ?></button>
		</div>
	</form>

	<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
		<h2><?php esc_html_e( 'Add injection rule', 'sg-commerce' ); ?></h2>

		<?php wp_nonce_field( 'sg_add_injection_rule', AdminModule::NONCE ); ?>
		<input type="hidden" name="action" value="sg_add_injection_rule" />

		<div class="sg-grid-4">
			<label><?php esc_html_e( 'Pattern type', 'sg-commerce' ); ?>
				<select name="pattern_type">
					<option value="keyword"><?php esc_html_e( 'Keyword (exact)', 'sg-commerce' ); ?></option>
					<option value="regex"><?php esc_html_e( 'Regex (advanced)', 'sg-commerce' ); ?></option>
				</select>
			</label>
			<label><?php esc_html_e( 'Pattern', 'sg-commerce' ); ?> *
				<input type="text" name="pattern" required placeholder="cookie gum" />
			</label>
			<label>SKU *
				<input type="text" name="sku" required placeholder="SG-COOKIE-01" />
			</label>
			<label><?php esc_html_e( 'Render as', 'sg-commerce' ); ?>
				<select name="render_as">
					<option value="link"><?php esc_html_e( 'Link (SEO-friendly)', 'sg-commerce' ); ?></option>
					<option value="widget"><?php esc_html_e( 'Full widget', 'sg-commerce' ); ?></option>
					<option value="tooltip"><?php esc_html_e( 'Hover tooltip', 'sg-commerce' ); ?></option>
				</select>
			</label>
		</div>

		<div class="sg-grid-4">
			<label><?php esc_html_e( 'Market (blank = visitor geo)', 'sg-commerce' ); ?>
				<select name="market">
					<option value="">auto</option>
					<?php foreach ( array_keys( $marketplaces->all() ) as $code ) : ?>
						<option value="<?php echo esc_attr( $code ); ?>"><?php echo esc_html( $code ); ?></option>
					<?php endforeach; ?>
				</select>
			</label>
			<label><?php esc_html_e( 'Priority', 'sg-commerce' ); ?>
				<input type="number" name="priority" min="1" max="100" value="10" />
			</label>
			<label><?php esc_html_e( 'Max per post', 'sg-commerce' ); ?>
				<input type="number" name="max_per_post" min="1" max="20" value="1" />
			</label>
		</div>

		<div class="sg-actions">
			<button class="sg-btn sg-btn-primary"><?php esc_html_e( 'Add rule', 'sg-commerce' ); ?></button>
		</div>
	</form>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Rules', 'sg-commerce' ); ?> (<?php echo count( (array) $rules ); ?>)</h2>

		<?php if ( empty( $rules ) ) : ?>
			<div class="sg-empty"><p><?php esc_html_e( 'No rules yet. Add one above.', 'sg-commerce' ); ?></p></div>
		<?php else : ?>
			<table class="sg-table">
				<thead><tr>
					<th><?php esc_html_e( 'Active', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Priority', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Pattern', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'SKU', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Market', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Render', 'sg-commerce' ); ?></th>
					<th style="text-align:right;"><?php esc_html_e( 'Hits', 'sg-commerce' ); ?></th>
					<th></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $rules as $rule ) : ?>
					<tr>
						<td>
							<?php echo (int) $rule['is_active']
								? '<span class="sg-chip sg-chip-ok">On</span>'
								: '<span class="sg-chip sg-chip-muted">Off</span>'; ?>
						</td>
						<td class="sg-mono"><?php echo (int) $rule['priority']; ?></td>
						<td>
							<code><?php echo esc_html( (string) $rule['pattern'] ); ?></code>
							<?php if ( 'regex' === $rule['pattern_type'] ) : ?>
								<span class="sg-chip sg-chip-muted" style="margin-left:4px;">regex</span>
							<?php endif; ?>
						</td>
						<td class="sg-mono"><?php echo esc_html( $rule['sku'] ); ?></td>
						<td><?php echo (string) $rule['market'] !== '' ? '<span class="sg-chip">' . esc_html( $rule['market'] ) . '</span>' : '<span class="sg-muted">auto</span>'; ?></td>
						<td><span class="sg-chip"><?php echo esc_html( $rule['render_as'] ); ?></span></td>
						<td style="text-align:right;" class="sg-mono"><?php echo (int) $rule['hit_count']; ?></td>
						<td style="white-space:nowrap;">
							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;">
								<?php wp_nonce_field( 'sg_toggle_injection', AdminModule::NONCE ); ?>
								<input type="hidden" name="action" value="sg_toggle_injection" />
								<input type="hidden" name="id" value="<?php echo (int) $rule['id']; ?>" />
								<button class="sg-btn sg-btn-sm"><?php echo (int) $rule['is_active'] ? esc_html__( 'Off', 'sg-commerce' ) : esc_html__( 'On', 'sg-commerce' ); ?></button>
							</form>
							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;"
								onsubmit="return confirm('<?php echo esc_js( __( 'Delete this rule?', 'sg-commerce' ) ); ?>');">
								<?php wp_nonce_field( 'sg_delete_injection', AdminModule::NONCE ); ?>
								<input type="hidden" name="action" value="sg_delete_injection" />
								<input type="hidden" name="id" value="<?php echo (int) $rule['id']; ?>" />
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
		<h2><?php esc_html_e( 'Short-link helper', 'sg-commerce' ); ?></h2>
		<p><?php esc_html_e( 'Use this geotargeted redirect URL anywhere — inside posts, emails, social media. Visitors are sent to the correct amazon.xx URL for their country automatically.', 'sg-commerce' ); ?></p>
<pre class="sg-code"><?php echo esc_html( home_url( '/?sg_go={SKU}' ) ); ?></pre>
		<p class="sg-muted" style="font-size:12px;"><?php esc_html_e( 'Example:', 'sg-commerce' ); ?> <code><?php echo esc_html( home_url( '/?sg_go=SG-COOKIE-01' ) ); ?></code></p>
	</div>
</div>
