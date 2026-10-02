<?php
/**
 * EventDispatcher — domain events.
 *
 * Thin bridge over WP do_action/add_action that lets us emit and listen for
 * domain events with type-safe payload. Used to decouple modules:
 *
 *   AmazonModule emits 'product.synced' → AnalyticsModule + RepricerModule react.
 *
 * Why bridge over WP hooks at all? Two reasons:
 *   1. Events are namespaced (`sg_commerce.product.synced`) and discoverable
 *      via list_events().
 *   2. We can later swap to a true PSR-14 dispatcher without touching emit sites.
 *
 * @package SevenGum\Commerce\Events
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Events;

defined( 'ABSPATH' ) || exit;

final class EventDispatcher {

	private const HOOK_PREFIX = 'sg_commerce.';

	/** @var array<string, true> Registered event names (for introspection). */
	private array $known = array();

	/**
	 * Emit an event. Listeners receive the $payload array as their single
	 * argument. Listeners may mutate $payload (returned by reference).
	 */
	public function emit( string $event, array $payload = array() ): array {
		$this->known[ $event ] = true;
		$payload = apply_filters( self::HOOK_PREFIX . $event, $payload );
		do_action( self::HOOK_PREFIX . $event . '.after', $payload );
		return $payload;
	}

	/**
	 * Subscribe to an event. Listeners receive the payload array.
	 *
	 * @param string                       $event
	 * @param callable(array): array|void  $listener
	 * @param int                          $priority
	 */
	public function on( string $event, callable $listener, int $priority = 10 ): void {
		$this->known[ $event ] = true;
		add_filter( self::HOOK_PREFIX . $event, $listener, $priority );
	}

	/**
	 * Subscribe to the post-emit signal (cannot mutate payload).
	 */
	public function after( string $event, callable $listener, int $priority = 10 ): void {
		$this->known[ $event ] = true;
		add_action( self::HOOK_PREFIX . $event . '.after', $listener, $priority );
	}

	/** @return string[] */
	public function list_events(): array {
		return array_keys( $this->known );
	}
}
