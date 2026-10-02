<?php
/**
 * View — Settlements (v3.2).
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;

global $wpdb;
$table = $wpdb->prefix . 'sg_settlements';

$totals_by_type = $wpdb->get_results(
	"SELECT event_type, COUNT(*) cnt, SUM(amount) total, currency
	 FROM {$table}
	 GROUP BY event_type, currency
	 ORDER BY ABS(SUM(amount)) DESC",
	ARRAY_A
);

$net = (float) $wpdb->get_var( "SELECT COALESCE(SUM(amount), 0) FROM {$table}" );
$event_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table}" );

$top_skus = $wpdb->get_results(
	"SELECT sku,
	        SUM(CASE WHEN event_type = 'sale' THEN amount ELSE 0 END) revenue,
	        SUM(CASE WHEN event_type IN ('fba_fee','fba_storage','referral_fee','advertising') THEN amount ELSE 0 END) fees,
	        SUM(amount) net
	 FROM {$table}
	 WHERE sku != ''
	 GROUP BY sku
	 ORDER BY revenue DESC
	 LIMIT 20",
	ARRAY_A
);

$recent = $wpdb->get_results(
	"SELECT * FROM {$table} ORDER BY event_date DESC, id DESC LIMIT 50",
	ARRAY_A
);

$settlement_ids = $wpdb->get_col( "SELECT DISTINCT settlement_id FROM {$table} WHERE settlement_id != '' ORDER BY imported_at DESC LIMIT 10" );
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1><?php esc_html_e( 'Settlements', 'sg-commerce' ); ?></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Parse and import Amazon settlement reports. Gives true profit after FBA fees, referral fees, advertising, refunds, and adjustments.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<section class="sg-stats">
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Events imported', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo number_format( $event_count ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Net total', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value" style="color: <?php echo $net >= 0 ? '#059669' : '#b91c1c'; ?>;">
				<?php echo esc_html( number_format( $net, 2 ) ); ?>
			</p>
			<p class="sg-stat-meta"><?php esc_html_e( 'across all reports', 'sg-commerce' ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Settlement files', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo count( (array) $settlement_ids ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Top SKUs', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo count( (array) $top_skus ); ?></p>
		</div>
	</section>

	<form class="sg-card" method="post" enctype="multipart/form-data" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
		<h2><?php esc_html_e( 'Upload settlement report', 'sg-commerce' ); ?></h2>

		<?php wp_nonce_field( 'sg_settlement_upload', AdminModule::NONCE ); ?>
		<input type="hidden" name="action" value="sg_settlement_upload" />

		<p><?php esc_html_e( 'Get the file from Amazon Seller Central → Reports → Payments → All Statements → choose a period → Download Flat File V2.', 'sg-commerce' ); ?></p>
		<p class="sg-muted" style="font-size:12px;">
			<?php esc_html_e( 'Report type:', 'sg-commerce' ); ?>
			<code>GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2</code>
		</p>

		<div class="sg-grid-2">
			<label><?php esc_html_e( 'Settlement ID (optional)', 'sg-commerce' ); ?>
				<input type="text" name="settlement_id" placeholder="12345678901" />
			</label>
			<label><?php esc_html_e( 'TSV file', 'sg-commerce' ); ?> *
				<input type="file" name="settlement_file" accept=".tsv,.txt,.csv" required />
			</label>
		</div>

		<div class="sg-actions">
			<button class="sg-btn sg-btn-primary"><?php esc_html_e( 'Parse + import', 'sg-commerce' ); ?></button>
		</div>
	</form>

	<div class="sg-grid-2">
		<div class="sg-card">
			<h2><?php esc_html_e( 'Totals by event type', 'sg-commerce' ); ?></h2>
			<?php if ( empty( $totals_by_type ) ) : ?>
				<div class="sg-empty"><p><?php esc_html_e( 'No settlement data yet. Upload a report above.', 'sg-commerce' ); ?></p></div>
			<?php else : ?>
				<table class="sg-table">
					<thead><tr>
						<th><?php esc_html_e( 'Type', 'sg-commerce' ); ?></th>
						<th style="text-align:right;"><?php esc_html_e( 'Count', 'sg-commerce' ); ?></th>
						<th style="text-align:right;"><?php esc_html_e( 'Total', 'sg-commerce' ); ?></th>
					</tr></thead>
					<tbody>
					<?php foreach ( $totals_by_type as $t ) :
						$amt = (float) $t['total'];
					?>
						<tr>
							<td><span class="sg-chip"><?php echo esc_html( $t['event_type'] ); ?></span></td>
							<td style="text-align:right;" class="sg-mono"><?php echo number_format( (int) $t['cnt'] ); ?></td>
							<td style="text-align:right;" class="sg-mono" style="color: <?php echo $amt >= 0 ? '#059669' : '#b91c1c'; ?>;">
								<?php echo esc_html( number_format( $amt, 2 ) . ' ' . $t['currency'] ); ?>
							</td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
			<?php endif; ?>
		</div>

		<div class="sg-card">
			<h2><?php esc_html_e( 'True profit by SKU', 'sg-commerce' ); ?></h2>
			<?php if ( empty( $top_skus ) ) : ?>
				<div class="sg-empty"><p><?php esc_html_e( 'Nothing yet.', 'sg-commerce' ); ?></p></div>
			<?php else : ?>
				<table class="sg-table">
					<thead><tr>
						<th><?php esc_html_e( 'SKU', 'sg-commerce' ); ?></th>
						<th style="text-align:right;"><?php esc_html_e( 'Revenue', 'sg-commerce' ); ?></th>
						<th style="text-align:right;"><?php esc_html_e( 'Fees', 'sg-commerce' ); ?></th>
						<th style="text-align:right;"><?php esc_html_e( 'Net', 'sg-commerce' ); ?></th>
					</tr></thead>
					<tbody>
					<?php foreach ( $top_skus as $s ) :
						$net_s = (float) $s['net'];
					?>
						<tr>
							<td class="sg-mono"><?php echo esc_html( $s['sku'] ); ?></td>
							<td style="text-align:right;" class="sg-mono"><?php echo esc_html( number_format( (float) $s['revenue'], 2 ) ); ?></td>
							<td style="text-align:right;" class="sg-mono" style="color:#b91c1c;"><?php echo esc_html( number_format( (float) $s['fees'], 2 ) ); ?></td>
							<td style="text-align:right;" class="sg-mono" style="color: <?php echo $net_s >= 0 ? '#059669' : '#b91c1c'; ?>; font-weight:600;">
								<?php echo esc_html( number_format( $net_s, 2 ) ); ?>
							</td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
			<?php endif; ?>
		</div>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Recent events (50)', 'sg-commerce' ); ?></h2>
		<?php if ( empty( $recent ) ) : ?>
			<div class="sg-empty"><p><?php esc_html_e( 'No events.', 'sg-commerce' ); ?></p></div>
		<?php else : ?>
			<table class="sg-table">
				<thead><tr>
					<th><?php esc_html_e( 'Date', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Type', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'SKU', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Order', 'sg-commerce' ); ?></th>
					<th style="text-align:right;"><?php esc_html_e( 'Amount', 'sg-commerce' ); ?></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $recent as $e ) :
					$amt = (float) $e['amount'];
				?>
					<tr>
						<td class="sg-mono" style="font-size:11.5px;"><?php echo esc_html( (string) $e['event_date'] ); ?></td>
						<td><span class="sg-chip"><?php echo esc_html( $e['event_type'] ); ?></span></td>
						<td class="sg-mono"><?php echo esc_html( $e['sku'] ?: '—' ); ?></td>
						<td class="sg-mono" style="font-size:11.5px;"><?php echo esc_html( $e['order_id'] ?: '—' ); ?></td>
						<td style="text-align:right;" class="sg-mono" style="color: <?php echo $amt >= 0 ? '#059669' : '#b91c1c'; ?>;">
							<?php echo esc_html( number_format( $amt, 2 ) . ' ' . $e['currency'] ); ?>
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</div>
</div>
