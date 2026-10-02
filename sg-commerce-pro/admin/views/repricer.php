<?php
/**
 * View — Repricer.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;

$settings = $container->get( SettingsRepository::class );

$enabled       = (bool)  $settings->get( 'repricer_enabled', false );
$strategy      = (string) $settings->get( 'repricer_strategy', 'match_buybox' );
$dry_run       = (bool)  $settings->get( 'repricer_dry_run', true );
$cents_below   = (float) $settings->get( 'repricer_cents_below_buybox', 0.01 );
$min_margin    = (float) $settings->get( 'repricer_min_margin_pct', 15.0 );
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1><?php esc_html_e( 'Repricer', 'sg-commerce' ); ?></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Automatic price adjustments toward Buy Box, respecting your minimum margin floor.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<div class="sg-grid-2">
		<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<h2><?php esc_html_e( 'Configuration', 'sg-commerce' ); ?></h2>

			<?php wp_nonce_field( 'sg_save_repricer', AdminModule::NONCE ); ?>
			<input type="hidden" name="action" value="sg_save_repricer" />

			<label class="sg-inline" style="margin:18px 0;">
				<input type="checkbox" name="repricer_enabled" value="1" <?php checked( $enabled ); ?> />
				<strong><?php esc_html_e( 'Enable repricer', 'sg-commerce' ); ?></strong>
			</label>

			<label class="sg-inline" style="margin-bottom:18px;">
				<input type="checkbox" name="repricer_dry_run" value="1" <?php checked( $dry_run ); ?> />
				<strong><?php esc_html_e( 'Dry run mode', 'sg-commerce' ); ?></strong>
				<span class="sg-muted">(<?php esc_html_e( 'log changes but don\'t patch Amazon', 'sg-commerce' ); ?>)</span>
			</label>

			<label><?php esc_html_e( 'Strategy', 'sg-commerce' ); ?>
				<select name="repricer_strategy">
					<option value="match_buybox" <?php selected( $strategy, 'match_buybox' ); ?>>Match Buy Box (minus offset)</option>
				</select>
			</label>

			<label><?php esc_html_e( 'Cents below Buy Box', 'sg-commerce' ); ?>
				<input type="number" step="0.01" min="0" name="repricer_cents_below_buybox" value="<?php echo esc_attr( (string) $cents_below ); ?>" />
			</label>

			<label><?php esc_html_e( 'Minimum margin %', 'sg-commerce' ); ?>
				<input type="number" step="0.1" min="0" max="100" name="repricer_min_margin_pct" value="<?php echo esc_attr( (string) $min_margin ); ?>" />
			</label>

			<div class="sg-actions">
				<button class="sg-btn sg-btn-primary"><?php esc_html_e( 'Save repricer settings', 'sg-commerce' ); ?></button>
			</div>
		</form>

		<div class="sg-card">
			<h2><?php esc_html_e( 'Run now', 'sg-commerce' ); ?></h2>
			<p class="sg-muted"><?php esc_html_e( 'Manually fire the repricer engine. The 15-minute cron also runs automatically when enabled.', 'sg-commerce' ); ?></p>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<?php wp_nonce_field( 'sg_run_repricer', AdminModule::NONCE ); ?>
				<input type="hidden" name="action" value="sg_run_repricer" />
				<div class="sg-actions">
					<button class="sg-btn"><?php esc_html_e( 'Run repricer tick', 'sg-commerce' ); ?></button>
				</div>
			</form>

			<hr />
			<h3><?php esc_html_e( 'How it works', 'sg-commerce' ); ?></h3>
			<ol class="sg-attr-list">
				<li><?php esc_html_e( 'Finds products where you don\'t hold the Buy Box AND you have a cost set.', 'sg-commerce' ); ?></li>
				<li><?php esc_html_e( 'Computes target = buybox_price − cents_below_buybox.', 'sg-commerce' ); ?></li>
				<li><?php esc_html_e( 'Floors target at the minimum price that satisfies your margin floor.', 'sg-commerce' ); ?></li>
				<li><?php esc_html_e( 'Updates my_price in the local DB; if dry-run is OFF, also patches the Amazon listing.', 'sg-commerce' ); ?></li>
			</ol>
		</div>
	</div>
</div>
