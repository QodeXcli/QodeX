<?php
/**
 * AmazonClient — high-level SP-API client.
 *
 * Wraps wp_remote_request with the full reliability stack:
 *   - LWA token injection
 *   - per-endpoint rate limiting (token bucket)
 *   - circuit breaker (fail fast when SP-API is down)
 *   - exponential backoff retry on 429/500/502/503
 *
 * @package SevenGum\Commerce\Amazon
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon;

use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class AmazonClient {

	private const MAX_RETRIES = 3;
	private const USER_AGENT  = 'SevenGum-Commerce/' . SG_COMMERCE_VERSION . ' (Language=PHP)';

	public function __construct(
		private LWATokenManager $tokens,
		private Marketplaces $marketplaces,
		private RateLimiter $rate_limiter,
		private CircuitBreaker $breaker,
		private Logger $logger,
	) {}

	public function has_credentials(): bool {
		return $this->tokens->has_credentials();
	}

	/**
	 * Accessor for marketplace metadata — used by modules that need the
	 * marketplace ID/region without taking a Marketplaces dep of their own.
	 */
	public function marketplace_info( string $market ): ?array {
		return $this->marketplaces->get( $market );
	}

	/**
	 * Send a signed SP-API request.
	 *
	 * @param string      $method     HTTP method.
	 * @param string      $market     Marketplace code (US, DE, ...).
	 * @param string      $path       Path component, e.g. /fba/inventory/v1/summaries
	 * @param array       $query      Query parameters.
	 * @param array|null  $body       JSON body for POST/PATCH.
	 * @param string      $endpoint_key  Rate-limit bucket name (see RateLimiter::LIMITS).
	 *
	 * @return array  Decoded JSON response.
	 *
	 * @throws \RuntimeException  on permanent failure.
	 */
	public function request(
		string $method,
		string $market,
		string $path,
		array $query = array(),
		?array $body = null,
		string $endpoint_key = 'default'
	): array {
		// Sandbox mode — return canned responses, never touch the network.
		if ( \SevenGum\Commerce\Testing\Sandbox::is_enabled() ) {
			return \SevenGum\Commerce\Testing\Sandbox::mock( $method, $path );
		}

		$mp = $this->marketplaces->get( $market );
		if ( null === $mp ) {
			throw new \RuntimeException( "Unknown marketplace: {$market}" );
		}

		// Circuit breaker first — if downstream is down, don't even try.
		$this->breaker->guard( 'sp-api.' . $mp['region'] );

		// Rate limit (block up to 5s).
		if ( ! $this->rate_limiter->acquire_blocking( $endpoint_key, 5.0 ) ) {
			throw new \RuntimeException( "Rate limit exceeded for {$endpoint_key} after waiting." );
		}

		$url = $mp['endpoint'] . $path . ( ! empty( $query ) ? '?' . http_build_query( $query ) : '' );

		$last_exception = null;
		for ( $attempt = 1; $attempt <= self::MAX_RETRIES; $attempt++ ) {
			try {
				$result = $this->fire( $method, $url, $body, $attempt );
				$this->breaker->record_success( 'sp-api.' . $mp['region'] );
				return $result;
			} catch ( RetryableException $e ) {
				$last_exception = $e;
				$wait = (int) pow( 2, $attempt - 1 ); // 1s, 2s, 4s
				$this->logger->warning( 'SP-API retryable error', array(
					'attempt' => $attempt,
					'wait'    => $wait,
					'msg'     => $e->getMessage(),
				) );
				sleep( $wait );
				continue;
			} catch ( \Throwable $e ) {
				$this->breaker->record_failure( 'sp-api.' . $mp['region'] );
				throw $e;
			}
		}

		$this->breaker->record_failure( 'sp-api.' . $mp['region'] );
		throw new \RuntimeException(
			'SP-API failed after ' . self::MAX_RETRIES . ' attempts: ' . ( $last_exception ? $last_exception->getMessage() : 'unknown' )
		);
	}

	/** @throws RetryableException|\RuntimeException */
	private function fire( string $method, string $url, ?array $body, int $attempt ): array {
		$args = array(
			'method'  => $method,
			'timeout' => 30,
			'headers' => array(
				'x-amz-access-token' => $this->tokens->access_token( $attempt > 1 ),
				'Accept'             => 'application/json',
				'Content-Type'       => 'application/json',
				'User-Agent'         => self::USER_AGENT,
			),
		);
		if ( null !== $body ) {
			$args['body'] = wp_json_encode( $body );
		}

		$response = wp_remote_request( $url, $args );
		if ( is_wp_error( $response ) ) {
			throw new RetryableException( 'Network error: ' . $response->get_error_message() );
		}

		$code     = (int) wp_remote_retrieve_response_code( $response );
		$raw_body = (string) wp_remote_retrieve_body( $response );
		$json     = json_decode( $raw_body, true );

		if ( in_array( $code, array( 429, 500, 502, 503, 504 ), true ) ) {
			throw new RetryableException( "SP-API HTTP {$code}" );
		}
		if ( $code >= 400 ) {
			$msg = "HTTP {$code}";
			if ( is_array( $json ) && isset( $json['errors'][0]['message'] ) ) {
				$msg .= ' — ' . (string) $json['errors'][0]['message'];
			} elseif ( '' !== $raw_body ) {
				$msg .= ' — ' . substr( $raw_body, 0, 200 );
			}
			throw new \RuntimeException( $msg );
		}

		return is_array( $json ) ? $json : array();
	}

	/**
	 * Lightweight credential test using getMarketplaceParticipations.
	 */
	public function test_connection(): array {
		$this->tokens->clear_cache();
		$token = $this->tokens->access_token();
		$mp    = $this->marketplaces->get( $this->marketplaces->primary() );

		$response = wp_remote_get(
			$mp['endpoint'] . '/sellers/v1/marketplaceParticipations',
			array(
				'timeout' => 20,
				'headers' => array(
					'x-amz-access-token' => $token,
					'Accept'             => 'application/json',
					'User-Agent'         => self::USER_AGENT,
				),
			)
		);

		if ( is_wp_error( $response ) ) {
			throw new \RuntimeException( 'Network error: ' . $response->get_error_message() );
		}
		$code = (int) wp_remote_retrieve_response_code( $response );
		$body = (string) wp_remote_retrieve_body( $response );
		$json = json_decode( $body, true );

		if ( 200 !== $code ) {
			$msg = is_array( $json ) && isset( $json['errors'][0]['message'] )
				? $json['errors'][0]['message']
				: "HTTP {$code}";
			throw new \RuntimeException( "Amazon rejected us: {$msg}" );
		}

		return array(
			'ok'             => true,
			'token_length'   => strlen( $token ),
			'participations' => is_array( $json ) && isset( $json['payload'] ) ? count( $json['payload'] ) : 0,
		);
	}
}
