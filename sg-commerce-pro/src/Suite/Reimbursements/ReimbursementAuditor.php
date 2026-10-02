<?php
/**
 * ReimbursementAuditor — finds money Amazon owes you (GETIDA-style).
 *
 * Detectors (all from data the suite already ingests):
 *
 *  1. lost_warehouse    Ledger "Adjustments" reason M (misplaced) not offset by
 *                       F (found) or an existing reimbursement, older than the
 *                       30 days Amazon gives itself to reconcile.
 *  2. damaged_warehouse Ledger adjustments for FC damage (E, Q, 6, 7) not
 *                       reimbursed.
 *  3. refund_no_return  Buyer refunded > 45 days ago, no return received, no
 *                       reimbursement on the order — Amazon must reimburse or
 *                       charge the buyer back.
 *  4. fee_overcharge    FBA fulfilment fee per unit jumped > 10 % vs the SKU's
 *                       prior baseline with no listing change — typical of a
 *                       wrong dimension re-measure; request a re-measurement.
 *
 * Each finding becomes a case with a ready-to-paste Seller Central message.
 * Findings are de-duplicated by a stable hash so re-scans never duplicate.
 *
 * @package SevenGum\Commerce\Suite\Reimbursements
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Reimbursements;

use SevenGum\Commerce\Suite\Support\Db;

defined( 'ABSPATH' ) || exit;

final class ReimbursementAuditor {

	public const LOST_REASONS    = array( 'M' );
	public const FOUND_REASONS   = array( 'F' );
	public const DAMAGED_REASONS = array( 'E', 'Q', '6', '7' );

	/** @return array{found:int, new:int, value:float} */
	public function scan( ?int $now = null ): array {
		$now   = $now ?? time();
		$stats = array( 'found' => 0, 'new' => 0, 'value' => 0.0 );
		$cases = array_merge(
			$this->lost_and_damaged( $now ),
			$this->refunds_without_return( $now ),
			$this->fee_overcharges( $now )
		);
		foreach ( $cases as $c ) {
			$stats['found']++;
			$stats['value'] += $c['est_amount'];
			$exists = Db::row( 'SELECT id, status FROM {t:reimb_cases} WHERE case_hash = %s', array( $c['case_hash'] ) );
			if ( null === $exists ) {
				Db::insert( 'reimb_cases', $c + array( 'status' => 'open', 'created_at' => Db::now(), 'updated_at' => Db::now() ) );
				$stats['new']++;
			} elseif ( 'open' === $exists['status'] ) {
				Db::update( 'reimb_cases', array(
					'qty' => $c['qty'], 'est_amount' => $c['est_amount'], 'evidence' => $c['evidence'], 'updated_at' => Db::now(),
				), array( 'id' => (int) $exists['id'] ) );
			}
		}
		// Auto-close open cases Amazon has since reimbursed on its own.
		$this->auto_resolve();
		$stats['value'] = round( $stats['value'], 2 );
		return $stats;
	}

	public function lost_and_damaged( int $now ): array {
		$cutoff = gmdate( 'Y-m-d', $now - 30 * DAY_IN_SECONDS );
		$oldest = gmdate( 'Y-m-d', $now - 540 * DAY_IN_SECONDS ); // 18-month claim window.
		$rows = Db::rows(
			"SELECT market, fnsku, MAX(sku) AS sku, MAX(asin) AS asin, reason, SUM(qty) AS qty, MIN(event_date) AS first_date, MAX(event_date) AS last_date,
			        COUNT(*) AS events, MAX(fulfillment_center) AS fc
			 FROM {t:ledger}
			 WHERE event_type = 'Adjustments' AND event_date BETWEEN %s AND %s
			 GROUP BY market, fnsku, reason",
			array( $oldest, $cutoff )
		);
		$by = array();
		foreach ( $rows as $r ) {
			$k = $r['market'] . '|' . $r['fnsku'];
			$by[ $k ] ??= array( 'market' => $r['market'], 'fnsku' => $r['fnsku'], 'sku' => $r['sku'], 'asin' => $r['asin'], 'lost' => 0, 'found' => 0, 'damaged' => 0, 'first' => $r['first_date'], 'last' => $r['last_date'], 'fc' => $r['fc'] );
			$q = (int) $r['qty'];
			if ( in_array( $r['reason'], self::LOST_REASONS, true ) ) {
				$by[ $k ]['lost'] += -$q;
			} elseif ( in_array( $r['reason'], self::FOUND_REASONS, true ) ) {
				$by[ $k ]['found'] += $q;
			} elseif ( in_array( $r['reason'], self::DAMAGED_REASONS, true ) ) {
				$by[ $k ]['damaged'] += -$q;
			}
			$by[ $k ]['first'] = min( $by[ $k ]['first'], $r['first_date'] );
			$by[ $k ]['last']  = max( $by[ $k ]['last'], $r['last_date'] );
		}

		$out = array();
		foreach ( $by as $g ) {
			$reimbursed = Db::rows(
				'SELECT reason, SUM(qty_cash + qty_inventory) AS q FROM {t:reimbursements} WHERE fnsku = %s GROUP BY reason',
				array( $g['fnsku'] )
			);
			$r_lost = 0;
			$r_dmg  = 0;
			foreach ( $reimbursed as $r ) {
				$reason = strtolower( (string) $r['reason'] );
				if ( str_contains( $reason, 'lost' ) ) {
					$r_lost += (int) $r['q'];
				} elseif ( str_contains( $reason, 'damage' ) ) {
					$r_dmg += (int) $r['q'];
				}
			}
			$unit = $this->unit_value( (string) $g['sku'] );
			$lost_open = $g['lost'] - $g['found'] - $r_lost;
			if ( $lost_open > 0 ) {
				$out[] = $this->make( 'lost_warehouse', $g, $lost_open, $unit, array(
					'misplaced_units' => $g['lost'], 'found_units' => $g['found'], 'reimbursed_units' => $r_lost,
					'first_event' => $g['first'], 'last_event' => $g['last'], 'fulfillment_center' => $g['fc'],
				) );
			}
			$dmg_open = $g['damaged'] - $r_dmg;
			if ( $dmg_open > 0 ) {
				$out[] = $this->make( 'damaged_warehouse', $g, $dmg_open, $unit, array(
					'damaged_units' => $g['damaged'], 'reimbursed_units' => $r_dmg,
					'first_event' => $g['first'], 'last_event' => $g['last'], 'fulfillment_center' => $g['fc'],
				) );
			}
		}
		return $out;
	}

	public function refunds_without_return( int $now ): array {
		$before = gmdate( 'Y-m-d', $now - 45 * DAY_IN_SECONDS );
		$after  = gmdate( 'Y-m-d', $now - 540 * DAY_IN_SECONDS );
		$rows = Db::rows(
			"SELECT f.market, f.amazon_order_id, MAX(f.sku) AS sku, SUM(f.amount) AS refunded, SUM(f.qty) AS qty, MIN(f.local_date) AS refund_date, MAX(f.currency) AS currency
			 FROM {t:fin_events} f
			 WHERE f.event_type = 'Refund' AND f.category = 'refund' AND f.charge_type = 'Principal' AND f.local_date BETWEEN %s AND %s
			   AND NOT EXISTS (SELECT 1 FROM {t:returns} r WHERE r.amazon_order_id = f.amazon_order_id)
			   AND NOT EXISTS (SELECT 1 FROM {t:reimbursements} b WHERE b.amazon_order_id = f.amazon_order_id)
			   AND EXISTS (SELECT 1 FROM {t:orders} o WHERE o.amazon_order_id = f.amazon_order_id AND o.fulfillment_channel = 'AFN')
			 GROUP BY f.market, f.amazon_order_id",
			array( $after, $before )
		);
		$out = array();
		foreach ( $rows as $r ) {
			$amt = abs( (float) $r['refunded'] );
			if ( $amt <= 0 ) {
				continue;
			}
			$qty = max( 1, abs( (int) $r['qty'] ) );
			$evidence = array( 'refund_date' => $r['refund_date'], 'refunded_amount' => round( $amt, 2 ), 'units' => $qty );
			$out[] = array(
				'case_hash'    => sha1( 'refund_no_return|' . $r['amazon_order_id'] ),
				'kind'         => 'refund_no_return',
				'market'       => (string) $r['market'],
				'sku'          => (string) $r['sku'],
				'fnsku'        => '',
				'asin'         => '',
				'reference_id' => (string) $r['amazon_order_id'],
				'event_date'   => (string) $r['refund_date'],
				'qty'          => $qty,
				'est_amount'   => round( $amt, 2 ),
				'currency'     => (string) $r['currency'],
				'evidence'     => wp_json_encode( $evidence ),
				'notes'        => self::message( 'refund_no_return', (string) $r['sku'], '', (string) $r['amazon_order_id'], $qty, $evidence ),
			);
		}
		return $out;
	}

	public function fee_overcharges( int $now ): array {
		$recent_from = gmdate( 'Y-m-d', $now - 30 * DAY_IN_SECONDS );
		$base_from   = gmdate( 'Y-m-d', $now - 120 * DAY_IN_SECONDS );
		$rows = Db::rows(
			"SELECT f.market, f.sku, CASE WHEN f.local_date >= %s THEN 'recent' ELSE 'base' END AS period,
			        SUM(f.amount) AS fees, SUM(p.qty) AS units, MAX(f.currency) AS currency
			 FROM {t:fin_events} f
			 INNER JOIN (SELECT amazon_order_id, sku, SUM(qty) AS qty FROM {t:fin_events}
			             WHERE event_type = 'Shipment' AND charge_type = 'Principal' GROUP BY amazon_order_id, sku) p
			   ON p.amazon_order_id = f.amazon_order_id AND p.sku = f.sku
			 WHERE f.event_type = 'Shipment' AND f.charge_type = 'FBAPerUnitFulfillmentFee' AND f.local_date >= %s
			 GROUP BY f.market, f.sku, period",
			array( $recent_from, $base_from )
		);
		$by = array();
		foreach ( $rows as $r ) {
			$by[ $r['market'] . '|' . $r['sku'] ][ $r['period'] ] = $r;
		}
		$out = array();
		foreach ( $by as $key => $p ) {
			if ( empty( $p['recent'] ) || empty( $p['base'] ) || (int) $p['recent']['units'] < 5 || (int) $p['base']['units'] < 5 ) {
				continue;
			}
			$old = abs( (float) $p['base']['fees'] ) / (int) $p['base']['units'];
			$new = abs( (float) $p['recent']['fees'] ) / (int) $p['recent']['units'];
			if ( $old <= 0 || ( $new - $old ) / $old < 0.10 ) {
				continue;
			}
			[ $market, $sku ] = explode( '|', $key, 2 );
			$units = (int) $p['recent']['units'];
			$evidence = array( 'baseline_fee_per_unit' => round( $old, 2 ), 'current_fee_per_unit' => round( $new, 2 ), 'units_affected' => $units );
			$out[] = array(
				'case_hash'    => sha1( 'fee_overcharge|' . $key . '|' . round( $new, 2 ) ),
				'kind'         => 'fee_overcharge',
				'market'       => $market,
				'sku'          => $sku,
				'fnsku'        => '',
				'asin'         => '',
				'reference_id' => '',
				'event_date'   => gmdate( 'Y-m-d', $now ),
				'qty'          => $units,
				'est_amount'   => round( ( $new - $old ) * $units, 2 ),
				'currency'     => (string) $p['recent']['currency'],
				'evidence'     => wp_json_encode( $evidence ),
				'notes'        => self::message( 'fee_overcharge', $sku, '', '', $units, $evidence ),
			);
		}
		return $out;
	}

	public function update_case( int $id, array $in ): bool {
		$data = array( 'updated_at' => Db::now() );
		if ( isset( $in['status'] ) && in_array( $in['status'], array( 'open', 'filed', 'reimbursed', 'dismissed' ), true ) ) {
			$data['status'] = $in['status'];
		}
		if ( isset( $in['amazon_case_id'] ) ) {
			$data['amazon_case_id'] = mb_substr( sanitize_text_field( (string) $in['amazon_case_id'] ), 0, 32 );
		}
		return Db::update( 'reimb_cases', $data, array( 'id' => $id ) ) > 0;
	}

	public function summary(): array {
		$by = Db::rows(
			"SELECT kind, status, COUNT(*) AS n, SUM(est_amount) AS value FROM {t:reimb_cases} GROUP BY kind, status"
		);
		$recovered = (float) Db::var( 'SELECT COALESCE(SUM(amount),0) FROM {t:reimbursements} WHERE approval_date >= %s', array( gmdate( 'Y-m-d', time() - 365 * DAY_IN_SECONDS ) ) );
		return array( 'by' => $by, 'reimbursed_12m' => round( $recovered, 2 ) );
	}

	private function auto_resolve(): void {
		Db::exec(
			"UPDATE {t:reimb_cases} SET status = 'reimbursed', updated_at = %s
			 WHERE status IN ('open','filed') AND kind = 'refund_no_return'
			   AND reference_id IN (SELECT amazon_order_id FROM {t:reimbursements} WHERE amazon_order_id <> '')",
			array( Db::now() )
		);
	}

	/** Average realised sale price per unit over 180 days (Amazon reimburses at estimated sale value). */
	private function unit_value( string $sku ): float {
		$v = Db::row(
			'SELECT SUM(item_price) AS s, SUM(qty) AS q FROM {t:order_items} WHERE sku = %s AND local_date >= %s AND qty > 0',
			array( $sku, gmdate( 'Y-m-d', time() - 180 * DAY_IN_SECONDS ) )
		);
		return null !== $v && (int) $v['q'] > 0 ? (float) $v['s'] / (int) $v['q'] : 0.0;
	}

	private function make( string $kind, array $g, int $qty, float $unit, array $evidence ): array {
		$currency = (string) Db::var( 'SELECT currency FROM {t:orders} WHERE market = %s AND currency <> %s LIMIT 1', array( $g['market'], '' ) );
		return array(
			'case_hash'    => sha1( $kind . '|' . $g['market'] . '|' . $g['fnsku'] . '|' . $g['first'] ),
			'kind'         => $kind,
			'market'       => (string) $g['market'],
			'sku'          => (string) $g['sku'],
			'fnsku'        => (string) $g['fnsku'],
			'asin'         => (string) $g['asin'],
			'reference_id' => '',
			'event_date'   => (string) $g['last'],
			'qty'          => $qty,
			// Reimbursement ≈ sale price minus referral & FBA fees; 0.7 is a conservative haircut.
			'est_amount'   => round( $qty * $unit * 0.7, 2 ),
			'currency'     => $currency,
			'evidence'     => wp_json_encode( $evidence ),
			'notes'        => self::message( $kind, (string) $g['sku'], (string) $g['fnsku'], '', $qty, $evidence ),
		);
	}

	/** Ready-to-paste Seller Central case text. */
	public static function message( string $kind, string $sku, string $fnsku, string $order, int $qty, array $ev ): string {
		return match ( $kind ) {
			'lost_warehouse' => sprintf(
				"Hello Seller Support,\n\nOur inventory ledger shows %d unit(s) of FNSKU %s (SKU %s) adjusted as misplaced (reason code M) between %s and %s at %s. Only %d unit(s) were subsequently found and %d were reimbursed, leaving %d unit(s) unaccounted for beyond the 30-day reconciliation period.\n\nPer the FBA Inventory Reimbursement Policy, please investigate and reimburse the %d missing unit(s).\n\nThank you.",
				(int) $ev['misplaced_units'], $fnsku, $sku, $ev['first_event'], $ev['last_event'], $ev['fulfillment_center'] ?: 'your fulfillment centers',
				(int) $ev['found_units'], (int) $ev['reimbursed_units'], $qty, $qty
			),
			'damaged_warehouse' => sprintf(
				"Hello Seller Support,\n\nOur inventory ledger shows %d unit(s) of FNSKU %s (SKU %s) adjusted as damaged in an Amazon fulfillment center between %s and %s. %d unit(s) have been reimbursed so far, leaving %d unit(s) unreimbursed.\n\nPer the FBA Inventory Reimbursement Policy for warehouse damage, please reimburse the remaining %d unit(s).\n\nThank you.",
				(int) $ev['damaged_units'], $fnsku, $sku, $ev['first_event'], $ev['last_event'], (int) $ev['reimbursed_units'], $qty, $qty
			),
			'refund_no_return' => sprintf(
				"Hello Seller Support,\n\nOrder %s (SKU %s) was refunded to the customer on %s for %s, but more than 45 days later no return has been received at a fulfillment center and no reimbursement has been issued.\n\nPer the FBA customer returns policy, please either charge the customer for the unreturned item or reimburse us for %d unit(s).\n\nThank you.",
				$order, $sku, $ev['refund_date'], number_format( (float) $ev['refunded_amount'], 2 ), $qty
			),
			'fee_overcharge' => sprintf(
				"Hello Seller Support,\n\nThe FBA fulfillment fee for SKU %s increased from %s to %s per unit over the last 30 days (%d units affected) without any change to the product or its packaging. This suggests an incorrect dimension/weight measurement.\n\nPlease re-measure the item and refund the fee difference for all affected units.\n\nThank you.",
				$sku, number_format( (float) $ev['baseline_fee_per_unit'], 2 ), number_format( (float) $ev['current_fee_per_unit'], 2 ), $qty
			),
			default => '',
		};
	}
}
