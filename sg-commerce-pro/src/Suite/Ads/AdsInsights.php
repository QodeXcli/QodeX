<?php
/**
 * AdsInsights — read models for the PPC screens.
 *
 * @package SevenGum\Commerce\Suite\Ads
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Ads;

use SevenGum\Commerce\Suite\Support\Db;

defined( 'ABSPATH' ) || exit;

final class AdsInsights {

	public function overview( string $from, string $to ): array {
		$t = Db::row(
			"SELECT COALESCE(SUM(impressions),0) AS impressions, COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(cost),0) AS cost,
			        COALESCE(SUM(sales),0) AS sales, COALESCE(SUM(orders),0) AS orders, COALESCE(SUM(units),0) AS units
			 FROM {t:ads_daily} WHERE level = 'campaign' AND report_date BETWEEN %s AND %s",
			array( $from, $to )
		) ?? array();
		$series = Db::rows(
			"SELECT report_date AS date, SUM(cost) AS cost, SUM(sales) AS sales, SUM(clicks) AS clicks, SUM(orders) AS orders
			 FROM {t:ads_daily} WHERE level = 'campaign' AND report_date BETWEEN %s AND %s GROUP BY report_date ORDER BY report_date",
			array( $from, $to )
		);
		foreach ( $series as &$s ) {
			$s['acos'] = (float) $s['sales'] > 0 ? round( (float) $s['cost'] / (float) $s['sales'] * 100, 2 ) : null;
		}
		$wasted = (float) Db::var(
			'SELECT COALESCE(SUM(cost),0) FROM (SELECT search_term, SUM(cost) AS cost, SUM(orders) AS o FROM {t:ads_search_terms}
			 WHERE report_date BETWEEN %s AND %s GROUP BY search_term) x WHERE x.o = 0',
			array( $from, $to )
		);
		return array( 'totals' => self::kpis( $t ) + array( 'wasted_spend' => round( $wasted, 2 ) ), 'series' => $series );
	}

	public function campaigns( string $from, string $to ): array {
		$rows = Db::rows(
			"SELECT c.campaign_id, c.name, c.state, c.targeting_type, c.daily_budget, c.bidding_strategy,
			        COALESCE(SUM(d.impressions),0) AS impressions, COALESCE(SUM(d.clicks),0) AS clicks, COALESCE(SUM(d.cost),0) AS cost,
			        COALESCE(SUM(d.sales),0) AS sales, COALESCE(SUM(d.orders),0) AS orders, COALESCE(SUM(d.units),0) AS units
			 FROM {t:ads_campaigns} c
			 LEFT JOIN {t:ads_daily} d ON d.campaign_id = c.campaign_id AND d.level = 'campaign' AND d.report_date BETWEEN %s AND %s
			 GROUP BY c.campaign_id, c.name, c.state, c.targeting_type, c.daily_budget, c.bidding_strategy
			 ORDER BY cost DESC",
			array( $from, $to )
		);
		return array_map( static fn( $r ) => self::kpis( $r ) + $r, $rows );
	}

	public function targets( string $from, string $to, string $campaign = '' ): array {
		$args  = array( $from, $to );
		$where = "t.state <> 'ARCHIVED'";
		if ( '' !== $campaign ) {
			$where .= ' AND t.campaign_id = %s';
			$args[] = $campaign;
		}
		$rows = Db::rows(
			"SELECT t.target_id, t.kind, t.campaign_id, t.ad_group_id, t.keyword_text, t.match_type, t.state, t.bid, c.name AS campaign,
			        COALESCE(SUM(d.impressions),0) AS impressions, COALESCE(SUM(d.clicks),0) AS clicks, COALESCE(SUM(d.cost),0) AS cost,
			        COALESCE(SUM(d.sales),0) AS sales, COALESCE(SUM(d.orders),0) AS orders, COALESCE(SUM(d.units),0) AS units
			 FROM {t:ads_targets} t
			 LEFT JOIN {t:ads_campaigns} c ON c.campaign_id = t.campaign_id
			 LEFT JOIN {t:ads_daily} d ON d.target_id = t.target_id AND d.level = 'target' AND d.report_date BETWEEN %s AND %s
			 WHERE {$where}
			 GROUP BY t.target_id, t.kind, t.campaign_id, t.ad_group_id, t.keyword_text, t.match_type, t.state, t.bid, c.name
			 ORDER BY cost DESC LIMIT 1000",
			$args
		);
		return array_map( static fn( $r ) => self::kpis( $r ) + $r, $rows );
	}

	public function search_terms( string $from, string $to ): array {
		$rows = Db::rows(
			"SELECT search_term, MAX(keyword_text) AS keyword_text, MAX(match_type) AS match_type, COUNT(DISTINCT campaign_id) AS campaigns,
			        SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(cost) AS cost, SUM(sales) AS sales, SUM(orders) AS orders
			 FROM {t:ads_search_terms} WHERE report_date BETWEEN %s AND %s
			 GROUP BY search_term ORDER BY SUM(cost) DESC LIMIT 1000",
			array( $from, $to )
		);
		return array_map( static fn( $r ) => self::kpis( $r ) + $r, $rows );
	}

	public function actions( string $status = 'planned' ): array {
		return Db::rows( 'SELECT * FROM {t:ads_actions} WHERE status = %s ORDER BY kind, id LIMIT 1000', array( $status ) );
	}

	public function history(): array {
		return Db::rows( "SELECT * FROM {t:ads_actions} WHERE status IN ('applied','failed','dismissed') ORDER BY COALESCE(applied_at, created_at) DESC LIMIT 300" );
	}

	private static function kpis( array $r ): array {
		$cost  = (float) ( $r['cost'] ?? 0 );
		$sales = (float) ( $r['sales'] ?? 0 );
		$clk   = (int) ( $r['clicks'] ?? 0 );
		$imp   = (int) ( $r['impressions'] ?? 0 );
		$ord   = (int) ( $r['orders'] ?? 0 );
		return array(
			'impressions' => $imp,
			'clicks'      => $clk,
			'cost'        => round( $cost, 2 ),
			'sales'       => round( $sales, 2 ),
			'orders'      => $ord,
			'acos'        => $sales > 0 ? round( $cost / $sales * 100, 2 ) : null,
			'roas'        => $cost > 0 ? round( $sales / $cost, 2 ) : null,
			'ctr'         => $imp > 0 ? round( $clk / $imp * 100, 2 ) : null,
			'cpc'         => $clk > 0 ? round( $cost / $clk, 2 ) : null,
			'cvr'         => $clk > 0 ? round( $ord / $clk * 100, 2 ) : null,
		);
	}
}
