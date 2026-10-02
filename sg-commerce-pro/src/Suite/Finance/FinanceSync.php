<?php
/**
 * FinanceSync — incremental pull of SP-API Finances v0 financial events.
 *
 *   GET /finances/v0/financialEvents?PostedAfter=…&PostedBefore=…&MaxResultsPerPage=100
 *
 * Works window-by-window (7 days max) per region with a persisted cursor,
 * so a first-time backfill of 60+ days spreads across several cron ticks
 * instead of blowing PHP's max_execution_time on shared hosting.
 *
 * @package SevenGum\Commerce\Suite\Finance
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Finance;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Suite\SuiteSettings;
use SevenGum\Commerce\Suite\Support\Db;
use SevenGum\Commerce\Suite\Support\SuiteTime;

defined( 'ABSPATH' ) || exit;

final class FinanceSync {

	private const CURSOR_OPTION = 'sg_suite_fin_cursor_';
	private const WINDOW_DAYS   = 7;
	private const MAX_PAGES     = 15;

	public function __construct(
		private AmazonClient $client,
		private Marketplaces $marketplaces,
		private SuiteSettings $settings,
		private Logger $logger,
	) {}

	/** @return array{regions:int, lines:int, windows:int} */
	public function run(): array {
		$stats = array( 'regions' => 0, 'lines' => 0, 'windows' => 0 );
		if ( ! $this->client->has_credentials() ) {
			return $stats;
		}
		foreach ( $this->region_anchor_markets() as $region => $market ) {
			$stats['regions']++;
			$pages = 0;
			$until = time() - 5 * MINUTE_IN_SECONDS;
			while ( $pages < self::MAX_PAGES ) {
				$cursor = (int) get_option( self::CURSOR_OPTION . $region, 0 );
				if ( $cursor <= 0 ) {
					$cursor = time() - $this->settings->int( 'suite_backfill_days' ) * DAY_IN_SECONDS;
				}
				if ( $cursor >= $until - 60 ) {
					break;
				}
				$end = min( $until, $cursor + self::WINDOW_DAYS * DAY_IN_SECONDS );
				[ $lines, $used, $complete ] = $this->fetch_window( $market, $cursor, $end, self::MAX_PAGES - $pages );
				$pages += $used;
				$stats['lines'] += $lines;
				if ( ! $complete ) {
					break; // Page budget exhausted mid-window; retry the window next tick (idempotent).
				}
				update_option( self::CURSOR_OPTION . $region, $end, false );
				$stats['windows']++;
			}
		}
		return $stats;
	}

	/** Reset cursors (forces a full re-backfill). */
	public static function reset_cursors(): void {
		foreach ( array( 'na', 'eu', 'fe' ) as $r ) {
			delete_option( self::CURSOR_OPTION . $r );
		}
	}

	/** @return array{0:int,1:int,2:bool} lines written, pages used, window complete */
	private function fetch_window( string $market, int $from, int $to, int $page_budget ): array {
		$query = array(
			'PostedAfter'       => gmdate( 'Y-m-d\TH:i:s\Z', $from ),
			'PostedBefore'      => gmdate( 'Y-m-d\TH:i:s\Z', $to ),
			'MaxResultsPerPage' => 100,
		);
		$written = 0;
		$pages   = 0;
		$seen    = array();
		do {
			$res     = $this->client->request( 'GET', $market, '/finances/v0/financialEvents', $query, null, 'finances.events' );
			$payload = (array) ( $res['payload'] ?? array() );
			$lines   = FinancialEventFlattener::flatten( (array) ( $payload['FinancialEvents'] ?? array() ), $query['PostedBefore'] );
			$written += $this->store( $lines, $market, $seen );
			$pages++;
			$next = (string) ( $payload['NextToken'] ?? '' );
			$query = '' !== $next ? array( 'NextToken' => $next ) : array();
		} while ( '' !== ( $next ?? '' ) && $pages < $page_budget );

		return array( $written, $pages, '' === ( $next ?? '' ) );
	}

	/**
	 * @param array<string,int> $seen  base-hash occurrence counter (window-scoped)
	 */
	public function store( array $lines, string $default_market, array &$seen, bool $demo = false ): int {
		$n = 0;
		foreach ( $lines as $line ) {
			$market = $this->market_from_name( $line['marketplace'] ) ?: $default_market;
			$base   = FinancialEventFlattener::hash( $line, 0 );
			$seen[ $base ] = ( $seen[ $base ] ?? -1 ) + 1;
			$hash   = 0 === $seen[ $base ] ? $base : FinancialEventFlattener::hash( $line, $seen[ $base ] );
			$posted = SuiteTime::to_mysql( $line['posted'] ) ?? Db::now();
			$ok = Db::upsert( 'fin_events', array(
				'market'          => $market,
				'event_hash'      => $hash,
				'posted_date'     => $posted,
				'local_date'      => SuiteTime::local_date( $posted, $market ),
				'event_type'      => $line['event_type'],
				'amazon_order_id' => $line['order_id'],
				'sku'             => $line['sku'],
				'charge_type'     => $line['charge_type'],
				'category'        => $line['category'],
				'amount'          => (float) $line['amount'],
				'currency'        => $line['currency'],
				'qty'             => (int) $line['qty'],
				'is_demo'         => $demo ? 1 : 0,
			) );
			if ( $ok ) {
				$n++;
			}
		}
		return $n;
	}

	/** "Amazon.com" → US, "Amazon.co.uk" → UK, "Amazon.ae" → AE. */
	public function market_from_name( string $name ): string {
		$name = strtolower( trim( $name ) );
		if ( '' === $name || ! str_starts_with( $name, 'amazon.' ) ) {
			return '';
		}
		$tld = substr( $name, 7 );
		foreach ( $this->marketplaces->all() as $code => $m ) {
			if ( ( $m['tld'] ?? '' ) === $tld ) {
				return (string) $code;
			}
		}
		return '';
	}

	/** One enabled market per SP-API region (finance events are region-wide). */
	private function region_anchor_markets(): array {
		$out = array();
		$primary = $this->marketplaces->primary();
		$codes   = array_unique( array_merge( array( $primary ), $this->marketplaces->enabled_codes() ) );
		foreach ( $codes as $code ) {
			$mp = $this->marketplaces->get( $code );
			if ( $mp && ! isset( $out[ $mp['region'] ] ) ) {
				$out[ $mp['region'] ] = $code;
			}
		}
		return $out;
	}
}
