<?php
/**
 * View — Dashboard.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Analytics\SalesAggregator;
use SevenGum\Commerce\Automation\AlertDispatcher;
use SevenGum\Commerce\Database\Repositories\ProductRepository;

$amazon       = $container->get( AmazonClient::class );
$marketplaces = $container->get( Marketplaces::class );
$products     = $container->get( ProductRepository::class );
$kpis         = $container->get( SalesAggregator::class )->headline_kpis();

$has_amazon   = $amazon->has_credentials();
$total        = (int) $kpis['products_total'];

global $wpdb;
$described = (int) $wpdb->get_var( "SELECT COUNT(DISTINCT product_id) FROM {$wpdb->prefix}sg_descriptions WHERE language='en'" );

$step1 = $has_amazon;
$step2 = $total > 0;
$step3 = $described > 0;
$all_done = $step1 && $step2 && $step3;

$last_sync = $products->last_sync_at();
$last_sync_human = $last_sync ? human_time_diff( strtotime( (string) $last_sync ), time() ) . ' ago' : 'never';

$at_risk = $container->get( SalesAggregator::class )->at_risk( 5 );
$recent_alerts = AlertDispatcher::recent( 5 );
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<div>
			<h1>Seven Gum <span>Commerce</span></h1>
			<p class="sg-subtitle">Enterprise Amazon SP-API + AI commerce engine. Inventory, pricing, copywriting, repricing &amp; analytics — all in one place.</p>
		</div>
		<div class="sg-hero-meta">
			<span class="sg-chip">v<?php echo esc_html( SG_COMMERCE_VERSION ); ?></span>
			<span class="sg-chip"><?php echo esc_html( count( $marketplaces->enabled_codes() ) ); ?> markets</span>
		</div>
	</div>

	<?php AdminModule::render_flash(); ?>

	<?php if ( ! $all_done ) : ?>
		<section class="sg-onboarding">
			<h2><?php esc_html_e( 'Getting started', 'sg-commerce' ); ?></h2>
			<ol class="sg-steps">
				<li class="<?php echo $step1 ? 'done' : 'active'; ?>">
					<span class="sg-step-num"><?php echo $step1 ? '✓' : '1'; ?></span>
					<div>
						<h3><?php esc_html_e( 'Connect your Amazon seller account', 'sg-commerce' ); ?></h3>
						<p><?php esc_html_e( 'Paste LWA credentials so we can pull FBA inventory, Buy Box, and pricing.', 'sg-commerce' ); ?></p>
						<?php if ( $step1 ) : ?>
							<span class="sg-chip sg-chip-ok"><?php esc_html_e( 'Connected', 'sg-commerce' ); ?></span>
							<a href="<?php echo esc_url( admin_url( 'admin.php?page=sg-commerce-amazon' ) ); ?>" class="sg-link"><?php esc_html_e( 'Edit', 'sg-commerce' ); ?></a>
						<?php else : ?>
							<a href="<?php echo esc_url( admin_url( 'admin.php?page=sg-commerce-amazon' ) ); ?>" class="sg-btn sg-btn-primary"><?php esc_html_e( 'Connect Amazon →', 'sg-commerce' ); ?></a>
						<?php endif; ?>
					</div>
				</li>

				<li class="<?php echo $step2 ? 'done' : ( $step1 ? 'active' : 'pending' ); ?>">
					<span class="sg-step-num"><?php echo $step2 ? '✓' : '2'; ?></span>
					<div>
						<h3><?php esc_html_e( 'Sync your products', 'sg-commerce' ); ?></h3>
						<p><?php esc_html_e( 'Pull FBA inventory and competitive pricing across all enabled marketplaces.', 'sg-commerce' ); ?></p>
						<?php if ( $step2 ) : ?>
							<span class="sg-chip sg-chip-ok"><?php echo esc_html( $total ); ?> <?php esc_html_e( 'products', 'sg-commerce' ); ?></span>
							<a href="<?php echo esc_url( admin_url( 'admin.php?page=sg-commerce-products' ) ); ?>" class="sg-link"><?php esc_html_e( 'View', 'sg-commerce' ); ?></a>
						<?php elseif ( $step1 ) : ?>
							<a href="<?php echo esc_url( admin_url( 'admin.php?page=sg-commerce-products' ) ); ?>" class="sg-btn sg-btn-primary"><?php esc_html_e( 'Go to Products →', 'sg-commerce' ); ?></a>
						<?php else : ?>
							<span class="sg-chip sg-chip-muted"><?php esc_html_e( 'Complete Step 1 first', 'sg-commerce' ); ?></span>
						<?php endif; ?>
					</div>
				</li>

				<li class="<?php echo $step3 ? 'done' : ( $step2 ? 'active' : 'pending' ); ?>">
					<span class="sg-step-num"><?php echo $step3 ? '✓' : '3'; ?></span>
					<div>
						<h3><?php esc_html_e( 'Generate AI copy', 'sg-commerce' ); ?></h3>
						<p><?php esc_html_e( 'Let Ollama write polished product descriptions, then translate them per market.', 'sg-commerce' ); ?></p>
						<?php if ( $step3 ) : ?>
							<span class="sg-chip sg-chip-ok"><?php echo esc_html( $described ); ?> <?php esc_html_e( 'described', 'sg-commerce' ); ?></span>
						<?php elseif ( $step2 ) : ?>
							<a href="<?php echo esc_url( admin_url( 'admin.php?page=sg-commerce-ai' ) ); ?>" class="sg-btn sg-btn-primary"><?php esc_html_e( 'Configure AI →', 'sg-commerce' ); ?></a>
						<?php else : ?>
							<span class="sg-chip sg-chip-muted"><?php esc_html_e( 'Complete Step 2 first', 'sg-commerce' ); ?></span>
						<?php endif; ?>
					</div>
				</li>
			</ol>
		</section>
	<?php endif; ?>

	<!-- KPI ROW -->
	<section class="sg-stats">
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Products', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo esc_html( (string) $total ); ?></p>
			<p class="sg-stat-meta"><?php echo esc_html( sprintf( __( 'across %d markets', 'sg-commerce' ), (int) $kpis['markets'] ) ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'In stock', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo esc_html( (string) $kpis['products_in_stock'] ); ?></p>
			<p class="sg-stat-meta"><?php echo esc_html( sprintf( __( '%s%% stockout rate', 'sg-commerce' ), number_format( $kpis['stockout_rate'], 1 ) ) ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Buy Box wins', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo esc_html( (string) $kpis['products_winning_buybox'] ); ?></p>
			<p class="sg-stat-meta"><?php echo esc_html( sprintf( __( '%s%% win rate', 'sg-commerce' ), number_format( $kpis['buybox_win_rate'], 1 ) ) ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Last sync', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value sg-stat-value-text"><?php echo esc_html( $last_sync_human ); ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'hourly cron is active', 'sg-commerce' ); ?></p>
		</div>
	</section>

	<!-- AT RISK + RECENT ALERTS -->
	<div class="sg-grid-2">
		<div class="sg-card">
			<h2><?php esc_html_e( 'At-risk products', 'sg-commerce' ); ?></h2>
			<p class="sg-muted"><?php esc_html_e( 'Low stock or losing the Buy Box.', 'sg-commerce' ); ?></p>
			<?php if ( empty( $at_risk ) ) : ?>
				<div class="sg-empty"><p><?php esc_html_e( 'Nothing at risk. Nice work.', 'sg-commerce' ); ?></p></div>
			<?php else : ?>
				<table class="sg-table">
					<thead><tr><th>SKU</th><th>Market</th><th style="text-align:right;">Stock</th><th>Buy Box</th></tr></thead>
					<tbody>
					<?php foreach ( $at_risk as $r ) : ?>
						<tr>
							<td class="sg-mono"><?php echo esc_html( $r['sku'] ); ?></td>
							<td><span class="sg-chip"><?php echo esc_html( $r['market'] ); ?></span></td>
							<td style="text-align:right;" class="sg-mono">
								<?php if ( (int) $r['fulfillable_qty'] <= 5 ) : ?>
									<span class="sg-chip sg-chip-warn"><?php echo (int) $r['fulfillable_qty']; ?></span>
								<?php else : ?>
									<?php echo (int) $r['fulfillable_qty']; ?>
								<?php endif; ?>
							</td>
							<td>
								<?php if ( ! (int) $r['buybox_is_mine'] && null !== $r['buybox_price'] ) : ?>
									<span class="sg-chip sg-chip-warn"><?php esc_html_e( 'Lost', 'sg-commerce' ); ?></span>
								<?php else : ?>
									<span class="sg-chip sg-chip-ok"><?php esc_html_e( 'Won', 'sg-commerce' ); ?></span>
								<?php endif; ?>
							</td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
			<?php endif; ?>
		</div>

		<div class="sg-card">
			<h2><?php esc_html_e( 'Recent alerts', 'sg-commerce' ); ?></h2>
			<p class="sg-muted"><?php esc_html_e( 'Triggered by automation rules.', 'sg-commerce' ); ?></p>
			<?php if ( empty( $recent_alerts ) ) : ?>
				<div class="sg-empty"><p><?php esc_html_e( 'No alerts yet.', 'sg-commerce' ); ?></p></div>
			<?php else : ?>
				<ul class="sg-alerts">
					<?php foreach ( $recent_alerts as $a ) : ?>
						<li class="sg-alert sg-alert--<?php echo esc_attr( $a['level'] ); ?>">
							<strong><?php echo esc_html( $a['title'] ); ?></strong>
							<span class="sg-muted"> · <?php echo esc_html( human_time_diff( strtotime( $a['created_at'] ), time() ) ); ?> ago</span>
							<?php if ( '' !== (string) $a['message'] ) : ?>
								<p><?php echo esc_html( $a['message'] ); ?></p>
							<?php endif; ?>
						</li>
					<?php endforeach; ?>
				</ul>
				<a href="<?php echo esc_url( admin_url( 'admin.php?page=sg-commerce-automation' ) ); ?>" class="sg-link"><?php esc_html_e( 'View all alerts →', 'sg-commerce' ); ?></a>
			<?php endif; ?>
		</div>
	</div>
</div>
