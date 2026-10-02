<?php
/**
 * Db — thin helpers over $wpdb for the suite tables.
 *
 * upsert() issues INSERT … ON DUPLICATE KEY UPDATE so re-ingesting the same
 * report (Amazon frequently restates rows) is idempotent and never changes
 * row ids, unlike $wpdb->replace().
 *
 * @package SevenGum\Commerce\Suite\Support
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Support;

use SevenGum\Commerce\Suite\SuiteSchema;

defined( 'ABSPATH' ) || exit;

final class Db {

	/**
	 * @param string               $short       Suite table short name.
	 * @param array<string, mixed> $row         Column => value.
	 * @param string[]             $keep        Columns NOT overwritten on conflict.
	 */
	public static function upsert( string $short, array $row, array $keep = array() ): bool {
		global $wpdb;
		if ( ! $row ) {
			return false;
		}
		$table   = SuiteSchema::table( $short );
		$cols    = array_keys( $row );
		$ph      = array();
		$values  = array();
		foreach ( $row as $v ) {
			if ( null === $v ) {
				$ph[] = 'NULL';
				continue;
			}
			if ( is_int( $v ) || is_bool( $v ) ) {
				$ph[]     = '%d';
				$values[] = (int) $v;
			} elseif ( is_float( $v ) ) {
				$ph[]     = '%s';
				$values[] = self::num( $v );
			} else {
				$ph[]     = '%s';
				$values[] = (string) $v;
			}
		}
		$updates = array();
		foreach ( $cols as $col ) {
			if ( ! in_array( $col, $keep, true ) ) {
				$updates[] = "`{$col}` = VALUES(`{$col}`)";
			}
		}
		$sql = "INSERT INTO {$table} (`" . implode( '`,`', $cols ) . '`) VALUES (' . implode( ',', $ph ) . ')';
		if ( $updates ) {
			$sql .= ' ON DUPLICATE KEY UPDATE ' . implode( ', ', $updates );
		}
		$prepared = $values ? $wpdb->prepare( $sql, $values ) : $sql; // phpcs:ignore WordPress.DB.PreparedSQL
		return false !== $wpdb->query( $prepared ); // phpcs:ignore WordPress.DB.PreparedSQL
	}

	/** Upsert many rows; returns count written. */
	public static function upsert_many( string $short, array $rows, array $keep = array() ): int {
		$n = 0;
		foreach ( $rows as $row ) {
			if ( self::upsert( $short, $row, $keep ) ) {
				$n++;
			}
		}
		return $n;
	}

	/** Prepared SELECT returning ARRAY_A rows. `{t:name}` expands to a suite table. */
	public static function rows( string $sql, array $args = array() ): array {
		global $wpdb;
		$sql = self::expand( $sql );
		$res = $wpdb->get_results( $args ? $wpdb->prepare( $sql, $args ) : $sql, ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL
		return is_array( $res ) ? $res : array();
	}

	public static function row( string $sql, array $args = array() ): ?array {
		$rows = self::rows( $sql, $args );
		return $rows[0] ?? null;
	}

	public static function var( string $sql, array $args = array() ): mixed {
		global $wpdb;
		$sql = self::expand( $sql );
		return $wpdb->get_var( $args ? $wpdb->prepare( $sql, $args ) : $sql ); // phpcs:ignore WordPress.DB.PreparedSQL
	}

	public static function exec( string $sql, array $args = array() ): int {
		global $wpdb;
		$sql = self::expand( $sql );
		$res = $wpdb->query( $args ? $wpdb->prepare( $sql, $args ) : $sql ); // phpcs:ignore WordPress.DB.PreparedSQL
		return is_int( $res ) ? $res : 0;
	}

	public static function insert( string $short, array $row ): int {
		global $wpdb;
		$wpdb->insert( SuiteSchema::table( $short ), $row );
		return (int) $wpdb->insert_id;
	}

	public static function update( string $short, array $data, array $where ): int {
		global $wpdb;
		$res = $wpdb->update( SuiteSchema::table( $short ), $data, $where );
		return is_int( $res ) ? $res : 0;
	}

	/** Replace `{t:orders}` placeholders with real table names. */
	public static function expand( string $sql ): string {
		return (string) preg_replace_callback(
			'/\{t:([a-z_]+)\}/',
			static fn( array $m ): string => SuiteSchema::table( $m[1] ),
			$sql
		);
	}

	/** Placeholder list for IN (...) clauses. */
	public static function in( array $values, string $ph = '%s' ): string {
		return implode( ',', array_fill( 0, max( 1, count( $values ) ), $ph ) );
	}

	public static function num( float $v ): string {
		return number_format( $v, 4, '.', '' );
	}

	public static function now(): string {
		return gmdate( 'Y-m-d H:i:s' );
	}
}
