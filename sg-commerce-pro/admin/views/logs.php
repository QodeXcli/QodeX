<?php
/**
 * View — Logs.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Logging\Logger;

$logger = $container->get( Logger::class );
$lines = $logger->tail( 200 );
$log_dir = $logger->get_log_dir();
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1><?php esc_html_e( 'Logs', 'sg-commerce' ); ?></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Most recent 200 log lines from today\'s file. One JSON object per line.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<div class="sg-card">
		<?php if ( null === $log_dir ) : ?>
			<div class="sg-empty"><p><?php esc_html_e( 'Logs directory could not be created. Logs are falling back to PHP error_log.', 'sg-commerce' ); ?></p></div>
		<?php else : ?>
			<p class="sg-muted"><?php esc_html_e( 'Log directory:', 'sg-commerce' ); ?> <code><?php echo esc_html( $log_dir ); ?></code></p>
		<?php endif; ?>

		<?php if ( empty( $lines ) ) : ?>
			<div class="sg-empty"><p><?php esc_html_e( 'No log entries today yet.', 'sg-commerce' ); ?></p></div>
		<?php else : ?>
			<table class="sg-table">
				<thead><tr>
					<th><?php esc_html_e( 'Time', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Level', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Message', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Context', 'sg-commerce' ); ?></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $lines as $line ) :
					$level = (string) ( $line['level'] ?? 'INFO' );
					$class = match ( $level ) {
						'ERROR', 'CRITICAL' => 'sg-chip-err',
						'WARNING'           => 'sg-chip-warn',
						'INFO', 'NOTICE'    => 'sg-chip-ok',
						default             => 'sg-chip-muted',
					};
				?>
					<tr>
						<td class="sg-mono" style="font-size:11.5px; white-space:nowrap;"><?php echo esc_html( (string) ( $line['timestamp'] ?? '' ) ); ?></td>
						<td><span class="sg-chip <?php echo esc_attr( $class ); ?>"><?php echo esc_html( $level ); ?></span></td>
						<td><?php echo esc_html( (string) ( $line['message'] ?? '' ) ); ?></td>
						<td class="sg-mono" style="font-size:11px; color:#6b7280; max-width:340px; overflow:hidden; text-overflow:ellipsis;">
							<?php echo esc_html( wp_json_encode( $line['context'] ?? array() ) ); ?>
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</div>
</div>
