<?php
/**
 * AdsSync — mirrors Sponsored Products structure + performance locally and
 * turns BidOptimizer output into reviewable, applicable actions.
 *
 * Flow:
 *   sync_structure()   campaigns, keywords, product targets  → ads_campaigns / ads_targets
 *   request_reports()  spCampaigns, spTargeting, spSearchTerm (async)  → reports rows (source=ads)
 *   ingest()           called by ReportPipeline when a report completes → ads_daily / ads_search_terms
 *   optimize()         build a plan → ads_actions (status=planned)
 *   apply( ids )       push planned actions to Amazon → status applied|failed
 *
 * @package SevenGum\Commerce\Suite\Ads
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Ads;

use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Suite\Reports\ReportParser;
use SevenGum\Commerce\Suite\SuiteSettings;
use SevenGum\Commerce\Suite\Support\Db;

defined( 'ABSPATH' ) || exit;

final class AdsSync {

	public const REPORTS = array(
		'spCampaigns' => array(
			'group'   => array( 'campaign' ),
			'columns' => array( 'date', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'impressions', 'clicks', 'cost', 'sales7d', 'purchases7d', 'unitsSoldClicks7d' ),
		),
		'spTargeting' => array(
			'group'   => array( 'targeting' ),
			'columns' => array( 'date', 'campaignId', 'adGroupId', 'keywordId', 'keyword', 'matchType', 'targeting', 'keywordType', 'impressions', 'clicks', 'cost', 'sales7d', 'purchases7d', 'unitsSoldClicks7d' ),
		),
		'spSearchTerm' => array(
			'group'   => array( 'searchTerm' ),
			'columns' => array( 'date', 'campaignId', 'adGroupId', 'keywordId', 'keyword', 'matchType', 'searchTerm', 'impressions', 'clicks', 'cost', 'sales7d', 'purchases7d' ),
		),
	);

	public function __construct(
		private AdsClient $ads,
		private SuiteSettings $settings,
		private Logger $logger,
	) {}

	public function profile(): string {
		return $this->settings->string( 'suite_ads_profile_id' );
	}

	/** @return array{campaigns:int, targets:int} */
	public function sync_structure(): array {
		$profile = $this->profile();
		$now     = Db::now();
		$nc = 0;
		foreach ( $this->ads->campaigns() as $c ) {
			Db::upsert( 'ads_campaigns', array(
				'profile_id'       => $profile,
				'campaign_id'      => (string) ( $c['campaignId'] ?? '' ),
				'name'             => mb_substr( (string) ( $c['name'] ?? '' ), 0, 255 ),
				'state'            => (string) ( $c['state'] ?? '' ),
				'targeting_type'   => (string) ( $c['targetingType'] ?? '' ),
				'daily_budget'     => (float) ( $c['budget']['budget'] ?? 0 ),
				'bidding_strategy' => (string) ( $c['dynamicBidding']['strategy'] ?? '' ),
				'start_date'       => ! empty( $c['startDate'] ) ? substr( (string) $c['startDate'], 0, 10 ) : null,
				'updated_at'       => $now,
				'is_demo'          => 0,
			) );
			$nc++;
		}
		$nt = 0;
		foreach ( $this->ads->keywords() as $k ) {
			Db::upsert( 'ads_targets', array(
				'profile_id'   => $profile,
				'target_id'    => (string) ( $k['keywordId'] ?? '' ),
				'kind'         => 'keyword',
				'campaign_id'  => (string) ( $k['campaignId'] ?? '' ),
				'ad_group_id'  => (string) ( $k['adGroupId'] ?? '' ),
				'keyword_text' => mb_substr( (string) ( $k['keywordText'] ?? '' ), 0, 255 ),
				'match_type'   => (string) ( $k['matchType'] ?? '' ),
				'state'        => (string) ( $k['state'] ?? '' ),
				'bid'          => isset( $k['bid'] ) ? (float) $k['bid'] : null,
				'updated_at'   => $now,
				'is_demo'      => 0,
			) );
			$nt++;
		}
		foreach ( $this->ads->targets() as $t ) {
			$expr = array();
			foreach ( (array) ( $t['expression'] ?? array() ) as $e ) {
				$expr[] = strtolower( (string) ( $e['type'] ?? '' ) ) . ( isset( $e['value'] ) ? '=' . $e['value'] : '' );
			}
			Db::upsert( 'ads_targets', array(
				'profile_id'   => $profile,
				'target_id'    => (string) ( $t['targetId'] ?? '' ),
				'kind'         => 'target',
				'campaign_id'  => (string) ( $t['campaignId'] ?? '' ),
				'ad_group_id'  => (string) ( $t['adGroupId'] ?? '' ),
				'keyword_text' => mb_substr( implode( ' ', $expr ), 0, 255 ),
				'match_type'   => (string) ( $t['expressionType'] ?? '' ),
				'state'        => (string) ( $t['state'] ?? '' ),
				'bid'          => isset( $t['bid'] ) ? (float) $t['bid'] : null,
				'updated_at'   => $now,
				'is_demo'      => 0,
			) );
			$nt++;
		}
		return array( 'campaigns' => $nc, 'targets' => $nt );
	}

	/**
	 * Request the three daily reports for [start, end] (max 31 days).
	 *
	 * @return array<string, string> type => remote report id
	 */
	public function request_reports( string $start, string $end ): array {
		$out = array();
		foreach ( self::REPORTS as $type => $spec ) {
			try {
				$id = $this->ads->create_report( "sg-{$type}-{$start}-{$end}", $type, $spec['group'], $spec['columns'], $start, $end );
				Db::insert( 'reports', array(
					'report_type'  => $type,
					'market'       => '',
					'source'       => 'ads',
					'remote_id'    => $id,
					'status'       => 'requested',
					'data_start'   => $start . ' 00:00:00',
					'data_end'     => $end . ' 23:59:59',
					'requested_at' => Db::now(),
				) );
				$out[ $type ] = $id;
			} catch ( \Throwable $e ) {
				// 425 = duplicate request already in flight; anything else is logged.
				$this->logger->warning( 'Ads report request failed', array( 'type' => $type, 'error' => $e->getMessage() ) );
			}
		}
		return $out;
	}

	/** Ingest a downloaded GZIP_JSON report. */
	public function ingest( string $type, string $raw, bool $demo = false ): int {
		$rows    = ReportParser::json( $raw );
		$profile = $this->profile();
		$n       = 0;
		foreach ( $rows as $r ) {
			if ( ! is_array( $r ) ) {
				continue;
			}
			$date = substr( (string) ( $r['date'] ?? '' ), 0, 10 );
			if ( '' === $date ) {
				continue;
			}
			if ( 'spSearchTerm' === $type ) {
				$term = mb_substr( (string) ( $r['searchTerm'] ?? '' ), 0, 255 );
				Db::upsert( 'ads_search_terms', array(
					'profile_id'   => $profile,
					'row_hash'     => sha1( implode( '|', array( $profile, $date, $r['campaignId'] ?? '', $r['adGroupId'] ?? '', $r['keywordId'] ?? '', $term ) ) ),
					'report_date'  => $date,
					'campaign_id'  => (string) ( $r['campaignId'] ?? '' ),
					'ad_group_id'  => (string) ( $r['adGroupId'] ?? '' ),
					'target_id'    => (string) ( $r['keywordId'] ?? '' ),
					'keyword_text' => mb_substr( (string) ( $r['keyword'] ?? $r['targeting'] ?? '' ), 0, 255 ),
					'match_type'   => (string) ( $r['matchType'] ?? '' ),
					'search_term'  => $term,
					'impressions'  => (int) ( $r['impressions'] ?? 0 ),
					'clicks'       => (int) ( $r['clicks'] ?? 0 ),
					'cost'         => (float) ( $r['cost'] ?? 0 ),
					'sales'        => (float) ( $r['sales7d'] ?? 0 ),
					'orders'       => (int) ( $r['purchases7d'] ?? 0 ),
					'is_demo'      => $demo ? 1 : 0,
				) );
			} else {
				$is_campaign = 'spCampaigns' === $type;
				Db::upsert( 'ads_daily', array(
					'profile_id'   => $profile,
					'report_date'  => $date,
					'level'        => $is_campaign ? 'campaign' : 'target',
					'campaign_id'  => (string) ( $r['campaignId'] ?? '' ),
					'ad_group_id'  => (string) ( $r['adGroupId'] ?? '' ),
					'target_id'    => $is_campaign ? '' : (string) ( $r['keywordId'] ?? '' ),
					'keyword_text' => mb_substr( (string) ( $r['keyword'] ?? $r['targeting'] ?? $r['campaignName'] ?? '' ), 0, 255 ),
					'match_type'   => (string) ( $r['matchType'] ?? '' ),
					'impressions'  => (int) ( $r['impressions'] ?? 0 ),
					'clicks'       => (int) ( $r['clicks'] ?? 0 ),
					'cost'         => (float) ( $r['cost'] ?? 0 ),
					'sales'        => (float) ( $r['sales7d'] ?? 0 ),
					'orders'       => (int) ( $r['purchases7d'] ?? 0 ),
					'units'        => (int) ( $r['unitsSoldClicks7d'] ?? 0 ),
					'is_demo'      => $demo ? 1 : 0,
				) );
			}
			$n++;
		}
		return $n;
	}

	/**
	 * Build a fresh optimisation plan. Previously planned (unapplied)
	 * actions are superseded so the queue never shows stale advice.
	 *
	 * @return array{bids:int, terms:int, budgets:int}
	 */
	public function optimize( ?string $today = null ): array {
		$today    = $today ?? gmdate( 'Y-m-d' );
		$lookback = max( 3, $this->settings->int( 'suite_ads_lookback_days' ) );
		$from     = gmdate( 'Y-m-d', strtotime( $today . " -{$lookback} days" ) );
		// Ads attribution lags 1–2 days; exclude the most recent 2 days.
		$to       = gmdate( 'Y-m-d', strtotime( $today . ' -2 days' ) );

		$aov = (float) Db::var(
			"SELECT CASE WHEN SUM(orders) > 0 THEN SUM(sales)/SUM(orders) ELSE 0 END FROM {t:ads_daily}
			 WHERE level = 'campaign' AND report_date BETWEEN %s AND %s",
			array( $from, $to )
		);
		$opt = new BidOptimizer( array(
			'target_acos'        => $this->settings->float( 'suite_ads_target_acos' ),
			'min_clicks'         => $this->settings->int( 'suite_ads_min_clicks' ),
			'max_step_pct'       => $this->settings->float( 'suite_ads_max_step_pct' ),
			'min_bid'            => $this->settings->float( 'suite_ads_min_bid' ),
			'max_bid'            => $this->settings->float( 'suite_ads_max_bid' ),
			'raise_low_impr'     => $this->settings->bool( 'suite_ads_raise_low_impr' ),
			'neg_min_clicks'     => $this->settings->int( 'suite_ads_neg_min_clicks' ),
			'harvest_min_orders' => $this->settings->int( 'suite_ads_harvest_min_orders' ),
			'avg_order_value'    => $aov,
		) );

		$targets = Db::rows(
			"SELECT t.target_id, t.kind, t.campaign_id, t.ad_group_id, t.keyword_text AS label, t.state, t.bid,
			        COALESCE(SUM(d.impressions),0) AS impressions, COALESCE(SUM(d.clicks),0) AS clicks,
			        COALESCE(SUM(d.cost),0) AS cost, COALESCE(SUM(d.sales),0) AS sales, COALESCE(SUM(d.orders),0) AS orders
			 FROM {t:ads_targets} t
			 LEFT JOIN {t:ads_daily} d ON d.target_id = t.target_id AND d.level = 'target' AND d.report_date BETWEEN %s AND %s
			 WHERE t.state = 'ENABLED' AND t.bid IS NOT NULL
			 GROUP BY t.target_id, t.kind, t.campaign_id, t.ad_group_id, t.keyword_text, t.state, t.bid",
			array( $from, $to )
		);
		$targets = array_map( static fn( $r ) => array(
			'target_id' => (string) $r['target_id'], 'kind' => (string) $r['kind'], 'campaign_id' => (string) $r['campaign_id'],
			'ad_group_id' => (string) $r['ad_group_id'], 'label' => (string) $r['label'], 'state' => (string) $r['state'],
			'bid' => (float) $r['bid'], 'impressions' => (int) $r['impressions'], 'clicks' => (int) $r['clicks'],
			'cost' => (float) $r['cost'], 'sales' => (float) $r['sales'], 'orders' => (int) $r['orders'],
		), $targets );

		$terms = Db::rows(
			"SELECT search_term, campaign_id, ad_group_id, MAX(keyword_text) AS keyword_text, MAX(match_type) AS match_type,
			        SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(cost) AS cost, SUM(sales) AS sales, SUM(orders) AS orders
			 FROM {t:ads_search_terms} WHERE report_date BETWEEN %s AND %s
			 GROUP BY search_term, campaign_id, ad_group_id",
			array( $from, $to )
		);
		$exact = array();
		foreach ( Db::rows( "SELECT keyword_text FROM {t:ads_targets} WHERE kind = 'keyword' AND match_type = 'EXACT' AND state <> 'ARCHIVED'" ) as $k ) {
			$exact[ strtolower( (string) $k['keyword_text'] ) ] = true;
		}
		$neg = array();
		foreach ( Db::rows( "SELECT ad_group_id, entity_id FROM {t:ads_actions} WHERE kind = 'negative' AND status = 'applied'" ) as $k ) {
			$neg[ $k['ad_group_id'] . '|' . strtolower( (string) $k['entity_id'] ) ] = true;
		}

		$campaigns = Db::rows(
			"SELECT c.campaign_id, c.name, c.state, c.daily_budget,
			        COUNT(DISTINCT d.report_date) AS days, COALESCE(SUM(d.cost),0) AS cost, COALESCE(SUM(d.sales),0) AS sales
			 FROM {t:ads_campaigns} c
			 LEFT JOIN {t:ads_daily} d ON d.campaign_id = c.campaign_id AND d.level = 'campaign' AND d.report_date BETWEEN %s AND %s
			 GROUP BY c.campaign_id, c.name, c.state, c.daily_budget",
			array( gmdate( 'Y-m-d', strtotime( $today . ' -9 days' ) ), $to )
		);

		$plan = array_merge(
			$opt->bids( $targets ),
			$opt->search_terms(
				array_map( static fn( $r ) => array_merge( $r, array(
					'impressions' => (int) $r['impressions'], 'clicks' => (int) $r['clicks'], 'cost' => (float) $r['cost'],
					'sales' => (float) $r['sales'], 'orders' => (int) $r['orders'],
				) ), $terms ),
				$exact, $neg,
				$this->settings->string( 'suite_ads_harvest_campaign' ),
				$this->settings->string( 'suite_ads_harvest_ad_group' )
			),
			$opt->budgets( array_map( static fn( $r ) => array(
				'campaign_id' => (string) $r['campaign_id'], 'name' => (string) $r['name'], 'state' => (string) $r['state'],
				'daily_budget' => (float) $r['daily_budget'], 'days' => (int) $r['days'], 'cost' => (float) $r['cost'], 'sales' => (float) $r['sales'],
			), $campaigns ) )
		);

		Db::exec( "UPDATE {t:ads_actions} SET status = 'superseded' WHERE status = 'planned'" );
		$demo = (int) Db::var( 'SELECT COUNT(*) FROM {t:ads_targets} WHERE is_demo = 1' ) > 0 ? 1 : 0;
		$counts = array( 'bids' => 0, 'terms' => 0, 'budgets' => 0 );
		foreach ( $plan as $a ) {
			Db::insert( 'ads_actions', array(
				'profile_id'  => $this->profile(),
				'kind'        => $a['kind'],
				'entity_id'   => $a['entity_id'],
				'campaign_id' => $a['campaign_id'],
				'ad_group_id' => $a['ad_group_id'],
				'label'       => mb_substr( $a['label'], 0, 255 ),
				'old_value'   => $a['old_value'],
				'new_value'   => $a['new_value'],
				'reason'      => $a['reason'],
				'payload'     => wp_json_encode( $a['payload'] ),
				'status'      => 'planned',
				'created_at'  => Db::now(),
				'is_demo'     => $demo,
			) );
			$key = match ( $a['kind'] ) {
				'bid', 'pause' => 'bids',
				'budget'       => 'budgets',
				default        => 'terms',
			};
			$counts[ $key ]++;
		}
		if ( $this->settings->bool( 'suite_ads_auto_apply' ) && $this->ads->is_ready() ) {
			$ids = array_map( 'intval', array_column( Db::rows( "SELECT id FROM {t:ads_actions} WHERE status = 'planned' AND kind IN ('bid','negative') AND is_demo = 0" ), 'id' ) );
			if ( $ids ) {
				$this->apply( $ids );
			}
		}
		return $counts;
	}

	/**
	 * Push planned actions to Amazon. Demo actions are marked applied
	 * without network calls.
	 *
	 * @param int[] $ids
	 * @return array{applied:int, failed:int}
	 */
	public function apply( array $ids ): array {
		$ids = array_values( array_filter( array_map( 'intval', $ids ) ) );
		$res = array( 'applied' => 0, 'failed' => 0 );
		if ( ! $ids ) {
			return $res;
		}
		$rows = Db::rows( 'SELECT * FROM {t:ads_actions} WHERE status = %s AND id IN (' . Db::in( $ids, '%d' ) . ')', array_merge( array( 'planned' ), $ids ) );
		foreach ( $rows as $a ) {
			try {
				if ( ! (int) $a['is_demo'] ) {
					$this->push( $a );
				}
				Db::update( 'ads_actions', array( 'status' => 'applied', 'applied_at' => Db::now(), 'error' => null ), array( 'id' => (int) $a['id'] ) );
				$this->reflect_locally( $a );
				$res['applied']++;
			} catch ( \Throwable $e ) {
				Db::update( 'ads_actions', array( 'status' => 'failed', 'error' => mb_substr( $e->getMessage(), 0, 500 ) ), array( 'id' => (int) $a['id'] ) );
				$res['failed']++;
			}
		}
		return $res;
	}

	public function dismiss( array $ids ): int {
		$ids = array_values( array_filter( array_map( 'intval', $ids ) ) );
		if ( ! $ids ) {
			return 0;
		}
		return Db::exec( "UPDATE {t:ads_actions} SET status = 'dismissed' WHERE status = 'planned' AND id IN (" . Db::in( $ids, '%d' ) . ')', $ids );
	}

	private function push( array $a ): void {
		$payload = json_decode( (string) $a['payload'], true ) ?: array();
		$errors  = static function ( array $resp, string $key ): void {
			$err = $resp[ $key ]['error'] ?? array();
			if ( ! empty( $err ) ) {
				$first = $err[0]['errors'][0]['errorValue'] ?? $err[0] ?? array();
				throw new \RuntimeException( 'Amazon rejected: ' . wp_json_encode( $first ) );
			}
		};
		switch ( $a['kind'] ) {
			case 'bid':
			case 'pause':
				$upd = 'pause' === $a['kind'] ? array( 'state' => 'PAUSED' ) : array( 'bid' => (float) $a['new_value'] );
				if ( 'target' === ( $payload['target_kind'] ?? 'keyword' ) ) {
					$errors( $this->ads->update_targets( array( array( 'targetId' => (string) $a['entity_id'] ) + $upd ) ), 'targetingClauses' );
				} else {
					$errors( $this->ads->update_keywords( array( array( 'keywordId' => (string) $a['entity_id'] ) + $upd ) ), 'keywords' );
				}
				break;
			case 'negative':
				$errors( $this->ads->create_negative_keywords( array( array(
					'campaignId' => (string) $a['campaign_id'], 'adGroupId' => (string) $a['ad_group_id'],
					'keywordText' => (string) $a['entity_id'], 'matchType' => 'NEGATIVE_EXACT', 'state' => 'ENABLED',
				) ) ), 'negativeKeywords' );
				break;
			case 'harvest':
				if ( '' === (string) $a['ad_group_id'] ) {
					throw new \RuntimeException( 'Set a harvest destination ad group in Suite settings first.' );
				}
				$errors( $this->ads->create_keywords( array( array(
					'campaignId' => (string) $a['campaign_id'], 'adGroupId' => (string) $a['ad_group_id'],
					'keywordText' => (string) $a['entity_id'], 'matchType' => 'EXACT', 'state' => 'ENABLED',
					'bid' => (float) ( $payload['bid'] ?? 0.5 ),
				) ) ), 'keywords' );
				// Prevent the source (auto/broad) ad group from cannibalising the new exact keyword.
				if ( ! empty( $payload['source_ad_group_id'] ) && $payload['source_ad_group_id'] !== $a['ad_group_id'] ) {
					$this->ads->create_negative_keywords( array( array(
						'campaignId' => (string) $payload['source_campaign_id'], 'adGroupId' => (string) $payload['source_ad_group_id'],
						'keywordText' => (string) $a['entity_id'], 'matchType' => 'NEGATIVE_EXACT', 'state' => 'ENABLED',
					) ) );
				}
				break;
			case 'budget':
				$errors( $this->ads->update_campaigns( array( array(
					'campaignId' => (string) $a['campaign_id'],
					'budget'     => array( 'budget' => (float) $a['new_value'], 'budgetType' => 'DAILY' ),
				) ) ), 'campaigns' );
				break;
			default:
				throw new \RuntimeException( 'This action type must be applied manually in Campaign Manager (ASIN targeting).' );
		}
	}

	/** Mirror an applied change into the local tables so the UI is consistent before the next sync. */
	private function reflect_locally( array $a ): void {
		match ( $a['kind'] ) {
			'bid'    => Db::update( 'ads_targets', array( 'bid' => (float) $a['new_value'] ), array( 'target_id' => (string) $a['entity_id'] ) ),
			'pause'  => Db::update( 'ads_targets', array( 'state' => 'PAUSED' ), array( 'target_id' => (string) $a['entity_id'] ) ),
			'budget' => Db::update( 'ads_campaigns', array( 'daily_budget' => (float) $a['new_value'] ), array( 'campaign_id' => (string) $a['campaign_id'] ) ),
			default  => 0,
		};
	}
}
