<?php
/**
 * View — Products. Paginated, searchable, filterable.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\AI\Copywriter;
use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Database\Repositories\ProductRepository;

$products     = $container->get( ProductRepository::class );
$marketplaces = $container->get( Marketplaces::class );
$copywriter   = $container->get( Copywriter::class );
$has_amazon   = $container->get( AmazonClient::class )->has_credentials();

$markets    = $marketplaces->all();
$enabled    = $marketplaces->enabled_codes();

$search   = isset( $_GET['s'] ) ? sanitize_text_field( wp_unslash( (string) $_GET['s'] ) ) : '';
$market_f = isset( $_GET['market'] ) ? strtoupper( sanitize_text_field( wp_unslash( (string) $_GET['market'] ) ) ) : '';
$in_stock = ! empty( $_GET['in_stock'] );
$page_num = max( 1, (int) ( $_GET['paged'] ?? 1 ) );
$per_page = 25;

$result = $products->paginate( array(
	'search'   => $search,
	'market'   => $market_f,
	'in_stock' => $in_stock,
	'page'     => $page_num,
	'per_page' => $per_page,
	'orderby'  => 'updated_at',
	'order'    => 'DESC',
) );

$base_url = admin_url( 'admin.php?page=sg-commerce-products' );
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1><?php esc_html_e( 'Products', 'sg-commerce' ); ?></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Every SKU tracked by Seven Gum Commerce — inventory and pricing from Amazon, copy from your AI provider.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<!-- SYNC BAR -->
	<form class="sg-card sg-syncbar" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
		<?php wp_nonce_field( 'sg_sync_amazon', AdminModule::NONCE ); ?>
		<input type="hidden" name="action" value="sg_sync_amazon" />
		<div>
			<strong><?php esc_html_e( 'Sync from Amazon', 'sg-commerce' ); ?></strong>
			<p class="sg-muted" style="margin:2px 0 0;">
				<?php if ( $has_amazon ) : ?>
					<?php esc_html_e( 'Pulls FBA inventory + competitive pricing. Hourly cron also runs automatically.', 'sg-commerce' ); ?>
				<?php else : ?>
					<span style="color:#b45309;"><?php esc_html_e( 'Connect Amazon first to enable syncing.', 'sg-commerce' ); ?></span>
				<?php endif; ?>
			</p>
		</div>
		<label class="sg-inline">
			<?php esc_html_e( 'Market:', 'sg-commerce' ); ?>
			<select name="market" <?php disabled( ! $has_amazon ); ?>>
				<option value=""><?php echo esc_html( sprintf( __( 'All enabled (%d)', 'sg-commerce' ), count( $enabled ) ) ); ?></option>
				<?php foreach ( $enabled as $m ) : ?>
					<option value="<?php echo esc_attr( $m ); ?>"><?php echo esc_html( $m ); ?></option>
				<?php endforeach; ?>
			</select>
		</label>
		<button type="submit" class="sg-btn sg-btn-primary" <?php disabled( ! $has_amazon ); ?>><?php esc_html_e( 'Sync now', 'sg-commerce' ); ?></button>
	</form>

	<!-- FILTER BAR -->
	<form class="sg-card sg-filterbar" method="get" action="<?php echo esc_url( admin_url( 'admin.php' ) ); ?>">
		<input type="hidden" name="page" value="sg-commerce-products" />
		<label class="sg-inline">
			<?php esc_html_e( 'Search:', 'sg-commerce' ); ?>
			<input type="search" name="s" value="<?php echo esc_attr( $search ); ?>" placeholder="<?php esc_attr_e( 'SKU, ASIN, name…', 'sg-commerce' ); ?>" />
		</label>
		<label class="sg-inline">
			<?php esc_html_e( 'Market:', 'sg-commerce' ); ?>
			<select name="market">
				<option value=""><?php esc_html_e( 'All', 'sg-commerce' ); ?></option>
				<?php foreach ( array_keys( $markets ) as $m ) : ?>
					<option value="<?php echo esc_attr( $m ); ?>" <?php selected( $market_f, $m ); ?>><?php echo esc_html( $m ); ?></option>
				<?php endforeach; ?>
			</select>
		</label>
		<label class="sg-inline">
			<input type="checkbox" name="in_stock" value="1" <?php checked( $in_stock ); ?> />
			<?php esc_html_e( 'In stock only', 'sg-commerce' ); ?>
		</label>
		<button type="submit" class="sg-btn"><?php esc_html_e( 'Filter', 'sg-commerce' ); ?></button>
		<?php if ( $search || $market_f || $in_stock ) : ?>
			<a href="<?php echo esc_url( $base_url ); ?>" class="sg-link"><?php esc_html_e( 'Reset', 'sg-commerce' ); ?></a>
		<?php endif; ?>
		<span class="sg-muted" style="margin-left:auto;">
			<?php echo esc_html( sprintf( __( '%d total · page %d of %d', 'sg-commerce' ), $result['total'], $page_num, $result['pages'] ) ); ?>
		</span>
	</form>

	<!-- TABLE -->
	<div class="sg-card">
		<?php if ( empty( $result['rows'] ) ) : ?>
			<div class="sg-empty">
				<p><?php esc_html_e( 'No products match. Click "Sync now" above, or add one manually below.', 'sg-commerce' ); ?></p>
			</div>
		<?php else : ?>
			<div class="sg-table-wrap">
				<table class="sg-table">
					<thead>
						<tr>
							<th><?php esc_html_e( 'Market', 'sg-commerce' ); ?></th>
							<th><?php esc_html_e( 'SKU', 'sg-commerce' ); ?></th>
							<th><?php esc_html_e( 'ASIN', 'sg-commerce' ); ?></th>
							<th><?php esc_html_e( 'Name', 'sg-commerce' ); ?></th>
							<th style="text-align:right;"><?php esc_html_e( 'Stock', 'sg-commerce' ); ?></th>
							<th style="text-align:right;"><?php esc_html_e( 'BB Price', 'sg-commerce' ); ?></th>
							<th style="text-align:right;"><?php esc_html_e( 'Cost', 'sg-commerce' ); ?></th>
							<th><?php esc_html_e( 'AI', 'sg-commerce' ); ?></th>
							<th><?php esc_html_e( 'Actions', 'sg-commerce' ); ?></th>
						</tr>
					</thead>
					<tbody>
					<?php foreach ( $result['rows'] as $r ) :
						$mp = $markets[ $r['market'] ] ?? null;
						$qty = (int) $r['fulfillable_qty'];
						$price = null !== $r['buybox_price'] ? (float) $r['buybox_price'] : null;
						$currency = $r['buybox_currency'] ?: ( $mp['currency'] ?? '' );
						$descs = $copywriter->descriptions_for( (int) $r['id'] );
						$has_en = isset( $descs['en'] );
					?>
						<tr>
							<td><span class="sg-chip"><?php echo esc_html( (string) $r['market'] ); ?></span></td>
							<td class="sg-mono"><?php echo esc_html( (string) $r['sku'] ); ?></td>
							<td class="sg-mono"><?php echo esc_html( $r['asin'] ?: '—' ); ?></td>
							<td><?php echo esc_html( $r['product_name'] ?: '—' ); ?></td>
							<td style="text-align:right;" class="sg-mono">
								<?php if ( $qty > 0 && $qty > 5 ) : ?>
									<span class="sg-chip sg-chip-ok"><?php echo $qty; ?></span>
								<?php elseif ( $qty > 0 ) : ?>
									<span class="sg-chip sg-chip-warn"><?php echo $qty; ?></span>
								<?php else : ?>
									<span class="sg-chip sg-chip-err">0</span>
								<?php endif; ?>
							</td>
							<td style="text-align:right;" class="sg-mono">
								<?php echo null !== $price ? esc_html( number_format( $price, 2 ) . ' ' . $currency ) : '—'; ?>
							</td>
							<td style="text-align:right;" class="sg-mono">
								<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-flex; gap:4px;">
									<?php wp_nonce_field( 'sg_update_cost', AdminModule::NONCE ); ?>
									<input type="hidden" name="action" value="sg_update_cost" />
									<input type="hidden" name="id" value="<?php echo (int) $r['id']; ?>" />
									<input type="number" step="0.01" name="cost" value="<?php echo esc_attr( null !== $r['cost_price'] ? (string) $r['cost_price'] : '' ); ?>" placeholder="—" style="width:70px; padding:3px 6px;" />
									<button type="submit" class="sg-btn-icon" title="<?php esc_attr_e( 'Save cost', 'sg-commerce' ); ?>">↵</button>
								</form>
							</td>
							<td style="font-size:11px;">
								<?php foreach ( $descs as $lang => $d ) : ?>
									<span class="sg-chip sg-chip-ok"><?php echo esc_html( strtoupper( $lang ) ); ?></span>
								<?php endforeach; ?>
								<?php if ( empty( $descs ) ) : ?><span class="sg-muted">—</span><?php endif; ?>
							</td>
							<td class="sg-row-actions">
								<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;">
									<?php wp_nonce_field( 'sg_describe_product', AdminModule::NONCE ); ?>
									<input type="hidden" name="action" value="sg_describe_product" />
									<input type="hidden" name="id" value="<?php echo (int) $r['id']; ?>" />
									<button class="sg-btn sg-btn-sm" title="<?php esc_attr_e( 'Generate English description with AI', 'sg-commerce' ); ?>">
										<?php echo $has_en ? esc_html__( 'Re-describe', 'sg-commerce' ) : esc_html__( 'Describe', 'sg-commerce' ); ?>
									</button>
								</form>
								<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;">
									<?php wp_nonce_field( 'sg_translate_product', AdminModule::NONCE ); ?>
									<input type="hidden" name="action" value="sg_translate_product" />
									<input type="hidden" name="id" value="<?php echo (int) $r['id']; ?>" />
									<select name="target_market" class="sg-select-sm">
										<option value=""><?php esc_html_e( 'Translate to…', 'sg-commerce' ); ?></option>
										<?php foreach ( $enabled as $m ) :
											$lang = $markets[ $m ]['language'] ?? '';
											if ( 'en' === $lang ) continue;
										?>
											<option value="<?php echo esc_attr( $m ); ?>"><?php echo esc_html( "{$m} ({$lang})" ); ?></option>
										<?php endforeach; ?>
									</select>
									<button class="sg-btn sg-btn-sm"><?php esc_html_e( 'Go', 'sg-commerce' ); ?></button>
								</form>
								<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;" onsubmit="return confirm('<?php echo esc_js( __( 'Remove this product?', 'sg-commerce' ) ); ?>');">
									<?php wp_nonce_field( 'sg_delete_product', AdminModule::NONCE ); ?>
									<input type="hidden" name="action" value="sg_delete_product" />
									<input type="hidden" name="id" value="<?php echo (int) $r['id']; ?>" />
									<button class="sg-btn-icon" title="<?php esc_attr_e( 'Remove', 'sg-commerce' ); ?>">×</button>
								</form>
							</td>
						</tr>
						<?php if ( ! empty( $descs ) ) : ?>
							<tr class="sg-desc-row"><td colspan="9">
								<?php foreach ( $descs as $lang => $d ) : ?>
									<div><strong><?php echo esc_html( strtoupper( $lang ) ); ?>:</strong> <?php echo esc_html( (string) $d['content'] ); ?></div>
								<?php endforeach; ?>
							</td></tr>
						<?php endif; ?>
					<?php endforeach; ?>
					</tbody>
				</table>
			</div>

			<!-- PAGINATION -->
			<?php if ( $result['pages'] > 1 ) : ?>
				<div class="sg-pagination">
					<?php
					$query_args = array_filter( array(
						's'        => $search,
						'market'   => $market_f,
						'in_stock' => $in_stock ? '1' : null,
					) );
					$args = array(
						'base'      => add_query_arg( array_merge( $query_args, array( 'paged' => '%#%' ) ), $base_url ),
						'format'    => '',
						'current'   => $page_num,
						'total'     => $result['pages'],
						'prev_text' => '←',
						'next_text' => '→',
					);
					echo paginate_links( $args ); // phpcs:ignore
					?>
				</div>
			<?php endif; ?>
		<?php endif; ?>
	</div>

	<!-- ADD PRODUCT MANUALLY -->
	<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
		<h2><?php esc_html_e( 'Add product manually', 'sg-commerce' ); ?></h2>
		<p class="sg-muted"><?php esc_html_e( 'Use this to pre-seed a SKU before its first sync, or to track a competitor ASIN.', 'sg-commerce' ); ?></p>
		<?php wp_nonce_field( 'sg_add_product', AdminModule::NONCE ); ?>
		<input type="hidden" name="action" value="sg_add_product" />
		<div class="sg-grid-4">
			<label><?php esc_html_e( 'Market', 'sg-commerce' ); ?>
				<select name="market">
					<?php foreach ( $enabled as $m ) : ?>
						<option value="<?php echo esc_attr( $m ); ?>"><?php echo esc_html( $m ); ?></option>
					<?php endforeach; ?>
				</select>
			</label>
			<label>SKU *<input type="text" name="sku" required placeholder="SG-COOKIE-01" /></label>
			<label>ASIN<input type="text" name="asin" placeholder="B0XXXXXXXX" /></label>
			<label><?php esc_html_e( 'Cost', 'sg-commerce' ); ?><input type="number" step="0.01" name="cost_price" placeholder="2.50" /></label>
		</div>
		<label><?php esc_html_e( 'Name', 'sg-commerce' ); ?><input type="text" name="product_name" placeholder="Seven Gum Cookie 30-pc" /></label>
		<label><?php esc_html_e( 'Image URL', 'sg-commerce' ); ?><input type="url" name="image_url" placeholder="https://sevengum.com/wp-content/uploads/cookie.jpg" /></label>
		<div class="sg-actions"><button class="sg-btn sg-btn-primary"><?php esc_html_e( 'Add product', 'sg-commerce' ); ?></button></div>
	</form>
</div>
