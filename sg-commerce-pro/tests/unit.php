<?php
/**
 * Unit tests for the Seller Suite's pure logic — no WordPress needed.
 *
 *   php tests/unit.php
 *
 * Covers: financial-event flattening, report parsing, bid/search-term/budget
 * rules, restock maths, listing scoring and the profitability calculator.
 */

declare( strict_types = 1 );

define( 'ABSPATH', __DIR__ . '/' );
define( 'DAY_IN_SECONDS', 86400 );

spl_autoload_register( static function ( string $class ): void {
	$prefix = 'SevenGum\\Commerce\\';
	if ( str_starts_with( $class, $prefix ) ) {
		$file = dirname( __DIR__ ) . '/src/' . str_replace( '\\', '/', substr( $class, strlen( $prefix ) ) ) . '.php';
		if ( is_readable( $file ) ) {
			require_once $file;
		}
	}
} );

use SevenGum\Commerce\Suite\Ads\BidOptimizer;
use SevenGum\Commerce\Suite\Finance\FinancialEventFlattener;
use SevenGum\Commerce\Suite\Inventory\RestockPlanner;
use SevenGum\Commerce\Suite\Listings\ListingAuditor;
use SevenGum\Commerce\Suite\Reports\ReportIngestor;
use SevenGum\Commerce\Suite\Reports\ReportParser;
use SevenGum\Commerce\Suite\Research\ProductResearch;

$pass = 0;
$fail = 0;
function check( string $name, bool $ok, string $detail = '' ): void {
	global $pass, $fail;
	if ( $ok ) {
		$pass++;
		echo "  ✓ {$name}\n";
	} else {
		$fail++;
		echo "  ✗ {$name}" . ( '' !== $detail ? " — {$detail}" : '' ) . "\n";
	}
}
function near( float $a, float $b, float $eps = 0.011 ): bool {
	return abs( $a - $b ) <= $eps;
}
function money( float $v, string $c = 'USD' ): array {
	return array( 'CurrencyCode' => $c, 'CurrencyAmount' => $v );
}

