<?php
/**
 * SuiteController — REST API for the Amazon Suite app.
 *
 * Namespace: sg-commerce/v1/suite/*  ·  Capability: manage_options
 * Auth: cookie + `wp_rest` nonce (X-WP-Nonce), or application passwords.
 *
 * No endpoint ever returns a secret; settings expose presence flags only.
 *
 * @package SevenGum\Commerce\Suite\Rest
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Rest;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Automation\AlertDispatcher;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Suite\Ads\AdsClient;
use SevenGum\Commerce\Suite\Ads\AdsInsights;
use SevenGum\Commerce\Suite\Ads\AdsSync;
use SevenGum\Commerce\Suite\Demo\DemoSeeder;
use SevenGum\Commerce\Suite\Finance\FinanceSync;
use SevenGum\Commerce\Suite\Inventory\RestockPlanner;
use SevenGum\Commerce\Suite\Keywords\KeywordService;
use SevenGum\Commerce\Suite\Listings\ListingAuditor;
use SevenGum\Commerce\Suite\Monitor\ListingMonitor;
use SevenGum\Commerce\Suite\Orders\OrdersSync;
use SevenGum\Commerce\Suite\Profit\CostBook;
use SevenGum\Commerce\Suite\Profit\ProfitEngine;
use SevenGum\Commerce\Suite\Reimbursements\ReimbursementAuditor;
use SevenGum\Commerce\Suite\Reports\ReportPipeline;
use SevenGum\Commerce\Suite\Research\ProductResearch;
use SevenGum\Commerce\Suite\Reviews\ReviewRequester;
use SevenGum\Commerce\Suite\SuiteModule;
use SevenGum\Commerce\Suite\SuiteSettings;
use SevenGum\Commerce\Suite\Support\Db;
use SevenGum\Commerce\Suite\Support\SuiteTime;

defined( 'ABSPATH' ) || exit;

final class SuiteController {

	public const NS = 'sg-commerce/v1';

	public function __construct( private Container $c ) {}

	public function routes(): void {
		$r = array(
			// path => [methods, handler]
			'/suite/overview'                 => array( 'GET', 'overview' ),
			'/suite/profit'                   => array( 'GET', 'profit' ),
			'/suite/orders'                   => array( 'GET', 'orders' ),
			'/suite/costs'                    => array( 'GET,POST', 'costs' ),
			'/suite/expenses'                 => array( 'GET,POST', 'expenses' ),
			'/suite/expenses/(?P<id>\d+)'     => array( 'DELETE', 'expense_delete' ),
			'/suite/restock'                  => array( 'GET', 'restock' ),
			'/suite/inventory-health'         => array( 'GET', 'inventory_health' ),
			'/suite/ads/overview'             => array( 'GET', 'ads_overview' ),
			'/suite/ads/campaigns'            => array( 'GET', 'ads_campaigns' ),
			'/suite/ads/targets'              => array( 'GET', 'ads_targets' ),
			'/suite/ads/search-terms'         => array( 'GET', 'ads_search_terms' ),
			'/suite/ads/actions'              => array( 'GET', 'ads_actions' ),
			'/suite/ads/optimize'             => array( 'POST', 'ads_optimize' ),
			'/suite/ads/apply'                => array( 'POST', 'ads_apply' ),
			'/suite/ads/dismiss'              => array( 'POST', 'ads_dismiss' ),
			'/suite/ads/sync'                 => array( 'POST', 'ads_sync' ),
			'/suite/ads/test'                 => array( 'POST', 'ads_test' ),
			'/suite/keywords'                 => array( 'GET,POST', 'keywords' ),
			'/suite/keywords/(?P<id>\d+)'     => array( 'DELETE', 'keyword_delete' ),
			'/suite/keywords/research'        => array( 'POST', 'keyword_research' ),
			'/suite/keywords/queries'         => array( 'GET', 'keyword_queries' ),
			'/suite/listings'                 => array( 'GET', 'listings' ),
			'/suite/listings/audit'           => array( 'POST', 'listing_audit' ),
			'/suite/listings/ai'              => array( 'POST', 'listing_ai' ),
			'/suite/monitor'                  => array( 'GET', 'monitor' ),
			'/suite/monitor/history'          => array( 'GET', 'monitor_history' ),
			'/suite/monitor/run'              => array( 'POST', 'monitor_run' ),
			'/suite/reviews'                  => array( 'GET', 'reviews' ),
			'/suite/reviews/run'              => array( 'POST', 'reviews_run' ),
			'/suite/reimbursements'           => array( 'GET', 'reimbursements' ),
			'/suite/reimbursements/scan'      => array( 'POST', 'reimbursements_scan' ),
			'/suite/reimbursements/(?P<id>\d+)' => array( 'POST', 'reimbursement_update' ),
			'/suite/research/search'          => array( 'POST', 'research_search' ),
			'/suite/research/fees'            => array( 'POST', 'research_fees' ),
			'/suite/research/calc'            => array( 'POST', 'research_calc' ),
			'/suite/traffic'                  => array( 'GET', 'traffic' ),
			'/suite/returns'                  => array( 'GET', 'returns' ),
			'/suite/feedback'                 => array( 'GET', 'feedback' ),
			'/suite/alerts'                   => array( 'GET,POST', 'alerts' ),
			'/suite/reports'                  => array( 'GET,POST', 'reports' ),
			'/suite/reports/poll'             => array( 'POST', 'reports_poll' ),
			'/suite/sync'                     => array( 'POST', 'sync' ),
			'/suite/settings'                 => array( 'GET,POST', 'settings' ),
			'/suite/demo'                     => array( 'POST,DELETE', 'demo' ),
		);
		foreach ( $r as $path => [ $methods, $handler ] ) {
			register_rest_route( self::NS, $path, array(
				'methods'             => $methods,
				'permission_callback' => static fn() => current_user_can( 'manage_options' ),
				'callback'            => function ( \WP_REST_Request $req ) use ( $handler ) {
					try {
						return rest_ensure_response( $this->{$handler}( $req ) );
					} catch ( \Throwable $e ) {
						return new \WP_Error( 'sg_suite_error', $e->getMessage(), array( 'status' => $e instanceof \InvalidArgumentException ? 400 : 500 ) );
					}
				},
			) );
		}
	}

	/* ------------------------------------------------------------------ */
	/* Helpers                                                            */
	/* ------------------------------------------------------------------ */

	private function market( \WP_REST_Request $req ): string {
		$mp = $this->c->get( Marketplaces::class );
		$m  = strtoupper( (string) ( $req['market'] ?? '' ) );
		return $mp->exists( $m ) ? $m : $mp->primary();
	}

	/** @return array{0:string,1:string} */
	private function range( \WP_REST_Request $req, string $market, int $default_days = 30 ): array {
		$today = SuiteTime::today( $market );
		$to    = SuiteTime::ymd( $req['to'] ?? '', $today );
		$from  = SuiteTime::ymd( $req['from'] ?? '', SuiteTime::shift( $to, -( $default_days - 1 ) ) );
		if ( $from > $to ) {
			[ $from, $to ] = array( $to, $from );
		}
		if ( SuiteTime::days_between( $from, $to ) > 400 ) {
			$from = SuiteTime::shift( $to, -399 );
		}
		return array( $from, $to );
	}

	private function json( \WP_REST_Request $req ): array {
		$p = $req->get_json_params();
		return is_array( $p ) ? $p : $req->get_params();
	}

	/* ------------------------------------------------------------------ */
	/* Dashboard & profit                                                 */
	/* ------------------------------------------------------------------ */

	public function overview( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		$today  = SuiteTime::today( $market );
		$profit = $this->c->get( ProfitEngine::class );
		$pnl30  = $profit->pnl( $market, SuiteTime::shift( $today, -29 ), $today );
		$restock = $this->c->get( RestockPlanner::class )->build( $market );
		$board  = $this->c->get( ListingMonitor::class )->board();
		$mine   = array_filter( $board, static fn( $r ) => (int) $r['is_mine'] );
		$bb_won = array_filter( $mine, static fn( $r ) => (int) $r['buybox_is_mine'] );
		$listing_scores = Db::rows( 'SELECT score FROM {t:listing_audits} WHERE market = %s', array( $market ) );
		$reimb  = Db::row( "SELECT COUNT(*) AS n, COALESCE(SUM(est_amount),0) AS v FROM {t:reimb_cases} WHERE status = 'open'" );
		$ads    = $this->c->get( AdsInsights::class )->overview( SuiteTime::shift( $today, -29 ), $today );
		$traffic = Db::row(
			"SELECT COALESCE(SUM(sessions),0) AS sessions, COALESCE(SUM(units),0) AS units FROM {t:traffic_daily}
			 WHERE market = %s AND asin = '' AND report_date BETWEEN %s AND %s",
			array( $market, SuiteTime::shift( $today, -29 ), $today )
		);
		return array(
			'market'      => $market,
			'currency'    => $pnl30['currency'],
			'periods'     => $profit->dashboard( $market ),
			'series'      => $pnl30['series'],
			'top_skus'    => array_slice( $pnl30['skus'], 0, 8 ),
			'totals_30'   => $pnl30['totals'],
			'restock'     => $restock['summary'] + array( 'urgent' => array_slice( array_values( array_filter( $restock['rows'], static fn( $r ) => in_array( $r['status'], array( 'out_of_stock', 'critical', 'reorder_now' ), true ) ) ), 0, 6 ) ),
			'buybox'      => array( 'asins' => count( $mine ), 'winning' => count( $bb_won ), 'pct' => $mine ? round( count( $bb_won ) / count( $mine ) * 100, 1 ) : null, 'hijacked' => count( array_filter( $mine, static fn( $r ) => (int) $r['other_sellers'] > 0 ) ) ),
			'listings'    => array( 'audited' => count( $listing_scores ), 'avg_score' => $listing_scores ? (int) round( array_sum( array_column( $listing_scores, 'score' ) ) / count( $listing_scores ) ) : null ),
			'reimburse'   => array( 'open' => (int) ( $reimb['n'] ?? 0 ), 'value' => round( (float) ( $reimb['v'] ?? 0 ), 2 ) ),
			'ads'         => $ads['totals'],
			'conversion'  => (int) ( $traffic['sessions'] ?? 0 ) > 0 ? round( (int) $traffic['units'] / (int) $traffic['sessions'] * 100, 2 ) : null,
			'sessions'    => (int) ( $traffic['sessions'] ?? 0 ),
			'reviews'     => $this->c->get( ReviewRequester::class )->stats( 30 )['by_status'],
			'alerts'      => AlertDispatcher::recent( 8 ),
			'unread'      => AlertDispatcher::unread_count(),
			'connected'   => $this->c->get( AmazonClient::class )->has_credentials(),
			'ads_ready'   => $this->c->get( AdsClient::class )->is_ready(),
			'demo'        => DemoSeeder::active(),
			'missing_costs' => $pnl30['missing_costs'],
		);
	}

	public function profit( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		[ $from, $to ] = $this->range( $req, $market );
		$out  = $this->c->get( ProfitEngine::class )->pnl( $market, $from, $to );
		$days = SuiteTime::days_between( $from, $to );
		$prev = $this->c->get( ProfitEngine::class )->pnl( $market, SuiteTime::shift( $from, -$days ), SuiteTime::shift( $from, -1 ), false );
		$out['previous'] = $prev['totals'];
		return $out;
	}

	public function orders( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		[ $from, $to ] = $this->range( $req, $market, 7 );
		$args  = array( $market, $from, $to );
		$where = 'o.market = %s AND o.local_date BETWEEN %s AND %s';
		$q = trim( (string) ( $req['q'] ?? '' ) );
		if ( '' !== $q ) {
			$where .= ' AND (o.amazon_order_id LIKE %s OR EXISTS (SELECT 1 FROM {t:order_items} x WHERE x.amazon_order_id = o.amazon_order_id AND (x.sku LIKE %s OR x.asin LIKE %s)))';
			$like = '%' . $GLOBALS['wpdb']->esc_like( $q ) . '%';
			array_push( $args, $like, $like, $like );
		}
		$status = (string) ( $req['status'] ?? '' );
		if ( '' !== $status ) {
			$where .= ' AND o.status = %s';
			$args[] = $status;
		}
		$orders = Db::rows( "SELECT o.* FROM {t:orders} o WHERE {$where} ORDER BY o.purchase_date DESC LIMIT 500", $args );
		$ids = array_column( $orders, 'amazon_order_id' );
		$items = array();
		$fees  = array();
		if ( $ids ) {
			foreach ( Db::rows( 'SELECT * FROM {t:order_items} WHERE amazon_order_id IN (' . Db::in( $ids ) . ')', $ids ) as $it ) {
				$items[ $it['amazon_order_id'] ][] = $it;
			}
			foreach ( Db::rows( "SELECT amazon_order_id, category, SUM(amount) AS amt FROM {t:fin_events} WHERE amazon_order_id IN (" . Db::in( $ids ) . ') GROUP BY amazon_order_id, category', $ids ) as $f ) {
				$fees[ $f['amazon_order_id'] ][ $f['category'] ] = (float) $f['amt'];
			}
		}
		$costs = $this->c->get( CostBook::class );
		$unit_fee = $this->c->get( ProfitEngine::class )->fee_per_unit( $market, $to );
		foreach ( $orders as &$o ) {
			$o['items'] = $items[ $o['amazon_order_id'] ] ?? array();
			$f = $fees[ $o['amazon_order_id'] ] ?? array();
			$sales = array_sum( array_map( static fn( $i ) => (float) $i['item_price'], $o['items'] ) );
			$promo = array_sum( array_map( static fn( $i ) => (float) $i['promo_discount'], $o['items'] ) );
			$cogs  = array_sum( array_map( static fn( $i ) => (int) $i['qty'] * $costs->landed( $market, (string) $i['sku'] ), $o['items'] ) );
			if ( isset( $f['fee'] ) ) {
				$fee = $f['fee'];
				$o['fees_estimated'] = false;
			} else {
				$fee = -array_sum( array_map( static fn( $i ) => isset( $unit_fee['sku'][ $i['sku'] ] ) ? $unit_fee['sku'][ $i['sku'] ] * (int) $i['qty'] : $unit_fee['ratio'] * (float) $i['item_price'], $o['items'] ) );
				$o['fees_estimated'] = true;
			}
			$o['sales']  = round( $sales, 2 );
			$o['fees']   = round( $fee, 2 );
			$o['refund'] = round( (float) ( $f['refund'] ?? 0 ), 2 );
			$o['cogs']   = round( $cogs, 2 );
			$o['profit'] = 'Canceled' === $o['status'] ? 0.0 : round( $sales - $promo + $fee + $o['refund'] - $cogs, 2 );
		}
		return array( 'from' => $from, 'to' => $to, 'orders' => $orders );
	}

	public function costs( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		$book   = $this->c->get( CostBook::class );
		if ( 'POST' === $req->get_method() ) {
			$rows = (array) ( $this->json( $req )['rows'] ?? array() );
			$n = 0;
			foreach ( $rows as $row ) {
				if ( ! empty( $row['sku'] ) && $book->save( $market, (string) $row['sku'], (array) $row ) ) {
					$n++;
				}
			}
			return array( 'saved' => $n );
		}
		return array( 'rows' => $book->all( $market ) );
	}

	public function expenses( \WP_REST_Request $req ): array {
		if ( 'POST' === $req->get_method() ) {
			$in = $this->json( $req );
			$label = sanitize_text_field( (string) ( $in['label'] ?? '' ) );
			if ( '' === $label ) {
				throw new \InvalidArgumentException( 'Label is required.' );
			}
			$id = Db::insert( 'expenses', array(
				'market'     => strtoupper( sanitize_text_field( (string) ( $in['market'] ?? '' ) ) ),
				'label'      => mb_substr( $label, 0, 128 ),
				'category'   => sanitize_key( (string) ( $in['category'] ?? 'other' ) ) ?: 'other',
				'amount'     => max( 0, (float) ( $in['amount'] ?? 0 ) ),
				'recurrence' => 'monthly' === ( $in['recurrence'] ?? '' ) ? 'monthly' : 'once',
				'start_date' => SuiteTime::ymd( $in['start_date'] ?? '', gmdate( 'Y-m-d' ) ),
				'end_date'   => ! empty( $in['end_date'] ) ? SuiteTime::ymd( $in['end_date'], gmdate( 'Y-m-d' ) ) : null,
				'sku'        => '',
				'created_at' => Db::now(),
			) );
			return array( 'id' => $id );
		}
		return array( 'rows' => Db::rows( 'SELECT * FROM {t:expenses} ORDER BY start_date DESC' ) );
	}

	public function expense_delete( \WP_REST_Request $req ): array {
		return array( 'deleted' => Db::exec( 'DELETE FROM {t:expenses} WHERE id = %d', array( (int) $req['id'] ) ) );
	}

	/* ------------------------------------------------------------------ */
	/* Inventory                                                          */
	/* ------------------------------------------------------------------ */

	public function restock( \WP_REST_Request $req ): array {
		return $this->c->get( RestockPlanner::class )->build( $this->market( $req ) );
	}

	public function inventory_health( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		$snap = (string) Db::var( 'SELECT MAX(snapshot_date) FROM {t:inventory_health} WHERE market = %s', array( $market ) );
		return array(
			'snapshot' => $snap,
			'rows'     => '' === $snap ? array() : Db::rows( 'SELECT * FROM {t:inventory_health} WHERE market = %s AND snapshot_date = %s ORDER BY (age_181_270 + age_271_365 + age_365_plus) DESC, available DESC', array( $market, $snap ) ),
		);
	}

	/* ------------------------------------------------------------------ */
	/* PPC                                                                */
	/* ------------------------------------------------------------------ */

	public function ads_overview( \WP_REST_Request $req ): array {
		[ $from, $to ] = $this->range( $req, $this->market( $req ) );
		return $this->c->get( AdsInsights::class )->overview( $from, $to ) + array(
			'from' => $from, 'to' => $to,
			'ready' => $this->c->get( AdsClient::class )->is_ready(),
			'planned' => (int) Db::var( "SELECT COUNT(*) FROM {t:ads_actions} WHERE status = 'planned'" ),
		);
	}

	public function ads_campaigns( \WP_REST_Request $req ): array {
		[ $from, $to ] = $this->range( $req, $this->market( $req ) );
		return array( 'rows' => $this->c->get( AdsInsights::class )->campaigns( $from, $to ) );
	}

	public function ads_targets( \WP_REST_Request $req ): array {
		[ $from, $to ] = $this->range( $req, $this->market( $req ) );
		return array( 'rows' => $this->c->get( AdsInsights::class )->targets( $from, $to, sanitize_text_field( (string) ( $req['campaign'] ?? '' ) ) ) );
	}

	public function ads_search_terms( \WP_REST_Request $req ): array {
		[ $from, $to ] = $this->range( $req, $this->market( $req ) );
		return array( 'rows' => $this->c->get( AdsInsights::class )->search_terms( $from, $to ) );
	}

	public function ads_actions( \WP_REST_Request $req ): array {
		$i = $this->c->get( AdsInsights::class );
		return array( 'planned' => $i->actions( 'planned' ), 'history' => $i->history() );
	}

	public function ads_optimize(): array {
		return $this->c->get( AdsSync::class )->optimize();
	}

	public function ads_apply( \WP_REST_Request $req ): array {
		return $this->c->get( AdsSync::class )->apply( (array) ( $this->json( $req )['ids'] ?? array() ) );
	}

	public function ads_dismiss( \WP_REST_Request $req ): array {
		return array( 'dismissed' => $this->c->get( AdsSync::class )->dismiss( (array) ( $this->json( $req )['ids'] ?? array() ) ) );
	}

	public function ads_sync(): array {
		$sync = $this->c->get( AdsSync::class );
		$structure = $sync->sync_structure();
		$reports = $sync->request_reports( gmdate( 'Y-m-d', time() - 31 * DAY_IN_SECONDS ), gmdate( 'Y-m-d', time() - DAY_IN_SECONDS ) );
		return array( 'structure' => $structure, 'reports_requested' => count( $reports ) );
	}

	public function ads_test( \WP_REST_Request $req ): array {
		$in = $this->json( $req );
		if ( $in ) {
			$this->c->get( SuiteSettings::class )->save( $in );
		}
		return $this->c->get( AdsClient::class )->test();
	}

	/* ------------------------------------------------------------------ */
	/* Keywords & listings                                                */
	/* ------------------------------------------------------------------ */

	public function keywords( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		$svc = $this->c->get( KeywordService::class );
		if ( 'POST' === $req->get_method() ) {
			$in = $this->json( $req );
			$asin = strtoupper( sanitize_text_field( (string) ( $in['asin'] ?? '' ) ) );
			if ( 1 !== preg_match( '/^[A-Z0-9]{10}$/', $asin ) ) {
				throw new \InvalidArgumentException( 'A valid 10-character ASIN is required.' );
			}
			$list = is_array( $in['keywords'] ?? null ) ? $in['keywords'] : preg_split( '/[\r\n,]+/', (string) ( $in['keywords'] ?? '' ) );
			return array( 'added' => $svc->add( $market, $asin, (array) $list, 'manual', (int) ( $in['priority'] ?? 2 ) ) );
		}
		return array( 'rows' => $svc->tracked( $market, strtoupper( sanitize_text_field( (string) ( $req['asin'] ?? '' ) ) ) ), 'asins' => $this->own_asins( $market ) );
	}

	public function keyword_delete( \WP_REST_Request $req ): array {
		return array( 'deleted' => $this->c->get( KeywordService::class )->delete( (int) $req['id'] ) );
	}

	public function keyword_research( \WP_REST_Request $req ): array {
		$in = $this->json( $req );
		$asins = array_values( array_filter( array_map( static fn( $a ) => strtoupper( trim( (string) $a ) ), (array) ( $in['asins'] ?? array() ) ) ) );
		return array( 'rows' => $this->c->get( KeywordService::class )->research( $asins ) );
	}

	public function keyword_queries( \WP_REST_Request $req ): array {
		return array( 'rows' => $this->c->get( KeywordService::class )->sqp_queries( $this->market( $req ), strtoupper( sanitize_text_field( (string) ( $req['asin'] ?? '' ) ) ) ) );
	}

	public function listings( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		$rows = Db::rows( 'SELECT * FROM {t:listing_audits} WHERE market = %s ORDER BY score ASC', array( $market ) );
		foreach ( $rows as &$r ) {
			$r['findings'] = json_decode( (string) $r['findings'], true ) ?: array();
			$r['snapshot'] = json_decode( (string) $r['snapshot'], true ) ?: array();
		}
		return array( 'rows' => $rows, 'seller_id_set' => '' !== $this->c->get( SuiteSettings::class )->seller_id() );
	}

	public function listing_audit( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		$sku = sanitize_text_field( (string) ( $this->json( $req )['sku'] ?? '' ) );
		if ( '' === $sku ) {
			return array( 'audited' => $this->c->get( SuiteModule::class )->audit_batch( 30 ) );
		}
		$asin = (string) Db::var( 'SELECT asin FROM ' . $GLOBALS['wpdb']->prefix . 'sg_products WHERE market = %s AND sku = %s', array( $market, $sku ) );
		$kw = array_column( Db::rows( 'SELECT keyword FROM {t:keywords} WHERE market = %s AND asin = %s', array( $market, $asin ) ), 'keyword' );
		return $this->c->get( ListingAuditor::class )->audit( $market, $sku, $kw );
	}

	/** AI rewrite of title/bullets/backend using the configured AI provider and tracked keywords. */
	public function listing_ai( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		$sku = sanitize_text_field( (string) ( $this->json( $req )['sku'] ?? '' ) );
		$row = Db::row( 'SELECT * FROM {t:listing_audits} WHERE market = %s AND sku = %s', array( $market, $sku ) );
		if ( null === $row ) {
			throw new \InvalidArgumentException( 'Audit the listing first.' );
		}
		$snap = json_decode( (string) $row['snapshot'], true ) ?: array();
		$kw   = array_column( Db::rows( 'SELECT keyword FROM {t:keywords} WHERE market = %s AND asin = %s ORDER BY priority', array( $market, (string) $row['asin'] ) ), 'keyword' );
		$voice = (string) $this->c->get( \SevenGum\Commerce\Database\Repositories\SettingsRepository::class )->get( 'ai_brand_voice', 'modern, clean, playful but confident' );
		$prompt = "You are an Amazon listing copywriter. Brand voice: {$voice}.\n"
			. "Rewrite this Amazon listing to maximise conversion and search indexing while following Amazon policy:\n"
			. "- Title: start with the brand, max 200 characters, no word more than twice, no !\$?_{}^ characters, no promotional claims.\n"
			. "- Exactly 5 bullet points, each 150-250 characters, starting with a short CAPITALISED benefit phrase.\n"
			. "- Backend search terms: max 249 bytes, space separated, no commas, no brand names, no words already in the title.\n"
			. '- Naturally include these target keywords: ' . implode( ', ', array_slice( $kw, 0, 15 ) ) . "\n\n"
			. 'Current title: ' . ( $snap['title'] ?? '' ) . "\n"
			. "Current bullets:\n- " . implode( "\n- ", (array) ( $snap['bullets'] ?? array() ) ) . "\n\n"
			. "Respond ONLY with JSON: {\"title\": \"...\", \"bullets\": [\"...\"], \"backend\": \"...\"}";
		$provider = $this->c->get( \SevenGum\Commerce\AI\ProviderInterface::class );
		$res  = $provider->generate( $prompt, array( 'temperature' => 0.6, 'max_tokens' => 1200 ) );
		$text = (string) ( $res['text'] ?? '' );
		$json = null;
		if ( preg_match( '/\{.*\}/s', $text, $m ) ) {
			$json = json_decode( $m[0], true );
		}
		if ( ! is_array( $json ) ) {
			throw new \RuntimeException( 'The AI provider did not return valid JSON. Raw output: ' . mb_substr( $text, 0, 300 ) );
		}
		$draft = array_merge( $snap, array(
			'title'   => (string) ( $json['title'] ?? '' ),
			'bullets' => array_values( array_map( 'strval', (array) ( $json['bullets'] ?? array() ) ) ),
			'backend' => (string) ( $json['backend'] ?? '' ),
		) );
		return array( 'draft' => $draft, 'score' => ListingAuditor::score( $draft, $kw ), 'provider' => $res['provider'] ?? '', 'model' => $res['model'] ?? '' );
	}

	/* ------------------------------------------------------------------ */
	/* Monitor, reviews, reimbursements                                   */
	/* ------------------------------------------------------------------ */

	public function monitor(): array {
		$mon = $this->c->get( ListingMonitor::class );
		return array(
			'rows'     => $mon->board(),
			'hijacks'  => Db::rows( "SELECT s.*, (SELECT COUNT(*) FROM {t:offer_sellers} x WHERE x.asin = s.asin AND x.is_me = 1) AS mine FROM {t:offer_sellers} s WHERE s.is_me = 0 AND s.active = 1 AND EXISTS (SELECT 1 FROM {t:offer_sellers} m WHERE m.asin = s.asin AND m.market = s.market AND m.is_me = 1) ORDER BY s.first_seen DESC" ),
			'watching' => count( $mon->watchlist() ),
		);
	}

	public function monitor_history( \WP_REST_Request $req ): array {
		$mon = $this->c->get( ListingMonitor::class );
		$market = $this->market( $req );
		$asin = strtoupper( sanitize_text_field( (string) ( $req['asin'] ?? '' ) ) );
		return array( 'history' => $mon->history( $market, $asin, max( 7, min( 365, (int) ( $req['days'] ?? 90 ) ) ) ), 'sellers' => $mon->sellers( $market, $asin ) );
	}

	public function monitor_run(): array {
		return $this->c->get( ListingMonitor::class )->run();
	}

	public function reviews(): array {
		return $this->c->get( ReviewRequester::class )->stats( 30 ) + array( 'enabled' => $this->c->get( SuiteSettings::class )->bool( 'suite_reviews_enabled' ) );
	}

	public function reviews_run(): array {
		return $this->c->get( ReviewRequester::class )->run();
	}

	public function reimbursements( \WP_REST_Request $req ): array {
		$status = sanitize_key( (string) ( $req['status'] ?? 'open' ) );
		$rows = 'all' === $status
			? Db::rows( 'SELECT * FROM {t:reimb_cases} ORDER BY est_amount DESC LIMIT 500' )
			: Db::rows( 'SELECT * FROM {t:reimb_cases} WHERE status = %s ORDER BY est_amount DESC LIMIT 500', array( $status ) );
		foreach ( $rows as &$r ) {
			$r['evidence'] = json_decode( (string) $r['evidence'], true ) ?: array();
		}
		return array(
			'rows'     => $rows,
			'summary'  => $this->c->get( ReimbursementAuditor::class )->summary(),
			'recent'   => Db::rows( 'SELECT * FROM {t:reimbursements} ORDER BY approval_date DESC LIMIT 100' ),
		);
	}

	public function reimbursements_scan(): array {
		return $this->c->get( ReimbursementAuditor::class )->scan();
	}

	public function reimbursement_update( \WP_REST_Request $req ): array {
		return array( 'updated' => $this->c->get( ReimbursementAuditor::class )->update_case( (int) $req['id'], $this->json( $req ) ) );
	}

	/* ------------------------------------------------------------------ */
	/* Research                                                           */
	/* ------------------------------------------------------------------ */

	public function research_search( \WP_REST_Request $req ): array {
		$kw = sanitize_text_field( (string) ( $this->json( $req )['keywords'] ?? '' ) );
		if ( '' === $kw ) {
			throw new \InvalidArgumentException( 'Enter keywords to search.' );
		}
		return $this->c->get( ProductResearch::class )->search( $kw, $this->market( $req ) );
	}

	public function research_fees( \WP_REST_Request $req ): array {
		$in = $this->json( $req );
		$asin = strtoupper( sanitize_text_field( (string) ( $in['asin'] ?? '' ) ) );
		if ( 1 !== preg_match( '/^[A-Z0-9]{10}$/', $asin ) ) {
			throw new \InvalidArgumentException( 'A valid ASIN is required.' );
		}
		return $this->c->get( ProductResearch::class )->fees( $asin, (float) ( $in['price'] ?? 0 ), $this->market( $req ) );
	}

	public function research_calc( \WP_REST_Request $req ): array {
		return ProductResearch::calc( array_map( 'floatval', array_intersect_key( $this->json( $req ), array_flip( array(
			'price', 'unit_cost', 'inbound', 'referral_pct', 'referral', 'fba_fee', 'storage_per_unit', 'tacos_pct', 'return_pct', 'cvr_pct',
		) ) ) ) );
	}

	/* ------------------------------------------------------------------ */
	/* Traffic, returns, feedback, alerts                                 */
	/* ------------------------------------------------------------------ */

	public function traffic( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		[ $from, $to ] = $this->range( $req, $market );
		$series = Db::rows(
			"SELECT report_date AS date, sessions, page_views, buy_box_pct, units, ordered_sales FROM {t:traffic_daily}
			 WHERE market = %s AND asin = '' AND report_date BETWEEN %s AND %s ORDER BY report_date",
			array( $market, $from, $to )
		);
		$asins = Db::rows(
			"SELECT asin, MAX(sku) AS sku, SUM(sessions) AS sessions, SUM(page_views) AS page_views, AVG(buy_box_pct) AS buy_box_pct,
			        SUM(units) AS units, SUM(ordered_sales) AS sales
			 FROM {t:traffic_daily} WHERE market = %s AND asin <> '' AND report_date BETWEEN %s AND %s GROUP BY asin ORDER BY SUM(sessions) DESC",
			array( $market, $from, $to )
		);
		foreach ( $asins as &$a ) {
			$a['cvr'] = (int) $a['sessions'] > 0 ? round( (int) $a['units'] / (int) $a['sessions'] * 100, 2 ) : null;
			$a['buy_box_pct'] = round( (float) $a['buy_box_pct'], 1 );
		}
		return array( 'from' => $from, 'to' => $to, 'series' => $series, 'asins' => $asins );
	}

	public function returns( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		[ $from, $to ] = $this->range( $req, $market, 90 );
		$a = array( $market, $from, $to );
		return array(
			'by_reason' => Db::rows( 'SELECT reason, SUM(qty) AS units FROM {t:returns} WHERE market = %s AND return_date BETWEEN %s AND %s GROUP BY reason ORDER BY units DESC', $a ),
			'by_sku'    => Db::rows( 'SELECT sku, SUM(qty) AS units, SUM(CASE WHEN disposition = %s THEN qty ELSE 0 END) AS sellable FROM {t:returns} WHERE market = %s AND return_date BETWEEN %s AND %s GROUP BY sku ORDER BY units DESC', array_merge( array( 'SELLABLE' ), $a ) ),
			'rows'      => Db::rows( 'SELECT * FROM {t:returns} WHERE market = %s AND return_date BETWEEN %s AND %s ORDER BY return_date DESC LIMIT 300', $a ),
		);
	}

	public function feedback( \WP_REST_Request $req ): array {
		$market = $this->market( $req );
		$rows = Db::rows( 'SELECT * FROM {t:feedback} WHERE market = %s ORDER BY feedback_date DESC LIMIT 300', array( $market ) );
		$n = count( $rows );
		$neg = count( array_filter( $rows, static fn( $r ) => (int) $r['rating'] <= 2 ) );
		return array( 'rows' => $rows, 'count' => $n, 'negative_pct' => $n ? round( $neg / $n * 100, 2 ) : null, 'avg' => $n ? round( array_sum( array_column( $rows, 'rating' ) ) / $n, 2 ) : null );
	}

	public function alerts( \WP_REST_Request $req ): array {
		if ( 'POST' === $req->get_method() ) {
			return array( 'marked' => AlertDispatcher::mark_all_read() );
		}
		return array( 'rows' => AlertDispatcher::recent( 100 ), 'unread' => AlertDispatcher::unread_count() );
	}

	/* ------------------------------------------------------------------ */
	/* Reports, sync, settings, demo                                      */
	/* ------------------------------------------------------------------ */

	public function reports( \WP_REST_Request $req ): array {
		$pipeline = $this->c->get( ReportPipeline::class );
		if ( 'POST' === $req->get_method() ) {
			$in = $this->json( $req );
			$type = (string) ( $in['type'] ?? '' );
			if ( ! isset( ReportPipeline::CATALOG[ $type ] ) ) {
				throw new \InvalidArgumentException( 'Unsupported report type.' );
			}
			$market = $this->market( $req );
			$window = ReportPipeline::CATALOG[ $type ][2];
			$to   = SuiteTime::ymd( $in['to'] ?? '', SuiteTime::shift( SuiteTime::today( $market ), -1 ) );
			$from = SuiteTime::ymd( $in['from'] ?? '', SuiteTime::shift( $to, -max( 0, $window - 1 ) ) );
			if ( 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT' === $type ) {
				return array( 'requested' => $pipeline->request_sqp( $market, $this->own_asins( $market ) ) );
			}
			$id = 0 === $window ? $pipeline->request( $type, $market ) : $pipeline->request( $type, $market, $from, $to );
			return array( 'id' => $id, 'row' => Db::row( 'SELECT * FROM {t:reports} WHERE id = %d', array( $id ) ) );
		}
		return array(
			'catalog' => array_map( static fn( $k, $v ) => array( 'type' => $k, 'label' => $v[0], 'schedule' => $v[1], 'window' => $v[2] ), array_keys( ReportPipeline::CATALOG ), ReportPipeline::CATALOG ),
			'rows'    => Db::rows( 'SELECT * FROM {t:reports} ORDER BY requested_at DESC LIMIT 200' ),
			'jobs'    => get_option( 'sg_suite_job_status', array() ),
		);
	}

	public function reports_poll(): array {
		return $this->c->get( ReportPipeline::class )->poll( 10 );
	}

	/** Manual "sync now" for a given job. */
	public function sync( \WP_REST_Request $req ): array {
		$job = sanitize_key( (string) ( $this->json( $req )['job'] ?? '' ) );
		$m   = $this->c->get( SuiteModule::class );
		$market = $this->market( $req );
		return array( 'job' => $job, 'result' => match ( $job ) {
			'orders'   => $m->guard( 'orders', fn() => $this->c->get( OrdersSync::class )->run() ),
			'finance'  => $m->guard( 'finance', fn() => $this->c->get( FinanceSync::class )->run() ),
			'reports'  => $m->guard( 'reports.daily', fn() => $this->c->get( ReportPipeline::class )->request_scheduled( 'daily' ) ),
			'weekly'   => $m->guard( 'reports.weekly', fn() => $this->c->get( ReportPipeline::class )->request_scheduled( 'weekly', $m->sqp_asins() ) ),
			'backfill' => $m->guard( 'backfill', function () use ( $market ) {
				FinanceSync::reset_cursors();
				return $this->c->get( ReportPipeline::class )->backfill( $market, $this->c->get( SuiteSettings::class )->int( 'suite_backfill_days' ) );
			} ),
			'poll'     => $m->guard( 'pipeline', fn() => $this->c->get( ReportPipeline::class )->poll( 10 ) ),
			'daily'    => $m->daily() ?? 'done',
			default    => throw new \InvalidArgumentException( 'Unknown job.' ),
		} );
	}

	public function settings( \WP_REST_Request $req ): array {
		$s = $this->c->get( SuiteSettings::class );
		if ( 'POST' === $req->get_method() ) {
			$saved = $s->save( $this->json( $req ) );
			return array( 'saved' => $saved, 'settings' => $s->export() );
		}
		return array(
			'settings'  => $s->export(),
			'connected' => $this->c->get( AmazonClient::class )->has_credentials(),
			'jobs'      => get_option( 'sg_suite_job_status', array() ),
			'next_runs' => array_map( static fn( $h ) => ( $t = wp_next_scheduled( $h ) ) ? gmdate( 'c', $t ) : null, array_combine( array_keys( SuiteModule::HOOKS ), array_keys( SuiteModule::HOOKS ) ) ),
			'ads_hosts' => array_keys( AdsClient::HOSTS ),
		);
	}

	public function demo( \WP_REST_Request $req ): array {
		$seeder = $this->c->get( DemoSeeder::class );
		if ( 'DELETE' === $req->get_method() ) {
			$seeder->clear();
			return array( 'demo' => false );
		}
		return array( 'demo' => true, 'counts' => $seeder->seed( $this->market( $req ) ) );
	}

	/** @return string[] */
	private function own_asins( string $market ): array {
		global $wpdb;
		return array_values( array_filter( (array) $wpdb->get_col( $wpdb->prepare( "SELECT DISTINCT asin FROM {$wpdb->prefix}sg_products WHERE market = %s AND asin <> '' ORDER BY asin", $market ) ) ) ); // phpcs:ignore
	}
}
