<?php
/**
 * View — Automation: rules + alert feed.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Automation\AlertDispatcher;

global $wpdb;
$rules  = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}sg_rules ORDER BY id ASC", ARRAY_A );
$alerts = AlertDispatcher::recent( 50 );
$unread = AlertDispatcher::unread_count();
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1><?php esc_html_e( 'Automation', 'sg-commerce' ); ?></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'When-then rules trigger off domain events. Edit rule JSON directly via WP-CLI or the database for now.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Rules', 'sg-commerce' ); ?> (<?php echo count( (array) $rules ); ?>)</h2>
		<?php if ( empty( $rules ) ) : ?>
			<div class="sg-empty"><p><?php esc_html_e( 'No rules yet.', 'sg-commerce' ); ?></p></div>
		<?php else : ?>
			<table class="sg-table">
				<thead><tr>
					<th><?php esc_html_e( 'Status', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Name', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Trigger', 'sg-commerce' ); ?></th>
					<th style="text-align:right;"><?php esc_html_e( 'Runs', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Last run', 'sg-commerce' ); ?></th>
					<th></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $rules as $rule ) : ?>
					<tr>
						<td>
							<?php echo (int) $rule['is_active']
								? '<span class="sg-chip sg-chip-ok">Active</span>'
								: '<span class="sg-chip sg-chip-muted">Off</span>'; ?>
						</td>
						<td><strong><?php echo esc_html( $rule['name'] ); ?></strong></td>
						<td class="sg-mono" style="font-size:12px;"><?php echo esc_html( $rule['trigger_event'] ); ?></td>
						<td style="text-align:right;" class="sg-mono"><?php echo (int) $rule['run_count']; ?></td>
						<td class="sg-muted"><?php echo $rule['last_run_at'] ? esc_html( human_time_diff( strtotime( (string) $rule['last_run_at'] ), time() ) . ' ago' ) : '—'; ?></td>
						<td>
							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;">
								<?php wp_nonce_field( 'sg_toggle_rule', AdminModule::NONCE ); ?>
								<input type="hidden" name="action" value="sg_toggle_rule" />
								<input type="hidden" name="id" value="<?php echo (int) $rule['id']; ?>" />
								<button class="sg-btn sg-btn-sm">
									<?php echo (int) $rule['is_active'] ? esc_html__( 'Disable', 'sg-commerce' ) : esc_html__( 'Enable', 'sg-commerce' ); ?>
								</button>
							</form>
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</div>

	<div class="sg-card">
		<h2>
			<?php esc_html_e( 'Alert feed', 'sg-commerce' ); ?>
			<?php if ( $unread > 0 ) : ?>
				<span class="sg-chip sg-chip-warn"><?php echo esc_html( sprintf( __( '%d unread', 'sg-commerce' ), $unread ) ); ?></span>
			<?php endif; ?>
		</h2>

		<?php if ( $unread > 0 ) : ?>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="margin-bottom:12px;">
				<?php wp_nonce_field( 'sg_mark_alerts_read', AdminModule::NONCE ); ?>
				<input type="hidden" name="action" value="sg_mark_alerts_read" />
				<button class="sg-btn sg-btn-sm"><?php esc_html_e( 'Mark all as read', 'sg-commerce' ); ?></button>
			</form>
		<?php endif; ?>

		<?php if ( empty( $alerts ) ) : ?>
			<div class="sg-empty"><p><?php esc_html_e( 'No alerts yet.', 'sg-commerce' ); ?></p></div>
		<?php else : ?>
			<ul class="sg-alerts">
				<?php foreach ( $alerts as $a ) : ?>
					<li class="sg-alert sg-alert--<?php echo esc_attr( $a['level'] ); ?> <?php echo (int) $a['is_read'] ? 'is-read' : ''; ?>">
						<div>
							<strong><?php echo esc_html( $a['title'] ); ?></strong>
							<span class="sg-chip" style="margin-left:6px;"><?php echo esc_html( $a['category'] ); ?></span>
							<span class="sg-muted" style="margin-left:6px;"><?php echo esc_html( human_time_diff( strtotime( (string) $a['created_at'] ), time() ) ); ?> ago</span>
						</div>
						<?php if ( '' !== (string) $a['message'] ) : ?>
							<p><?php echo esc_html( (string) $a['message'] ); ?></p>
						<?php endif; ?>
					</li>
				<?php endforeach; ?>
			</ul>
		<?php endif; ?>
	</div>
</div>
