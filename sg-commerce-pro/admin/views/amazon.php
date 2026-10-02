<?php
/**
 * View — Amazon Connect.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;

$settings     = $container->get( SettingsRepository::class );
$marketplaces = $container->get( Marketplaces::class );
$client       = $container->get( AmazonClient::class );

$markets       = $marketplaces->all();
$enabled_codes = $marketplaces->enabled_codes();
$primary       = $marketplaces->primary();
$has_creds     = $client->has_credentials();
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1>Amazon <span>Connect</span></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Paste your SP-API credentials. Secrets are encrypted with AES-256-GCM before they touch the database.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<div class="sg-grid-2">
		<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" autocomplete="off">
			<h2><?php esc_html_e( 'Credentials', 'sg-commerce' ); ?></h2>
			<p class="sg-muted"><?php esc_html_e( 'Get these from Seller Central → Apps & Services → Develop Apps.', 'sg-commerce' ); ?></p>

			<?php wp_nonce_field( 'sg_save_amazon', AdminModule::NONCE ); ?>
			<input type="hidden" name="action" value="sg_save_amazon" />

			<label>LWA Client ID
				<input type="text" name="amazon_client_id"
					value="<?php echo esc_attr( (string) $settings->get( 'amazon_client_id', '' ) ); ?>"
					placeholder="amzn1.application-oa2-client.xxxx" />
			</label>

			<label>LWA Client Secret
				<input type="password" name="amazon_client_secret"
					placeholder="<?php echo esc_attr( $settings->mask( 'amazon_client_secret' ) ?: 'amzn1.oa2-cs.v1.xxxx' ); ?>" />
			</label>

			<label>LWA Refresh Token
				<input type="password" name="amazon_refresh_token"
					placeholder="<?php echo esc_attr( $settings->mask( 'amazon_refresh_token' ) ?: 'Atzr|xxxx...' ); ?>" />
			</label>

			<label>Seller ID (optional)
				<input type="text" name="amazon_seller_id"
					value="<?php echo esc_attr( (string) $settings->get( 'amazon_seller_id', '' ) ); ?>"
					placeholder="A1B2C3D4E5FGHI" />
			</label>

			<label><?php esc_html_e( 'Primary Marketplace', 'sg-commerce' ); ?>
				<select name="amazon_primary_market">
					<?php foreach ( $markets as $code => $m ) : ?>
						<option value="<?php echo esc_attr( $code ); ?>" <?php selected( $primary, $code ); ?>>
							<?php echo esc_html( "{$code} — {$m['country']} ({$m['currency']})" ); ?>
						</option>
					<?php endforeach; ?>
				</select>
			</label>

			<fieldset class="sg-fieldset">
				<legend><?php esc_html_e( 'Enabled Marketplaces', 'sg-commerce' ); ?></legend>
				<div class="sg-market-grid">
					<?php foreach ( $markets as $code => $m ) : ?>
						<label class="sg-check">
							<input type="checkbox" name="amazon_enabled_markets[]" value="<?php echo esc_attr( $code ); ?>"
								<?php checked( in_array( $code, $enabled_codes, true ) ); ?> />
							<span><?php echo esc_html( $code ); ?></span>
							<em><?php echo esc_html( $m['country'] ); ?></em>
						</label>
					<?php endforeach; ?>
				</div>
			</fieldset>

			<div class="sg-actions">
				<button type="submit" class="sg-btn sg-btn-primary"><?php esc_html_e( 'Save credentials', 'sg-commerce' ); ?></button>
			</div>
		</form>

		<div class="sg-card">
			<h2><?php esc_html_e( 'Connection test', 'sg-commerce' ); ?></h2>
			<p class="sg-muted"><?php esc_html_e( 'Forces a fresh LWA token and calls getMarketplaceParticipations against your primary market.', 'sg-commerce' ); ?></p>

			<?php if ( ! $has_creds ) : ?>
				<div class="sg-empty"><p><?php esc_html_e( 'Save credentials first.', 'sg-commerce' ); ?></p></div>
			<?php else : ?>
				<div class="sg-creds-summary">
					<div><span class="sg-dot sg-dot-ok"></span> Client ID saved</div>
					<div><span class="sg-dot sg-dot-ok"></span> Client Secret encrypted</div>
					<div><span class="sg-dot sg-dot-ok"></span> Refresh Token encrypted</div>
				</div>

				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<?php wp_nonce_field( 'sg_test_amazon', AdminModule::NONCE ); ?>
					<input type="hidden" name="action" value="sg_test_amazon" />
					<div class="sg-actions">
						<button type="submit" class="sg-btn"><?php esc_html_e( 'Run connection test', 'sg-commerce' ); ?></button>
					</div>
				</form>

				<hr />

				<h3><?php esc_html_e( 'Clear secrets', 'sg-commerce' ); ?></h3>
				<p class="sg-muted"><?php esc_html_e( 'Wipe individual encrypted credentials from storage. You\'ll need to paste them again to use SP-API.', 'sg-commerce' ); ?></p>
				<?php foreach ( array( 'amazon_client_secret' => 'Client Secret', 'amazon_refresh_token' => 'Refresh Token', 'amazon_seller_id' => 'Seller ID' ) as $secret_key => $label ) : ?>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block; margin-right:6px;">
						<?php wp_nonce_field( 'sg_clear_secret', AdminModule::NONCE ); ?>
						<input type="hidden" name="action" value="sg_clear_secret" />
						<input type="hidden" name="secret" value="<?php echo esc_attr( $secret_key ); ?>" />
						<input type="hidden" name="return" value="amazon" />
						<button class="sg-btn sg-btn-sm" onclick="return confirm('Clear <?php echo esc_js( $label ); ?>?');">
							× <?php echo esc_html( $label ); ?>
						</button>
					</form>
				<?php endforeach; ?>
			<?php endif; ?>

			<hr />

			<h3><?php esc_html_e( 'How to get credentials', 'sg-commerce' ); ?></h3>
			<ol class="sg-steps sg-steps-compact">
				<li><span class="sg-step-num">1</span><div><?php esc_html_e( 'In Seller Central, open Apps & Services → Develop Apps.', 'sg-commerce' ); ?></div></li>
				<li><span class="sg-step-num">2</span><div><?php esc_html_e( 'Open (or create) your app. Copy the LWA Client ID and Client Secret.', 'sg-commerce' ); ?></div></li>
				<li><span class="sg-step-num">3</span><div><?php esc_html_e( 'Click Authorize, complete OAuth — you\'ll receive a refresh token starting with Atzr|', 'sg-commerce' ); ?></div></li>
				<li><span class="sg-step-num">4</span><div><?php esc_html_e( 'Paste all three here and save. Then run the connection test.', 'sg-commerce' ); ?></div></li>
			</ol>
		</div>
	</div>
</div>
