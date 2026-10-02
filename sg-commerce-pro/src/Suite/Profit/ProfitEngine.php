<?php
/**
 * ProfitEngine — real net profit, Sellerboard-style.
 *
 * Basis (matches how Seller Central and the paid profit tools count):
 *   - Sales, units, orders, promotions → order items by ORDER date (marketplace tz).
 *   - Amazon fees on those orders      → settled Finances events joined by order id;
 *                                        for orders not yet settled, fees are ESTIMATED
 *                                        from each SKU's trailing 90-day fee-per-unit.
 *   - Refunds, reimbursements, account-level fees (storage, subscription…),
 *     adjustments                      → by POSTED date.
 *   - Ad spend                         → Ads API daily campaign cost (falls back to
 *                                        invoiced ProductAdsPayment events).
 *   - COGS                             → units × landed cost (CostBook), with cost
 *                                        added back for returns restocked as SELLABLE.
 *   - Custom expenses                  → one-off on start date, monthly pro-rated per day.
 *   - Taxes                            → excluded (pass-through) unless configured.
 *
 * @package SevenGum\Commerce\Suite\Profit
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Profit;

use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Suite\SuiteSettings;
use SevenGum\Commerce\Suite\Support\Db;
use SevenGum\Commerce\Suite\Support\SuiteTime;

defined( 'ABSPATH' ) || exit;

final class ProfitEngine {

	public function __construct(
		private CostBook $costs,
		private Marketplaces $marketplaces,
		private SuiteSettings $settings,
	) {}

	public function pnl( string $market, string $from, string $to, bool $detail = true ): array {
		$mp       = $this->marketplaces->get( $market );
		$currency = (string) ( $mp['currency'] ?? 'USD' );
		$days     = array();
		for ( $d = $from; $d <= $to; $d = SuiteTime::shift( $d, 1 ) ) {
			$days[ $d ] = self::blank_day();
			if ( count( $days ) > 400 ) {
				break;
			}
		}
		$skus = array();

		// 1. Sales by order date.
		$items = Db::rows(
			"SELECT local_date, sku, MAX(asin) AS asin, MAX(title) AS title, SUM(qty) AS units, SUM(item_price) AS sales,
			        SUM(promo_discount) AS promo, SUM(item_tax) AS tax, COUNT(DISTINCT amazon_order_id) AS orders
			 FROM {t:order_items}
			 WHERE market = %s AND local_date BETWEEN %s AND %s AND status <> 'Canceled'
			 GROUP BY local_date, sku",
			array( $market, $from, $to )
		);
		foreach ( $items as $r ) {
			$d   = (string) $r['local_date'];
			$sku = (string) $r['sku'];
			$u   = (int) $r['units'];
			$cogs = $u * $this->costs->landed( $market, $sku );
			$this->add( $days, $skus, $d, $sku, array(
				'units' => $u, 'sales' => (float) $r['sales'], 'promo' => -abs( (float) $r['promo'] ),
				'tax_collected' => (float) $r['tax'], 'cogs' => -$cogs,
			), $r );
		}
		$order_count = Db::rows(
			"SELECT local_date, COUNT(*) AS n FROM {t:orders} WHERE market = %s AND local_date BETWEEN %s AND %s AND status <> 'Canceled' GROUP BY local_date",
			array( $market, $from, $to )
		);
		foreach ( $order_count as $r ) {
			if ( isset( $days[ $r['local_date'] ] ) ) {
				$days[ $r['local_date'] ]['orders'] = (int) $r['n'];
			}
		}

		// 2. Settled fees for orders placed in range.
		$settled = Db::rows(
			"SELECT o.local_date, f.sku, f.charge_type, SUM(f.amount) AS amt
			 FROM {t:fin_events} f INNER JOIN {t:orders} o ON o.amazon_order_id = f.amazon_order_id
			 WHERE o.market = %s AND o.local_date BETWEEN %s AND %s AND f.event_type = 'Shipment' AND f.category = 'fee'
			 GROUP BY o.local_date, f.sku, f.charge_type",
			array( $market, $from, $to )
		);
		$fee_types = array();
		foreach ( $settled as $r ) {
			$this->add( $days, $skus, (string) $r['local_date'], (string) $r['sku'], array( 'amazon_fees' => (float) $r['amt'] ) );
			$fee_types[ (string) $r['charge_type'] ] = ( $fee_types[ (string) $r['charge_type'] ] ?? 0 ) + (float) $r['amt'];
		}

		// 3. Estimated fees for unsettled orders.
		$unit_fee = $this->fee_per_unit( $market, $to );
		$unsettled = Db::rows(
			"SELECT oi.local_date, oi.sku, SUM(oi.qty) AS units, SUM(oi.item_price) AS sales
			 FROM {t:order_items} oi
			 LEFT JOIN (SELECT DISTINCT amazon_order_id FROM {t:fin_events} WHERE event_type = 'Shipment') s ON s.amazon_order_id = oi.amazon_order_id
			 WHERE oi.market = %s AND oi.local_date BETWEEN %s AND %s AND oi.status <> 'Canceled' AND s.amazon_order_id IS NULL
			 GROUP BY oi.local_date, oi.sku",
			array( $market, $from, $to )
		);
		$estimated_total = 0.0;
		foreach ( $unsettled as $r ) {
			$sku = (string) $r['sku'];
			if ( isset( $unit_fee['sku'][ $sku ] ) ) {
				$est = -$unit_fee['sku'][ $sku ] * (int) $r['units'];
			} else {
				$est = -$unit_fee['ratio'] * (float) $r['sales'];
			}
			$estimated_total += $est;
			$this->add( $days, $skus, (string) $r['local_date'], $sku, array( 'amazon_fees' => $est, 'fees_estimated' => $est ) );
		}
		if ( 0.0 !== $estimated_total ) {
			$fee_types['Estimated (unsettled orders)'] = $estimated_total;
		}

		// 4. Posted-date items: refunds, reimbursements, account fees, adjustments, ads invoices.
		$posted = Db::rows(
			"SELECT local_date, sku, category, event_type, charge_type, SUM(amount) AS amt, SUM(qty) AS qty
			 FROM {t:fin_events}
			 WHERE market = %s AND local_date BETWEEN %s AND %s AND (event_type <> 'Shipment' OR category NOT IN ('revenue','fee','promo','tax'))
			 GROUP BY local_date, sku, category, event_type, charge_type",
			array( $market, $from, $to )
		);
		$ads_invoice = array();
		foreach ( $posted as $r ) {
			$d   = (string) $r['local_date'];
			$sku = (string) $r['sku'];
			$amt = (float) $r['amt'];
			switch ( $r['category'] ) {
				case 'refund':
					$this->add( $days, $skus, $d, $sku, array( 'refunds' => $amt, 'refund_units' => 'Principal' === $r['charge_type'] ? abs( (int) $r['qty'] ) : 0 ) );
					break;
				case 'fee':
					// Fees on refunds (refund commission, restocking) belong to the SKU; others are account-level.
					$key = ( 'Refund' === $r['event_type'] && '' !== $sku ) ? 'amazon_fees' : 'account_fees';
					$this->add( $days, $skus, $d, $key === 'amazon_fees' ? $sku : '', array( $key => $amt ) );
					$fee_types[ (string) $r['charge_type'] ] = ( $fee_types[ (string) $r['charge_type'] ] ?? 0 ) + $amt;
					break;
				case 'reimbursement':
					$this->add( $days, $skus, $d, $sku, array( 'reimbursements' => $amt ) );
					break;
				case 'ads':
					$ads_invoice[ $d ] = ( $ads_invoice[ $d ] ?? 0 ) + $amt;
					break;
				case 'tax':
					break;
				case 'promo':
					$this->add( $days, $skus, $d, '', array( 'promo' => $amt ) );
					break;
				default:
					$this->add( $days, $skus, $d, $sku, array( 'adjustments' => $amt ) );
			}
		}

		// 5. Ads: Ads API spend if present, else invoices.
		$ads = Db::rows(
			"SELECT report_date, SUM(cost) AS cost, SUM(sales) AS sales FROM {t:ads_daily}
			 WHERE level = 'campaign' AND report_date BETWEEN %s AND %s GROUP BY report_date",
			array( $from, $to )
		);
		$ads_sales = 0.0;
		if ( $ads ) {
			foreach ( $ads as $r ) {
				if ( isset( $days[ $r['report_date'] ] ) ) {
					$days[ $r['report_date'] ]['ads'] -= (float) $r['cost'];
				}
				$ads_sales += (float) $r['sales'];
			}
		} else {
			foreach ( $ads_invoice as $d => $amt ) {
				if ( isset( $days[ $d ] ) ) {
					$days[ $d ]['ads'] += $amt;
				}
			}
		}

		// 6. COGS add-back for sellable returns.
		$returns = Db::rows(
			"SELECT return_date, sku, SUM(qty) AS qty FROM {t:returns}
			 WHERE market = %s AND return_date BETWEEN %s AND %s AND disposition = 'SELLABLE' GROUP BY return_date, sku",
			array( $market, $from, $to )
		);
		foreach ( $returns as $r ) {
			$this->add( $days, $skus, (string) $r['return_date'], (string) $r['sku'], array( 'cogs' => (int) $r['qty'] * $this->costs->landed( $market, (string) $r['sku'] ) ) );
		}

		// 7. Custom expenses.
		foreach ( $this->expenses( $market, $from, $to ) as $d => $amt ) {
			if ( isset( $days[ $d ] ) ) {
				$days[ $d ]['expenses'] -= $amt;
			}
		}

		// Roll up.
		$include_tax = $this->settings->bool( 'suite_include_tax' );
		$totals = self::blank_day();
		foreach ( $days as $d => &$row ) {
			$row['net_profit'] = self::net( $row, $include_tax );
			foreach ( $row as $k => $v ) {
				$totals[ $k ] += $v;
			}
		}
		unset( $row );
		$totals = self::ratios( $totals );
		$totals['ads_sales'] = $ads_sales;
		$totals['acos_pct']  = $ads_sales > 0 ? round( -$totals['ads'] / $ads_sales * 100, 2 ) : null;
		$totals['tacos_pct'] = $totals['sales'] > 0 ? round( -$totals['ads'] / $totals['sales'] * 100, 2 ) : null;

		$out = array(
			'market'   => $market,
			'currency' => $currency,
			'from'     => $from,
			'to'       => $to,
			'totals'   => $totals,
		);
		if ( ! $detail ) {
			return $out;
		}

		// Allocate ad spend to SKUs by sales share (labelled "allocated").
		$total_sales = max( 0.0001, array_sum( array_column( $skus, 'sales' ) ) );
		$sku_rows = array();
		foreach ( $skus as $sku => $s ) {
			if ( '' === $sku ) {
				continue;
			}
			$s['ads'] = $totals['ads'] * ( $s['sales'] / $total_sales );
			$s['net_profit'] = self::net( $s, $include_tax );
			$s = self::ratios( $s );
			$s['sku'] = $sku;
			$s['has_cost'] = $this->costs->has_cost( $market, $sku );
			$s['unit_cost'] = $this->costs->landed( $market, $sku );
			$sku_rows[] = $s;
		}
		usort( $sku_rows, static fn( $a, $b ) => $b['sales'] <=> $a['sales'] );

		$series = array();
		foreach ( $days as $d => $row ) {
			$series[] = array(
				'date'       => $d,
				'sales'      => round( $row['sales'], 2 ),
				'units'      => (int) $row['units'],
				'orders'     => (int) $row['orders'],
				'net_profit' => round( $row['net_profit'], 2 ),
				'ads'        => round( -$row['ads'], 2 ),
				'refunds'    => round( -$row['refunds'], 2 ),
				'fees'       => round( -$row['amazon_fees'], 2 ),
			);
		}
		arsort( $fee_types );
		$fees = array();
		foreach ( $fee_types as $type => $amt ) {
			if ( abs( $amt ) >= 0.005 ) {
				$fees[] = array( 'type' => $type, 'amount' => round( $amt, 2 ) );
			}
		}
		usort( $fees, static fn( $a, $b ) => $a['amount'] <=> $b['amount'] );

		$out['series']        = $series;
		$out['skus']          = $sku_rows;
		$out['fee_breakdown'] = $fees;
		$out['missing_costs'] = array_values( array_map( static fn( $r ) => $r['sku'], array_filter( $sku_rows, static fn( $r ) => ! $r['has_cost'] && $r['units'] > 0 ) ) );
		$out['waterfall']     = array(
			array( 'label' => 'Sales', 'value' => $totals['sales'] ),
			array( 'label' => 'Promotions', 'value' => $totals['promo'] ),
			array( 'label' => 'Refunds', 'value' => $totals['refunds'] ),
			array( 'label' => 'Amazon fees', 'value' => $totals['amazon_fees'] ),
			array( 'label' => 'Account fees', 'value' => $totals['account_fees'] ),
			array( 'label' => 'Advertising', 'value' => $totals['ads'] ),
			array( 'label' => 'COGS', 'value' => $totals['cogs'] ),
			array( 'label' => 'Reimbursements', 'value' => $totals['reimbursements'] ),
			array( 'label' => 'Adjustments', 'value' => $totals['adjustments'] ),
			array( 'label' => 'Expenses', 'value' => $totals['expenses'] ),
		);
		return $out;
	}

	/** Period-over-period comparison plus month-end forecast. */
	public function dashboard( string $market ): array {
		$today = SuiteTime::today( $market );
		$ranges = array(
			'today'      => array( $today, $today ),
			'yesterday'  => array( SuiteTime::shift( $today, -1 ), SuiteTime::shift( $today, -1 ) ),
			'last_7'     => array( SuiteTime::shift( $today, -6 ), $today ),
			'mtd'        => array( substr( $today, 0, 8 ) . '01', $today ),
			'last_month' => array(
				( new \DateTimeImmutable( $today ) )->modify( 'first day of last month' )->format( 'Y-m-d' ),
				( new \DateTimeImmutable( $today ) )->modify( 'last day of last month' )->format( 'Y-m-d' ),
			),
		);
		$out = array();
		foreach ( $ranges as $key => [ $a, $b ] ) {
			$out[ $key ] = $this->pnl( $market, $a, $b, false )['totals'] + array( 'from' => $a, 'to' => $b );
		}
		// Forecast: month-to-date actuals (excluding partial today) + daily run-rate × remaining days.
		// Early in the month the run-rate comes from the trailing 7 full days instead.
		$day_of_month  = (int) substr( $today, 8, 2 );
		$days_in_month = (int) ( new \DateTimeImmutable( $today ) )->format( 't' );
		$elapsed       = $day_of_month - 1;
		$mtd_ex_today  = $elapsed > 0
			? $this->pnl( $market, substr( $today, 0, 8 ) . '01', SuiteTime::shift( $today, -1 ), false )['totals']
			: self::blank_day();
		if ( $elapsed >= 7 ) {
			$rate = $mtd_ex_today;
			$rate_days = $elapsed;
		} else {
			$rate = $this->pnl( $market, SuiteTime::shift( $today, -7 ), SuiteTime::shift( $today, -1 ), false )['totals'];
			$rate_days = 7;
		}
		$remaining = $days_in_month - $elapsed;
		$out['forecast'] = array(
			'sales'      => round( (float) $mtd_ex_today['sales'] + (float) $rate['sales'] / $rate_days * $remaining, 2 ),
			'net_profit' => round( (float) $mtd_ex_today['net_profit'] + (float) $rate['net_profit'] / $rate_days * $remaining, 2 ),
			'units'      => (int) round( (float) $mtd_ex_today['units'] + (float) $rate['units'] / $rate_days * $remaining ),
			'basis'      => $elapsed >= 7 ? 'month-to-date run-rate' : 'trailing 7-day run-rate',
		);
		return $out;
	}

	/**
	 * Trailing-90-day settled fee per unit per SKU, plus a global fee/sales
	 * ratio fallback (defaults to 30 % — referral + FBA for a typical item —
	 * when the account has no settlement history yet).
	 */
	public function fee_per_unit( string $market, string $to ): array {
		$from = SuiteTime::shift( $to, -90 );
		$rows = Db::rows(
			"SELECT sku,
			        SUM(CASE WHEN category = 'fee' THEN amount ELSE 0 END) AS fees,
			        SUM(CASE WHEN category = 'revenue' AND charge_type = 'Principal' THEN qty ELSE 0 END) AS units,
			        SUM(CASE WHEN category = 'revenue' AND charge_type = 'Principal' THEN amount ELSE 0 END) AS sales
			 FROM {t:fin_events}
			 WHERE market = %s AND event_type = 'Shipment' AND local_date BETWEEN %s AND %s AND sku <> ''
			 GROUP BY sku",
			array( $market, $from, $to )
		);
		$sku = array();
		$tf  = 0.0;
		$ts  = 0.0;
		foreach ( $rows as $r ) {
			if ( (int) $r['units'] > 0 ) {
				$sku[ (string) $r['sku'] ] = abs( (float) $r['fees'] ) / (int) $r['units'];
			}
			$tf += abs( (float) $r['fees'] );
			$ts += (float) $r['sales'];
		}
		return array( 'sku' => $sku, 'ratio' => $ts > 0 ? $tf / $ts : 0.30 );
	}

	/** @return array<string, float> date => expense amount */
	private function expenses( string $market, string $from, string $to ): array {
		$rows = Db::rows(
			"SELECT * FROM {t:expenses} WHERE (market = '' OR market = %s) AND start_date <= %s AND (end_date IS NULL OR end_date >= %s)",
			array( $market, $to, $from )
		);
		$out = array();
		foreach ( $rows as $e ) {
			$amt = (float) $e['amount'];
			if ( 'monthly' === $e['recurrence'] ) {
				$per_day = $amt * 12 / 365.25;
				$start   = max( $from, (string) $e['start_date'] );
				$end     = min( $to, (string) ( $e['end_date'] ?: $to ) );
				for ( $d = $start; $d <= $end; $d = SuiteTime::shift( $d, 1 ) ) {
					$out[ $d ] = ( $out[ $d ] ?? 0 ) + $per_day;
				}
			} elseif ( $e['start_date'] >= $from && $e['start_date'] <= $to ) {
				$out[ (string) $e['start_date'] ] = ( $out[ (string) $e['start_date'] ] ?? 0 ) + $amt;
			}
		}
		return $out;
	}

	private function add( array &$days, array &$skus, string $d, string $sku, array $vals, ?array $meta = null ): void {
		if ( ! isset( $days[ $d ] ) ) {
			return;
		}
		if ( ! isset( $skus[ $sku ] ) ) {
			$skus[ $sku ] = self::blank_day() + array( 'asin' => '', 'title' => '' );
		}
		if ( $meta ) {
			$skus[ $sku ]['asin']  = $skus[ $sku ]['asin'] ?: (string) ( $meta['asin'] ?? '' );
			$skus[ $sku ]['title'] = $skus[ $sku ]['title'] ?: (string) ( $meta['title'] ?? '' );
		}
		foreach ( $vals as $k => $v ) {
			$days[ $d ][ $k ] += $v;
			$skus[ $sku ][ $k ] += $v;
		}
		if ( isset( $vals['units'] ) && isset( $meta['orders'] ) ) {
			$skus[ $sku ]['orders'] += (int) $meta['orders'];
		}
	}

	private static function blank_day(): array {
		return array(
			'orders' => 0, 'units' => 0, 'sales' => 0.0, 'promo' => 0.0, 'refunds' => 0.0, 'refund_units' => 0,
			'amazon_fees' => 0.0, 'fees_estimated' => 0.0, 'account_fees' => 0.0, 'ads' => 0.0, 'cogs' => 0.0,
			'reimbursements' => 0.0, 'adjustments' => 0.0, 'expenses' => 0.0, 'tax_collected' => 0.0, 'net_profit' => 0.0,
		);
	}

	private static function net( array $r, bool $include_tax ): float {
		return $r['sales'] + $r['promo'] + $r['refunds'] + $r['amazon_fees'] + $r['account_fees'] + $r['ads']
			+ $r['cogs'] + $r['reimbursements'] + $r['adjustments'] + $r['expenses']
			+ ( $include_tax ? $r['tax_collected'] : 0.0 );
	}

	private static function ratios( array $t ): array {
		foreach ( $t as $k => $v ) {
			if ( is_float( $v ) ) {
				$t[ $k ] = round( $v, 2 );
			}
		}
		$t['margin_pct']      = $t['sales'] > 0 ? round( $t['net_profit'] / $t['sales'] * 100, 2 ) : null;
		$t['roi_pct']         = $t['cogs'] < 0 ? round( $t['net_profit'] / -$t['cogs'] * 100, 2 ) : null;
		$t['avg_order_value'] = $t['orders'] > 0 ? round( $t['sales'] / $t['orders'], 2 ) : null;
		$t['refund_rate_pct'] = $t['units'] > 0 ? round( $t['refund_units'] / $t['units'] * 100, 2 ) : null;
		return $t;
	}
}
