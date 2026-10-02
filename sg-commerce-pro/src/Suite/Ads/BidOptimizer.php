<?php
/**
 * BidOptimizer — rules-based Sponsored Products bid & search-term engine.
 *
 * Pure: input is aggregated performance rows, output is a list of proposed
 * actions. Nothing here talks to Amazon — AdsSync persists the plan as
 * `planned` actions which the user (or auto-apply) pushes later.
 *
 * Bid logic (per keyword/target over the lookback window):
 *
 *   1. orders > 0  →  target CPC = (sales / clicks) × targetACoS
 *                     move bid toward target CPC, capped at ±max_step%.
 *   2. orders = 0 and clicks ≥ min_clicks
 *                  →  cut bid by max_step% (bleeding spend, no conversions).
 *                     If spend ≥ 2 × (avg order value × targetACoS) → pause.
 *   3. impressions < 100 and (no data or ACoS < target)
 *                  →  raise bid by half the step to win visibility.
 *   Changes smaller than 3 % or 0.02 are dropped as noise.
 *   Bids always clamp to [min_bid, max_bid].
 *
 * Search-term logic:
 *   - Harvest: term with ≥ harvest_min_orders orders and ACoS ≤ 1.2×target,
 *     not already an exact keyword → add as EXACT (and negate in source).
 *   - Negate: term with ≥ neg_min_clicks clicks and 0 orders → NEGATIVE_EXACT
 *     in its source ad group.
 *
 * Budget logic:
 *   - Campaign spending ≥ 90 % of budget on average with ACoS < target
 *     → raise budget 20 %. ACoS > 1.5×target and spending at cap → cut 15 %.
 *
 * @package SevenGum\Commerce\Suite\Ads
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Ads;

final class BidOptimizer {

	/**
	 * @param array $cfg {target_acos, min_clicks, max_step_pct, min_bid, max_bid, raise_low_impr, neg_min_clicks, harvest_min_orders, avg_order_value}
	 */
	public function __construct( private array $cfg ) {
		$this->cfg += array(
			'target_acos'        => 30.0,
			'min_clicks'         => 12,
			'max_step_pct'       => 20.0,
			'min_bid'            => 0.20,
			'max_bid'            => 4.00,
			'raise_low_impr'     => true,
			'neg_min_clicks'     => 15,
			'harvest_min_orders' => 2,
			'avg_order_value'    => 0.0,
		);
	}

	/**
	 * @param array<int, array{target_id:string, kind:string, campaign_id:string, ad_group_id:string, label:string, state:string, bid:float, impressions:int, clicks:int, cost:float, sales:float, orders:int}> $targets
	 * @return array<int, array{kind:string, entity_id:string, campaign_id:string, ad_group_id:string, label:string, old_value:string, new_value:string, reason:string, payload:array}>
	 */
	public function bids( array $targets ): array {
		$t     = (float) $this->cfg['target_acos'] / 100;
		$step  = (float) $this->cfg['max_step_pct'] / 100;
		$min   = (float) $this->cfg['min_bid'];
		$max   = (float) $this->cfg['max_bid'];
		$out   = array();

		foreach ( $targets as $r ) {
			if ( 'ENABLED' !== strtoupper( (string) $r['state'] ) || $r['bid'] <= 0 ) {
				continue;
			}
			$bid    = (float) $r['bid'];
			$clicks = (int) $r['clicks'];
			$orders = (int) $r['orders'];
			$cost   = (float) $r['cost'];
			$sales  = (float) $r['sales'];
			$acos   = $sales > 0 ? $cost / $sales : null;
			$new    = null;
			$why    = '';
			$pause  = false;

			if ( $orders > 0 && $clicks > 0 ) {
				$target_cpc = ( $sales / $clicks ) * $t;
				$new = max( $bid * ( 1 - $step ), min( $bid * ( 1 + $step ), $target_cpc ) );
				$why = sprintf(
					'ACoS %.1f%% vs target %.1f%% · %d clicks · %d orders · RPC %s → target CPC %s',
					$acos * 100, $t * 100, $clicks, $orders, self::m( $sales / $clicks ), self::m( $target_cpc )
				);
			} elseif ( 0 === $orders && $clicks >= (int) $this->cfg['min_clicks'] ) {
				$aov = (float) $this->cfg['avg_order_value'];
				if ( $aov > 0 && $cost >= 2 * $aov * $t ) {
					$pause = true;
					$why   = sprintf( 'No orders after %d clicks; spent %s (≥ 2× break-even CPA %s)', $clicks, self::m( $cost ), self::m( $aov * $t ) );
				} else {
					$new = $bid * ( 1 - $step );
					$why = sprintf( 'No orders after %d clicks (spent %s)', $clicks, self::m( $cost ) );
				}
			} elseif ( $this->cfg['raise_low_impr'] && (int) $r['impressions'] < 100 && ( null === $acos || $acos < $t ) ) {
				$new = $bid * ( 1 + $step / 2 );
				$why = sprintf( 'Low visibility: %d impressions in window', (int) $r['impressions'] );
			}

			if ( $pause ) {
				$out[] = $this->action( 'pause', $r, (string) $bid, 'PAUSED', $why );
				continue;
			}
			if ( null === $new ) {
				continue;
			}
			$new = round( max( $min, min( $max, $new ) ), 2 );
			if ( abs( $new - $bid ) < 0.02 || abs( $new - $bid ) / $bid < 0.03 ) {
				continue;
			}
			$out[] = $this->action( 'bid', $r, number_format( $bid, 2, '.', '' ), number_format( $new, 2, '.', '' ), $why );
		}
		return $out;
	}

	/**
	 * @param array<int, array{search_term:string, campaign_id:string, ad_group_id:string, keyword_text:string, match_type:string, impressions:int, clicks:int, cost:float, sales:float, orders:int}> $terms
	 * @param array<string, bool> $existing_exact  lower-case exact keywords already targeted
	 * @param array<string, bool> $existing_neg    "adgroup|term" negatives already present
	 */
	public function search_terms( array $terms, array $existing_exact, array $existing_neg, string $harvest_campaign, string $harvest_ad_group ): array {
		$t   = (float) $this->cfg['target_acos'] / 100;
		$out = array();
		$harvested = array();
		foreach ( $terms as $r ) {
			$term = strtolower( trim( (string) $r['search_term'] ) );
			if ( '' === $term ) {
				continue;
			}
			$orders = (int) $r['orders'];
			$clicks = (int) $r['clicks'];
			$cost   = (float) $r['cost'];
			$sales  = (float) $r['sales'];
			$acos   = $sales > 0 ? $cost / $sales : null;
			$is_asin = 1 === preg_match( '/^b0[a-z0-9]{8}$/', $term );
			$neg_key = $r['ad_group_id'] . '|' . $term;

			if ( $orders >= (int) $this->cfg['harvest_min_orders'] && null !== $acos && $acos <= $t * 1.2
				&& ! isset( $existing_exact[ $term ] ) && ! isset( $harvested[ $term ] ) ) {
				$harvested[ $term ] = true;
				$cpc = $clicks > 0 ? $cost / $clicks : (float) $this->cfg['min_bid'];
				$bid = round( max( (float) $this->cfg['min_bid'], min( (float) $this->cfg['max_bid'], $cpc * 1.1 ) ), 2 );
				$out[] = array(
					'kind'        => $is_asin ? 'harvest_asin' : 'harvest',
					'entity_id'   => $term,
					'campaign_id' => '' !== $harvest_campaign ? $harvest_campaign : (string) $r['campaign_id'],
					'ad_group_id' => '' !== $harvest_ad_group ? $harvest_ad_group : (string) $r['ad_group_id'],
					'label'       => $term,
					'old_value'   => '',
					'new_value'   => $is_asin ? 'ASIN target @ ' . number_format( $bid, 2 ) : 'EXACT @ ' . number_format( $bid, 2 ),
					'reason'      => sprintf( '%d orders · ACoS %.1f%% · from "%s" (%s)', $orders, $acos * 100, $r['keyword_text'], $r['match_type'] ),
					'payload'     => array(
						'term' => $term, 'bid' => $bid, 'asin' => $is_asin,
						'source_campaign_id' => (string) $r['campaign_id'], 'source_ad_group_id' => (string) $r['ad_group_id'],
					),
				);
				continue;
			}

			if ( 0 === $orders && $clicks >= (int) $this->cfg['neg_min_clicks'] && ! isset( $existing_neg[ $neg_key ] ) && ! $is_asin ) {
				$out[] = array(
					'kind'        => 'negative',
					'entity_id'   => $term,
					'campaign_id' => (string) $r['campaign_id'],
					'ad_group_id' => (string) $r['ad_group_id'],
					'label'       => $term,
					'old_value'   => '',
					'new_value'   => 'NEGATIVE_EXACT',
					'reason'      => sprintf( '%d clicks, 0 orders, wasted %s', $clicks, self::m( $cost ) ),
					'payload'     => array( 'term' => $term ),
				);
			}
		}
		return $out;
	}

	/**
	 * @param array<int, array{campaign_id:string, name:string, state:string, daily_budget:float, days:int, cost:float, sales:float}> $campaigns
	 */
	public function budgets( array $campaigns ): array {
		$t   = (float) $this->cfg['target_acos'] / 100;
		$out = array();
		foreach ( $campaigns as $c ) {
			if ( 'ENABLED' !== strtoupper( (string) $c['state'] ) || $c['daily_budget'] <= 0 || $c['days'] <= 0 ) {
				continue;
			}
			$avg  = $c['cost'] / $c['days'];
			$util = $avg / $c['daily_budget'];
			$acos = $c['sales'] > 0 ? $c['cost'] / $c['sales'] : null;
			$new  = null;
			$why  = '';
			if ( $util >= 0.9 && null !== $acos && $acos < $t ) {
				$new = $c['daily_budget'] * 1.2;
				$why = sprintf( 'Budget-capped (%.0f%% used/day) while profitable (ACoS %.1f%%)', $util * 100, $acos * 100 );
			} elseif ( $util >= 0.9 && ( null === $acos || $acos > $t * 1.5 ) ) {
				$new = $c['daily_budget'] * 0.85;
				$why = null === $acos
					? sprintf( 'Budget-capped (%.0f%%) with zero sales', $util * 100 )
					: sprintf( 'Budget-capped (%.0f%%) at ACoS %.1f%% (> 1.5× target)', $util * 100, $acos * 100 );
			}
			if ( null === $new ) {
				continue;
			}
			$new   = max( 1.0, round( $new, 2 ) );
			$out[] = array(
				'kind'        => 'budget',
				'entity_id'   => (string) $c['campaign_id'],
				'campaign_id' => (string) $c['campaign_id'],
				'ad_group_id' => '',
				'label'       => (string) $c['name'],
				'old_value'   => number_format( (float) $c['daily_budget'], 2, '.', '' ),
				'new_value'   => number_format( $new, 2, '.', '' ),
				'reason'      => $why,
				'payload'     => array(),
			);
		}
		return $out;
	}

	private function action( string $kind, array $r, string $old, string $new, string $why ): array {
		return array(
			'kind'        => $kind,
			'entity_id'   => (string) $r['target_id'],
			'campaign_id' => (string) $r['campaign_id'],
			'ad_group_id' => (string) $r['ad_group_id'],
			'label'       => (string) $r['label'],
			'old_value'   => $old,
			'new_value'   => $new,
			'reason'      => $why,
			'payload'     => array( 'target_kind' => (string) $r['kind'] ),
		);
	}

	private static function m( float $v ): string {
		return number_format( $v, 2 );
	}
}