/* -------------------------------------------------------------------- */
echo "FinancialEventFlattener\n";
$events = array(
	'ShipmentEventList' => array( array(
		'AmazonOrderId' => '111-1', 'PostedDate' => '2026-09-10T12:00:00Z', 'MarketplaceName' => 'Amazon.com',
		'ShipmentItemList' => array( array(
			'SellerSKU' => 'SKU-A', 'QuantityShipped' => 2,
			'ItemChargeList' => array(
				array( 'ChargeType' => 'Principal', 'ChargeAmount' => money( 33.98 ) ),
				array( 'ChargeType' => 'Tax', 'ChargeAmount' => money( 2.46 ) ),
			),
			'ItemFeeList' => array(
				array( 'FeeType' => 'Commission', 'FeeAmount' => money( -5.10 ) ),
				array( 'FeeType' => 'FBAPerUnitFulfillmentFee', 'FeeAmount' => money( -8.04 ) ),
			),
			'PromotionList' => array( array( 'PromotionType' => 'PromotionMetaDataDefinitionValue', 'PromotionAmount' => money( -3.40 ) ) ),
			'ItemTaxWithheldList' => array( array( 'TaxesWithheld' => array( array( 'ChargeType' => 'MarketplaceFacilitatorTax-Principal', 'ChargeAmount' => money( -2.46 ) ) ) ) ),
		) ),
	) ),
	'RefundEventList' => array( array(
		'AmazonOrderId' => '111-0', 'PostedDate' => '2026-09-11T08:00:00Z',
		'ShipmentItemAdjustmentList' => array( array(
			'SellerSKU' => 'SKU-A', 'QuantityShipped' => 1,
			'ItemChargeAdjustmentList' => array( array( 'ChargeType' => 'Principal', 'ChargeAmount' => money( -16.99 ) ) ),
			'ItemFeeAdjustmentList' => array(
				array( 'FeeType' => 'Commission', 'FeeAmount' => money( 2.04 ) ),
				array( 'FeeType' => 'RefundCommission', 'FeeAmount' => money( -0.51 ) ),
			),
		) ),
	) ),
	'ServiceFeeEventList' => array( array( 'FeeList' => array( array( 'FeeType' => 'FBAStorageFee', 'FeeAmount' => money( -42.17 ) ) ) ) ),
	'AdjustmentEventList' => array( array(
		'AdjustmentType' => 'WAREHOUSE_DAMAGE', 'PostedDate' => '2026-09-12T00:00:00Z',
		'AdjustmentItemList' => array( array( 'SellerSKU' => 'SKU-A', 'Quantity' => 2, 'TotalAmount' => money( 19.80 ) ) ),
	) ),
	'ProductAdsPaymentEventList' => array( array( 'postedDate' => '2026-09-13T00:00:00Z', 'transactionType' => 'Charge', 'invoiceId' => 'INV1', 'transactionValue' => money( 250.00 ) ) ),
);
$lines = FinancialEventFlattener::flatten( $events, '2026-09-30T00:00:00Z' );
$by = array();
foreach ( $lines as $l ) {
	$by[ $l['category'] ] = ( $by[ $l['category'] ] ?? 0 ) + $l['amount'];
}
check( 'revenue = principal only', near( $by['revenue'] ?? 0, 33.98 ) );
check( 'tax nets to zero (collected + withheld)', near( $by['tax'] ?? 1, 0.0 ) );
check( 'fees include item, refund and storage fees', near( $by['fee'] ?? 0, -5.10 - 8.04 + 2.04 - 0.51 - 42.17 ) );
check( 'promotion captured', near( $by['promo'] ?? 0, -3.40 ) );
check( 'refund principal negative', near( $by['refund'] ?? 0, -16.99 ) );
check( 'warehouse damage is a reimbursement', near( $by['reimbursement'] ?? 0, 19.80 ) );
check( 'ads invoice negative', near( $by['ads'] ?? 0, -250.0 ) );
$units = array_sum( array_map( static fn( $l ) => 'revenue' === $l['category'] ? $l['qty'] : 0, $lines ) );
check( 'units attributed once on Principal', 2 === $units, (string) $units );
$refund_units = array_sum( array_map( static fn( $l ) => 'refund' === $l['category'] ? $l['qty'] : 0, $lines ) );
check( 'refund units negative', -1 === $refund_units );
$storage = array_values( array_filter( $lines, static fn( $l ) => 'FBAStorageFee' === $l['charge_type'] ) );
check( 'ServiceFeeEvent without PostedDate uses window end', '2026-09-30T00:00:00Z' === ( $storage[0]['posted'] ?? '' ) );
check( 'payout identity: Σ amount == net', near( array_sum( array_column( $lines, 'amount' ) ), 33.98 + 2.46 - 2.46 - 5.10 - 8.04 - 3.40 - 16.99 + 2.04 - 0.51 - 42.17 + 19.80 - 250.0 ) );
check( 'hash is deterministic', FinancialEventFlattener::hash( $lines[0], 0 ) === FinancialEventFlattener::hash( $lines[0], 0 ) );
check( 'hash ordinal disambiguates duplicates', FinancialEventFlattener::hash( $lines[0], 0 ) !== FinancialEventFlattener::hash( $lines[0], 1 ) );
check( 'adjustment categories', 'fee' === FinancialEventFlattener::adjustment_category( 'FBAStorageFeeAdjustment' ) && 'adjustment' === FinancialEventFlattener::adjustment_category( 'ReserveDebit' ) );

