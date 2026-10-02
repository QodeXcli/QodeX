<?php
/**
 * Marketplaces — Amazon marketplace catalog.
 *
 * 20 markets across NA, EU, ME, FE regions. Marketplace IDs are public/stable.
 * Endpoint URL is the regional gateway. Language is the default AI output
 * locale when generating localized copy for that market.
 *
 * Filterable via `sg_commerce_marketplaces` so third-party code can add
 * new markets without forking the plugin.
 *
 * @package SevenGum\Commerce\Amazon
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon;

defined( 'ABSPATH' ) || exit;

final class Marketplaces {

	/** @var array<string, array>|null */
	private static ?array $cache = null;

	/**
	 * @return array<string, array{id:string, country:string, currency:string, language:string, endpoint:string, region:string, tld:string}>
	 */
	public function all(): array {
		if ( null !== self::$cache ) {
			return self::$cache;
		}

		$markets = array(
			// North America
			'US' => array( 'id' => 'ATVPDKIKX0DER',  'country' => 'United States',   'currency' => 'USD', 'language' => 'en', 'endpoint' => 'https://sellingpartnerapi-na.amazon.com', 'region' => 'na', 'tld' => 'com' ),
			'CA' => array( 'id' => 'A2EUQ1WTGCTBG2', 'country' => 'Canada',          'currency' => 'CAD', 'language' => 'en', 'endpoint' => 'https://sellingpartnerapi-na.amazon.com', 'region' => 'na', 'tld' => 'ca' ),
			'MX' => array( 'id' => 'A1AM78C64UM0Y8', 'country' => 'Mexico',          'currency' => 'MXN', 'language' => 'es', 'endpoint' => 'https://sellingpartnerapi-na.amazon.com', 'region' => 'na', 'tld' => 'com.mx' ),
			'BR' => array( 'id' => 'A2Q3Y263D00KWC', 'country' => 'Brazil',          'currency' => 'BRL', 'language' => 'pt', 'endpoint' => 'https://sellingpartnerapi-na.amazon.com', 'region' => 'na', 'tld' => 'com.br' ),
			// Europe
			'UK' => array( 'id' => 'A1F83G8C2ARO7P', 'country' => 'United Kingdom',  'currency' => 'GBP', 'language' => 'en', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'co.uk' ),
			'DE' => array( 'id' => 'A1PA6795UKMFR9', 'country' => 'Germany',         'currency' => 'EUR', 'language' => 'de', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'de' ),
			'FR' => array( 'id' => 'A13V1IB3VIYZZH', 'country' => 'France',          'currency' => 'EUR', 'language' => 'fr', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'fr' ),
			'IT' => array( 'id' => 'APJ6JRA9NG5V4',  'country' => 'Italy',           'currency' => 'EUR', 'language' => 'it', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'it' ),
			'ES' => array( 'id' => 'A1RKKUPIHCS9HS', 'country' => 'Spain',           'currency' => 'EUR', 'language' => 'es', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'es' ),
			'NL' => array( 'id' => 'A1805IZSGTT6HS', 'country' => 'Netherlands',     'currency' => 'EUR', 'language' => 'nl', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'nl' ),
			'SE' => array( 'id' => 'A2NODRKZP88ZB9', 'country' => 'Sweden',          'currency' => 'SEK', 'language' => 'sv', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'se' ),
			'PL' => array( 'id' => 'A1C3SOZRARQ6R3', 'country' => 'Poland',          'currency' => 'PLN', 'language' => 'pl', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'pl' ),
			'BE' => array( 'id' => 'AMEN7PMS3EDWL',  'country' => 'Belgium',         'currency' => 'EUR', 'language' => 'nl', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'com.be' ),
			'IE' => array( 'id' => 'A28R8C7NBKEWEA', 'country' => 'Ireland',         'currency' => 'EUR', 'language' => 'en', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'ie' ),
			'TR' => array( 'id' => 'A33AVAJ2PDY3EV', 'country' => 'Turkey',          'currency' => 'TRY', 'language' => 'tr', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'com.tr' ),
			// Middle East
			'AE' => array( 'id' => 'A2VIGQ35RCS4UG', 'country' => 'United Arab Emirates', 'currency' => 'AED', 'language' => 'ar', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'ae' ),
			'SA' => array( 'id' => 'A17E79C6D8DWNP', 'country' => 'Saudi Arabia',    'currency' => 'SAR', 'language' => 'ar', 'endpoint' => 'https://sellingpartnerapi-eu.amazon.com', 'region' => 'eu', 'tld' => 'sa' ),
			// Far East
			'AU' => array( 'id' => 'A39IBJ37TRP1C6', 'country' => 'Australia',       'currency' => 'AUD', 'language' => 'en', 'endpoint' => 'https://sellingpartnerapi-fe.amazon.com', 'region' => 'fe', 'tld' => 'com.au' ),
			'IN' => array( 'id' => 'A21TJRUUN4KGV',  'country' => 'India',           'currency' => 'INR', 'language' => 'en', 'endpoint' => 'https://sellingpartnerapi-fe.amazon.com', 'region' => 'fe', 'tld' => 'in' ),
			'SG' => array( 'id' => 'A19VAU5U5O7RUS', 'country' => 'Singapore',       'currency' => 'SGD', 'language' => 'en', 'endpoint' => 'https://sellingpartnerapi-fe.amazon.com', 'region' => 'fe', 'tld' => 'sg' ),
			'JP' => array( 'id' => 'A1VC38T7YXB528', 'country' => 'Japan',           'currency' => 'JPY', 'language' => 'ja', 'endpoint' => 'https://sellingpartnerapi-fe.amazon.com', 'region' => 'fe', 'tld' => 'co.jp' ),
		);

		self::$cache = apply_filters( 'sg_commerce_marketplaces', $markets );
		return self::$cache;
	}

	public function get( string $code ): ?array {
		return $this->all()[ strtoupper( $code ) ] ?? null;
	}

	public function exists( string $code ): bool {
		return null !== $this->get( $code );
	}

	/** @return string[] */
	public function enabled_codes(): array {
		$settings = get_option( 'sg_commerce_settings', array() );
		$codes = (array) ( is_array( $settings ) ? ( $settings['amazon_enabled_markets'] ?? array( 'US' ) ) : array( 'US' ) );
		$all   = $this->all();
		return array_values( array_filter( $codes, static fn( $c ) => isset( $all[ $c ] ) ) );
	}

	public function primary(): string {
		$settings = get_option( 'sg_commerce_settings', array() );
		$p = is_array( $settings ) ? (string) ( $settings['amazon_primary_market'] ?? 'US' ) : 'US';
		return $this->exists( $p ) ? $p : 'US';
	}

	/** Build the public Amazon product URL for an ASIN in a market. */
	public function product_url( string $asin, string $market ): string {
		$mp = $this->get( $market );
		$tld = $mp['tld'] ?? 'com';
		return "https://www.amazon.{$tld}/dp/{$asin}";
	}

	/** Reverse lookup: marketplace_id (e.g. ATVPDKIKX0DER) → code (US). */
	public function code_by_id( string $marketplace_id ): string {
		if ( '' === $marketplace_id ) return '';
		foreach ( $this->all() as $code => $m ) {
			if ( ( $m['id'] ?? '' ) === $marketplace_id ) {
				return (string) $code;
			}
		}
		return '';
	}

	public static function flush_cache(): void {
		self::$cache = null;
	}
}
