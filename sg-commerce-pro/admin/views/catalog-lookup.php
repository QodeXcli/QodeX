<?php
/**
 * View — Catalog Lookup (v3.3).
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Amazon\CatalogItems\CatalogLookup;
use SevenGum\Commerce\Amazon\Marketplaces;

$marketplaces = $container->get( Marketplaces::class );
$lookup       = $container->get( CatalogLookup::class );

global $wpdb;
$mapped = $wpdb->get_results(
	"SELECT * FROM {$wpdb->prefix}sg_product_ean ORDER BY sku ASC, market ASC",
	ARRAY_A
);

$search_ean    = isset( $_POST['ean'] ) ? sanitize_text_field( wp_unslash( (string) $_POST['ean'] ) ) : '';
$search_market = isset( $_POST['market'] ) ? strtoupper( sanitize_text_field( wp_unslash( (string) $_POST['market'] ) ) ) : 'US';
$search_results = null;
$search_error   = '';

if ( '' !== $search_ean && isset( $_POST['_wpnonce'] ) && wp_verify_nonce( sanitize_text_field( wp_unslash( (string) $_POST['_wpnonce'] ) ), 'sg_ean_lookup' ) ) {
	try {
		if ( ! CatalogLookup::validate_ean13( $search_ean ) ) {
			$search_error = __( 'Invalid EAN-13 — checksum digit does not match.', 'sg-commerce' );
		} else {
			$preflight = $lookup->preflight( $search_ean, $search_market );
			$search_results = $preflight;
		}
	} catch ( \Throwable $e ) {
		$search_error = $e->getMessage();
	}
}
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1>Catalog <span>Lookup</span></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Search Amazon\'s catalog by EAN-13 before creating a listing. If the product already exists you can list against its ASIN (commingled inventory — no FNSKU labels).', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<form class="sg-card" method="post">
		<h2><?php esc_html_e( 'Search by EAN-13', 'sg-commerce' ); ?></h2>
		<?php wp_nonce_field( 'sg_ean_lookup' ); ?>

		<div class="sg-grid-4">
			<label style="grid-column: span 2;">EAN-13
				<input type="text" name="ean" value="<?php echo esc_attr( $search_ean ); ?>"
					pattern="\d{13}" maxlength="13" required placeholder="1234567890128" />
			</label>
			<label><?php esc_html_e( 'Market', 'sg-commerce' ); ?>
				<select name="market">
					<?php foreach ( $marketplaces->enabled_codes() as $m ) : ?>
						<option value="<?php echo esc_attr( $m ); ?>" <?php selected( $search_market, $m ); ?>><?php echo esc_html( $m ); ?></option>
					<?php endforeach; ?>
				</select>
			</label>
			<label>&nbsp;
				<button class="sg-btn sg-btn-primary" style="width:100%;"><?php esc_html_e( 'Search', 'sg-commerce' ); ?></button>
			</label>
		</div>

		<?php if ( '' !== $search_ean && CatalogLookup::validate_ean13( $search_ean ) ) : ?>
			<p class="sg-muted" style="font-size:12px; margin-top:6px; color:#059669;">
				✓ EAN checksum valid.
			</p>
		<?php elseif ( '' !== $search_ean ) : ?>
			<p class="sg-muted" style="font-size:12px; margin-top:6px; color:#b91c1c;">
				✗ EAN checksum invalid.
			</p>
		<?php endif; ?>
	</form>

	<?php if ( '' !== $search_error ) : ?>
		<div class="sg-card" style="border-left:4px solid #b91c1c; background:#fef2f2;">
			<h2 style="margin-top:0; color:#b91c1c;"><?php esc_html_e( 'Error', 'sg-commerce' ); ?></h2>
			<p><?php echo esc_html( $search_error ); ?></p>
		</div>
	<?php elseif ( null !== $search_results ) : ?>
		<div class="sg-card">
			<h2><?php esc_html_e( 'Search results', 'sg-commerce' ); ?></h2>

			<?php if ( 'absent' === $search_results['status'] ) : ?>
				<div class="sg-empty" style="background:#fffbeb; border-color:#fde68a;">
					<p>
						<strong>⚠ <?php esc_html_e( 'No matching product on Amazon.', 'sg-commerce' ); ?></strong><br />
						<?php esc_html_e( 'You\'ll need to create a new listing via Listings API — our plugin can submit this via admin → Products.', 'sg-commerce' ); ?>
					</p>
				</div>
			<?php elseif ( 'match' === $search_results['status'] ) : ?>
				<div class="sg-card" style="border-left:4px solid #059669; background:#f0fdf4; margin:0 0 14px;">
					<strong style="color:#059669;">✓ <?php esc_html_e( 'Exact match found', 'sg-commerce' ); ?></strong>
					<p style="margin:4px 0 0; font-size:13px;">
						<?php esc_html_e( 'List against this ASIN. Amazon will use the EAN on your packs to identify inventory — no FNSKU labels required.', 'sg-commerce' ); ?>
					</p>
				</div>
			<?php else : ?>
				<div class="sg-card" style="border-left:4px solid #b45309; background:#fffbeb; margin:0 0 14px;">
					<strong style="color:#b45309;">⚠ <?php esc_html_e( 'Multiple matches', 'sg-commerce' ); ?></strong>
					<p style="margin:4px 0 0; font-size:13px;"><?php esc_html_e( 'Pick the right one. If none match, create a new listing.', 'sg-commerce' ); ?></p>
				</div>
			<?php endif; ?>

			<?php foreach ( (array) $search_results['matches'] as $m ) : ?>
				<div class="sg-card" style="margin:0 0 10px; padding:14px 16px;">
					<div style="display:flex; justify-content:space-between; gap:14px; flex-wrap:wrap;">
						<div>
							<strong><?php echo esc_html( (string) $m['title'] ); ?></strong>
							<div class="sg-muted" style="font-size:12px;">
								<?php echo esc_html( (string) $m['brand'] ); ?>
							</div>
						</div>
						<div>
							<span class="sg-chip"><?php echo esc_html( (string) $m['asin'] ); ?></span>
							<span class="sg-chip"><?php echo esc_html( (string) $m['marketplace'] ); ?></span>
						</div>
					</div>
				</div>
			<?php endforeach; ?>
		</div>
	<?php endif; ?>

	<div class="sg-card">
		<h2><?php esc_html_e( 'EAN → SKU mappings', 'sg-commerce' ); ?> (<?php echo count( (array) $mapped ); ?>)</h2>
		<?php if ( empty( $mapped ) ) : ?>
			<div class="sg-empty">
				<p><?php esc_html_e( 'No EAN mappings yet. Search above and the plugin will persist lookups here.', 'sg-commerce' ); ?></p>
			</div>
		<?php else : ?>
			<table class="sg-table">
				<thead><tr>
					<th>SKU</th>
					<th>EAN-13</th>
					<th><?php esc_html_e( 'Market', 'sg-commerce' ); ?></th>
					<th>ASIN</th>
					<th><?php esc_html_e( 'Catalog', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Listing', 'sg-commerce' ); ?></th>
					<th><?php esc_html_e( 'Last check', 'sg-commerce' ); ?></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $mapped as $m ) :
					$catalog_chip = match ( (string) $m['catalog_status'] ) {
						'match' => 'sg-chip-ok', 'absent' => 'sg-chip-warn', 'ambiguous' => 'sg-chip-warn',
						default => 'sg-chip-muted',
					};
					$listing_chip = match ( (string) $m['listing_status'] ) {
						'published' => 'sg-chip-ok', 'draft' => 'sg-chip-muted',
						'error' => 'sg-chip-err', default => 'sg-chip-muted',
					};
				?>
					<tr>
						<td class="sg-mono"><?php echo esc_html( $m['sku'] ); ?></td>
						<td class="sg-mono"><?php echo esc_html( $m['ean13'] ); ?></td>
						<td><span class="sg-chip"><?php echo esc_html( $m['market'] ); ?></span></td>
						<td class="sg-mono"><?php echo esc_html( $m['asin'] ?: '—' ); ?></td>
						<td><span class="sg-chip <?php echo esc_attr( $catalog_chip ); ?>"><?php echo esc_html( $m['catalog_status'] ); ?></span></td>
						<td><span class="sg-chip <?php echo esc_attr( $listing_chip ); ?>"><?php echo esc_html( $m['listing_status'] ); ?></span></td>
						<td class="sg-muted" style="font-size:11.5px;">
							<?php echo $m['last_checked_at'] ? esc_html( human_time_diff( strtotime( (string) $m['last_checked_at'] ), time() ) . ' ago' ) : '—'; ?>
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</div>
</div>
