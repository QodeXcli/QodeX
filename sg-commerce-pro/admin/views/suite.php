<?php
/**
 * Amazon Seller Suite — single-page app shell.
 *
 * The app itself is rendered by assets/js/suite.js against the
 * sg-commerce/v1/suite REST API. This shell only provides the mount point
 * and a no-JS fallback.
 *
 * @package SevenGum\Commerce
 */

defined( 'ABSPATH' ) || exit;
?>
<div class="wrap sgs-wrap">
	<h1 class="screen-reader-text"><?php esc_html_e( 'Amazon Seller Suite', 'sg-commerce' ); ?></h1>
	<div id="sgs-app" class="sgs" aria-live="polite">
		<div class="sgs-boot">
			<span class="sgs-spinner" aria-hidden="true"></span>
			<?php esc_html_e( 'Loading Amazon Seller Suite…', 'sg-commerce' ); ?>
		</div>
	</div>
	<noscript>
		<div class="notice notice-error"><p><?php esc_html_e( 'Amazon Seller Suite requires JavaScript.', 'sg-commerce' ); ?></p></div>
	</noscript>
</div>