/* -------------------------------------------------------------------- */
echo "ReportParser / ReportIngestor::date\n";
$tsv = "amazon-order-id\tsku\tquantity\titem-price\n111-1\tSKU-A\t2\t33.98\r\n111-2\tSKU-B\t1\t\"4.99\"\n";
$rows = ReportParser::tsv( $tsv );
check( 'tsv rows', 2 === count( $rows ) );
check( 'tsv header normalised', isset( $rows[0]['amazon-order-id'] ) && '33.98' === $rows[0]['item-price'] );
check( 'tsv strips quotes', '4.99' === $rows[1]['item-price'] );
check( 'gzip transparently decoded', 2 === count( ReportParser::tsv( gzencode( $tsv ) ) ) );
check( 'Windows-1252 converted to UTF-8', 'Café' === ReportParser::tsv( "name\n" . "Caf\xE9" )[0]['name'] );
check( 'BOM stripped from header', isset( ReportParser::tsv( "\xEF\xBB\xBFDate\tFNSKU\n1\t2" )[0]['date'] ) );
check( 'header with spaces → hyphens', isset( ReportParser::tsv( "Event Type\tReference ID\nA\tB" )[0]['event-type'] ) );
check( 'money US', near( ReportParser::money( '$1,234.50' ), 1234.50 ) );
check( 'money EU', near( ReportParser::money( '1.234,50' ), 1234.50 ) );
check( 'money EU decimal', near( ReportParser::money( '4,99' ), 4.99 ) );
check( 'money negative', near( ReportParser::money( '-12.30' ), -12.30 ) );
check( 'json gzip', 1 === ReportParser::json( gzencode( '[{"a":1}]' ) )[0]['a'] );
check( 'date ISO', '2026-09-01' === ReportIngestor::date( '2026-09-01T07:00:00+00:00' ) );
check( 'date US m/d/Y', '2026-09-05' === ReportIngestor::date( '09/05/2026' ) );
check( 'date empty', null === ReportIngestor::date( '' ) );

/* -------------------------------------------------------------------- */
echo "BidOptimizer\n";
$opt = new BidOptimizer( array( 'target_acos' => 30, 'min_clicks' => 12, 'max_step_pct' => 20, 'min_bid' => 0.2, 'max_bid' => 4, 'raise_low_impr' => true, 'neg_min_clicks' => 15, 'harvest_min_orders' => 2, 'avg_order_value' => 17 ) );
$base = array( 'kind' => 'keyword', 'campaign_id' => 'C1', 'ad_group_id' => 'AG1', 'state' => 'ENABLED' );
$plan = $opt->bids( array(
	$base + array( 'target_id' => 'hi-acos', 'label' => 'a', 'bid' => 1.50, 'impressions' => 5000, 'clicks' => 100, 'cost' => 120, 'sales' => 200, 'orders' => 10 ),
	$base + array( 'target_id' => 'lo-acos', 'label' => 'b', 'bid' => 0.50, 'impressions' => 5000, 'clicks' => 50, 'cost' => 25, 'sales' => 300, 'orders' => 15 ),
	$base + array( 'target_id' => 'no-orders', 'label' => 'c', 'bid' => 1.00, 'impressions' => 3000, 'clicks' => 14, 'cost' => 9, 'sales' => 0, 'orders' => 0 ),
	$base + array( 'target_id' => 'bleeder', 'label' => 'd', 'bid' => 1.00, 'impressions' => 3000, 'clicks' => 40, 'cost' => 40, 'sales' => 0, 'orders' => 0 ),
	$base + array( 'target_id' => 'invisible', 'label' => 'e', 'bid' => 0.40, 'impressions' => 20, 'clicks' => 0, 'cost' => 0, 'sales' => 0, 'orders' => 0 ),
	$base + array( 'target_id' => 'on-target', 'label' => 'f', 'bid' => 0.60, 'impressions' => 5000, 'clicks' => 100, 'cost' => 60, 'sales' => 200, 'orders' => 10 ),
	array_merge( $base, array( 'state' => 'PAUSED' ) ) + array( 'target_id' => 'paused', 'label' => 'g', 'bid' => 1.0, 'impressions' => 0, 'clicks' => 50, 'cost' => 50, 'sales' => 0, 'orders' => 0 ),
) );
$a = array();
foreach ( $plan as $p ) {
	$a[ $p['entity_id'] ] = $p;
}
check( 'high ACoS → bid cut, capped at -20%', isset( $a['hi-acos'] ) && near( (float) $a['hi-acos']['new_value'], 1.20 ) );
check( 'low ACoS → bid raised, capped at +20%', isset( $a['lo-acos'] ) && near( (float) $a['lo-acos']['new_value'], 0.60 ) );
check( 'no orders after min clicks → cut', isset( $a['no-orders'] ) && near( (float) $a['no-orders']['new_value'], 0.80 ) );
check( 'heavy bleeder (≥2× break-even CPA) → pause', 'pause' === ( $a['bleeder']['kind'] ?? '' ) );
check( 'low impressions → raise half step', isset( $a['invisible'] ) && near( (float) $a['invisible']['new_value'], 0.44 ) );
check( 'on-target keyword left alone', ! isset( $a['on-target'] ) );
check( 'paused keywords ignored', ! isset( $a['paused'] ) );
$clamp = ( new BidOptimizer( array( 'target_acos' => 90, 'max_step_pct' => 50, 'max_bid' => 1.0 ) ) )->bids( array(
	$base + array( 'target_id' => 'x', 'label' => 'x', 'bid' => 0.9, 'impressions' => 900, 'clicks' => 10, 'cost' => 9, 'sales' => 100, 'orders' => 5 ),
) );
check( 'bids clamp to max_bid', near( (float) ( $clamp[0]['new_value'] ?? 0 ), 1.0 ) );

