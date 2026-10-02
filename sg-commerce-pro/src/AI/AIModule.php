<?php
/**
 * AIModule — selects active AI provider based on settings, wires Copywriter.
 *
 * The provider is bound dynamically so changing 'ai_provider' setting takes
 * effect on the next request without code changes. Default: ollama.
 *
 * @package SevenGum\Commerce\AI
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\AI;

use SevenGum\Commerce\AI\Providers\OllamaProvider;
use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class AIModule implements Module {

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'ai';
	}

	public function register(): void {
		$c = $this->container;

		// Bind the active provider as ProviderInterface.
		$c->singleton( ProviderInterface::class, function ( Container $c ): ProviderInterface {
			$active = (string) $c->get( SettingsRepository::class )->get( 'ai_provider', 'ollama' );
			return match ( $active ) {
				// Future providers: openai, anthropic
				'ollama' => $c->get( OllamaProvider::class ),
				default  => $c->get( OllamaProvider::class ),
			};
		} );

		// Copywriter — depends on the provider above.
		$c->singleton( Copywriter::class, static fn( Container $c ) =>
			new Copywriter(
				$c->get( ProviderInterface::class ),
				$c->get( PromptRegistry::class ),
				$c->get( ProductRepository::class ),
				$c->get( Marketplaces::class ),
				$c->get( Logger::class )
			)
		);

		// Async generation queue handler.
		add_action( 'sg_commerce_ai_describe', function ( $args ): void {
			if ( ! is_array( $args ) || empty( $args['product_id'] ) ) return;
			try {
				$this->container->get( Copywriter::class )->describe( (int) $args['product_id'] );
			} catch ( \Throwable $e ) {
				$this->container->get( Logger::class )->error( 'queued describe failed: ' . $e->getMessage() );
			}
		} );

		add_action( 'sg_commerce_ai_translate', function ( $args ): void {
			if ( ! is_array( $args ) || empty( $args['product_id'] ) || empty( $args['market'] ) ) return;
			try {
				$this->container->get( Copywriter::class )->translate(
					(int) $args['product_id'],
					(string) $args['market']
				);
			} catch ( \Throwable $e ) {
				$this->container->get( Logger::class )->error( 'queued translate failed: ' . $e->getMessage() );
			}
		} );
	}
}
