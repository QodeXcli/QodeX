<?php
/**
 * AWS Signature V4 signer — required for polling Amazon SQS.
 *
 * Amazon SP-API Notifications pushes events (order status, BuyBox changes,
 * inventory alerts) to an SQS queue in your AWS account. To consume those
 * messages we need to call the SQS API using AWS Signature V4.
 *
 * This is a minimal, dependency-free signer that handles ReceiveMessage
 * and DeleteMessage — the only two operations we need. It does NOT rely
 * on the AWS SDK (which is ~50MB of dependencies we don't want to drag
 * into a WordPress plugin).
 *
 * Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
 *
 * @package SevenGum\Commerce\Amazon\SQSConsumer
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon\SQSConsumer;

defined( 'ABSPATH' ) || exit;

final class SignatureV4 {

	public function __construct(
		private string $access_key,
		private string $secret_key,
		private string $region,
		private string $service = 'sqs',
	) {}

	/**
	 * Sign a GET request to an SQS queue URL and return {url, headers} for
	 * wp_remote_get(). Query params are passed as $params.
	 */
	public function sign_get( string $queue_url, array $params ): array {
		$parsed = wp_parse_url( $queue_url );
		$host   = (string) $parsed['host'];
		$path   = (string) ( $parsed['path'] ?? '/' );

		ksort( $params );
		$canonical_query = http_build_query( $params, '', '&', PHP_QUERY_RFC3986 );

		$amz_date     = gmdate( 'Ymd\THis\Z' );
		$date_stamp   = gmdate( 'Ymd' );

		$payload_hash = hash( 'sha256', '' );

		$canonical_headers = "host:{$host}\nx-amz-date:{$amz_date}\n";
		$signed_headers    = 'host;x-amz-date';

		$canonical_request = implode( "\n", array(
			'GET',
			$path,
			$canonical_query,
			$canonical_headers,
			$signed_headers,
			$payload_hash,
		) );

		$algorithm      = 'AWS4-HMAC-SHA256';
		$credential_scope = "{$date_stamp}/{$this->region}/{$this->service}/aws4_request";
		$string_to_sign = implode( "\n", array(
			$algorithm,
			$amz_date,
			$credential_scope,
			hash( 'sha256', $canonical_request ),
		) );

		$k_date    = hash_hmac( 'sha256', $date_stamp, 'AWS4' . $this->secret_key, true );
		$k_region  = hash_hmac( 'sha256', $this->region, $k_date, true );
		$k_service = hash_hmac( 'sha256', $this->service, $k_region, true );
		$k_signing = hash_hmac( 'sha256', 'aws4_request', $k_service, true );
		$signature = hash_hmac( 'sha256', $string_to_sign, $k_signing );

		$authorization = "{$algorithm} Credential={$this->access_key}/{$credential_scope}, "
			. "SignedHeaders={$signed_headers}, Signature={$signature}";

		return array(
			'url'     => "{$queue_url}?{$canonical_query}",
			'headers' => array(
				'Host'          => $host,
				'X-Amz-Date'    => $amz_date,
				'Authorization' => $authorization,
			),
		);
	}
}