$terms = $opt->search_terms( array(
	array( 'search_term' => 'Sugar Free Gum Bulk', 'campaign_id' => 'AUTO', 'ad_group_id' => 'AGA', 'keyword_text' => 'close-match', 'match_type' => 'AUTO', 'impressions' => 900, 'clicks' => 20, 'cost' => 15, 'sales' => 85, 'orders' => 5 ),
	array( 'search_term' => 'nicotine gum', 'campaign_id' => 'BROAD', 'ad_group_id' => 'AGB', 'keyword_text' => 'gum', 'match_type' => 'BROAD', 'impressions' => 900, 'clicks' => 22, 'cost' => 18, 'sales' => 0, 'orders' => 0 ),
	array( 'search_term' => 'spearmint gum', 'campaign_id' => 'AUTO', 'ad_group_id' => 'AGA', 'keyword_text' => 'close-match', 'match_type' => 'AUTO', 'impressions' => 900, 'clicks' => 20, 'cost' => 10, 'sales' => 80, 'orders' => 4 ),
	array( 'search_term' => 'b0abcdefgh', 'campaign_id' => 'AUTO', 'ad_group_id' => 'AGA', 'keyword_text' => 'substitutes', 'match_type' => 'AUTO', 'impressions' => 900, 'clicks' => 20, 'cost' => 10, 'sales' => 80, 'orders' => 4 ),
	array( 'search_term' => 'bubble gum machine', 'campaign_id' => 'BROAD', 'ad_group_id' => 'AGB', 'keyword_text' => 'gum', 'match_type' => 'BROAD', 'impressions' => 900, 'clicks' => 30, 'cost' => 20, 'sales' => 0, 'orders' => 0 ),
), array( 'spearmint gum' => true ), array( 'AGB|bubble gum machine' => true ), 'EXACT-C', 'EXACT-AG' );
$k = array();
foreach ( $terms as $t ) {
	$k[ $t['entity_id'] ] = $t;
}
check( 'converting term harvested to exact destination', 'harvest' === ( $k['sugar free gum bulk']['kind'] ?? '' ) && 'EXACT-AG' === $k['sugar free gum bulk']['ad_group_id'] );
check( 'harvest bid = CPC × 1.1', near( (float) $k['sugar free gum bulk']['payload']['bid'], 0.83 ) );
check( 'non-converting term negated in its source ad group', 'negative' === ( $k['nicotine gum']['kind'] ?? '' ) && 'AGB' === $k['nicotine gum']['ad_group_id'] );
check( 'already-exact keyword not re-harvested', ! isset( $k['spearmint gum'] ) );
check( 'ASIN term → product-target harvest', 'harvest_asin' === ( $k['b0abcdefgh']['kind'] ?? '' ) );
check( 'existing negative not duplicated', ! isset( $k['bubble gum machine'] ) );

$budgets = $opt->budgets( array(
	array( 'campaign_id' => 'capped-good', 'name' => 'A', 'state' => 'ENABLED', 'daily_budget' => 20, 'days' => 7, 'cost' => 135, 'sales' => 700 ),
	array( 'campaign_id' => 'capped-bad', 'name' => 'B', 'state' => 'ENABLED', 'daily_budget' => 20, 'days' => 7, 'cost' => 138, 'sales' => 200 ),
	array( 'campaign_id' => 'fine', 'name' => 'C', 'state' => 'ENABLED', 'daily_budget' => 50, 'days' => 7, 'cost' => 100, 'sales' => 600 ),
) );
$b = array_column( $budgets, 'new_value', 'entity_id' );
check( 'profitable capped campaign → +20% budget', near( (float) ( $b['capped-good'] ?? 0 ), 24.0 ) );
check( 'unprofitable capped campaign → -15% budget', near( (float) ( $b['capped-bad'] ?? 0 ), 17.0 ) );
check( 'uncapped campaign untouched', ! isset( $b['fine'] ) );

