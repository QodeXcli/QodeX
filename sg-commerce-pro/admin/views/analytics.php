<?php
/**
 * View — Analytics dashboard.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Analytics\SalesAggregator;
use SevenGum\Commerce\Database\Repositories\ProductRepository;

$products    = $container->get( ProductRepository::class );
$aggregator  = $container->get( SalesAggregator::class );

$kpis    = $aggregator->headline_kpis();
$by_mkt  = $products->counts_by_market();
$trend   = $aggregator->buybox_trend( 14 );
$at_risk = $aggregator->at_risk( 20 );

// Build chart data.
$trend_labels = array();
$trend_won    = array();
$trend_lost   = array();
foreach ( $trend as $row ) {
	$trend_labels[] = (string) $row['day'];
	$trend_won[]    = (int) $row['won'];
	$trend_lost[]   = (int) $row['lost'];
}
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1><?php esc_html_e( 'Analytics', 'sg-commerce' ); ?></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Inventory + Buy Box performance trends across all enabled markets.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<section class="sg-stats">
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Buy Box win rate', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo esc_html( number_format( $kpis['buybox_win_rate'], 1 ) ); ?>%</p>
			<p class="sg-stat-meta"><?php echo esc_html( sprintf( __( '%d of %d products', 'sg-commerce' ), $kpis['products_winning_buybox'], $kpis['products_total'] ) ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Stockout rate', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo esc_html( number_format( $kpis['stockout_rate'], 1 ) ); ?>%</p>
			<p class="sg-stat-meta"><?php echo esc_html( sprintf( __( '%d in stock', 'sg-commerce' ), $kpis['products_in_stock'] ) ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Markets', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo esc_html( (string) $kpis['markets'] ); ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'with synced products', 'sg-commerce' ); ?></p>
		</div>
		<div class="sg-stat">
			<p class="sg-stat-label"><?php esc_html_e( 'Total tracked', 'sg-commerce' ); ?></p>
			<p class="sg-stat-value"><?php echo esc_html( (string) $kpis['products_total'] ); ?></p>
			<p class="sg-stat-meta"><?php esc_html_e( 'across all markets', 'sg-commerce' ); ?></p>
		</div>
	</section>

	<div class="sg-grid-2">
		<div class="sg-card">
			<h2><?php esc_html_e( 'Buy Box · last 14 days', 'sg-commerce' ); ?></h2>
			<?php if ( empty( $trend ) ) : ?>
				<div class="sg-empty"><p><?php esc_html_e( 'Not enough history yet — sync first to start collecting data.', 'sg-commerce' ); ?></p></div>
			<?php else : ?>
				<canvas id="sg-trend-chart" height="120"></canvas>
				<script>
					(function() {
						var labels = <?php echo wp_json_encode( $trend_labels ); ?>;
						var won = <?php echo wp_json_encode( $trend_won ); ?>;
						var lost = <?php echo wp_json_encode( $trend_lost ); ?>;
						var canvas = document.getElementById('sg-trend-chart');
						if (!canvas) return;
						var ctx = canvas.getContext('2d');
						var W = canvas.width = canvas.parentElement.clientWidth;
						var H = canvas.height = 240;
						var pad = 32;
						var max = Math.max(1, Math.max.apply(null, won.concat(lost)));
						var bw = (W - pad * 2) / Math.max(1, labels.length) * 0.4;
						labels.forEach(function(label, i) {
							var x = pad + i * ((W - pad * 2) / labels.length) + ((W - pad * 2) / labels.length) / 2;
							var hWon = (won[i] / max) * (H - pad * 2);
							var hLost = (lost[i] / max) * (H - pad * 2);
							ctx.fillStyle = '#16a34a';
							ctx.fillRect(x - bw, H - pad - hWon, bw, hWon);
							ctx.fillStyle = '#dc2626';
							ctx.fillRect(x + 2, H - pad - hLost, bw, hLost);
							ctx.fillStyle = '#6b7280';
							ctx.font = '10px sans-serif';
							ctx.textAlign = 'center';
							ctx.fillText(label.substr(5), x, H - pad + 14);
						});
						ctx.fillStyle = '#16a34a'; ctx.fillRect(pad, 8, 12, 12);
						ctx.fillStyle = '#111827'; ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
						ctx.fillText('Won', pad + 18, 18);
						ctx.fillStyle = '#dc2626'; ctx.fillRect(pad + 70, 8, 12, 12);
						ctx.fillStyle = '#111827'; ctx.fillText('Lost', pad + 88, 18);
					})();
				</script>
			<?php endif; ?>
		</div>

		<div class="sg-card">
			<h2><?php esc_html_e( 'Products by market', 'sg-commerce' ); ?></h2>
			<?php if ( empty( $by_mkt ) ) : ?>
				<div class="sg-empty"><p><?php esc_html_e( 'No products yet.', 'sg-commerce' ); ?></p></div>
			<?php else :
				$max = max( $by_mkt );
			?>
				<table class="sg-table">
					<thead><tr><th><?php esc_html_e( 'Market', 'sg-commerce' ); ?></th><th></th><th style="text-align:right;"><?php esc_html_e( 'Count', 'sg-commerce' ); ?></th></tr></thead>
					<tbody>
					<?php foreach ( $by_mkt as $mkt => $count ) : ?>
						<tr>
							<td><span class="sg-chip"><?php echo esc_html( $mkt ); ?></span></td>
							<td><div class="sg-bar"><div class="sg-bar-fill" style="width:<?php echo esc_attr( (string) round( $count / $max * 100 ) ); ?>%;"></div></div></td>
							<td style="text-align:right;" class="sg-mono"><?php echo (int) $count; ?></td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
			<?php endif; ?>
		</div>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'At-risk products', 'sg-commerce' ); ?></h2>
		<?php if ( empty( $at_risk ) ) : ?>
			<div class="sg-empty"><p><?php esc_html_e( 'Nothing at risk.', 'sg-commerce' ); ?></p></div>
		<?php else : ?>
			<table class="sg-table">
				<thead><tr>
					<th><?php esc_html_e( 'Market', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'SKU', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Name', 'sg-commerce' ); ?></th>
					<th style="text-align:right;"><?php esc_html_e( 'Stock', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Buy Box', 'sg-commerce' ); ?></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $at_risk as $r ) : ?>
					<tr>
						<td><span class="sg-chip"><?php echo esc_html( $r['market'] ); ?></span></td>
						<td class="sg-mono"><?php echo esc_html( $r['sku'] ); ?></td>
						<td><?php echo esc_html( $r['product_name'] ?: '—' ); ?></td>
						<td style="text-align:right;" class="sg-mono">
							<?php
							$qty = (int) $r['fulfillable_qty'];
							echo $qty <= 5 ? '<span class="sg-chip sg-chip-warn">' . $qty . '</span>' : (string) $qty;
							?>
						</td>
						<td>
							<?php echo (int) $r['buybox_is_mine']
								? '<span class="sg-chip sg-chip-ok">Won</span>'
								: '<span class="sg-chip sg-chip-warn">Lost</span>'; ?>
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</div>
</div>
