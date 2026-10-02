<?php
/**
 * SettlementsParser — parse Amazon settlement reports.
 *
 * Amazon provides detailed settlement reports via SP-API Reports endpoint.
 * Type: GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2
 *
 * Each row is a financial event: sale, refund, FBA storage fee, referral fee,
 * reserve, etc. Parsing these gives us TRUE profit per SKU, not just
 * (price - cost) * 0.15 - 3.
 *
 * Flow:
 *   1. CLI/cron calls ReportsClient->request_settlement($start, $end)
 *      → creates a report, polls until done, downloads TSV
 *   2. SettlementsParser->parse($file_content) → array of events
 *   3. Events written to wp_sg_settlements table
 *   4. Analytics dashboard uses aggregated fees for accurate margin
 *
 * For v3.2: we only implement the parser — the Reports API client is
 * deferred because it requires AWS Signature V4 signing for some endpoints.
 * Operators can manually upload a settlement TSV via admin for now.
 *
 * @package SevenGum\Commerce\Amazon\ReportsParser
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon\ReportsParser;

defined( 'ABSPATH' ) || exit;

final class SettlementsParser {

	/**
	 * Parse a settlement TSV file's raw content.
	 *
	 * Returns an array of normalized financial events:
	 *   [
	 *     'date', 'type', 'sku', 'order_id',
	 *     'amount', 'currency', 'description'
	 *   ]
	 *
	 * @param string $tsv_content  Contents of the GET_V2_SETTLEMENT_REPORT file.
	 * @return array<int, array>
	 */
	public function parse( string $tsv_content ): array {
		$lines = preg_split( '/\r?\n/', trim( $tsv_content ) );
		if ( count( $lines ) < 2 ) {
			return array();
		}
		$headers = array_map( 'trim', explode( "\t", (string) array_shift( $lines ) ) );
		// Normalize: lowercase, no spaces, no dashes.
		$headers = array_map( static fn( $h ) => strtolower( preg_replace( '/[^a-z0-9_]/i', '_', (string) $h ) ), $headers );

		$events = array();
		foreach ( $lines as $line ) {
			if ( '' === trim( $line ) ) continue;
			$cols = explode( "\t", $line );
			if ( count( $cols ) !== count( $headers ) ) continue;
			$row = array_combine( $headers, array_map( 'trim', $cols ) );
			$normalized = $this->normalize_row( $row );
			if ( null !== $normalized ) {
				$events[] = $normalized;
			}
		}
		return $events;
	}

	private function normalize_row( array $row ): ?array {
		$type = strtolower( (string) ( $row['transaction_type'] ?? $row['type'] ?? '' ) );
		$amount_str = (string) ( $row['amount'] ?? $row['amount_'] ?? '0' );
		$amount = (float) str_replace( array( ',', ' ' ), '', $amount_str );
		if ( '' === $type ) return null;

		return array(
			'date'        => (string) ( $row['posted_date']       ?? $row['posted_date_time'] ?? '' ),
			'type'        => $this->canonical_type( $type ),
			'sku'         => (string) ( $row['sku']               ?? '' ),
			'order_id'    => (string) ( $row['order_id']          ?? $row['adjustment_id']    ?? '' ),
			'amount'      => round( $amount, 2 ),
			'currency'    => (string) ( $row['currency']          ?? '' ),
			'description' => (string) ( $row['transaction_type']  ?? $row['description']      ?? $type ),
			'marketplace' => (string) ( $row['marketplace_name']  ?? '' ),
		);
	}

	private function canonical_type( string $type ): string {
		$type = strtolower( trim( $type ) );
		if ( str_contains( $type, 'order' ) && ! str_contains( $type, 'refund' ) ) return 'sale';
		if ( str_contains( $type, 'refund' ) )                                      return 'refund';
		if ( str_contains( $type, 'storage' ) )                                     return 'fba_storage';
		if ( str_contains( $type, 'fulfillment' ) || str_contains( $type, 'fba' ) ) return 'fba_fee';
		if ( str_contains( $type, 'referral' ) )                                    return 'referral_fee';
		if ( str_contains( $type, 'advertising' ) )                                 return 'advertising';
		if ( str_contains( $type, 'adjustment' ) )                                  return 'adjustment';
		if ( str_contains( $type, 'reserve' ) )                                     return 'reserve';
		if ( str_contains( $type, 'service' ) )                                     return 'service_fee';
		return 'other';
	}

	/**
	 * Aggregate parsed events into totals per type.
	 *
	 * @param array<int, array> $events
	 */
	public function summary( array $events ): array {
		$totals = array();
		$by_sku = array();
		foreach ( $events as $e ) {
			$type = (string) $e['type'];
			$totals[ $type ] = ( $totals[ $type ] ?? 0.0 ) + (float) $e['amount'];
			if ( '' !== (string) $e['sku'] ) {
				$by_sku[ $e['sku'] ][ $type ] = ( $by_sku[ $e['sku'] ][ $type ] ?? 0.0 ) + (float) $e['amount'];
			}
		}
		ksort( $totals );
		$net = array_sum( $totals );
		return array(
			'event_count' => count( $events ),
			'totals'      => $totals,
			'net'         => round( $net, 2 ),
			'by_sku'      => $by_sku,
		);
	}
}
