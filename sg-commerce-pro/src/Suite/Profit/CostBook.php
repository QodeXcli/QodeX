<?php
/**
 * CostBook — landed unit cost per (market, sku).
 *
 * Landed cost = unit cost + inbound freight + prep + other, taken from
 * `sg_suite_sku_costs`, falling back to the core product `cost_price`,
 * then to the global default from Suite settings.
 *
 * @package SevenGum\Commerce\Suite\Profit
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Profit;

use SevenGum\Commerce\Suite\SuiteSettings;
use SevenGum\Commerce\Suite\Support\Db;

defined( 'ABSPATH' ) || exit;

final class CostBook {

	/** @var array<string, array<string, array>> market => sku => row */
	private array $cache = array();

	public function __construct( private SuiteSettings $settings ) {}

	public function landed( string $market, string $sku ): float {
		$row = $this->row( $market, $sku );
		return null === $row ? $this->settings->float( 'suite_default_unit_cost' ) : (float) $row['landed'];
	}

	public function has_cost( string $market, string $sku ): bool {
		$row = $this->row( $market, $sku );
		return null !== $row && (float) $row['landed'] > 0;
	}

	/** @return array{landed:float, unit_cost:float, inbound_per_unit:float, prep_per_unit:float, other_per_unit:float, lead_time_days:int, moq:int, case_pack:int, supplier:string}|null */
	public function row( string $market, string $sku ): ?array {
		$this->load( $market );
		return $this->cache[ $market ][ $sku ] ?? null;
	}

	/** Every SKU known to the suite (products, order items, cost rows) with its cost row. */
	public function all( string $market ): array {
		$this->load( $market );
		global $wpdb;
		$skus = Db::rows(
			"SELECT sku, MAX(asin) AS asin, MAX(title) AS title FROM (
				SELECT sku, asin, product_name AS title FROM {$wpdb->prefix}sg_products WHERE market = %s
				UNION ALL
				SELECT sku, asin, title FROM {t:order_items} WHERE market = %s AND sku <> ''
			) x GROUP BY sku ORDER BY sku",
			array( $market, $market )
		);
		$out = array();
		foreach ( $skus as $s ) {
			$c     = $this->cache[ $market ][ $s['sku'] ] ?? null;
			$out[] = array(
				'sku'              => (string) $s['sku'],
				'asin'             => (string) $s['asin'],
				'title'            => (string) $s['title'],
				'unit_cost'        => $c['unit_cost'] ?? 0.0,
				'inbound_per_unit' => $c['inbound_per_unit'] ?? 0.0,
				'prep_per_unit'    => $c['prep_per_unit'] ?? 0.0,
				'other_per_unit'   => $c['other_per_unit'] ?? 0.0,
				'landed'           => $c['landed'] ?? 0.0,
				'lead_time_days'   => $c['lead_time_days'] ?? 0,
				'moq'              => $c['moq'] ?? 0,
				'case_pack'        => $c['case_pack'] ?? 0,
				'supplier'         => $c['supplier'] ?? '',
				'source'           => $c['source'] ?? 'none',
			);
		}
		return $out;
	}

	public function save( string $market, string $sku, array $in ): bool {
		$ok = Db::upsert( 'sku_costs', array(
			'market'           => $market,
			'sku'              => mb_substr( $sku, 0, 64 ),
			'unit_cost'        => max( 0.0, (float) ( $in['unit_cost'] ?? 0 ) ),
			'inbound_per_unit' => max( 0.0, (float) ( $in['inbound_per_unit'] ?? 0 ) ),
			'prep_per_unit'    => max( 0.0, (float) ( $in['prep_per_unit'] ?? 0 ) ),
			'other_per_unit'   => max( 0.0, (float) ( $in['other_per_unit'] ?? 0 ) ),
			'lead_time_days'   => max( 0, (int) ( $in['lead_time_days'] ?? 0 ) ),
			'moq'              => max( 0, (int) ( $in['moq'] ?? 0 ) ),
			'case_pack'        => max( 0, (int) ( $in['case_pack'] ?? 0 ) ),
			'supplier'         => mb_substr( sanitize_text_field( (string) ( $in['supplier'] ?? '' ) ), 0, 128 ),
			'updated_at'       => Db::now(),
		) );
		unset( $this->cache[ $market ] );
		return $ok;
	}

	private function load( string $market ): void {
		if ( isset( $this->cache[ $market ] ) ) {
			return;
		}
		global $wpdb;
		$map = array();
		// Core product cost_price as a fallback layer.
		$core = $wpdb->get_results( $wpdb->prepare( "SELECT sku, cost_price FROM {$wpdb->prefix}sg_products WHERE market = %s AND cost_price IS NOT NULL", $market ), ARRAY_A ); // phpcs:ignore
		foreach ( (array) $core as $r ) {
			$map[ (string) $r['sku'] ] = array(
				'landed' => (float) $r['cost_price'], 'unit_cost' => (float) $r['cost_price'], 'inbound_per_unit' => 0.0,
				'prep_per_unit' => 0.0, 'other_per_unit' => 0.0, 'lead_time_days' => 0, 'moq' => 0, 'case_pack' => 0,
				'supplier' => '', 'source' => 'product',
			);
		}
		foreach ( Db::rows( 'SELECT * FROM {t:sku_costs} WHERE market = %s', array( $market ) ) as $r ) {
			$landed = (float) $r['unit_cost'] + (float) $r['inbound_per_unit'] + (float) $r['prep_per_unit'] + (float) $r['other_per_unit'];
			$map[ (string) $r['sku'] ] = array(
				'landed' => $landed, 'unit_cost' => (float) $r['unit_cost'], 'inbound_per_unit' => (float) $r['inbound_per_unit'],
				'prep_per_unit' => (float) $r['prep_per_unit'], 'other_per_unit' => (float) $r['other_per_unit'],
				'lead_time_days' => (int) $r['lead_time_days'], 'moq' => (int) $r['moq'], 'case_pack' => (int) $r['case_pack'],
				'supplier' => (string) $r['supplier'], 'source' => 'suite',
			);
		}
		$this->cache[ $market ] = $map;
	}
}
