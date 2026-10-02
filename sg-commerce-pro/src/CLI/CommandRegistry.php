<?php
/**
 * CommandRegistry — WP-CLI command surface.
 *
 * Registered as `wp sg-commerce <subcommand>`. Each subcommand resolves
 * services from the container so it shares state with the rest of the
 * plugin (caches, settings, etc.).
 *
 * Examples:
 *   wp sg-commerce sync-all
 *   wp sg-commerce sync US
 *   wp sg-commerce describe 42
 *   wp sg-commerce describe-all --market=US --limit=20
 *   wp sg-commerce translate 42 DE
 *   wp sg-commerce repricer-tick
 *   wp sg-commerce status
 *
 * @package SevenGum\Commerce\CLI
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\CLI;

use SevenGum\Commerce\AI\Copywriter;
use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Amazon\SyncOrchestrator;
use SevenGum\Commerce\Core\Plugin;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Repricer\RepricerEngine;

defined( 'ABSPATH' ) || exit;

final class CommandRegistry {

	/**
	 * Sync FBA inventory from one Amazon marketplace.
	 *
	 * ## OPTIONS
	 *
	 * <market>
	 * : Marketplace code (US, DE, UK, ...).
	 *
	 * [--max-pages=<n>]
	 * : Maximum pages of inventory to fetch (default 5).
	 *
	 * ## EXAMPLES
	 *
	 *     wp sg-commerce sync US
	 *     wp sg-commerce sync DE --max-pages=10
	 */
	public function sync( array $args, array $assoc ): void {
		$market = strtoupper( (string) ( $args[0] ?? '' ) );
		if ( '' === $market ) {
			\WP_CLI::error( 'market argument required' );
		}
		$max_pages = isset( $assoc['max-pages'] ) ? max( 1, (int) $assoc['max-pages'] ) : 5;
		try {
			$result = $this->container()->get( SyncOrchestrator::class )->sync_market( $market, $max_pages );
			\WP_CLI::success( sprintf( 'Synced %d products from %s in %d pages.', $result['rows'], $market, $result['pages'] ) );
		} catch ( \Throwable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/**
	 * Sync every enabled marketplace.
	 */
	public function sync_all( array $args, array $assoc ): void {
		$result = $this->container()->get( SyncOrchestrator::class )->sync_all();
		\WP_CLI::log( sprintf( 'Total: %d products', $result['total'] ) );
		foreach ( $result['by_market'] as $m => $n ) {
			\WP_CLI::log( "  {$m}: {$n}" );
		}
		foreach ( $result['errors'] as $m => $err ) {
			\WP_CLI::warning( "  {$m}: {$err}" );
		}
		\WP_CLI::success( 'sync-all complete' );
	}

	/**
	 * Generate AI description for one product.
	 *
	 * ## OPTIONS
	 *
	 * <id>
	 * : Product id.
	 */
	public function describe( array $args, array $assoc ): void {
		$id = (int) ( $args[0] ?? 0 );
		if ( $id <= 0 ) {
			\WP_CLI::error( 'product id required' );
		}
		try {
			$text = $this->container()->get( Copywriter::class )->describe( $id );
			\WP_CLI::log( $text );
			\WP_CLI::success( 'description saved' );
		} catch ( \Throwable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/**
	 * Bulk-describe products without an English description yet.
	 *
	 * [--market=<code>]
	 * : Restrict to one marketplace.
	 *
	 * [--limit=<n>]
	 * : Maximum products to process (default 20).
	 */
	public function describe_all( array $args, array $assoc ): void {
		global $wpdb;
		$market = isset( $assoc['market'] ) ? strtoupper( (string) $assoc['market'] ) : '';
		$limit  = isset( $assoc['limit'] ) ? max( 1, (int) $assoc['limit'] ) : 20;

		$where = "WHERE NOT EXISTS (SELECT 1 FROM {$wpdb->prefix}sg_descriptions d WHERE d.product_id = p.id AND d.language='en')";
		$params = array();
		if ( '' !== $market ) {
			$where .= ' AND market = %s';
			$params[] = $market;
		}
		$sql = "SELECT id FROM {$wpdb->prefix}sg_products p {$where} LIMIT %d";
		$params[] = $limit;
		$ids = $wpdb->get_col( $wpdb->prepare( $sql, ...$params ) );

		if ( empty( $ids ) ) {
			\WP_CLI::success( 'nothing to do' );
			return;
		}
		$copywriter = $this->container()->get( Copywriter::class );
		$progress = \WP_CLI\Utils\make_progress_bar( 'Describing', count( $ids ) );
		$ok = 0; $fail = 0;
		foreach ( $ids as $id ) {
			try { $copywriter->describe( (int) $id ); $ok++; }
			catch ( \Throwable $e ) { $fail++; \WP_CLI::warning( "{$id}: " . $e->getMessage() ); }
			$progress->tick();
		}
		$progress->finish();
		\WP_CLI::success( "described {$ok}, failed {$fail}" );
	}

	/**
	 * Translate one product's description into a market language.
	 *
	 * <id>
	 * : Product id.
	 *
	 * <market>
	 * : Target marketplace code.
	 */
	public function translate( array $args, array $assoc ): void {
		$id     = (int) ( $args[0] ?? 0 );
		$market = strtoupper( (string) ( $args[1] ?? '' ) );
		if ( $id <= 0 || '' === $market ) {
			\WP_CLI::error( 'usage: wp sg-commerce translate <id> <market>' );
		}
		try {
			$text = $this->container()->get( Copywriter::class )->translate( $id, $market );
			\WP_CLI::log( $text );
			\WP_CLI::success( 'translation saved' );
		} catch ( \Throwable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/** Run the repricer engine once. */
	public function repricer_tick( array $args, array $assoc ): void {
		try {
			$result = $this->container()->get( RepricerEngine::class )->tick();
			\WP_CLI::log( wp_json_encode( $result, JSON_PRETTY_PRINT ) );
			\WP_CLI::success( 'repricer tick complete' );
		} catch ( \Throwable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/** Print high-level status. */
	public function status( array $args, array $assoc ): void {
		$c = $this->container();
		$products = $c->get( ProductRepository::class );
		$client   = $c->get( AmazonClient::class );
		$mp       = $c->get( Marketplaces::class );

		\WP_CLI::log( '── Seven Gum Commerce v' . SG_COMMERCE_VERSION . ' ──' );
		\WP_CLI::log( 'Amazon credentials: ' . ( $client->has_credentials() ? 'configured' : 'NOT configured' ) );
		\WP_CLI::log( 'Primary market:     ' . $mp->primary() );
		\WP_CLI::log( 'Enabled markets:    ' . implode( ', ', $mp->enabled_codes() ) );
		\WP_CLI::log( 'Products tracked:   ' . $products->count_total() );
		\WP_CLI::log( 'In stock:           ' . $products->count_in_stock() );
		\WP_CLI::log( 'Winning Buy Box:    ' . $products->count_winning_buybox() );
		\WP_CLI::log( 'Last sync:          ' . ( $products->last_sync_at() ?? 'never' ) );
	}

	/**
	 * Refresh tracking for all pending MCF orders.
	 */
	public function mcf_refresh( array $args, array $assoc ): void {
		try {
			$module = $this->container()->get( \SevenGum\Commerce\Fulfillment\FulfillmentModule::class );
			$module->refresh_pending_tracking();
			\WP_CLI::success( 'MCF tracking refreshed' );
		} catch ( \Throwable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/**
	 * List recent MCF orders.
	 *
	 * [--limit=<n>]
	 * : Max rows (default 20).
	 */
	public function mcf_list( array $args, array $assoc ): void {
		$limit = isset( $assoc['limit'] ) ? max( 1, (int) $assoc['limit'] ) : 20;
		$repo = $this->container()->get( \SevenGum\Commerce\Fulfillment\MCFOrderRepository::class );
		$rows = $repo->recent( $limit );
		if ( empty( $rows ) ) { \WP_CLI::log( 'No MCF orders.' ); return; }
		\WP_CLI\Utils\format_items(
			'table',
			array_map( static fn( $r ) => array(
				'id'       => $r['id'],
				'order'    => $r['displayable_order_id'],
				'market'   => $r['market'],
				'status'   => $r['status'],
				'customer' => $r['customer_name'],
				'created'  => $r['created_at'],
			), $rows ),
			array( 'id', 'order', 'market', 'status', 'customer', 'created' )
		);
	}

	/**
	 * Probe the geo-resolver from CLI (useful for debugging headers).
	 */
	public function geo( array $args, array $assoc ): void {
		$resolver = $this->container()->get( \SevenGum\Commerce\Geotargeting\GeoResolver::class );
		\WP_CLI::log( 'country: ' . $resolver->country() );
		\WP_CLI::log( 'market:  ' . $resolver->market() );
	}

	/**
	 * Run PII anonymization pass immediately.
	 */
	public function pii_purge( array $args, array $assoc ): void {
		try {
			$count = $this->container()->get( \SevenGum\Commerce\Security\PIIManager\PIIManager::class )->purge_expired();
			\WP_CLI::success( "Anonymized {$count} expired MCF orders." );
		} catch ( \Throwable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/**
	 * Resync all theme posts' prices + URLs from Amazon data.
	 */
	public function theme_sync( array $args, array $assoc ): void {
		try {
			$updated = $this->container()->get( \SevenGum\Commerce\Integration\ThemeBridge::class )
				->on_sync_completed( array() );
			\WP_CLI::success( 'Theme bridge resync complete.' );
		} catch ( \Throwable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/**
	 * Parse + import a local settlement report TSV file.
	 *
	 * ## OPTIONS
	 *
	 * <file>
	 * : Path to the GET_V2_SETTLEMENT_REPORT TSV file.
	 *
	 * [--settlement-id=<id>]
	 * : Settlement ID to tag these rows with (optional).
	 */
	public function settlement_import( array $args, array $assoc ): void {
		$path = (string) ( $args[0] ?? '' );
		if ( '' === $path || ! file_exists( $path ) ) {
			\WP_CLI::error( "File not found: {$path}" );
		}
		$content = (string) file_get_contents( $path );
		$parser = new \SevenGum\Commerce\Amazon\ReportsParser\SettlementsParser();
		$events = $parser->parse( $content );

		$settlement_id = isset( $assoc['settlement-id'] ) ? sanitize_text_field( (string) $assoc['settlement-id'] ) : '';
		global $wpdb;
		$table = $wpdb->prefix . 'sg_settlements';
		$imported = 0;
		foreach ( $events as $e ) {
			$result = $wpdb->insert( $table, array(
				'event_date'    => $e['date'] ? gmdate( 'Y-m-d', strtotime( $e['date'] ) ) : null,
				'event_type'    => $e['type'],
				'sku'           => $e['sku'],
				'order_id'      => $e['order_id'],
				'marketplace'   => $e['marketplace'],
				'amount'        => $e['amount'],
				'currency'      => $e['currency'],
				'description'   => substr( $e['description'], 0, 190 ),
				'settlement_id' => $settlement_id,
				'imported_at'   => current_time( 'mysql', true ),
			), array( '%s', '%s', '%s', '%s', '%s', '%f', '%s', '%s', '%s', '%s' ) );
			if ( false !== $result ) $imported++;
		}
		$summary = $parser->summary( $events );
		\WP_CLI::log( "Parsed: {$summary['event_count']} events" );
		foreach ( $summary['totals'] as $t => $amt ) {
			\WP_CLI::log( sprintf( '  %-16s %10.2f', $t, $amt ) );
		}
		\WP_CLI::log( sprintf( "  %-16s %10.2f", 'NET', $summary['net'] ) );
		\WP_CLI::success( "Imported {$imported} rows." );
	}

	/**
	 * Poll SQS once (outside the normal cron).
	 */
	public function sqs_poll( array $args, array $assoc ): void {
		try {
			$processed = $this->container()->get( \SevenGum\Commerce\Amazon\SQSConsumer\SQSConsumer::class )->poll();
			\WP_CLI::success( "Processed {$processed} SQS messages." );
		} catch ( \Throwable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/**
	 * Mint a new API key for the Headless API. Prints the plaintext key ONCE.
	 *
	 * <label>
	 * : Human-readable label for the key.
	 */
	public function api_key_mint( array $args, array $assoc ): void {
		$label = sanitize_text_field( (string) ( $args[0] ?? '' ) );
		if ( '' === $label ) \WP_CLI::error( 'label required' );
		$key = \SevenGum\Commerce\API\HeadlessAPI::mint_key( $this->container(), $label );
		\WP_CLI::log( '' );
		\WP_CLI::log( '  API key (copy now — will not be shown again):' );
		\WP_CLI::log( '' );
		\WP_CLI::log( '    ' . $key );
		\WP_CLI::log( '' );
		\WP_CLI::success( "Minted API key labeled: {$label}" );
	}

	/**
	 * Enable or disable sandbox mode (mocked SP-API responses).
	 *
	 * <state>
	 * : on | off
	 */
	public function sandbox( array $args, array $assoc ): void {
		$state = strtolower( (string) ( $args[0] ?? '' ) );
		if ( 'on' === $state ) {
			\SevenGum\Commerce\Testing\Sandbox::enable();
			\WP_CLI::success( 'Sandbox enabled. All SP-API calls now return mock data.' );
		} elseif ( 'off' === $state ) {
			\SevenGum\Commerce\Testing\Sandbox::disable();
			\WP_CLI::success( 'Sandbox disabled.' );
		} else {
			\WP_CLI::log( 'Sandbox is currently: ' . ( \SevenGum\Commerce\Testing\Sandbox::is_enabled() ? 'ON' : 'OFF' ) );
		}
	}

	/**
	 * Look up an EAN-13 in Amazon catalog for a given market.
	 *
	 * <ean>
	 * : The 13-digit EAN.
	 *
	 * <market>
	 * : Marketplace code (US, DE, UK, ...).
	 */
	public function ean_lookup( array $args, array $assoc ): void {
		$ean    = (string) ( $args[0] ?? '' );
		$market = strtoupper( (string) ( $args[1] ?? 'US' ) );

		if ( ! \SevenGum\Commerce\Amazon\CatalogItems\CatalogLookup::validate_ean13( $ean ) ) {
			\WP_CLI::error( "Invalid EAN-13 checksum: {$ean}" );
		}

		try {
			$result = $this->container()->get( \SevenGum\Commerce\Amazon\CatalogItems\CatalogLookup::class )
				->preflight( $ean, $market );
			\WP_CLI::log( 'Status: ' . $result['status'] );
			foreach ( $result['matches'] as $m ) {
				\WP_CLI::log( sprintf( '  %s  %s  (%s)', $m['asin'], $m['title'], $m['brand'] ) );
			}
			\WP_CLI::success( 'Lookup complete.' );
		} catch ( \Throwable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/**
	 * Generate box labels for an inbound plan and save a PDF to disk.
	 *
	 * <plan_id>
	 * : Internal plan ID (from wp_sg_inbound_plans).
	 *
	 * <output_path>
	 * : File path to write the PDF.
	 */
	public function labels_generate( array $args, array $assoc ): void {
		$plan_id     = (int) ( $args[0] ?? 0 );
		$output_path = (string) ( $args[1] ?? '' );
		if ( $plan_id <= 0 || '' === $output_path ) {
			\WP_CLI::error( 'usage: wp sg-commerce labels-generate <plan_id> <output_path>' );
		}

		global $wpdb;
		$plan = $wpdb->get_row( $wpdb->prepare(
			"SELECT * FROM {$wpdb->prefix}sg_inbound_plans WHERE id = %d",
			$plan_id
		), ARRAY_A );
		if ( ! $plan ) \WP_CLI::error( 'plan not found' );

		$cartons = json_decode( (string) $plan['cartons'], true ) ?: array();
		$address = json_decode( (string) $plan['source_address'], true ) ?: array();

		$templates = $this->container()->get( \SevenGum\Commerce\Fulfillment\BoxContent\BoxContentService::class )->get_templates();
		$template = $templates['sg-master-24pack'] ?? array();

		$boxes = array();
		foreach ( $cartons as $c ) {
			$qty = (int) ( $c['quantity'] ?? 1 );
			for ( $i = 1; $i <= $qty; $i++ ) {
				$boxes[] = array(
					'box_id'       => sprintf( '%s-U%05d', $plan['name'], $i ),
					'plan_name'    => $plan['name'],
					'ship_to'      => array(
						'name'     => 'Amazon FBA Warehouse',
						'address1' => '(to be assigned after placement confirm)',
						'city'     => '',
						'state'    => '',
						'postal'   => '',
						'country'  => $plan['market'],
					),
					'sku_contents' => $c['contents'] ?? array(),
					'weight_kg'    => $template['weight_kg'] ?? 2.1,
					'dimensions'   => array(
						'length_cm' => $template['length_cm'] ?? 33,
						'width_cm'  => $template['width_cm']  ?? 9.5,
						'height_cm' => $template['height_cm'] ?? 22.5,
					),
				);
			}
		}
		if ( empty( $boxes ) ) \WP_CLI::error( 'no cartons in plan' );

		$pdf_bytes = $this->container()->get( \SevenGum\Commerce\Fulfillment\LabelGenerator\LabelGenerator::class )
			->generate_box_labels( $boxes );
		file_put_contents( $output_path, $pdf_bytes );
		\WP_CLI::success( sprintf( 'Wrote %d label pages (%s bytes) to %s',
			count( $boxes ), number_format( strlen( $pdf_bytes ) ), $output_path ) );
	}

	private function container() {
		return Plugin::instance()->container();
	}
}
