<?php
/**
 * OllamaProvider — talks to a local Ollama HTTP server.
 *
 * Default URL: http://127.0.0.1:11434
 *
 * Endpoints:
 *   POST /api/generate — single-shot prompt → response
 *   GET  /api/tags     — list installed models
 *
 * Recommended models:
 *   llama3.1:8b                  — fast English
 *   gemma2:9b-instruct-q4_K_M   — strong Persian/multilingual
 *   qwen2.5:7b                   — best general-purpose multilingual
 *
 * Caching: identical (prompt, model, temperature) tuples are cached for
 * 6 hours via CacheManager so repeated regeneration doesn't burn CPU.
 *
 * @package SevenGum\Commerce\AI\Providers
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\AI\Providers;

use SevenGum\Commerce\AI\ProviderInterface;
use SevenGum\Commerce\Cache\CacheManager;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class OllamaProvider implements ProviderInterface {

	public function __construct(
		private SettingsRepository $settings,
		private CacheManager $cache,
		private Logger $logger,
	) {}

	public function id(): string   { return 'ollama'; }
	public function name(): string { return 'Ollama (local)'; }

	public function generate( string $prompt, array $options = array() ): array {
		$model       = (string) ( $options['model']       ?? $this->default_model() );
		$temperature = (float)  ( $options['temperature'] ?? (float) $this->settings->get( 'ai_temperature', 0.7 ) );
		$system      = isset( $options['system'] ) ? (string) $options['system'] : null;
		$max_tokens  = isset( $options['max_tokens'] ) ? (int) $options['max_tokens'] : null;

		// Cache lookup.
		$cache_key = $this->cache_key( $prompt, $model, $temperature, $system );
		$cached    = $this->cache->get( $cache_key );
		if ( is_array( $cached ) && isset( $cached['text'] ) ) {
			$this->logger->debug( 'Ollama cache hit', array( 'model' => $model ) );
			return $cached;
		}

		$body = array(
			'model'   => $model,
			'prompt'  => $prompt,
			'stream'  => false,
			'options' => array(
				'temperature' => $temperature,
			),
			'keep_alive' => '5m',
		);
		if ( null !== $system ) {
			$body['system'] = $system;
		}
		if ( null !== $max_tokens && $max_tokens > 0 ) {
			$body['options']['num_predict'] = $max_tokens;
		}

		$start = microtime( true );
		$response = wp_remote_post(
			$this->base_url() . '/api/generate',
			array(
				'timeout' => 180,
				'headers' => $this->headers(),
				'body'    => wp_json_encode( $body ),
			)
		);

		if ( is_wp_error( $response ) ) {
			$msg = $response->get_error_message();
			$this->logger->error( 'Ollama unreachable: ' . $msg );
			throw new \RuntimeException( 'Ollama unreachable at ' . $this->base_url() . ': ' . $msg );
		}

		$code = (int) wp_remote_retrieve_response_code( $response );
		$raw  = (string) wp_remote_retrieve_body( $response );
		$json = json_decode( $raw, true );

		if ( 200 !== $code ) {
			$this->logger->error( "Ollama HTTP {$code}", array( 'body' => substr( $raw, 0, 300 ) ) );
			// Detect "model not found" specifically — most common failure.
			if ( str_contains( $raw, 'not found' ) || str_contains( $raw, 'model' ) ) {
				throw new \RuntimeException(
					"Ollama: model '{$model}' is not installed. Run: ollama pull {$model}"
				);
			}
			throw new \RuntimeException( "Ollama HTTP {$code}: " . substr( $raw, 0, 200 ) );
		}
		if ( ! is_array( $json ) || ! isset( $json['response'] ) ) {
			throw new \RuntimeException( 'Ollama returned malformed response.' );
		}

		$result = array(
			'text'        => trim( (string) $json['response'] ),
			'provider'    => $this->id(),
			'model'       => $model,
			'tokens'      => (int) ( $json['eval_count'] ?? 0 ),
			'duration_ms' => (int) ( ( microtime( true ) - $start ) * 1000 ),
		);

		$this->cache->set( $cache_key, $result, 6 * HOUR_IN_SECONDS );
		return $result;
	}

	public function is_reachable(): bool {
		try {
			$this->list_models();
			return true;
		} catch ( \Throwable ) {
			return false;
		}
	}

	public function list_models(): array {
		$response = wp_remote_get(
			$this->base_url() . '/api/tags',
			array( 'timeout' => 15, 'headers' => $this->headers() )
		);
		if ( is_wp_error( $response ) ) {
			throw new \RuntimeException( 'Ollama unreachable: ' . $response->get_error_message() );
		}
		$code = (int) wp_remote_retrieve_response_code( $response );
		if ( 200 !== $code ) {
			throw new \RuntimeException( "Ollama HTTP {$code} on /api/tags" );
		}
		$json = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		$out  = array();
		if ( is_array( $json ) && is_array( $json['models'] ?? null ) ) {
			foreach ( $json['models'] as $m ) {
				if ( isset( $m['name'] ) ) {
					$out[] = array(
						'id'   => (string) $m['name'],
						'name' => (string) $m['name'],
						'size' => (int) ( $m['size'] ?? 0 ),
					);
				}
			}
		}
		return $out;
	}

	private function base_url(): string {
		return rtrim( (string) $this->settings->get( 'ollama_url', 'http://127.0.0.1:11434' ), '/' );
	}

	private function default_model(): string {
		return (string) $this->settings->get( 'ollama_model', 'llama3.1:8b' );
	}

	private function headers(): array {
		$h = array( 'Content-Type' => 'application/json' );
		$token = (string) $this->settings->get( 'ollama_auth_token', '' );
		if ( '' !== $token ) {
			$h['Authorization'] = 'Bearer ' . $token;
		}
		return $h;
	}

	private function cache_key( string $prompt, string $model, float $temp, ?string $system ): string {
		return 'ai/ollama/' . substr( hash( 'sha256', $prompt . '|' . $model . '|' . $temp . '|' . ( $system ?? '' ) ), 0, 32 );
	}
}
