<?php
/**
 * LWATokenManager — Login With Amazon OAuth token handling.
 *
 * Exchanges a long-lived refresh token for a short-lived access token
 * (1 hour). Caches the access token until ~5 minutes before expiry.
 *
 * If LWA returns invalid_grant we surface a specific exception so the
 * admin sees "your refresh token is dead, reconnect" instead of a
 * generic HTTP error.
 *
 * @package SevenGum\Commerce\Amazon
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon;

use SevenGum\Commerce\Cache\CacheManager;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class LWATokenManager {

	private const ENDPOINT  = 'https://api.amazon.com/auth/o2/token';
	private const CACHE_KEY = 'lwa_access_token';

	public function __construct(
		private SettingsRepository $settings,
		private CacheManager $cache,
		private Logger $logger,
	) {}

	public function has_credentials(): bool {
		return $this->settings->has( 'amazon_client_id' )
			&& $this->settings->has( 'amazon_client_secret' )
			&& $this->settings->has( 'amazon_refresh_token' );
	}

	/**
	 * Get a valid access token. Uses cache; refreshes from LWA if needed.
	 *
	 * @throws \RuntimeException
	 */
	public function access_token( bool $force_refresh = false ): string {
		if ( ! $force_refresh ) {
			$cached = $this->cache->get( self::CACHE_KEY );
			if ( is_string( $cached ) && '' !== $cached ) {
				return $cached;
			}
		}
		if ( ! $this->has_credentials() ) {
			throw new \RuntimeException( 'Amazon credentials not configured.' );
		}

		$response = wp_remote_post(
			self::ENDPOINT,
			array(
				'timeout' => 20,
				'headers' => array( 'Content-Type' => 'application/x-www-form-urlencoded' ),
				'body'    => http_build_query(
					array(
						'grant_type'    => 'refresh_token',
						'refresh_token' => (string) $this->settings->get( 'amazon_refresh_token' ),
						'client_id'     => (string) $this->settings->get( 'amazon_client_id' ),
						'client_secret' => (string) $this->settings->get( 'amazon_client_secret' ),
					)
				),
			)
		);

		if ( is_wp_error( $response ) ) {
			$msg = $response->get_error_message();
			$this->logger->error( 'LWA network error: ' . $msg );
			throw new \RuntimeException( 'LWA network error: ' . $msg );
		}

		$code = (int) wp_remote_retrieve_response_code( $response );
		$body = (string) wp_remote_retrieve_body( $response );
		$json = json_decode( $body, true );

		if ( 200 !== $code || ! is_array( $json ) || empty( $json['access_token'] ) ) {
			$err  = is_array( $json ) ? (string) ( $json['error'] ?? '' ) : '';
			$desc = is_array( $json ) ? (string) ( $json['error_description'] ?? '' ) : '';
			if ( 'invalid_grant' === $err ) {
				$this->logger->error( 'LWA refresh token invalid/expired', array( 'desc' => $desc ) );
				throw new \RuntimeException( 'Your Amazon refresh token has expired or been revoked. Please reconnect your seller account in Amazon Connect.' );
			}
			$this->logger->error( "LWA HTTP {$code}: {$err} {$desc}" );
			throw new \RuntimeException( "LWA returned HTTP {$code}: {$desc}" );
		}

		$ttl = max( 60, (int) ( $json['expires_in'] ?? 3600 ) - 300 );
		$this->cache->set( self::CACHE_KEY, $json['access_token'], $ttl );

		$this->logger->debug( 'LWA token refreshed', array( 'ttl' => $ttl ) );
		return $json['access_token'];
	}

	public function clear_cache(): void {
		$this->cache->delete( self::CACHE_KEY );
	}
}
