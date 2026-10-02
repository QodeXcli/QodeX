<?php
/**
 * ReportPipeline — request → poll → download → ingest for SP-API and Ads
 * reports, tracked in the `sg_suite_reports` table.
 *
 * Each cron tick polls a bounded number of in-flight reports, so the work
 * fits inside shared-hosting execution limits.
 *
 * @package SevenGum\Commerce\Suite\Reports
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Reports;

use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Suite\Ads\AdsClient;
use SevenGum\Commerce\Suite\Ads\AdsSync;
use SevenGum\Commerce\Suite\Support\Db;
use SevenGum\Commerce\Suite\Support\SuiteTime;

defined( 'ABSPATH' ) || exit;

final class ReportPipeline {

	/**
	 * type => [label, schedule (daily|weekly|manual), window days, options]
	 * window 0 = report takes no date range.
	 */
	public const CATALOG = array(
		'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL' => array( 'Orders (all, by order date)', 'daily', 3, array() ),
		'GET_SALES_AND_TRAFFIC_REPORT'                        => array( 'Business Report — Sales & Traffic', 'daily', 1, array( 'dateGranularity' => 'DAY', 'asinGranularity' => 'CHILD' ) ),
		'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'           => array( 'FBA customer returns', 'daily', 14, array() ),
		'GET_FBA_INVENTORY_PLANNING_DATA'                     => array( 'FBA inventory health / aged inventory', 'daily', 0, array() ),
		'GET_SELLER_FEEDBACK_DATA'                            => array( 'Seller feedback', 'daily', 30, array() ),
		'GET_LEDGER_DETAIL_VIEW_DATA'                         => array( 'Inventory ledger (detail)', 'weekly', 60, array() ),
		'GET_FBA_REIMBURSEMENTS_DATA'                         => array( 'FBA reimbursements', 'weekly', 120, array() ),
		'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT' => array( 'Brand Analytics — Search Query Performance', 'weekly', 7, array( 'reportPeriod' => 'WEEK' ) ),
	);

	private const MAX_ATTEMPTS = 90;

	public function __construct(
		private ReportsClient $reports,
		private ReportIngestor $ingestor,
		private AdsClient $ads,
		private AdsSync $ads_sync,
		private Marketplaces $marketplaces,
		private Logger $logger,
	) {}

	/**
	 * Request an SP-API report. Dates are Y-m-d (inclusive) in UTC.
	 */
	public function request( string $type, string $market, ?string $from = null, ?string $to = null, array $options = array() ): int {
		$spec    = self::CATALOG[ $type ] ?? array( $type, 'manual', 0, array() );
		$options = $options + $spec[3];
		$start   = null !== $from ? $from . 'T00:00:00Z' : null;
		$end     = null !== $to ? $to . 'T23:59:59Z' : null;
		$row = array(
			'report_type'  => $type,
			'market'       => $market,
			'source'       => 'sp',
			'status'       => 'requested',
			'data_start'   => null !== $from ? $from . ' 00:00:00' : null,
			'data_end'     => null !== $to ? $to . ' 23:59:59' : null,
			'options'      => wp_json_encode( $options ),
			'requested_at' => Db::now(),
		);
		try {
			$row['remote_id'] = $this->reports->create( $type, $market, $start, $end, $options );
		} catch ( \Throwable $e ) {
			$row['status'] = 'failed';
			$row['error']  = mb_substr( $e->getMessage(), 0, 1000 );
		}
		return Db::insert( 'reports', $row );
	}

	/** Request every report whose schedule is due. */
	public function request_scheduled( string $schedule, array $sqp_asins = array() ): int {
		$n = 0;
		foreach ( $this->marketplaces->enabled_codes() as $market ) {
			$today = SuiteTime::today( $market );
			foreach ( self::CATALOG as $type => [ $label, $sched, $window ] ) {
				if ( $sched !== $schedule ) {
					continue;
				}
				if ( 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT' === $type ) {
					$n += $this->request_sqp( $market, $sqp_asins[ $market ] ?? array() );
					continue;
				}
				if ( 0 === $window ) {
					$this->request( $type, $market );
				} elseif ( 'GET_SALES_AND_TRAFFIC_REPORT' === $type ) {
					// One report per day gives per-day per-ASIN rows; restate the last 3 days.
					foreach ( array( 1, 2, 3 ) as $back ) {
						$d = SuiteTime::shift( $today, -$back );
						$this->request( $type, $market, $d, $d );
						$n++;
					}
					continue;
				} else {
					$this->request( $type, $market, SuiteTime::shift( $today, -$window ), SuiteTime::shift( $today, -1 ) );
				}
				$n++;
			}
		}
		return $n;
	}

	/** Backfill orders + traffic for N days (orders in 30-day chunks). */
	public function backfill( string $market, int $days ): int {
		$n     = 0;
		$today = SuiteTime::today( $market );
		for ( $back = $days; $back > 0; $back -= 30 ) {
			$from = SuiteTime::shift( $today, -$back );
			$to   = SuiteTime::shift( $today, -max( 1, $back - 29 ) );
			$this->request( 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', $market, $from, $to );
			$n++;
		}
		for ( $back = min( $days, 30 ); $back >= 1; $back-- ) {
			$d = SuiteTime::shift( $today, -$back );
			$this->request( 'GET_SALES_AND_TRAFFIC_REPORT', $market, $d, $d );
			$n++;
		}
		return $n;
	}

	/**
	 * SQP requires a full Sunday–Saturday week and ≤ 200 chars of
	 * space-separated ASINs per request.
	 */
	public function request_sqp( string $market, array $asins ): int {
		$asins = array_values( array_unique( array_filter( $asins ) ) );
		if ( ! $asins ) {
			return 0;
		}
		$today = new \DateTimeImmutable( SuiteTime::today( $market ) );
		$sat   = $today->modify( 'last saturday' );
		$sun   = $sat->modify( '-6 days' );
		$n     = 0;
		$chunk = array();
		$flush = function () use ( &$chunk, &$n, $market, $sun, $sat ): void {
			if ( $chunk ) {
				$this->request( 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', $market, $sun->format( 'Y-m-d' ), $sat->format( 'Y-m-d' ), array( 'asin' => implode( ' ', $chunk ) ) );
				$n++;
				$chunk = array();
			}
		};
		foreach ( $asins as $a ) {
			if ( strlen( implode( ' ', array_merge( $chunk, array( $a ) ) ) ) > 200 ) {
				$flush();
			}
			$chunk[] = $a;
		}
		$flush();
		return $n;
	}

	/** Poll in-flight reports; ingest finished ones. */
	public function poll( int $limit = 8 ): array {
		$stats = array( 'checked' => 0, 'completed' => 0, 'failed' => 0, 'rows' => 0 );
		$rows  = Db::rows(
			"SELECT * FROM {t:reports} WHERE status IN ('requested','processing') ORDER BY requested_at ASC LIMIT %d",
			array( $limit )
		);
		foreach ( $rows as $r ) {
			$stats['checked']++;
			$id = (int) $r['id'];
			try {
				$result = 'ads' === $r['source'] ? $this->poll_ads( $r ) : $this->poll_sp( $r );
				if ( null === $result ) {
					$attempts = (int) $r['attempts'] + 1;
					Db::update( 'reports', array(
						'status'   => $attempts >= self::MAX_ATTEMPTS ? 'failed' : 'processing',
						'attempts' => $attempts,
						'error'    => $attempts >= self::MAX_ATTEMPTS ? 'Timed out waiting for Amazon.' : null,
					), array( 'id' => $id ) );
					continue;
				}
				[ $status, $count, $err ] = $result;
				Db::update( 'reports', array(
					'status'        => $status,
					'rows_ingested' => $count,
					'error'         => $err,
					'completed_at'  => Db::now(),
				), array( 'id' => $id ) );
				if ( 'completed' === $status || 'empty' === $status ) {
					$stats['completed']++;
					$stats['rows'] += $count;
					do_action( 'sg_suite_report_ingested', (string) $r['report_type'], (string) $r['market'], $count );
				} else {
					$stats['failed']++;
				}
			} catch ( \Throwable $e ) {
				$stats['failed']++;
				Db::update( 'reports', array(
					'status'   => (int) $r['attempts'] >= 5 ? 'failed' : 'processing',
					'attempts' => (int) $r['attempts'] + 1,
					'error'    => mb_substr( $e->getMessage(), 0, 1000 ),
				), array( 'id' => $id ) );
				$this->logger->warning( 'Suite report poll failed', array( 'id' => $id, 'type' => $r['report_type'], 'error' => $e->getMessage() ) );
			}
		}
		return $stats;
	}

	/** @return array{0:string,1:int,2:?string}|null  null = still processing */
	private function poll_sp( array $r ): ?array {
		$st     = $this->reports->get( (string) $r['remote_id'], (string) $r['market'] );
		$status = (string) ( $st['processingStatus'] ?? '' );
		if ( in_array( $status, array( 'IN_QUEUE', 'IN_PROGRESS', '' ), true ) ) {
			return null;
		}
		if ( 'CANCELLED' === $status ) {
			return array( 'empty', 0, 'Amazon returned no data for this range.' );
		}
		if ( 'FATAL' === $status ) {
			$detail = '';
			if ( ! empty( $st['reportDocumentId'] ) ) {
				try {
					$detail = mb_substr( $this->reports->download( (string) $st['reportDocumentId'], (string) $r['market'] ), 0, 500 );
				} catch ( \Throwable ) {
					$detail = '';
				}
			}
			return array( 'failed', 0, 'FATAL' . ( '' !== $detail ? ': ' . $detail : '' ) );
		}
		$doc = (string) ( $st['reportDocumentId'] ?? '' );
		Db::update( 'reports', array( 'document_id' => $doc ), array( 'id' => (int) $r['id'] ) );
		$raw   = $this->reports->download( $doc, (string) $r['market'] );
		$count = $this->ingestor->ingest( (string) $r['report_type'], (string) $r['market'], $raw, $r );
		return array( 'completed', $count, null );
	}

	private function poll_ads( array $r ): ?array {
		$st     = $this->ads->report_status( (string) $r['remote_id'] );
		$status = strtoupper( (string) ( $st['status'] ?? '' ) );
		if ( 'FAILED' === $status ) {
			return array( 'failed', 0, (string) ( $st['failureReason'] ?? 'Ads report failed.' ) );
		}
		if ( 'COMPLETED' !== $status || empty( $st['url'] ) ) {
			return null;
		}
		$count = $this->ads_sync->ingest( (string) $r['report_type'], $this->ads->download( (string) $st['url'] ) );
		return array( 'completed', $count, null );
	}

	/** Housekeeping: drop report rows older than 90 days. */
	public function prune(): int {
		return Db::exec( 'DELETE FROM {t:reports} WHERE requested_at < %s', array( gmdate( 'Y-m-d H:i:s', time() - 90 * DAY_IN_SECONDS ) ) );
	}
}