/* -------------------------------------------------------------------- */
echo "RestockPlanner::plan\n";
$in = static fn( array $o ) => $o + array( 'sku' => 'S', 'asin' => 'A', 'title' => 'T', 'fulfillable' => 0, 'reserved' => 0, 'inbound' => 0, 'units_7' => 0, 'units_30' => 0, 'units_90' => 0, 'oos_days_30' => 0, 'lead_time' => 30, 'moq' => 0, 'case_pack' => 0, 'unit_cost' => 2.0, 'price' => 10.0 );
$plan = RestockPlanner::plan( array(
	$in( array( 'sku' => 'steady', 'fulfillable' => 300, 'units_7' => 70, 'units_30' => 300, 'units_90' => 900, 'case_pack' => 24, 'moq' => 100 ) ),
	$in( array( 'sku' => 'oos', 'fulfillable' => 0, 'units_7' => 0, 'units_30' => 150, 'units_90' => 600, 'oos_days_30' => 15 ) ),
	$in( array( 'sku' => 'fat', 'fulfillable' => 5000, 'units_7' => 14, 'units_30' => 60, 'units_90' => 180 ) ),
	$in( array( 'sku' => 'gap', 'fulfillable' => 20, 'inbound' => 2000, 'units_7' => 70, 'units_30' => 300, 'units_90' => 900 ) ),
	$in( array( 'sku' => 'dead', 'fulfillable' => 40 ) ),
), '2026-10-01', array( 'safety_days' => 14, 'target_cover' => 60, 'overstock_days' => 180 ) );
$r = array_column( $plan['rows'], null, 'sku' );
check( 'velocity = 0.5·v7 + 0.3·v30 + 0.2·v90', near( $r['steady']['velocity'], 10.0 ) );
check( 'days of cover', 30 === $r['steady']['days_of_cover'] );
check( 'steady SKU below reorder point → critical', 'critical' === $r['steady']['status'], $r['steady']['status'] );
// need = 10 × (30 + 60) − 300 = 600 → case pack 24 → 600
check( 'order qty rounded up to case pack', 600 === $r['steady']['order_qty'], (string) $r['steady']['order_qty'] );
check( 'stock-out date', '2026-10-31' === $r['steady']['stockout_date'] );
// v30 = 150 / (30 − 15 OOS days) = 10 → 0.3·10 + 0.2·6.67 = 4.33 (vs 2.83 if OOS days were counted).
check( 'OOS SKU flagged + velocity excludes stock-out days', 'out_of_stock' === $r['oos']['status'] && near( $r['oos']['velocity'], 4.333 ) );
check( 'lost sales per day for OOS', $r['oos']['lost_sales_day'] > 40 );
check( 'overstock detected', 'overstock' === $r['fat']['status'] && 0 === $r['fat']['order_qty'] );
check( 'inbound gap → stockout_risk', 'stockout_risk' === $r['gap']['status'], $r['gap']['status'] );
check( 'no sales → no_sales, no order', 'no_sales' === $r['dead']['status'] && 0 === $r['dead']['order_qty'] );
check( 'urgency ordering', 'oos' === $plan['rows'][0]['sku'] );
check( 'summary PO value', near( $plan['summary']['order_value'], array_sum( array_column( $plan['rows'], 'order_value' ) ) ) );

