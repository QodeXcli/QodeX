<?php
/**
 * ReportParser — pure decoding of Amazon report documents.
 *
 * SP-API documents are either flat files (tab-separated, header row,
 * sometimes Windows-1252 encoded) or JSON, optionally GZIP-compressed.
 * Ads API v3 reports are GZIP_JSON arrays.
 *
 * No WordPress dependencies — unit-testable in isolation.
 *
 * @package SevenGum\Commerce\Suite\Reports
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Reports;

final class ReportParser {

	/** Decompress when the payload is gzip (magic bytes 1f 8b). */
	public static function maybe_gunzip( string $raw ): string {
		if ( strlen( $raw ) >= 2 && "\x1f\x8b" === substr( $raw, 0, 2 ) ) {
			$out = @gzdecode( $raw );
			if ( false === $out ) {
				throw new \RuntimeException( 'Report document could not be decompressed.' );
			}
			return $out;
		}
		return $raw;
	}

	/** Normalise encoding to UTF-8 and strip a BOM. */
	public static function to_utf8( string $raw ): string {
		if ( str_starts_with( $raw, "\xEF\xBB\xBF" ) ) {
			$raw = substr( $raw, 3 );
		}
		if ( function_exists( 'mb_check_encoding' ) && ! mb_check_encoding( $raw, 'UTF-8' ) ) {
			$converted = function_exists( 'mb_convert_encoding' ) ? mb_convert_encoding( $raw, 'UTF-8', 'Windows-1252' ) : false;
			if ( is_string( $converted ) ) {
				return $converted;
			}
		}
		return $raw;
	}

	/**
	 * Parse a tab-separated flat file into associative rows keyed by a
	 * normalised header (lower-case, spaces/underscores → hyphens).
	 *
	 * @return array<int, array<string, string>>
	 */
	public static function tsv( string $raw ): array {
		$raw   = self::to_utf8( self::maybe_gunzip( $raw ) );
		$lines = preg_split( '/\r\n|\n|\r/', $raw ) ?: array();
		$header = null;
		$rows   = array();
		foreach ( $lines as $line ) {
			if ( '' === trim( $line ) ) {
				continue;
			}
			$cells = explode( "\t", $line );
			if ( null === $header ) {
				$header = array_map( array( self::class, 'normalise_key' ), $cells );
				continue;
			}
			$row = array();
			foreach ( $header as $i => $key ) {
				$row[ $key ] = isset( $cells[ $i ] ) ? trim( $cells[ $i ], " \"" ) : '';
			}
			$rows[] = $row;
		}
		return $rows;
	}

	/** @return array<mixed> */
	public static function json( string $raw ): array {
		$decoded = json_decode( self::to_utf8( self::maybe_gunzip( $raw ) ), true );
		if ( ! is_array( $decoded ) ) {
			throw new \RuntimeException( 'Report document is not valid JSON.' );
		}
		return $decoded;
	}

	public static function normalise_key( string $key ): string {
		$key = strtolower( trim( $key, " \t\"\xEF\xBB\xBF" ) );
		return (string) preg_replace( '/[\s_]+/', '-', $key );
	}

	/** Parse money strings like "1,234.50", "$4.99", "4,99" (EU). */
	public static function money( mixed $v ): float {
		if ( is_int( $v ) || is_float( $v ) ) {
			return (float) $v;
		}
		$s = preg_replace( '/[^\d,.\-]/', '', (string) $v ) ?? '';
		if ( '' === $s ) {
			return 0.0;
		}
		// "1.234,56" → EU format; "1,234.56" → US format; "4,99" → EU decimal.
		if ( str_contains( $s, ',' ) && str_contains( $s, '.' ) ) {
			$s = strrpos( $s, ',' ) > strrpos( $s, '.' )
				? str_replace( array( '.', ',' ), array( '', '.' ), $s )
				: str_replace( ',', '', $s );
		} elseif ( str_contains( $s, ',' ) ) {
			$s = 1 === preg_match( '/,\d{1,2}$/', $s ) ? str_replace( ',', '.', $s ) : str_replace( ',', '', $s );
		}
		return (float) $s;
	}

	/** Parse percent strings like "12.5%" → 12.5. */
	public static function pct( mixed $v ): float {
		return self::money( str_replace( '%', '', (string) $v ) );
	}
}
