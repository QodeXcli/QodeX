<?php
/**
 * AdsClient — Amazon Ads API (Sponsored Products v3 + Reporting v3).
 *
 * Auth: Login with Amazon refresh-token grant against the same token
 * endpoint as SP-API, but with an LWA app that has been approved for the
 * Advertising API (scope `advertising::campaign_management`).
 *
 * Every call carries:
 *   Authorization: Bearer {access_token}
 *   Amazon-Advertising-API-ClientId: {client_id}
 *   Amazon-Advertising-API-Scope: {profileId}     (except GET /v2/profiles)
 *
 * SP v3 endpoints use vendor media types, e.g.
 *   application/vnd.spCampaign.v3+json, application/vnd.spKeyword.v3+json
 *
 * @package SevenGum\Commerce\Suite\Ads
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Ads;

use SevenGum\Commerce\Cache\CacheManager;
use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Suite\SuiteSettings;

defined( 'ABSPATH' ) || exit;

final class AdsClient {

	public const HOSTS = array(
		'na' => 'https://advertising-api.amazon.com',
		'eu' => 'https://advertising-api-eu.amazon.com',
		'fe' => 'https://advertising-api-fe.amazon.com',
	);

	private const TOKEN_URL  = 'https://api.amazon.com/auth/o2/token';
	private const CACHE_KEY  = 'ads_access_token';
	private const MAX_RETRY  = 4;

	public function __construct(
		private SuiteSettings $settings,
		private CacheManager $cache,
		private Logger $logger,
	) {}

	public function has_credentials(): bool {
		return '' !== $this->client_id()
			&& '' !== $this->client_secret()
			&& '' !== $this->settings->secret( 'ads_refresh_token' );
	}

	public function is_ready(): bool {
		return $this->has_credentials() && '' !== $this->settings->string( 'suite_ads_profile_id' );
	}

	/** Ads may reuse the SP-API LWA app, so fall back to its client id/secret. */
	private function client_id(): string {
		$id = $this->settings->secret( 'ads_client_id' );
		return '' !== $id ? $id : $this->settings->secret( 'amazon_client_id' );
	}

	private function client_secret(): string {
		$s = $this->settings->secret( 'ads_client_secret' );
		return '' !== $s ? $s : $this->settings->secret( 'amazon_client_secret' );
	}

	public function access_token( bool $force = false ): string {
		if ( ! $force ) {
			$cached = $this->cache->get( self::CACHE_KEY );
			if ( is_string( $cached ) && '' !== $cached ) {
				return $cached;
			}
		}
		$res = wp_remote_post( self::TOKEN_URL, array(
			'timeout' => 20,
			'body'    => array(
				'grant_type'    => 'refresh_token',
				'refresh_token' => $this->settings->secret( 'ads_refresh_token' ),
				'client_id'     => $this->client_id(),
				'client_secret' => $this->client_secret(),
			),
		) );
		if ( is_wp_error( $res ) ) {
			throw new \RuntimeException( 'Ads LWA network error: ' . $res->get_error_message() );
		}
		$json = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		if ( 200 !== (int) wp_remote_retrieve_response_code( $res ) || empty( $json['access_token'] ) ) {
			$msg = is_array( $json ) ? (string) ( $json['error_description'] ?? $json['error'] ?? 'unknown' ) : 'unknown';
			throw new \RuntimeException( 'Ads LWA token refresh failed: ' . $msg );
		}
		$ttl = max( 60, (int) ( $json['expires_in'] ?? 3600 ) - 120 );
		$this->cache->set( self::CACHE_KEY, (string) $json['access_token'], $ttl );
		return (string) $json['access_token'];
	}

	public function clear_token(): void {
		$this->cache->delete( self::CACHE_KEY );
	}

	/** GET /v2/profiles — no scope header. */
	public function profiles(): array {
		return $this->call( 'GET', '/v2/profiles', null, 'application/json', false );
	}

	/**
	 * Generic list with nextToken pagination (SP v3 "/list" endpoints).
	 *
	 * @param string $path      e.g. /sp/campaigns/list
	 * @param string $media     e.g. application/vnd.spCampaign.v3+json
	 * @param string $key       response array key, e.g. campaigns
	 */
	public function list_all( string $path, string $media, string $key, array $body = array(), int $max_pages = 20 ): array {
		$out   = array();
		$token = null;
		$pages = 0;
		do {
			$req = $body + array( 'maxResults' => 500 );
			if ( null !== $token ) {
				$req['nextToken'] = $token;
			}
			$res   = $this->call( 'POST', $path, $req, $media );
			$out   = array_merge( $out, (array) ( $res[ $key ] ?? array() ) );
			$token = isset( $res['nextToken'] ) && '' !== $res['nextToken'] ? (string) $res['nextToken'] : null;
			$pages++;
		} while ( null !== $token && $pages < $max_pages );
		return $out;
	}

	public function campaigns(): array {
		return $this->list_all( '/sp/campaigns/list', 'application/vnd.spCampaign.v3+json', 'campaigns', array(
			'stateFilter' => array( 'include' => array( 'ENABLED', 'PAUSED' ) ),
		) );
	}

	public function keywords(): array {
		return $this->list_all( '/sp/keywords/list', 'application/vnd.spKeyword.v3+json', 'keywords', array(
			'stateFilter' => array( 'include' => array( 'ENABLED', 'PAUSED' ) ),
		) );
	}

	public function targets(): array {
		return $this->list_all( '/sp/targets/list', 'application/vnd.spTargetingClause.v3+json', 'targetingClauses', array(
			'stateFilter' => array( 'include' => array( 'ENABLED', 'PAUSED' ) ),
		) );
	}

	/** @param array<int, array{keywordId:string, bid?:float, state?:string}> $updates */
	public function update_keywords( array $updates ): array {
		return $this->call( 'PUT', '/sp/keywords', array( 'keywords' => array_values( $updates ) ), 'application/vnd.spKeyword.v3+json' );
	}

	/** @param array<int, array{targetId:string, bid?:float, state?:string}> $updates */
	public function update_targets( array $updates ): array {
		return $this->call( 'PUT', '/sp/targets', array( 'targetingClauses' => array_values( $updates ) ), 'application/vnd.spTargetingClause.v3+json' );
	}

	public function create_keywords( array $keywords ): array {
		return $this->call( 'POST', '/sp/keywords', array( 'keywords' => array_values( $keywords ) ), 'application/vnd.spKeyword.v3+json' );
	}

	public function create_negative_keywords( array $negatives ): array {
		return $this->call( 'POST', '/sp/negativeKeywords', array( 'negativeKeywords' => array_values( $negatives ) ), 'application/vnd.spNegativeKeyword.v3+json' );
	}

	public function update_campaigns( array $campaigns ): array {
		return $this->call( 'PUT', '/sp/campaigns', array( 'campaigns' => array_values( $campaigns ) ), 'application/vnd.spCampaign.v3+json' );
	}

	/** Keyword ideas for ASINs (SP keyword recommendations v3). */
	public function keyword_recommendations( array $asins, string $locale = 'en_US', int $max = 200 ): array {
		return $this->call( 'POST', '/sp/targets/keywords/recommendations', array(
			'recommendationType' => 'KEYWORDS_FOR_ASINS',
			'asins'              => array_values( array_slice( $asins, 0, 50 ) ),
			'maxRecommendations' => min( 200, $max ),
			'sortDimension'      => 'DEFAULT',
			'locale'             => $locale,
		), 'application/vnd.spkeywordsrecommendation.v3+json' );
	}

	/** Reporting v3: request an async report. Returns reportId. */
	public function create_report( string $name, string $type_id, array $group_by, array $columns, string $start, string $end ): string {
		$res = $this->call( 'POST', '/reporting/reports', array(
			'name'          => $name,
			'startDate'     => $start,
			'endDate'       => $end,
			'configuration' => array(
				'adProduct'    => 'SPONSORED_PRODUCTS',
				'groupBy'      => $group_by,
				'columns'      => $columns,
				'reportTypeId' => $type_id,
				'timeUnit'     => 'DAILY',
				'format'       => 'GZIP_JSON',
			),
		), 'application/vnd.createasyncreportrequest.v3+json' );
		$id = (string) ( $res['reportId'] ?? '' );
		if ( '' === $id ) {
			throw new \RuntimeException( 'Ads createReport returned no reportId.' );
		}
		return $id;
	}

	/** @return array{status:string, url?:string, failureReason?:string} */
	public function report_status( string $report_id ): array {
		return $this->call( 'GET', '/reporting/reports/' . rawurlencode( $report_id ), null, 'application/vnd.createasyncreportrequest.v3+json' );
	}

	public function download( string $url ): string {
		$res = wp_remote_get( $url, array( 'timeout' => 120 ) );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) {
			throw new \RuntimeException( 'Ads report download failed.' );
		}
		return (string) wp_remote_retrieve_body( $res );
	}

	/** Connection test: token + profiles. */
	public function test(): array {
		$this->clear_token();
		$this->access_token( true );
		$profiles = $this->profiles();
		return array(
			'ok'       => true,
			'profiles' => array_map( static fn( $p ) => array(
				'profileId'   => (string) ( $p['profileId'] ?? '' ),
				'countryCode' => (string) ( $p['countryCode'] ?? '' ),
				'currency'    => (string) ( $p['currencyCode'] ?? '' ),
				'type'        => (string) ( $p['accountInfo']['type'] ?? '' ),
				'name'        => (string) ( $p['accountInfo']['name'] ?? '' ),
			), $profiles ),
		);
	}

	private function call( string $method, string $path, ?array $body, string $media, bool $scoped = true ): array {
		if ( ! $this->has_credentials() ) {
			throw new \RuntimeException( 'Amazon Ads API credentials are not configured.' );
		}
		$host = self::HOSTS[ $this->settings->string( 'suite_ads_region' ) ] ?? self::HOSTS['na'];
		$last = '';
		for ( $attempt = 1; $attempt <= self::MAX_RETRY; $attempt++ ) {
			$headers = array(
				'Authorization'                    => 'Bearer ' . $this->access_token( $attempt > 1 && str_contains( $last, '401' ) ),
				'Amazon-Advertising-API-ClientId'  => $this->client_id(),
				'Accept'                           => $media,
				'Content-Type'                     => $media,
			);
			if ( $scoped ) {
				$headers['Amazon-Advertising-API-Scope'] = $this->settings->string( 'suite_ads_profile_id' );
			}
			$args = array( 'method' => $method, 'timeout' => 45, 'headers' => $headers );
			if ( null !== $body ) {
				$args['body'] = wp_json_encode( $body );
			}
			$res = wp_remote_request( $host . $path, $args );
			if ( is_wp_error( $res ) ) {
				$last = 'network: ' . $res->get_error_message();
				sleep( $attempt );
				continue;
			}
			$code = (int) wp_remote_retrieve_response_code( $res );
			$raw  = (string) wp_remote_retrieve_body( $res );
			$json = json_decode( $raw, true );
			if ( in_array( $code, array( 401, 429, 500, 502, 503, 504 ), true ) ) {
				$last  = "HTTP {$code}";
				$retry = (int) wp_remote_retrieve_header( $res, 'retry-after' );
				sleep( min( 10, max( $attempt, $retry ) ) );
				continue;
			}
			if ( $code >= 400 ) {
				$msg = is_array( $json ) ? (string) ( $json['message'] ?? $json['details'] ?? $json['code'] ?? '' ) : substr( $raw, 0, 200 );
				throw new \RuntimeException( "Ads API HTTP {$code}" . ( '' !== $msg ? " — {$msg}" : '' ) );
			}
			return is_array( $json ) ? $json : array();
		}
		throw new \RuntimeException( 'Ads API failed after retries: ' . $last );
	}
}
