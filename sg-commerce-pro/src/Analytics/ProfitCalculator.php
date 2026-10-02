<?php
/**
 * ProfitCalculator — applies cost + Amazon fees to compute margin.
 *
 * Operator stores cost per SKU manually (cost_price column). Amazon's
 * fee structure is approximated here as a configurable percentage
 * (default 15% referral + $3 FBA pick-pack). For exact fees we'd need
 * the SP-API Fees endpoint — that's a planned v3.1 feature.
 *
 * @package SevenGum\Commerce\Analytics
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Analytics;

use SevenGum\Commerce\Database\Repositories\SettingsRepository;

defined( 'ABSPATH' ) || exit;

final class ProfitCalculator {

	public function __construct( private SettingsRepository $settings ) {}

	/**
	 * Compute profit for a sale at $sale_price given $cost.
	 *
	 * Returns:
	 *   gross_profit, net_profit, margin_pct, fee_estimate
	 */
	public function compute( float $sale_price, ?float $cost ): array {
		$referral_pct = (float) $this->settings->get( 'referral_fee_pct', 15.0 );
		$fba_fee      = (float) $this->settings->get( 'fba_pick_pack_fee', 3.00 );

		$fee = $sale_price * ( $referral_pct / 100.0 ) + $fba_fee;

		$gross = ( null !== $cost ) ? ( $sale_price - $cost ) : 0.0;
		$net   = ( null !== $cost ) ? ( $sale_price - $cost - $fee ) : -1.0 * $fee;
		$margin = ( null !== $cost && $sale_price > 0 ) ? ( $net / $sale_price * 100.0 ) : 0.0;

		return array(
			'gross_profit' => round( $gross, 2 ),
			'net_profit'   => round( $net, 2 ),
			'margin_pct'   => round( $margin, 2 ),
			'fee_estimate' => round( $fee, 2 ),
		);
	}

	/**
	 * Minimum sale price that satisfies the configured min margin %.
	 * Useful for the repricer floor.
	 */
	public function min_price_for( float $cost ): float {
		$min_margin = (float) $this->settings->get( 'repricer_min_margin_pct', 15.0 );
		$referral_pct = (float) $this->settings->get( 'referral_fee_pct', 15.0 );
		$fba_fee = (float) $this->settings->get( 'fba_pick_pack_fee', 3.00 );

		// price - cost - (price * referral) - fba >= price * (margin/100)
		// price * (1 - referral/100 - margin/100) >= cost + fba
		$denom = 1.0 - ( $referral_pct / 100.0 ) - ( $min_margin / 100.0 );
		if ( $denom <= 0 ) {
			return 0.0; // misconfigured — refuse to compute
		}
		return round( ( $cost + $fba_fee ) / $denom, 2 );
	}
}
