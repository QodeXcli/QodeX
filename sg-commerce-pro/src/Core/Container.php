<?php
/**
 * Container — dependency injection container.
 *
 * Three binding modes:
 *   bind()      — factory; new instance every resolve()
 *   singleton() — factory; same instance returned forever
 *   instance()  — pre-built object; same instance returned forever
 *
 * Resolution is type-hint aware: factories receive the Container so they
 * can pull their own dependencies. Cyclic dependency throws.
 *
 * Why custom DI not Symfony/PHP-DI? Plugin must work standalone without
 * Composer install. ~120 lines is enough for our needs.
 *
 * @package SevenGum\Commerce\Core
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Core;

defined( 'ABSPATH' ) || exit;

final class Container {

	/** @var array<string, callable> */
	private array $factories = array();

	/** @var array<string, callable> */
	private array $singletons = array();

	/** @var array<string, mixed> */
	private array $instances = array();

	/** @var array<string, bool> Tracks active resolutions to detect cycles. */
	private array $resolving = array();

	/**
	 * Bind a factory. Each resolve() invokes the factory and returns a new
	 * instance.
	 */
	public function bind( string $id, callable $factory ): void {
		unset( $this->singletons[ $id ], $this->instances[ $id ] );
		$this->factories[ $id ] = $factory;
	}

	/**
	 * Bind a singleton factory. The factory is called once on first
	 * resolve(); subsequent calls return the cached result.
	 */
	public function singleton( string $id, callable $factory ): void {
		unset( $this->factories[ $id ], $this->instances[ $id ] );
		$this->singletons[ $id ] = $factory;
	}

	/**
	 * Bind an existing instance. Returned as-is from every resolve() call.
	 */
	public function instance( string $id, mixed $object ): void {
		unset( $this->factories[ $id ], $this->singletons[ $id ] );
		$this->instances[ $id ] = $object;
	}

	/**
	 * Resolve a binding by id.
	 *
	 * @throws \RuntimeException  If the binding is missing or a cycle is detected.
	 */
	public function get( string $id ): mixed {
		// Pre-built instance.
		if ( array_key_exists( $id, $this->instances ) ) {
			return $this->instances[ $id ];
		}

		// Cached singleton.
		if ( isset( $this->singletons[ $id ] ) ) {
			if ( isset( $this->resolving[ $id ] ) ) {
				throw new \RuntimeException( "Circular dependency while resolving '{$id}'." );
			}
			$this->resolving[ $id ] = true;
			try {
				$obj = ( $this->singletons[ $id ] )( $this );
			} finally {
				unset( $this->resolving[ $id ] );
			}
			$this->instances[ $id ] = $obj;
			return $obj;
		}

		// Per-call factory.
		if ( isset( $this->factories[ $id ] ) ) {
			if ( isset( $this->resolving[ $id ] ) ) {
				throw new \RuntimeException( "Circular dependency while resolving '{$id}'." );
			}
			$this->resolving[ $id ] = true;
			try {
				return ( $this->factories[ $id ] )( $this );
			} finally {
				unset( $this->resolving[ $id ] );
			}
		}

		throw new \RuntimeException( "No binding registered for '{$id}'." );
	}

	public function has( string $id ): bool {
		return isset( $this->instances[ $id ] )
			|| isset( $this->singletons[ $id ] )
			|| isset( $this->factories[ $id ] );
	}

	/**
	 * Convenience: resolve multiple bindings as an associative array.
	 *
	 * @param array<string> $ids
	 * @return array<string, mixed>
	 */
	public function getMany( array $ids ): array {
		$out = array();
		foreach ( $ids as $id ) {
			$out[ $id ] = $this->get( $id );
		}
		return $out;
	}
}
