<?php
/**
 * View — PII Compliance (v3.2).
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Security\PIIManager\PIIManager;

$settings = $container->get( SettingsRepository::class );
$pii      = $container->get( PIIManager::class );

$retention = (int) $settings->get( 'pii_retention_days', 30 );
$pending   = $pii->count_pending_anonymization();

global $wpdb;
$total_orders = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}sg_mcf_orders" );
$anonymized   = (int) $wpdb->get_var( $wpdb->prepare(
	"SELECT COUNT(*) FROM {$wpdb->prefix}sg_mcf_orders WHERE customer_name = %s",
	'[anonymized]'
) );

$recent_audit = $wpdb->get_results(
	"SELECT * FROM {$wpdb->prefix}sg_audit WHERE action LIKE 'pii_%' ORDER BY created_at DESC LIMIT 10",
	ARRAY_A
);
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1>PII <span>Compliance</span></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Amazon SP-API Data Protection Policy requires customer PII to be anonymized within 30 days. This dashboard tracks compliance + lets you export or erase subject data for GDPR requests.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<section class="sg-stats">
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Total MCF orders', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo (int) $total_orders; ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'lifetime', 'sg-commerce' ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Anonymized', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value" style="color:#059669;"><?php echo (int) $anonymized; ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'PII removed', 'sg-commerce' ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Pending anonymization', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value" style="color: <?php echo $pending > 0 ? '#b45309' : '#059669'; ?>;"><?php echo (int) $pending; ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'will run in daily cron', 'sg-commerce' ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Retention', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value sg-stat-value-text"><?php echo (int) $retention; ?> <?php esc_html_e( 'days', 'sg-commerce' ); ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'after terminal state', 'sg-commerce' ); ?></p>
		</div>
	</section>

	<div class="sg-grid-2">
		<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<h2><?php esc_html_e( 'Retention policy', 'sg-commerce' ); ?></h2>

			<?php wp_nonce_field( 'sg_pii_save_settings', AdminModule::NONCE ); ?>
			<input type="hidden" name="action" value="sg_pii_save_settings" />

			<label><?php esc_html_e( 'Retention days (after order is delivered/cancelled/failed)', 'sg-commerce' ); ?>
				<input type="number" name="pii_retention_days" value="<?php echo esc_attr( (string) $retention ); ?>" min="1" max="3650" />
			</label>
			<p class="sg-muted" style="font-size:12px;">
				<?php esc_html_e( 'Amazon\'s policy: 30 days maximum. Set lower for stricter compliance.', 'sg-commerce' ); ?>
			</p>

			<h3><?php esc_html_e( 'What gets anonymized', 'sg-commerce' ); ?></h3>
			<ul class="sg-attr-list">
				<li><span style="color:#dc2626;">✗ <?php esc_html_e( 'Customer name', 'sg-commerce' ); ?></span></li>
				<li><span style="color:#dc2626;">✗ <?php esc_html_e( 'Email', 'sg-commerce' ); ?></span></li>
				<li><span style="color:#dc2626;">✗ <?php esc_html_e( 'Phone', 'sg-commerce' ); ?></span></li>
				<li><span style="color:#dc2626;">✗ <?php esc_html_e( 'Address line 1 + 2', 'sg-commerce' ); ?></span></li>
				<li><span style="color:#059669;">✓ <?php esc_html_e( 'Country / city / postal — KEPT (for analytics)', 'sg-commerce' ); ?></span></li>
				<li><span style="color:#059669;">✓ <?php esc_html_e( 'Items / status / tracking — KEPT', 'sg-commerce' ); ?></span></li>
			</ul>

			<div class="sg-actions">
				<button class="sg-btn sg-btn-primary"><?php esc_html_e( 'Save', 'sg-commerce' ); ?></button>
			</div>
		</form>

		<div class="sg-card">
			<h2><?php esc_html_e( 'Manual actions', 'sg-commerce' ); ?></h2>

			<h3><?php esc_html_e( 'Purge all expired PII now', 'sg-commerce' ); ?></h3>
			<p class="sg-muted" style="font-size:12px;">
				<?php esc_html_e( 'Normally this runs daily via cron. Click to run immediately.', 'sg-commerce' ); ?>
			</p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="margin-bottom:20px;">
				<?php wp_nonce_field( 'sg_pii_purge_now', AdminModule::NONCE ); ?>
				<input type="hidden" name="action" value="sg_pii_purge_now" />
				<button class="sg-btn" <?php disabled( $pending === 0 ); ?>>
					<?php echo $pending > 0
						? esc_html( sprintf( __( 'Purge %d pending now', 'sg-commerce' ), $pending ) )
						: esc_html__( 'Nothing pending', 'sg-commerce' ); ?>
				</button>
			</form>

			<hr />

			<h3><?php esc_html_e( 'GDPR right-to-erasure', 'sg-commerce' ); ?></h3>
			<p class="sg-muted" style="font-size:12px;">
				<?php esc_html_e( 'Customer requested data deletion? Enter their email — we\'ll anonymize all their orders immediately (ignoring retention window).', 'sg-commerce' ); ?>
			</p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm('<?php echo esc_js( __( 'Erase all PII for this email? This is irreversible.', 'sg-commerce' ) ); ?>');">
				<?php wp_nonce_field( 'sg_pii_erase_subject', AdminModule::NONCE ); ?>
				<input type="hidden" name="action" value="sg_pii_erase_subject" />
				<label><?php esc_html_e( 'Subject email', 'sg-commerce' ); ?>
					<input type="email" name="email" required placeholder="customer@example.com" />
				</label>
				<div class="sg-actions">
					<button class="sg-btn"><?php esc_html_e( 'Erase data', 'sg-commerce' ); ?></button>
				</div>
			</form>
		</div>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Recent PII audit log', 'sg-commerce' ); ?></h2>
		<?php if ( empty( $recent_audit ) ) : ?>
			<div class="sg-empty"><p><?php esc_html_e( 'No PII operations yet.', 'sg-commerce' ); ?></p></div>
		<?php else : ?>
			<table class="sg-table">
				<thead><tr>
					<th><?php esc_html_e( 'When', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Action', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Details', 'sg-commerce' ); ?></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $recent_audit as $a ) : ?>
					<tr>
						<td class="sg-mono" style="font-size:11.5px;"><?php echo esc_html( (string) $a['created_at'] ); ?></td>
						<td><span class="sg-chip"><?php echo esc_html( $a['action'] ); ?></span></td>
						<td class="sg-mono" style="font-size:11px; color:#6b7280;"><?php echo esc_html( (string) $a['details'] ); ?></td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</div>
</div>
