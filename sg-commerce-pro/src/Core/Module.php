<?php
/**
 * Module interface — implemented by every functional module.
 *
 * The Plugin class iterates registered modules at boot and calls register()
 * on each. Modules add their own hooks, REST routes, shortcodes, etc.
 *
 * Why an interface? It lets us add modules from third-party plugins via the
 * `sg_commerce_modules` filter — they just have to implement Module.
 *
 * @package SevenGum\Commerce\Core
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Core;

defined( 'ABSPATH' ) || exit;

interface Module {
	/**
	 * Stable identifier used as container key. Lowercase, snake_case.
	 * Examples: 'amazon', 'ai', 'analytics', 'admin'.
	 */
	public function id(): string;

	/**
	 * Register WP hooks, REST routes, etc. Called once on plugin boot.
	 * Implementations must be idempotent (safe to call multiple times).
	 */
	public function register(): void;
}
