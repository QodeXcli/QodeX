<?php
/**
 * GeoResolver — best-effort visitor country detection.
 *
 * Probes in order:
 *   1. Explicit override (cookie or ?sg_market= query arg for debugging)
 *   2. Cloudflare header CF-IPCountry (most Hostinger sites use CF)
 *   3. Akamai True-Client-IP, AWS CloudFront-Viewer-Country, Fastly
 *   4. PHP GeoIP extension if enabled
 *   5. Accept-Language header (falls back to language, then maps to country)
 *   6. Primary marketplace configured in settings (final fallback)
 *
 * Country → marketplace mapping uses Marketplaces data. If visitor country
 * isn't in an enabled market, falls back to primary.
 *
 * Cache per-request so repeated calls don't re-probe headers.
 *
 * @package SevenGum\Commerce\Geotargeting
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Geotargeting;

use SevenGum\Commerce\Amazon\Marketplaces;
use SevenGum\Commerce\Cache\CacheManager;

defined( 'ABSPATH' ) || exit;

final class GeoResolver {

	/** Country ISO-2 → Amazon market code. Where multiple exist, prefer nearest. */
	private const COUNTRY_TO_MARKET = array(
		'US' => 'US', 'CA' => 'CA', 'MX' => 'MX', 'BR' => 'BR',
		'GB' => 'UK', 'DE' => 'DE', 'AT' => 'DE', 'CH' => 'DE',
		'FR' => 'FR', 'MC' => 'FR',
		'IT' => 'IT', 'SM' => 'IT',
		'ES' => 'ES', 'PT' => 'ES',
		'NL' => 'NL', 'BE' => 'BE',
		'SE' => 'SE', 'NO' => 'SE', 'FI' => 'SE', 'DK' => 'SE',
		'PL' => 'PL', 'CZ' => 'PL', 'SK' => 'PL',
		'IE' => 'IE',
		'TR' => 'TR',
		'AE' => 'AE', 'OM' => 'AE', 'KW' => 'AE', 'QA' => 'AE', 'BH' => 'AE',
		'SA' => 'SA',
		'AU' => 'AU', 'NZ' => 'AU',
		'IN' => 'IN',
		'SG' => 'SG', 'MY' => 'SG', 'ID' => 'SG', 'TH' => 'SG', 'VN' => 'SG', 'PH' => 'SG',
		'JP' => 'JP', 'KR' => 'JP',
	);

	private ?string $detected_country = null;
	private ?string $detected_market = null;

	public function __construct(
		private Marketplaces $marketplaces,
		private CacheManager $cache,
	) {}

	/** Best-guess ISO-2 country code for the current visitor. */
	public function country(): string {
		if ( null !== $this->detected_country ) {
			return $this->detected_country;
		}
		$this->detected_country = $this->detect_country();
		return $this->detected_country;
	}

	/**
	 * Best Amazon market for this visitor. Returns a code from enabled_codes()
	 * if possible, else falls back to primary.
	 */
	public function market(): string {
		if ( null !== $this->detected_market ) {
			return $this->detected_market;
		}
		$country = $this->country();
		$enabled = $this->marketplaces->enabled_codes();
		$primary = $this->marketplaces->primary();

		$candidate = self::COUNTRY_TO_MARKET[ $country ] ?? $primary;
		if ( ! in_array( $candidate, $enabled, true ) ) {
			$candidate = $primary;
		}
		$this->detected_market = $candidate;
		return $candidate;
	}

	/**
	 * Was the market chosen explicitly (override) or inferred?
	 * Used by Widget to show an "Other markets" dropdown only when inferred.
	 */
	public function was_overridden(): bool {
		return '' !== (string) ( $_GET['sg_market']    ?? '' ) // phpcs:ignore WordPress.Security.NonceVerification
			|| '' !== (string) ( $_COOKIE['sg_market'] ?? '' );
	}

	/** Let user set a sticky override (writes a 30-day cookie). */
	public function set_override( string $market ): void {
		if ( ! $this->marketplaces->exists( $market ) ) {
			return;
		}
		$this->detected_market  = $market;
		$this->detected_country = '';
		if ( ! headers_sent() ) {
			setcookie( 'sg_market', $market, array(
				'expires'  => time() + 30 * DAY_IN_SECONDS,
				'path'     => '/',
				'secure'   => is_ssl(),
				'httponly' => false, // JS may want to read this
				'samesite' => 'Lax',
			) );
		}
	}

	private function detect_country(): string {
		// 1. Explicit override.
		$override = '';
		if ( ! empty( $_GET['sg_market'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification
			$override = (string) $_GET['sg_market']; // phpcs:ignore
		} elseif ( ! empty( $_COOKIE['sg_market'] ) ) {
			$override = (string) $_COOKIE['sg_market'];
		}
		$override = strtoupper( preg_replace( '/[^A-Z]/i', '', $override ) );
		if ( 2 === strlen( $override ) ) {
			// sg_market is a market code, not strictly a country — map back.
			$mp = $this->marketplaces->get( $override );
			if ( $mp ) {
				return $this->iso_for_market( $override );
			}
		}

		// 2. Edge CDN headers.
		$headers = array(
			'HTTP_CF_IPCOUNTRY',
			'HTTP_X_VERCEL_IP_COUNTRY',
			'HTTP_CLOUDFRONT_VIEWER_COUNTRY',
			'HTTP_X_COUNTRY_CODE',
			'HTTP_X_APPENGINE_COUNTRY',
		);
		foreach ( $headers as $h ) {
			if ( ! empty( $_SERVER[ $h ] ) ) {
				$v = strtoupper( preg_replace( '/[^A-Z]/i', '', (string) $_SERVER[ $h ] ) );
				if ( 2 === strlen( $v ) && 'XX' !== $v && 'T1' !== $v ) {
					return $v;
				}
			}
		}

		// 3. PHP GeoIP extension (rarely installed but cheap to try).
		$ip = $this->client_ip();
		if ( function_exists( 'geoip_country_code_by_name' ) && '' !== $ip ) {
			$v = @geoip_country_code_by_name( $ip );
			if ( is_string( $v ) && 2 === strlen( $v ) ) {
				return strtoupper( $v );
			}
		}

		// 4. Accept-Language.
		if ( ! empty( $_SERVER['HTTP_ACCEPT_LANGUAGE'] ) ) {
			$al = (string) $_SERVER['HTTP_ACCEPT_LANGUAGE'];
			if ( preg_match( '/-([A-Za-z]{2})/', $al, $m ) ) {
				return strtoupper( $m[1] );
			}
			// Map bare language to a default country.
			$lang = strtolower( substr( $al, 0, 2 ) );
			$map = array(
				'en' => 'US', 'de' => 'DE', 'fr' => 'FR', 'es' => 'ES',
				'it' => 'IT', 'nl' => 'NL', 'sv' => 'SE', 'pl' => 'PL',
				'tr' => 'TR', 'ar' => 'AE', 'pt' => 'BR', 'ja' => 'JP',
				'fa' => 'AE', 'zh' => 'SG',
			);
			if ( isset( $map[ $lang ] ) ) return $map[ $lang ];
		}

		// 5. Primary market's country.
		return $this->iso_for_market( $this->marketplaces->primary() );
	}

	private function iso_for_market( string $market_code ): string {
		foreach ( self::COUNTRY_TO_MARKET as $country => $m ) {
			if ( $m === $market_code ) return $country;
		}
		return 'US';
	}

	private function client_ip(): string {
		foreach ( array( 'HTTP_CF_CONNECTING_IP', 'HTTP_X_REAL_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR' ) as $k ) {
			if ( ! empty( $_SERVER[ $k ] ) ) {
				$ip = trim( explode( ',', (string) $_SERVER[ $k ] )[0] );
				if ( filter_var( $ip, FILTER_VALIDATE_IP ) ) {
					return $ip;
				}
			}
		}
		return '';
	}
}