/* -------------------------------------------------------------------- */
echo "ListingAuditor::score\n";
$good = array(
	'asin' => 'B0X', 'brand' => '7 SEVEN', 'product_type' => 'GUM', 'status' => array( 'BUYABLE', 'DISCOVERABLE' ), 'issues' => array(),
	'title' => '7 SEVEN Sugar-Free Gum, Spearmint, 50 Pieces, Xylitol Sweetened, Aspartame-Free, Long-Lasting Flavor, Vegan',
	'bullets' => array_fill( 0, 5, 'LONG-LASTING FLAVOR — Our slow-release flavor beads keep every piece fresh for up to 45 minutes, so one piece covers your whole commute or meeting without fading.' ),
	'description' => str_repeat( 'Clean, confident chewing gum with xylitol sweetness and long-lasting flavor. ', 18 ),
	'backend' => 'sugarless chewing gum xylitol mints breath freshener keto vegan office travel bottle aspartame free dental gum fresh breath dry mouth',
	'images' => array_fill( 0, 7, 'x.jpg' ),
);
$s = ListingAuditor::score( $good, array( 'spearmint gum', 'xylitol gum' ) );
check( 'good listing scores ≥ 90', $s['score'] >= 90, (string) $s['score'] );
check( 'keyword coverage 100%', 100 === $s['keyword_coverage']['pct'] );
$bad = array_merge( $good, array(
	'title' => 'Gum Gum Gum!! Best Seller Sugar Free GUM GUM', 'bullets' => array( 'Short 😀' ), 'description' => '',
	'backend' => str_repeat( 'gum ', 70 ) . 'B0ABCDEFGH', 'images' => array( 'x.jpg' ),
	'status' => array( 'DISCOVERABLE' ), 'issues' => array( array( 'code' => '90220', 'severity' => 'ERROR', 'message' => 'missing weight' ) ),
) );
$s2 = ListingAuditor::score( $bad, array( 'spearmint gum' ) );
$msgs = implode( ' | ', array_column( $s2['findings'], 'message' ) );
check( 'bad listing scores < 40', $s2['score'] < 40, (string) $s2['score'] );
check( 'flags repeated words', str_contains( $msgs, 'more than twice' ) );
check( 'flags banned characters', str_contains( $msgs, 'decorative characters' ) );
check( 'flags promotional claims', str_contains( $msgs, 'best seller' ) );
check( 'flags emoji in bullets', str_contains( $msgs, 'emoji' ) );
check( 'flags backend > 249 bytes', str_contains( $msgs, '249 bytes' ) );
check( 'flags ASIN in backend', str_contains( $msgs, 'ASINs' ) );
check( 'flags suppression', 'suppressed' === $s2['status'] );
check( 'grade F', 'F' === $s2['grade'] );
check( 'claims ignore substrings (wholesale ≠ sale)', array() === ListingAuditor::claims( 'wholesale pack' ) );
check( 'extract() maps Listings API attributes', 'Hello' === ListingAuditor::extract( array(
	'summaries' => array( array( 'asin' => 'B0X', 'status' => array( 'BUYABLE' ) ) ),
	'attributes' => array( 'item_name' => array( array( 'value' => 'Hello' ) ), 'bullet_point' => array( array( 'value' => 'b1' ), array( 'value' => 'b2' ) ),
		'other_product_image_locator_1' => array( array( 'media_location' => 'i1' ) ), 'main_product_image_locator' => array( array( 'media_location' => 'm' ) ) ),
) )['title'] );

/* -------------------------------------------------------------------- */
echo "ProductResearch\n";
$c = ProductResearch::calc( array( 'price' => 20, 'unit_cost' => 4, 'inbound' => 1, 'referral_pct' => 15, 'fba_fee' => 5, 'tacos_pct' => 10, 'return_pct' => 0, 'cvr_pct' => 10 ) );
// 20 − 3 (referral) − 5 (FBA) − 5 (COGS) − 2 (ads) = 5
check( 'profit per unit', near( $c['profit_per_unit'], 5.0 ) );
check( 'margin %', near( $c['margin_pct'], 25.0 ) );
check( 'ROI %', near( $c['roi_pct'], 100.0 ) );
check( 'break-even ACoS = pre-ad margin', near( $c['breakeven_acos'], 35.0 ) );
check( 'max CPC = pre-ad profit × CVR', near( $c['max_cpc'], 0.70 ) );
check( 'break-even price', near( $c['breakeven_price'], 10 / 0.75 ) );
check( 'BSR estimate decreases with rank', ProductResearch::estimate_monthly_units( 100, 'grocery' ) > ProductResearch::estimate_monthly_units( 10000, 'grocery' ) );
check( 'BSR group factor applied', ProductResearch::estimate_monthly_units( 1000, 'home' ) > ProductResearch::estimate_monthly_units( 1000, 'baby' ) );

echo "\n{$pass} passed, {$fail} failed\n";
exit( $fail ? 1 : 0 );
