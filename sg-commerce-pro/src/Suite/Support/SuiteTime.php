<?php
/**
 * SuiteTime — marketplace-local day bucketing.
 *
 * Seller Central reports days in the marketplace's own timezone (US = Pacific).
 * Bucketing UTC timestamps by UTC date makes "today's sales" disagree with
 * Seller Central for 7–8 hours every day, so every ingest computes a
 * `local_date` column using the marketplace timezone below.
 *
 * @package SevenGum\Commerce\Suite\Support
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Support;

defined( 'ABSPATH' ) || exit;

final class SuiteTime {

	private const TZ = array(
		'US' => 'America/Los_Angeles', 'CA' => 'America/Los_Angeles', 'MX' => 'America/Mexico_City',
		'BR' => 'America/Sao_Paulo', 'UK' => 'Europe/London', 'IE' => 'Europe/Dublin',
		'DE' => 'Europe/Berlin', 'FR' => 'Europe/Paris', 'IT' => 'Europe/Rome', 'ES' => 'Europe/Madrid',
		'NL' => 'Europe/Amsterdam', 'BE' => 'Europe/Brussels', 'SE' => 'Europe/Stockholm',
		'PL' => 'Europe/Warsaw', 'TR' => 'Europe/Istanbul', 'AE' => 'Asia/Dubai', 'SA' => 'Asia/Riyadh',
		'IN' => 'Asia/Kolkata', 'JP' => 'Asia/Tokyo', 'AU' => 'Australia/Sydney', 'SG' => 'Asia/Singapore',
	);

	public static function tz( string $market ): \DateTimeZone {
		return new \DateTimeZone( self::TZ[ strtoupper( $market ) ] ?? 'UTC' );
	}

	/** ISO-8601 / MySQL UTC timestamp → 'Y-m-d' in marketplace time. */
	public static function local_date( string $utc, string $market ): string {
		try {
			$dt = new \DateTimeImmutable( '' === $utc ? 'now' : $utc, new \DateTimeZone( 'UTC' ) );
		} catch ( \Exception ) {
			$dt = new \DateTimeImmutable( 'now', new \DateTimeZone( 'UTC' ) );
		}
		return $dt->setTimezone( self::tz( $market ) )->format( 'Y-m-d' );
	}

	/** ISO-8601 → MySQL DATETIME in UTC. */
	public static function to_mysql( ?string $iso ): ?string {
		if ( null === $iso || '' === $iso ) {
			return null;
		}
		try {
			return ( new \DateTimeImmutable( $iso ) )->setTimezone( new \DateTimeZone( 'UTC' ) )->format( 'Y-m-d H:i:s' );
		} catch ( \Exception ) {
			return null;
		}
	}

	/** Today's date in the marketplace timezone. */
	public static function today( string $market ): string {
		return ( new \DateTimeImmutable( 'now', self::tz( $market ) ) )->format( 'Y-m-d' );
	}

	/** Shift a Y-m-d date by N days. */
	public static function shift( string $ymd, int $days ): string {
		return ( new \DateTimeImmutable( $ymd ) )->modify( sprintf( '%+d days', $days ) )->format( 'Y-m-d' );
	}

	/** Inclusive day count between two Y-m-d dates. */
	public static function days_between( string $from, string $to ): int {
		$a = new \DateTimeImmutable( $from );
		$b = new \DateTimeImmutable( $to );
		return (int) $a->diff( $b )->days + 1;
	}

	/** Validate Y-m-d; fall back to $default. */
	public static function ymd( mixed $value, string $default ): string {
		$v = is_string( $value ) ? $value : '';
		return 1 === preg_match( '/^\d{4}-\d{2}-\d{2}$/', $v ) ? $v : $default;
	}
}
