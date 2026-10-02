<?php
/**
 * KeywordService — keyword tracking, research and share-of-search.
 *
 * Data sources (all first-party, no scraping):
 *   - Brand Analytics Search Query Performance (weekly): per ASIN×query
 *     search volume, impression/click/cart/purchase share — this is the
 *     data Helium 10 "Keyword Tracker" approximates with scraping.
 *   - Ads API keyword recommendations: keyword ideas for your ASINs with
 *     suggested bids (Cerebro/Magnet-style discovery).
 *   - Your own search-term report: terms that already convert.
 *
 * Note: Amazon exposes no official organic *rank position* API. Share of
 * impressions/clicks/purchases from SQP is the compliant equivalent and is
 * what the tracker charts.
 *
 * @package SevenGum\Commerce\Suite\Keywords
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Keywords;

use SevenGum\Commerce\Suite\Ads\AdsClient;
use SevenGum\Commerce\Suite\Support\Db;

defined( 'ABSPATH' ) || exit;

final class KeywordService {

	public function __construct( private AdsClient $ads ) {}

	public function add( string $market, string $asin, array $keywords, string $source = 'manual', int $priority = 2 ): int {
		$n = 0;
		foreach ( $keywords as $kw ) {
			$kw = mb_substr( trim( mb_strtolower( sanitize_text_field( (string) $kw ) ) ), 0, 190 );
			if ( '' === $kw ) {
				continue;
			}
			if ( Db::upsert( 'keywords', array(
				'market' => $market, 'asin' => strtoupper( $asin ), 'keyword' => $kw, 'priority' => max( 1, min( 3, $priority ) ),
				'source' => $source, 'created_at' => Db::now(), 'is_demo' => 0,
			), array( 'created_at', 'source' ) ) ) {
				$n++;
			}
		}
		return $n;
	}

	public function delete( int $id ): bool {
		return Db::exec( 'DELETE FROM {t:keywords} WHERE id = %d', array( $id ) ) > 0;
	}

	/** Tracked keywords with latest + previous week SQP metrics. */
	public function tracked( string $market, string $asin = '' ): array {
		$args = array( $market );
		$where = 'k.market = %s';
		if ( '' !== $asin ) {
			$where .= ' AND k.asin = %s';
			$args[] = $asin;
		}
		$rows = Db::rows( "SELECT k.* FROM {t:keywords} k WHERE {$where} ORDER BY k.priority ASC, k.keyword ASC", $args );
		if ( ! $rows ) {
			return array();
		}
		$weeks = array_column( Db::rows( 'SELECT DISTINCT period_start FROM {t:keyword_metrics} WHERE market = %s ORDER BY period_start DESC LIMIT 8', array( $market ) ), 'period_start' );
		$metrics = array();
		if ( $weeks ) {
			foreach ( Db::rows( 'SELECT * FROM {t:keyword_metrics} WHERE market = %s AND period_start IN (' . Db::in( $weeks ) . ')', array_merge( array( $market ), $weeks ) ) as $m ) {
				$metrics[ $m['asin'] . '|' . $m['keyword'] ][ $m['period_start'] ] = $m;
			}
		}
		foreach ( $rows as &$r ) {
			$hist = $metrics[ $r['asin'] . '|' . $r['keyword'] ] ?? array();
			$cur  = isset( $weeks[0] ) ? ( $hist[ $weeks[0] ] ?? null ) : null;
			$prev = isset( $weeks[1] ) ? ( $hist[ $weeks[1] ] ?? null ) : null;
			$r['volume']          = null !== $cur ? (int) $cur['query_volume'] : null;
			$r['impr_share']      = self::share( $cur, 'impressions' );
			$r['click_share']     = self::share( $cur, 'clicks' );
			$r['purchase_share']  = self::share( $cur, 'purchases' );
			$r['purchase_share_prev'] = self::share( $prev, 'purchases' );
			$r['ctr']             = null !== $cur && (int) $cur['impressions_asin'] > 0 ? round( (int) $cur['clicks_asin'] / (int) $cur['impressions_asin'] * 100, 2 ) : null;
			$r['cvr']             = null !== $cur && (int) $cur['clicks_asin'] > 0 ? round( (int) $cur['purchases_asin'] / (int) $cur['clicks_asin'] * 100, 2 ) : null;
			$r['trend']           = array();
			foreach ( array_reverse( $weeks ) as $w ) {
				$r['trend'][] = self::share( $hist[ $w ] ?? null, 'impressions' ) ?? 0;
			}
			$r['week'] = $weeks[0] ?? null;
		}
		return $rows;
	}

	/** Every query Brand Analytics returned for the ASIN (not only tracked ones). */
	public function sqp_queries( string $market, string $asin ): array {
		$week = (string) Db::var( 'SELECT MAX(period_start) FROM {t:keyword_metrics} WHERE market = %s AND asin = %s', array( $market, $asin ) );
		if ( '' === $week ) {
			return array();
		}
		$rows = Db::rows(
			'SELECT * FROM {t:keyword_metrics} WHERE market = %s AND asin = %s AND period_start = %s ORDER BY query_volume DESC LIMIT 200',
			array( $market, $asin, $week )
		);
		foreach ( $rows as &$r ) {
			$r['impr_share']     = self::share( $r, 'impressions' );
			$r['click_share']    = self::share( $r, 'clicks' );
			$r['purchase_share'] = self::share( $r, 'purchases' );
		}
		return $rows;
	}

	/** Keyword ideas for ASINs via Ads API, merged with converting search terms. */
	public function research( array $asins, string $locale = 'en_US' ): array {
		$ideas = array();
		if ( $this->ads->is_ready() ) {
			$res = $this->ads->keyword_recommendations( $asins, $locale );
			$list = $res['keywordTargetList'] ?? $res['recommendations'] ?? $res['keywords'] ?? array();
			foreach ( (array) $list as $k ) {
				$kw = mb_strtolower( (string) ( $k['keyword'] ?? $k['keywordText'] ?? '' ) );
				if ( '' === $kw ) {
					continue;
				}
				$bid = null;
				foreach ( (array) ( $k['bidInfo'] ?? array() ) as $b ) {
					if ( 'EXACT' === ( $b['matchType'] ?? '' ) ) {
						$bid = $b['suggestedBid']['rangeMedian'] ?? $b['bid'] ?? null;
					}
				}
				$ideas[ $kw ] = array(
					'keyword'        => $kw,
					'source'         => 'amazon_ads',
					// Recommendation bids arrive in minor units (cents) for most locales; normalise to currency.
					'suggested_bid'  => null !== $bid ? round( (float) $bid / ( (float) $bid >= 10 ? 100 : 1 ), 2 ) : null,
					'impression_rank'=> $k['searchTermImpressionRank'] ?? null,
					'impression_share' => $k['searchTermImpressionShare'] ?? null,
					'orders'         => null,
					'acos'           => null,
				);
			}
		}
		$terms = Db::rows(
			"SELECT search_term, SUM(clicks) AS clicks, SUM(orders) AS orders, SUM(cost) AS cost, SUM(sales) AS sales
			 FROM {t:ads_search_terms} WHERE report_date >= %s GROUP BY search_term HAVING SUM(orders) > 0 ORDER BY SUM(orders) DESC LIMIT 100",
			array( gmdate( 'Y-m-d', time() - 60 * DAY_IN_SECONDS ) )
		);
		foreach ( $terms as $t ) {
			$kw = mb_strtolower( (string) $t['search_term'] );
			$acos = (float) $t['sales'] > 0 ? round( (float) $t['cost'] / (float) $t['sales'] * 100, 1 ) : null;
			$ideas[ $kw ] = array_merge( $ideas[ $kw ] ?? array( 'keyword' => $kw, 'suggested_bid' => null, 'impression_rank' => null, 'impression_share' => null ), array(
				'source' => isset( $ideas[ $kw ] ) ? 'both' : 'your_ads',
				'orders' => (int) $t['orders'],
				'acos'   => $acos,
			) );
		}
		return array_values( $ideas );
	}

	private static function share( ?array $m, string $what ): ?float {
		if ( null === $m ) {
			return null;
		}
		$total = (int) $m[ $what . '_total' ];
		return $total > 0 ? round( (int) $m[ $what . '_asin' ] / $total * 100, 2 ) : null;
	}
}
