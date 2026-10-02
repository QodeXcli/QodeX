<?php
/**
 * RateLimiter — per-endpoint token bucket.
 *
 * Amazon SP-API documents per-endpoint rate limits (e.g. fbaInventory:
 * 2 req/s, burst 2). We model each endpoint as a token bucket and refuse
 * to fire requests that would overshoot — caller can sleep+retry.
 *
 * Bucket state lives in the cache (so it persists across requests).
 *
 * Usage:
 *   if ($rate_limiter->try_acquire('fbaInventory.summaries')) { ... }
 *
 * @package SevenGum\Commerce\Amazon
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon;

use SevenGum\Commerce\Cache\CacheManager;

defined( 'ABSPATH' ) || exit;

final class RateLimiter {

	/** Per-endpoint config: [refill_per_sec, burst_capacity]. */
	private const LIMITS = array(
		'fbaInventory.summaries'         => array( 2.0, 2 ),
		'sellers.marketplaceParticipations' => array( 0.5, 1 ),
		'pricing.itemOffers'             => array( 0.5, 1 ),
		'pricing.competitivePricing'     => array( 0.5, 1 ),
		'reports.create'                 => array( 0.0167, 15 ),  // ~1/min
		'reports.get'                    => array( 2.0, 15 ),
		'orders.list'                    => array( 0.0167, 20 ),
		'listings.patch'                 => array( 5.0, 5 ),
		// v4.0 — Seller Suite (rates from the SP-API usage-plan docs).
		'reports.document'               => array( 0.0167, 15 ),
		'orders.items'                   => array( 0.5, 30 ),
		'finances.events'                => array( 0.5, 30 ),
		'listings.get'                   => array( 5.0, 10 ),
		'catalog.search'                 => array( 2.0, 2 ),
		'fees.estimate'                  => array( 1.0, 2 ),
		'solicitations'                  => array( 1.0, 5 ),
	);

	public function __construct( private CacheManager $cache ) {}

	/**
	 * Try to acquire one token. Returns true on success, false if depleted.
	 */
	public function try_acquire( string $endpoint ): bool {
		[ $refill, $capacity ] = self::LIMITS[ $endpoint ] ?? array( 1.0, 5 );
		$now = microtime( true );

		$key = 'ratelimit/' . $endpoint;
		$bucket = $this->cache->get( $key, array( 'tokens' => $capacity, 'last' => $now ) );

		// Refill since last check.
		$elapsed = max( 0.0, $now - (float) $bucket['last'] );
		$tokens  = min( $capacity, (float) $bucket['tokens'] + $elapsed * $refill );

		if ( $tokens >= 1.0 ) {
			$tokens -= 1.0;
			$this->cache->set( $key, array( 'tokens' => $tokens, 'last' => $now ), 300 );
			return true;
		}
		// Persist the (still-low) state.
		$this->cache->set( $key, array( 'tokens' => $tokens, 'last' => $now ), 300 );
		return false;
	}

	/**
	 * Block until a token is available, with a max wait. Returns true if
	 * acquired, false if max wait exceeded.
	 */
	public function acquire_blocking( string $endpoint, float $max_wait_sec = 5.0 ): bool {
		$deadline = microtime( true ) + $max_wait_sec;
		while ( microtime( true ) < $deadline ) {
			if ( $this->try_acquire( $endpoint ) ) {
				return true;
			}
			usleep( 200_000 ); // 200ms
		}
		return false;
	}
}
