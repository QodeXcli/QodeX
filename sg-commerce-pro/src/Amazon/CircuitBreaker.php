<?php
/**
 * CircuitBreaker — fail-fast when a downstream is unhealthy.
 *
 * Three states:
 *   CLOSED   — normal operation, all calls pass through.
 *   OPEN     — last N calls failed, all calls rejected for cooldown period.
 *   HALF_OPEN — cooldown elapsed; next call probes the downstream.
 *
 * State persists in cache so it spans requests. Tripped breaker logs at
 * WARNING level so the admin sees it.
 *
 * @package SevenGum\Commerce\Amazon
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon;

use SevenGum\Commerce\Cache\CacheManager;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class CircuitBreaker {

	private const STATE_CLOSED    = 'closed';
	private const STATE_OPEN      = 'open';
	private const STATE_HALF_OPEN = 'half_open';

	private const FAILURE_THRESHOLD = 5;
	private const COOLDOWN_SECONDS  = 60;

	public function __construct( private CacheManager $cache, private Logger $logger ) {}

	/** Throws if the breaker is open. Caller invokes on every attempt. */
	public function guard( string $key ): void {
		$state = $this->state( $key );
		if ( self::STATE_OPEN === $state['state'] ) {
			$elapsed = time() - (int) $state['opened_at'];
			if ( $elapsed >= self::COOLDOWN_SECONDS ) {
				// Transition OPEN → HALF_OPEN.
				$state['state'] = self::STATE_HALF_OPEN;
				$this->save( $key, $state );
				return;
			}
			$remaining = self::COOLDOWN_SECONDS - $elapsed;
			throw new \RuntimeException( "Circuit breaker open for '{$key}' — retry in {$remaining}s." );
		}
	}

	public function record_success( string $key ): void {
		$state = $this->state( $key );
		if ( self::STATE_CLOSED !== $state['state'] || $state['failures'] > 0 ) {
			$this->save( $key, array( 'state' => self::STATE_CLOSED, 'failures' => 0, 'opened_at' => 0 ) );
			if ( self::STATE_CLOSED !== $state['state'] ) {
				$this->logger->info( "Circuit breaker '{$key}' recovered to CLOSED." );
			}
		}
	}

	public function record_failure( string $key ): void {
		$state = $this->state( $key );
		$state['failures'] = (int) $state['failures'] + 1;

		if ( self::STATE_HALF_OPEN === $state['state'] || $state['failures'] >= self::FAILURE_THRESHOLD ) {
			$this->logger->warning( "Circuit breaker '{$key}' tripped to OPEN after {$state['failures']} failures." );
			$state['state']     = self::STATE_OPEN;
			$state['opened_at'] = time();
		}
		$this->save( $key, $state );
	}

	private function state( string $key ): array {
		$raw = $this->cache->get( 'circuit/' . $key, null );
		if ( ! is_array( $raw ) ) {
			return array( 'state' => self::STATE_CLOSED, 'failures' => 0, 'opened_at' => 0 );
		}
		return array(
			'state'     => (string) ( $raw['state'] ?? self::STATE_CLOSED ),
			'failures'  => (int) ( $raw['failures'] ?? 0 ),
			'opened_at' => (int) ( $raw['opened_at'] ?? 0 ),
		);
	}

	private function save( string $key, array $state ): void {
		$this->cache->set( 'circuit/' . $key, $state, HOUR_IN_SECONDS );
	}
}
