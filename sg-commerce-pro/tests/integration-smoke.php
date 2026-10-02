<?php
/**
 * Integration smoke test — run inside WordPress:
 *   wp eval-file wp-content/plugins/sg-commerce-pro/tests/integration-smoke.php
 *
 * Seeds the demo account, then calls every read endpoint of the Suite REST
 * API as an administrator and asserts a 2xx response with sane payloads.
 * Finishes by clearing the demo data and asserting nothing is left.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit( 1 );
}

$admins = get_users( array( 'role' => 'administrator', 'number' => 1 ) );
wp_set_current_user( $admins[0]->ID );

$fail = 0;
$call = static function ( string $method, string $route, array $params = array() ) use ( &$fail ) {
	$req = new WP_REST_Request( $method, '/sg-commerce/v1/suite' . $route );
	if ( 'GET' === $method ) {
		$req->set_query_params( $params );
	} else {
		$req->set_header( 'content-type', 'application/json' );
		$req->set_body( wp_json_encode( $params ) );
	}
	$t   = microtime( true );
	$res = rest_do_request( $req );
	$ms  = (int) ( ( microtime( true ) - $t ) * 1000 );
	$ok  = $res->get_status() < 300;
	if ( ! $ok ) {
		$fail++;
	}
	printf( "%-4s %-34s %d %5dms %s\n", $method, $route, $res->get_status(), $ms, $ok ? '' : wp_json_encode( $res->get_data() ) );
	return $res->get_data();
};
$assert = static function ( bool $cond, string $msg ) use ( &$fail ) {
	if ( ! $cond ) {
		$fail++;
		echo "ASSERT FAILED: {$msg}\n";
	}
};

$seed = $call( 'POST', '/demo', array() );
echo 'seed counts: ' . wp_json_encode( $seed['counts'] ?? array() ) . "\n";
$assert( ( $seed['counts']['orders'] ?? 0 ) > 500, 'demo orders seeded' );

$o = $call( 'GET', '/overview' );
$assert( isset( $o['periods']['mtd']['sales'] ), 'overview has MTD sales' );
$assert( ( $o['totals_30']['sales'] ?? 0 ) > 0, '30-day sales > 0' );
$assert( ( $o['totals_30']['amazon_fees'] ?? 0 ) < 0, 'fees negative' );
$assert( ( $o['totals_30']['cogs'] ?? 0 ) < 0, 'cogs negative' );
echo 'overview 30d: ' . wp_json_encode( array_intersect_key( $o['totals_30'], array_flip( array( 'orders', 'units', 'sales', 'refunds', 'amazon_fees', 'fees_estimated', 'account_fees', 'ads', 'cogs', 'expenses', 'net_profit', 'margin_pct', 'roi_pct', 'tacos_pct' ) ) ) ) . "\n";
echo 'forecast: ' . wp_json_encode( $o['periods']['forecast'] ) . "\n";

$p = $call( 'GET', '/profit', array( 'from' => gmdate( 'Y-m-d', strtotime( '-60 days' ) ) ) );
$assert( count( $p['skus'] ?? array() ) >= 18, 'profit by sku rows' );
$assert( count( $p['series'] ?? array() ) >= 60, 'profit daily series' );
$assert( ! empty( $p['fee_breakdown'] ), 'fee breakdown' );

$ord = $call( 'GET', '/orders' );
$assert( count( $ord['orders'] ?? array() ) > 50, 'orders list' );
$call( 'GET', '/orders', array( 'q' => 'SPEARMINT' ) );

$c = $call( 'GET', '/costs' );
$assert( count( $c['rows'] ?? array() ) >= 19, 'costs rows' );
$call( 'POST', '/costs', array( 'rows' => array( array( 'sku' => 'DEMO-P1-LEMON', 'unit_cost' => 1.2, 'inbound_per_unit' => 0.1, 'lead_time_days' => 40 ) ) ) );
$e = $call( 'POST', '/expenses', array( 'label' => 'Test expense', 'amount' => 10, 'recurrence' => 'once' ) );
$call( 'GET', '/expenses' );
$call( 'DELETE', '/expenses/' . (int) ( $e['id'] ?? 0 ) );

$r = $call( 'GET', '/restock' );
$assert( ( $r['summary']['skus'] ?? 0 ) >= 19, 'restock skus' );
$statuses = array_count_values( array_column( $r['rows'] ?? array(), 'status' ) );
echo 'restock statuses: ' . wp_json_encode( $statuses ) . "\n";
$assert( isset( $statuses['out_of_stock'] ), 'restock has OOS sku' );
$call( 'GET', '/inventory-health' );

$a = $call( 'GET', '/ads/overview' );
$assert( ( $a['totals']['cost'] ?? 0 ) > 0, 'ads spend' );
$call( 'GET', '/ads/campaigns' );
$call( 'GET', '/ads/targets' );
$call( 'GET', '/ads/search-terms' );
$plan = $call( 'POST', '/ads/optimize' );
echo 'ppc plan: ' . wp_json_encode( $plan ) . "\n";
$assert( ( $plan['bids'] ?? 0 ) + ( $plan['terms'] ?? 0 ) > 0, 'optimizer produced actions' );
$acts = $call( 'GET', '/ads/actions' );
$kinds = array_count_values( array_column( $acts['planned'] ?? array(), 'kind' ) );
echo 'planned kinds: ' . wp_json_encode( $kinds ) . "\n";
$ids = array_slice( array_map( 'intval', array_column( array_filter( $acts['planned'], static fn( $x ) => 'bid' === $x['kind'] ), 'id' ) ), 0, 2 );
$ap = $call( 'POST', '/ads/apply', array( 'ids' => $ids ) );
$assert( ( $ap['applied'] ?? 0 ) === count( $ids ), 'demo actions applied' );

$k = $call( 'GET', '/keywords' );
$assert( count( $k['rows'] ?? array() ) >= 10, 'tracked keywords' );
$call( 'POST', '/keywords', array( 'asin' => 'B0DEMO0001', 'keywords' => "test keyword one\ntest keyword two" ) );
$call( 'GET', '/keywords/queries', array( 'asin' => 'B0DEMO0001' ) );
$call( 'POST', '/keywords/research', array( 'asins' => array( 'B0DEMO0001' ) ) );

$l = $call( 'GET', '/listings' );
$assert( count( $l['rows'] ?? array() ) >= 19, 'listing audits' );
echo 'listing scores: ' . implode( ',', array_column( $l['rows'], 'score' ) ) . "\n";

$m = $call( 'GET', '/monitor' );
$assert( count( $m['hijacks'] ?? array() ) >= 1, 'hijacker detected in demo' );
$call( 'GET', '/monitor/history', array( 'asin' => 'B0DEMO0006' ) );

$rv = $call( 'GET', '/reviews' );
echo 'reviews: ' . wp_json_encode( $rv['by_status'] ?? array() ) . "\n";

$rb = $call( 'GET', '/reimbursements' );
$kinds = array_count_values( array_column( $rb['rows'] ?? array(), 'kind' ) );
echo 'reimbursement cases: ' . wp_json_encode( $kinds ) . ' value=' . array_sum( array_column( $rb['rows'], 'est_amount' ) ) . "\n";
$assert( count( $rb['rows'] ?? array() ) > 0, 'reimbursement cases found' );
if ( ! empty( $rb['rows'][0]['id'] ) ) {
	$call( 'POST', '/reimbursements/' . (int) $rb['rows'][0]['id'], array( 'status' => 'filed', 'amazon_case_id' => '1234567890' ) );
}

$calc = $call( 'POST', '/research/calc', array( 'price' => 16.99, 'unit_cost' => 4.2, 'inbound' => 0.5, 'referral_pct' => 15, 'fba_fee' => 4.02, 'tacos_pct' => 10, 'return_pct' => 2 ) );
echo 'calc: ' . wp_json_encode( $calc ) . "\n";
$assert( abs( ( $calc['profit_per_unit'] ?? 0 ) - 3.5 ) < 1.5, 'calc profit sane' );

$call( 'GET', '/traffic' );
$call( 'GET', '/returns' );
$call( 'GET', '/feedback' );
$call( 'GET', '/alerts' );
$call( 'GET', '/reports' );
$s = $call( 'GET', '/settings' );
$assert( ! isset( $s['settings']['ads_client_secret'] ), 'no secrets in settings payload' );
$call( 'POST', '/settings', array( 'suite_ads_target_acos' => '25', 'ads_client_secret' => 'shh-secret-value' ) );
$s2 = $call( 'GET', '/settings' );
$assert( true === ( $s2['settings']['has_ads_client_secret'] ?? null ), 'secret stored flag' );
$assert( ! str_contains( wp_json_encode( $s2 ), 'shh-secret-value' ), 'secret never echoed' );
$raw = get_option( 'sg_commerce_secret_ads_client_secret' );
$assert( is_string( $raw ) && ! str_contains( $raw, 'shh-secret-value' ), 'secret encrypted at rest' );

// Permission check: anonymous must be rejected.
wp_set_current_user( 0 );
$res = rest_do_request( new WP_REST_Request( 'GET', '/sg-commerce/v1/suite/overview' ) );
$assert( in_array( $res->get_status(), array( 401, 403 ), true ), 'anonymous rejected' );
wp_set_current_user( $admins[0]->ID );

$call( 'DELETE', '/demo' );
global $wpdb;
$left = 0;
foreach ( \SevenGum\Commerce\Suite\SuiteSchema::TABLES as $t ) {
	if ( in_array( $t, array( 'reports', 'sku_costs' ), true ) ) {
		continue;
	}
	$left += (int) $wpdb->get_var( 'SELECT COUNT(*) FROM ' . \SevenGum\Commerce\Suite\SuiteSchema::table( $t ) . ' WHERE is_demo = 1' );
}
$left += (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}sg_products WHERE sku LIKE 'DEMO-%'" );
$assert( 0 === $left, "demo fully cleared (left={$left})" );

echo $fail ? "\nFAILED: {$fail}\n" : "\nALL OK\n";
