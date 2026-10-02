<?php
/**
 * View — Inbound Plans (v3.3).
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Fulfillment\BoxContent\BoxContentService;

$marketplaces = $container->get( Marketplaces::class );
$box_service  = $container->get( BoxContentService::class );

global $wpdb;
$plans = $wpdb->get_results(
	"SELECT * FROM {$wpdb->prefix}sg_inbound_plans ORDER BY updated_at DESC LIMIT 50",
	ARRAY_A
);

$templates = $box_service->get_templates();
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1>Inbound <span>Shipments</span></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Send to Amazon (STA 2024+) workflow — create shipping plans, push box content, print labels. Designed for direct factory → FBA shipments.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<div class="sg-card" style="background:#f0fdf4; border-left:4px solid #059669;">
		<h2 style="color:#059669; margin-top:0;">✓ <?php esc_html_e( 'EAN-13 workflow enabled', 'sg-commerce' ); ?></h2>
		<p>
			<?php esc_html_e( 'Your product packs carry printed EAN-13 barcodes, so Amazon uses commingled inventory — NO per-pack FNSKU labels required. Master cartons ship directly from factory to FBA warehouse.', 'sg-commerce' ); ?>
		</p>
	</div>

	<div class="sg-grid-2">
		<div class="sg-card">
			<h2><?php esc_html_e( 'Master carton profile', 'sg-commerce' ); ?></h2>
			<?php if ( isset( $templates['sg-master-24pack'] ) ) : $t = $templates['sg-master-24pack']; ?>
				<dl class="sg-profile-grid">
					<dt><?php esc_html_e( 'Template', 'sg-commerce' ); ?></dt>
					<dd><code>sg-master-24pack</code></dd>

					<dt><?php esc_html_e( 'Dimensions', 'sg-commerce' ); ?></dt>
					<dd class="sg-mono"><?php
						echo esc_html( sprintf( '%.1f × %.1f × %.1f cm',
							(float) $t['length_cm'], (float) $t['width_cm'], (float) $t['height_cm']
						) );
					?></dd>

					<dt><?php esc_html_e( 'Volume', 'sg-commerce' ); ?></dt>
					<dd class="sg-mono"><?php
						$vol = (float) $t['length_cm'] * (float) $t['width_cm'] * (float) $t['height_cm'];
						echo esc_html( sprintf( '%.2f liters', $vol / 1000 ) );
					?></dd>

					<dt><?php esc_html_e( 'Net weight', 'sg-commerce' ); ?></dt>
					<dd class="sg-mono"><?php echo esc_html( (string) $t['net_weight_kg'] ); ?> kg</dd>

					<dt><?php esc_html_e( 'Gross weight', 'sg-commerce' ); ?></dt>
					<dd class="sg-mono"><strong><?php echo esc_html( (string) $t['weight_kg'] ); ?> kg</strong></dd>

					<dt><?php esc_html_e( 'Contents', 'sg-commerce' ); ?></dt>
					<dd><?php echo esc_html( sprintf(
						'%d inner × %d packs = %d packs',
						(int) $t['inner_boxes'],
						(int) $t['packs_per_inner_box'],
						(int) $t['packs_per_carton']
					) ); ?></dd>

					<dt><?php esc_html_e( 'Origin', 'sg-commerce' ); ?></dt>
					<dd><?php echo esc_html( (string) $t['origin'] ); ?></dd>
				</dl>

				<p class="sg-muted" style="font-size:12px; margin-top:14px;">
					<?php echo esc_html( (string) $t['notes'] ); ?>
				</p>

				<h3><?php esc_html_e( 'FBA limits check', 'sg-commerce' ); ?></h3>
				<ul class="sg-attr-list">
					<li>
						<?php echo esc_html( sprintf( __( 'Weight %s kg', 'sg-commerce' ), (string) $t['weight_kg'] ) ); ?>
						<span style="color:#059669; margin-left:4px;">✓ <?php esc_html_e( 'under 23kg standard limit', 'sg-commerce' ); ?></span>
					</li>
					<li>
						<?php echo esc_html( sprintf( __( 'Longest side %s cm', 'sg-commerce' ), (string) max( (float) $t['length_cm'], (float) $t['width_cm'], (float) $t['height_cm'] ) ) ); ?>
						<span style="color:#059669; margin-left:4px;">✓ <?php esc_html_e( 'under 63.5cm limit', 'sg-commerce' ); ?></span>
					</li>
					<li>
						<span style="color:#059669;">✓ <?php esc_html_e( 'Eligible for Amazon Small &amp; Light program', 'sg-commerce' ); ?></span>
					</li>
				</ul>
			<?php endif; ?>
		</div>

		<div class="sg-card">
			<h2><?php esc_html_e( 'STA 9-step workflow', 'sg-commerce' ); ?></h2>
			<ol class="sg-steps sg-steps-compact">
				<li><span class="sg-step-num">1</span><div>Create plan (items + source address)</div></li>
				<li><span class="sg-step-num">2</span><div>Poll plan status until READY</div></li>
				<li><span class="sg-step-num">3</span><div>Generate packing options</div></li>
				<li><span class="sg-step-num">4</span><div>Confirm packing option + push box content</div></li>
				<li><span class="sg-step-num">5</span><div>Generate placement options (warehouse choice)</div></li>
				<li><span class="sg-step-num">6</span><div>Confirm placement — operator review recommended</div></li>
				<li><span class="sg-step-num">7</span><div>Generate transport options (carrier, cost)</div></li>
				<li><span class="sg-step-num">8</span><div>Confirm transport option</div></li>
				<li><span class="sg-step-num">9</span><div>Confirm plan + print labels</div></li>
			</ol>
			<p class="sg-muted" style="font-size:12px; margin-top:12px;">
				<?php esc_html_e( 'Once step 9 is confirmed the plan is LOCKED — no further edits allowed by Amazon.', 'sg-commerce' ); ?>
			</p>
		</div>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Create new plan', 'sg-commerce' ); ?></h2>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'sg_inbound_create', AdminModule::NONCE ); ?>
			<input type="hidden" name="action" value="sg_inbound_create" />

			<div class="sg-grid-2">
				<label><?php esc_html_e( 'Plan name', 'sg-commerce' ); ?> *
					<input type="text" name="plan_name" required placeholder="SG-2026-Q2-Guangzhou-001" />
				</label>
				<label><?php esc_html_e( 'Destination market', 'sg-commerce' ); ?>
					<select name="market">
						<?php foreach ( $marketplaces->enabled_codes() as $m ) : ?>
							<option value="<?php echo esc_attr( $m ); ?>"><?php echo esc_html( $m ); ?></option>
						<?php endforeach; ?>
					</select>
				</label>
			</div>

			<h3><?php esc_html_e( 'Source address', 'sg-commerce' ); ?></h3>
			<div class="sg-grid-2">
				<label><?php esc_html_e( 'Company / sender name', 'sg-commerce' ); ?>
					<input type="text" name="src_name" placeholder="Seven Gum Factory" value="Seven Gum Factory" />
				</label>
				<label><?php esc_html_e( 'Phone', 'sg-commerce' ); ?>
					<input type="text" name="src_phone" />
				</label>
			</div>
			<label><?php esc_html_e( 'Address line 1', 'sg-commerce' ); ?>
				<input type="text" name="src_address1" placeholder="No. 1, Industrial Park" />
			</label>
			<div class="sg-grid-4">
				<label><?php esc_html_e( 'City', 'sg-commerce' ); ?>
					<input type="text" name="src_city" value="Guangzhou" />
				</label>
				<label><?php esc_html_e( 'State/Prov', 'sg-commerce' ); ?>
					<input type="text" name="src_state" value="Guangdong" />
				</label>
				<label><?php esc_html_e( 'Postal', 'sg-commerce' ); ?>
					<input type="text" name="src_postal" placeholder="510000" />
				</label>
				<label><?php esc_html_e( 'Country', 'sg-commerce' ); ?>
					<input type="text" name="src_country" value="CN" maxlength="2" />
				</label>
			</div>

			<h3><?php esc_html_e( 'Shipment', 'sg-commerce' ); ?></h3>
			<div class="sg-grid-4">
				<label><?php esc_html_e( 'MSKU', 'sg-commerce' ); ?> *
					<input type="text" name="msku" required placeholder="SG-COOKIE-24PACK" />
				</label>
				<label><?php esc_html_e( 'Packs per carton', 'sg-commerce' ); ?>
					<input type="number" name="packs_per_carton" value="24" min="1" />
				</label>
				<label><?php esc_html_e( 'Cartons', 'sg-commerce' ); ?> *
					<input type="number" name="carton_count" required placeholder="3500" min="1" />
				</label>
				<label><?php esc_html_e( 'Label owner', 'sg-commerce' ); ?>
					<select name="label_owner">
						<option value="NONE" selected>NONE (use EAN barcode)</option>
						<option value="SELLER">SELLER (we apply FNSKU)</option>
						<option value="AMAZON">AMAZON (Amazon applies)</option>
					</select>
				</label>
			</div>

			<div class="sg-actions">
				<button class="sg-btn sg-btn-primary"><?php esc_html_e( 'Create draft plan', 'sg-commerce' ); ?></button>
			</div>
		</form>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Recent plans', 'sg-commerce' ); ?> (<?php echo count( (array) $plans ); ?>)</h2>
		<?php if ( empty( $plans ) ) : ?>
			<div class="sg-empty"><p><?php esc_html_e( 'No inbound plans yet. Create one above.', 'sg-commerce' ); ?></p></div>
		<?php else : ?>
			<table class="sg-table">
				<thead><tr>
					<th><?php esc_html_e( 'Plan', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Market', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Status', 'sg-commerce' ); ?></th>
					<th style="text-align:right;"><?php esc_html_e( 'Cartons', 'sg-commerce' ); ?></th>
					<th style="text-align:right;"><?php esc_html_e( 'Units', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Amazon Plan ID', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Updated', 'sg-commerce' ); ?></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $plans as $p ) :
					$status_chip = match ( (string) $p['status'] ) {
						'confirmed' => 'sg-chip-ok',
						'draft'     => 'sg-chip-muted',
						'error'     => 'sg-chip-err',
						default     => 'sg-chip-warn',
					};
				?>
					<tr>
						<td><strong><?php echo esc_html( $p['name'] ); ?></strong></td>
						<td><span class="sg-chip"><?php echo esc_html( $p['market'] ); ?></span></td>
						<td><span class="sg-chip <?php echo esc_attr( $status_chip ); ?>"><?php echo esc_html( $p['status'] ); ?></span></td>
						<td style="text-align:right;" class="sg-mono"><?php echo number_format( (int) $p['total_cartons'] ); ?></td>
						<td style="text-align:right;" class="sg-mono"><?php echo number_format( (int) $p['total_units'] ); ?></td>
						<td class="sg-mono" style="font-size:11px;"><?php echo esc_html( $p['amazon_plan_id'] ?: '—' ); ?></td>
						<td class="sg-muted" style="font-size:11.5px;"><?php echo esc_html( human_time_diff( strtotime( (string) $p['updated_at'] ), time() ) . ' ago' ); ?></td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</div>
</div>

<style>
.sg-profile-grid {
	display: grid;
	grid-template-columns: 130px 1fr;
	gap: 6px 16px;
	margin: 0;
}
.sg-profile-grid dt { font-weight:600; color:#6b7280; font-size:13px; }
.sg-profile-grid dd { margin:0; color:#111827; }
</style>
