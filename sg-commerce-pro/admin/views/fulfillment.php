<?php
/**
 * View — Fulfillment (MCF).
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Fulfillment\MCFOrderRepository;

$settings     = $container->get( SettingsRepository::class );
$marketplaces = $container->get( Marketplaces::class );
$repo         = $container->get( MCFOrderRepository::class );
$orders       = $repo->recent( 50 );
$counts       = $repo->count_by_status();

$mcf_auto_wc = (bool) $settings->get( 'mcf_auto_wc', false );
$default_market = (string) $settings->get( 'mcf_default_market', 'US' );
$default_speed  = (string) $settings->get( 'mcf_default_speed', 'Standard' );
$wc_active = class_exists( 'WooCommerce' );
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1>Multi-Channel <span>Fulfillment</span></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Use Amazon FBA warehouses to ship orders from your own storefront, WooCommerce, or custom channels. Amazon picks, packs, and ships.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<section class="sg-stats">
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Submitted', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo (int) ( $counts['submitted'] ?? 0 ); ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'waiting on Amazon', 'sg-commerce' ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Processing', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo (int) ( $counts['processing'] ?? 0 ); ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'picking/packing', 'sg-commerce' ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Shipped', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo (int) ( $counts['shipped'] ?? 0 ); ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'in transit', 'sg-commerce' ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Delivered', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo (int) ( $counts['delivered'] ?? 0 ); ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'complete', 'sg-commerce' ); ?></p>
		</div>
	</section>

	<div class="sg-grid-2">
		<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<h2><?php esc_html_e( 'Configuration', 'sg-commerce' ); ?></h2>

			<?php wp_nonce_field( 'sg_save_mcf', AdminModule::NONCE ); ?>
			<input type="hidden" name="action" value="sg_save_mcf" />

			<label class="sg-inline" style="margin:18px 0;">
				<input type="checkbox" name="mcf_auto_wc" value="1" <?php checked( $mcf_auto_wc ); ?> <?php disabled( ! $wc_active ); ?> />
				<strong><?php esc_html_e( 'Auto-fulfill WooCommerce orders via MCF', 'sg-commerce' ); ?></strong>
				<?php if ( ! $wc_active ) : ?>
					<span class="sg-chip sg-chip-muted"><?php esc_html_e( 'WooCommerce not active', 'sg-commerce' ); ?></span>
				<?php endif; ?>
			</label>
			<p class="sg-muted" style="font-size:12px;">
				<?php esc_html_e( 'When a WooCommerce order transitions to Processing, submit it to Amazon FBA automatically. Only runs if product SKUs match tracked Amazon SKUs.', 'sg-commerce' ); ?>
			</p>

			<label><?php esc_html_e( 'Default market', 'sg-commerce' ); ?>
				<select name="mcf_default_market">
					<?php foreach ( $marketplaces->enabled_codes() as $code ) : ?>
						<option value="<?php echo esc_attr( $code ); ?>" <?php selected( $default_market, $code ); ?>>
							<?php echo esc_html( $code ); ?>
						</option>
					<?php endforeach; ?>
				</select>
			</label>

			<label><?php esc_html_e( 'Default shipping speed', 'sg-commerce' ); ?>
				<select name="mcf_default_speed">
					<option value="Standard"  <?php selected( $default_speed, 'Standard' ); ?>>Standard (3-5 days)</option>
					<option value="Expedited" <?php selected( $default_speed, 'Expedited' ); ?>>Expedited (2 days)</option>
					<option value="Priority"  <?php selected( $default_speed, 'Priority' ); ?>>Priority (1 day)</option>
				</select>
			</label>

			<div class="sg-actions">
				<button class="sg-btn sg-btn-primary"><?php esc_html_e( 'Save', 'sg-commerce' ); ?></button>
			</div>
		</form>

		<div class="sg-card">
			<h2><?php esc_html_e( 'How MCF works', 'sg-commerce' ); ?></h2>

			<ol class="sg-steps sg-steps-compact">
				<li><span class="sg-step-num">1</span><div><?php esc_html_e( 'Customer orders on sevengum.com (or any non-Amazon channel).', 'sg-commerce' ); ?></div></li>
				<li><span class="sg-step-num">2</span><div><?php esc_html_e( 'We submit the order to SP-API /mfn/v0/fulfillmentOrders.', 'sg-commerce' ); ?></div></li>
				<li><span class="sg-step-num">3</span><div><?php esc_html_e( 'Amazon picks from your FBA inventory and ships to the customer.', 'sg-commerce' ); ?></div></li>
				<li><span class="sg-step-num">4</span><div><?php esc_html_e( 'Every 15 min we pull tracking + carrier info and update WooCommerce.', 'sg-commerce' ); ?></div></li>
			</ol>

			<hr />
			<h3><?php esc_html_e( 'Programmatic API', 'sg-commerce' ); ?></h3>
			<p><?php esc_html_e( 'Other plugins can submit MCF orders via:', 'sg-commerce' ); ?></p>
<pre class="sg-code">do_action('sg_commerce_fulfill', [
  'displayable_order_id' => 'WEB-12345',
  'market' => 'US',
  'customer' => ['name' => 'Jane', 'email' => '...', 'phone' => '...'],
  'address' => [
    'line1' => '123 Main St',
    'city' => 'Austin',
    'state_region' => 'TX',
    'postal_code' => '78701',
    'country_code' => 'US',
  ],
  'items' => [['sku' => 'SG-COOKIE-01', 'quantity' => 2]],
  'shipping_speed' => 'Standard',
]);</pre>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<?php wp_nonce_field( 'sg_refresh_mcf', AdminModule::NONCE ); ?>
				<input type="hidden" name="action" value="sg_refresh_mcf" />
				<div class="sg-actions">
					<button class="sg-btn"><?php esc_html_e( 'Refresh tracking now', 'sg-commerce' ); ?></button>
				</div>
			</form>
		</div>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Recent MCF orders', 'sg-commerce' ); ?></h2>

		<?php if ( empty( $orders ) ) : ?>
			<div class="sg-empty">
				<p><?php esc_html_e( 'No MCF orders yet. Enable WooCommerce auto-fulfill above, or call the sg_commerce_fulfill action from your code.', 'sg-commerce' ); ?></p>
			</div>
		<?php else : ?>
			<div class="sg-table-wrap">
				<table class="sg-table">
					<thead><tr>
						<th><?php esc_html_e( 'Order', 'sg-commerce' ); ?></th>
						<th><?php esc_html_e( 'Market', 'sg-commerce' ); ?></th>
						<th><?php esc_html_e( 'Customer', 'sg-commerce' ); ?></th>
						<th><?php esc_html_e( 'Ship to', 'sg-commerce' ); ?></th>
						<th><?php esc_html_e( 'Status', 'sg-commerce' ); ?></th>
						<th><?php esc_html_e( 'Tracking', 'sg-commerce' ); ?></th>
						<th><?php esc_html_e( 'Created', 'sg-commerce' ); ?></th>
						<th></th>
					</tr></thead>
					<tbody>
					<?php foreach ( $orders as $o ) :
						$tracking = json_decode( (string) $o['tracking_numbers'], true );
						$status_chip = match ( (string) $o['status'] ) {
							'delivered' => 'sg-chip-ok',
							'shipped'   => 'sg-chip-ok',
							'processing'=> 'sg-chip-warn',
							'submitted' => 'sg-chip-warn',
							'failed'    => 'sg-chip-err',
							'cancelled' => 'sg-chip-err',
							default     => 'sg-chip-muted',
						};
					?>
						<tr>
							<td>
								<div class="sg-mono"><?php echo esc_html( $o['displayable_order_id'] ); ?></div>
								<div class="sg-muted" style="font-size:11px; font-family:monospace;"><?php echo esc_html( $o['seller_fulfillment_order_id'] ); ?></div>
							</td>
							<td><span class="sg-chip"><?php echo esc_html( $o['market'] ); ?></span></td>
							<td>
								<?php echo esc_html( $o['customer_name'] ?: '—' ); ?>
								<div class="sg-muted" style="font-size:11px;"><?php echo esc_html( $o['customer_email'] ); ?></div>
							</td>
							<td><?php echo esc_html( trim( $o['city'] . ', ' . $o['country_code'], ', ' ) ); ?></td>
							<td>
								<span class="sg-chip <?php echo esc_attr( $status_chip ); ?>"><?php echo esc_html( $o['status'] ); ?></span>
								<?php if ( '' !== (string) $o['error_message'] ) : ?>
									<div class="sg-muted" style="font-size:11px; color:#b91c1c; margin-top:2px;"><?php echo esc_html( substr( (string) $o['error_message'], 0, 120 ) ); ?></div>
								<?php endif; ?>
							</td>
							<td class="sg-mono" style="font-size:11.5px;">
								<?php if ( is_array( $tracking ) && ! empty( $tracking ) ) : ?>
									<?php echo esc_html( implode( ', ', array_slice( $tracking, 0, 2 ) ) ); ?>
									<?php if ( '' !== (string) $o['carrier_code'] ) : ?>
										<div class="sg-muted"><?php echo esc_html( $o['carrier_code'] ); ?></div>
									<?php endif; ?>
								<?php else : ?>
									<span class="sg-muted">—</span>
								<?php endif; ?>
							</td>
							<td class="sg-muted" style="font-size:11.5px;"><?php echo esc_html( human_time_diff( strtotime( (string) $o['created_at'] ), time() ) . ' ago' ); ?></td>
							<td>
								<?php if ( in_array( (string) $o['status'], array( 'submitted', 'processing' ), true ) ) : ?>
									<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>"
										onsubmit="return confirm('<?php echo esc_js( __( 'Cancel this MCF order?', 'sg-commerce' ) ); ?>');">
										<?php wp_nonce_field( 'sg_cancel_mcf', AdminModule::NONCE ); ?>
										<input type="hidden" name="action" value="sg_cancel_mcf" />
										<input type="hidden" name="id" value="<?php echo (int) $o['id']; ?>" />
										<button class="sg-btn sg-btn-sm"><?php esc_html_e( 'Cancel', 'sg-commerce' ); ?></button>
									</form>
								<?php endif; ?>
							</td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
			</div>
		<?php endif; ?>
	</div>
</div>
