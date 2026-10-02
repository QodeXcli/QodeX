<?php
/**
 * CacheManager — three-tier cache abstraction.
 *
 * Tier 1: in-request memory (PHP array). Wins for repeated reads in same request.
 * Tier 2: wp_cache_*  (Redis/Memcached if configured, else nothing).
 * Tier 3: transient  (database — survives request, slow but persistent).
 *
 * Reads check tiers in order. Writes populate all three.
 *
 * All keys are auto-prefixed with 'sg_commerce/' to avoid collisions.
 *
 * @package SevenGum\Commerce\Cache
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Cache;

defined( 'ABSPATH' ) || exit;

final class CacheManager {

	private const GROUP = 'sg_commerce';

	/** @var array<string, mixed> */
	private array $memory = array();

	/**
	 * Read a key. Returns $default if not found.
	 */
	public function get( string $key, mixed $default = null ): mixed {
		$full = $this->key( $key );

		// Tier 1: in-request.
		if ( array_key_exists( $full, $this->memory ) ) {
			return $this->memory[ $full ];
		}

		// Tier 2: object cache.
		$found = false;
		$value = wp_cache_get( $full, self::GROUP, false, $found );
		if ( $found ) {
			$this->memory[ $full ] = $value;
			return $value;
		}

		// Tier 3: transient.
		$value = get_transient( $full );
		if ( false !== $value ) {
			$this->memory[ $full ] = $value;
			wp_cache_set( $full, $value, self::GROUP, 0 );
			return $value;
		}

		return $default;
	}

	/**
	 * Write a key with optional TTL (seconds). 0 = no expiration.
	 */
	public function set( string $key, mixed $value, int $ttl = 0 ): void {
		$full = $this->key( $key );
		$this->memory[ $full ] = $value;
		wp_cache_set( $full, $value, self::GROUP, $ttl );
		set_transient( $full, $value, $ttl );
	}

	public function delete( string $key ): void {
		$full = $this->key( $key );
		unset( $this->memory[ $full ] );
		wp_cache_delete( $full, self::GROUP );
		delete_transient( $full );
	}

	/**
	 * Memoize a callable: call it on first access, return cached result thereafter.
	 *
	 * @template T
	 * @param string $key
	 * @param callable(): T $producer
	 * @param int $ttl
	 * @return T
	 */
	public function remember( string $key, callable $producer, int $ttl = 300 ): mixed {
		$value = $this->get( $key, null );
		if ( null !== $value ) {
			return $value;
		}
		$value = $producer();
		if ( null !== $value ) {
			$this->set( $key, $value, $ttl );
		}
		return $value;
	}

	/**
	 * Clear in-request memory tier only (useful in long-running CLI processes).
	 */
	public function flush_memory(): void {
		$this->memory = array();
	}

	private function key( string $key ): string {
		return self::GROUP . '/' . $key;
	}
}
