<?php
/**
 * View — Settings.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;

$settings = $container->get( SettingsRepository::class );

$log_level     = (string) $settings->get( 'log_level', 'info' );
$log_retention = (int)    $settings->get( 'log_retention_days', 30 );
$pages_per_run = (int)    $settings->get( 'sync_pages_per_run', 5 );
$referral_pct  = (float)  $settings->get( 'referral_fee_pct', 15.0 );
$fba_fee       = (float)  $settings->get( 'fba_pick_pack_fee', 3.00 );
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1><?php esc_html_e( 'Settings', 'sg-commerce' ); ?></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'General behavior, logging, sync limits, and Amazon fee assumptions.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
		<?php wp_nonce_field( 'sg_save_settings', AdminModule::NONCE ); ?>
		<input type="hidden" name="action" value="sg_save_settings" />

		<h2><?php esc_html_e( 'Logging', 'sg-commerce' ); ?></h2>
		<div class="sg-grid-2">
			<label><?php esc_html_e( 'Log level', 'sg-commerce' ); ?>
				<select name="log_level">
					<?php foreach ( array( 'debug', 'info', 'notice', 'warning', 'error' ) as $lvl ) : ?>
						<option value="<?php echo esc_attr( $lvl ); ?>" <?php selected( $log_level, $lvl ); ?>><?php echo esc_html( ucfirst( $lvl ) ); ?></option>
					<?php endforeach; ?>
				</select>
			</label>
			<label><?php esc_html_e( 'Price-history retention (days)', 'sg-commerce' ); ?>
				<input type="number" min="1" max="3650" name="log_retention_days" value="<?php echo esc_attr( (string) $log_retention ); ?>" />
			</label>
		</div>

		<h2 style="margin-top:24px;"><?php esc_html_e( 'Sync', 'sg-commerce' ); ?></h2>
		<label><?php esc_html_e( 'Pages per sync run', 'sg-commerce' ); ?>
			<input type="number" min="1" max="50" name="sync_pages_per_run" value="<?php echo esc_attr( (string) $pages_per_run ); ?>" />
		</label>
		<p class="sg-muted" style="margin:4px 0 14px; font-size:12px;">
			<?php esc_html_e( '50 items per page. 5 pages = up to 250 items per sync run per market.', 'sg-commerce' ); ?>
		</p>

		<h2 style="margin-top:24px;"><?php esc_html_e( 'Amazon fee assumptions', 'sg-commerce' ); ?></h2>
		<p class="sg-muted"><?php esc_html_e( 'Used by the profit calculator and repricer floor. Override if your category has different fees.', 'sg-commerce' ); ?></p>
		<div class="sg-grid-2">
			<label><?php esc_html_e( 'Referral fee %', 'sg-commerce' ); ?>
				<input type="number" step="0.1" min="0" max="50" name="referral_fee_pct" value="<?php echo esc_attr( (string) $referral_pct ); ?>" />
			</label>
			<label><?php esc_html_e( 'FBA pick-pack fee', 'sg-commerce' ); ?>
				<input type="number" step="0.01" min="0" name="fba_pick_pack_fee" value="<?php echo esc_attr( (string) $fba_fee ); ?>" />
			</label>
		</div>

		<div class="sg-actions">
			<button class="sg-btn sg-btn-primary"><?php esc_html_e( 'Save settings', 'sg-commerce' ); ?></button>
		</div>
	</form>

	<!-- ────────── SANDBOX (v3.2) ────────── -->
	<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
		<h2><?php esc_html_e( 'Sandbox mode', 'sg-commerce' ); ?></h2>
		<p class="sg-muted"><?php esc_html_e( 'When ON, every SP-API call returns mocked data instead of hitting Amazon. Use for demos, local dev, or CI tests without burning real API quota.', 'sg-commerce' ); ?></p>

		<?php
		$sandbox_on = \SevenGum\Commerce\Testing\Sandbox::is_enabled();
		?>
		<p>
			<span class="sg-chip <?php echo $sandbox_on ? 'sg-chip-warn' : 'sg-chip-muted'; ?>">
				<?php echo $sandbox_on ? esc_html__( 'ON — mocked responses', 'sg-commerce' ) : esc_html__( 'OFF — real Amazon API', 'sg-commerce' ); ?>
			</span>
		</p>

		<?php wp_nonce_field( 'sg_toggle_sandbox', \SevenGum\Commerce\Admin\AdminModule::NONCE ); ?>
		<input type="hidden" name="action" value="sg_toggle_sandbox" />

		<div class="sg-actions">
			<button class="sg-btn"><?php echo $sandbox_on ? esc_html__( 'Disable sandbox', 'sg-commerce' ) : esc_html__( 'Enable sandbox', 'sg-commerce' ); ?></button>
		</div>
	</form>

	<!-- ────────── SQS REAL-TIME CONSUMER (v3.2) ────────── -->
	<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" autocomplete="off">
		<h2><?php esc_html_e( 'SQS real-time consumer', 'sg-commerce' ); ?></h2>
		<p class="sg-muted">
			<?php esc_html_e( 'Optional: receive Amazon SP-API notifications (BuyBox changes, order updates, inventory) via AWS SQS push. Much faster and uses no SP-API throttle.', 'sg-commerce' ); ?>
		</p>

		<?php
		$sqs_enabled = (bool) $settings->get( 'sqs_enabled', false );
		$sqs_region  = (string) $settings->get( 'sqs_region', 'us-east-1' );
		$sqs_queue   = (string) $settings->get( 'sqs_queue_url', '' );
		$sqs_ak      = (string) $settings->get( 'sqs_access_key', '' );
		$sqs_has_sk  = '' !== (string) $settings->get( 'sqs_secret_key_enc', '' );
		?>

		<?php wp_nonce_field( 'sg_save_sqs', \SevenGum\Commerce\Admin\AdminModule::NONCE ); ?>
		<input type="hidden" name="action" value="sg_save_sqs" />

		<label class="sg-inline" style="margin:14px 0;">
			<input type="checkbox" name="sqs_enabled" value="1" <?php checked( $sqs_enabled ); ?> />
			<strong><?php esc_html_e( 'Enable SQS polling (every 5 minutes)', 'sg-commerce' ); ?></strong>
		</label>

		<div class="sg-grid-2">
			<label><?php esc_html_e( 'AWS region', 'sg-commerce' ); ?>
				<input type="text" name="sqs_region" value="<?php echo esc_attr( $sqs_region ); ?>" placeholder="us-east-1" />
			</label>
			<label><?php esc_html_e( 'Queue URL', 'sg-commerce' ); ?>
				<input type="url" name="sqs_queue_url" value="<?php echo esc_attr( $sqs_queue ); ?>"
					placeholder="https://sqs.us-east-1.amazonaws.com/123456789/my-queue" />
			</label>
		</div>

		<div class="sg-grid-2">
			<label>AWS Access Key ID
				<input type="text" name="sqs_access_key" value="<?php echo esc_attr( $sqs_ak ); ?>" placeholder="AKIAXXXXXXXX" />
			</label>
			<label>AWS Secret Access Key
				<input type="password" name="sqs_secret_key"
					placeholder="<?php echo $sqs_has_sk ? esc_attr__( '●●●●●●●● (stored, enter to change)', 'sg-commerce' ) : esc_attr__( '40-character secret key', 'sg-commerce' ); ?>" />
			</label>
		</div>

		<p class="sg-muted" style="font-size:12px;">
			<?php esc_html_e( 'Setup: (1) create SQS queue in AWS, (2) grant Amazon principal arn:aws:iam::437568002678:root SendMessage permission, (3) call SP-API /notifications/v1/subscriptions with your queue ARN for event types like ANY_OFFER_CHANGED.', 'sg-commerce' ); ?>
		</p>

		<div class="sg-actions">
			<button class="sg-btn sg-btn-primary"><?php esc_html_e( 'Save SQS config', 'sg-commerce' ); ?></button>
		</div>
	</form>

	<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
		<h2><?php esc_html_e( 'Test SQS poll', 'sg-commerce' ); ?></h2>
		<p class="sg-muted"><?php esc_html_e( 'Run one poll immediately to verify your credentials and queue URL work.', 'sg-commerce' ); ?></p>
		<?php wp_nonce_field( 'sg_test_sqs', \SevenGum\Commerce\Admin\AdminModule::NONCE ); ?>
		<input type="hidden" name="action" value="sg_test_sqs" />
		<div class="sg-actions">
			<button class="sg-btn"><?php esc_html_e( 'Run poll', 'sg-commerce' ); ?></button>
		</div>
	</form>
</div>
