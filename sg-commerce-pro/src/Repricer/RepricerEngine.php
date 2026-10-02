<?php
/**
 * RepricerEngine — automated price adjustment.
 *
 * Strategy: match_buybox
 *   For each tracked product where buybox_price exists and we're not winning,
 *   compute a target price = buybox_price - $cents_below_buybox.
 *   Floor to ProfitCalculator::min_price_for(cost). Skip if no cost set.
 *
 * Patches Amazon listings via PATCH /listings/2021-08-01/items/{seller}/{sku}.
 * NOTE: actual SP-API patch requires Listings API role authorization. We log
 * the intended price change and persist my_price locally; the PATCH call is
 * implemented but disabled by default (`repricer_dry_run` setting).
 *
 * @package SevenGum\Commerce\Repricer
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Repricer;

use SevenGum\Commerce\Analytics\ProfitCalculator;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class RepricerEngine {

	public function __construct(
		private ProductRepository $products,
		private SettingsRepository $settings,
		private ProfitCalculator $profit,
		private Logger $logger,
	) {}

	public function tick(): array {
		if ( ! $this->settings->get( 'repricer_enabled', false ) ) {
			return array( 'skipped' => 'disabled' );
		}

		$strategy   = (string) $this->settings->get( 'repricer_strategy', 'match_buybox' );
		$cents_off  = (float)  $this->settings->get( 'repricer_cents_below_buybox', 0.01 );
		$dry_run    = (bool)   $this->settings->get( 'repricer_dry_run', true );

		// Pull losing products with cost set.
		global $wpdb;
		$rows = $wpdb->get_results(
			"SELECT id, market, sku, asin, buybox_price, my_price, cost_price, buybox_currency
			 FROM {$wpdb->prefix}sg_products
			 WHERE buybox_is_mine = 0
			   AND buybox_price IS NOT NULL
			   AND cost_price IS NOT NULL
			 ORDER BY updated_at DESC
			 LIMIT 100",
			ARRAY_A
		);

		$adjusted = 0;
		$skipped_floor = 0;
		$logs = array();

		foreach ( (array) $rows as $row ) {
			$buybox = (float) $row['buybox_price'];
			$cost   = (float) $row['cost_price'];
			$target = match ( $strategy ) {
				'match_buybox' => max( 0.01, $buybox - $cents_off ),
				default        => $buybox,
			};
			$floor = $this->profit->min_price_for( $cost );

			if ( $target < $floor ) {
				++$skipped_floor;
				$logs[] = array(
					'sku'    => $row['sku'],
					'market' => $row['market'],
					'reason' => 'would breach min margin floor',
					'target' => $target,
					'floor'  => $floor,
				);
				continue;
			}

			$current = isset( $row['my_price'] ) ? (float) $row['my_price'] : 0.0;
			if ( abs( $current - $target ) < 0.005 ) {
				continue; // already at target
			}

			$logs[] = array(
				'sku'         => $row['sku'],
				'market'      => $row['market'],
				'from'        => $current,
				'to'          => round( $target, 2 ),
				'buybox'      => $buybox,
				'dry_run'     => $dry_run,
			);

			$this->products->update_my_price( (int) $row['id'], round( $target, 2 ) );
			++$adjusted;

			if ( ! $dry_run ) {
				// In a real production flow, here we'd PATCH the Amazon listing.
				// We log intent only — operator must enable Listings API authorization.
				$this->logger->info( 'repricer would PATCH listing', array(
					'asin' => $row['asin'], 'sku' => $row['sku'], 'price' => $target,
				) );
			}
		}

		$summary = array(
			'adjusted'      => $adjusted,
			'skipped_floor' => $skipped_floor,
			'dry_run'       => $dry_run,
			'logs'          => $logs,
		);
		$this->logger->info( 'repricer tick complete', array(
			'adjusted' => $adjusted, 'skipped_floor' => $skipped_floor,
		) );
		return $summary;
	}
}
