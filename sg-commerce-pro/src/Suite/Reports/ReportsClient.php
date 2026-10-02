<?php
/**
 * ReportsClient — SP-API Reports API 2021-06-30.
 *
 *   POST /reports/2021-06-30/reports                    createReport
 *   GET  /reports/2021-06-30/reports/{reportId}         getReport
 *   GET  /reports/2021-06-30/documents/{documentId}     getReportDocument
 *
 * Document URLs are pre-signed S3 links: they are downloaded WITHOUT the
 * x-amz-access-token header, and expire after 5 minutes, so download
 * immediately after resolving.
 *
 * @package SevenGum\Commerce\Suite\Reports
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Reports;

use SevenGum\Commerce\Amazon\AmazonClient;

defined( 'ABSPATH' ) || exit;

final class ReportsClient {

	private const BASE = '/reports/2021-06-30';

	public function __construct( private AmazonClient $client ) {}

	/**
	 * @return string reportId
	 */
	public function create( string $type, string $market, ?string $start = null, ?string $end = null, array $options = array() ): string {
		$mp   = $this->client->marketplace_info( $market );
		$body = array(
			'reportType'     => $type,
			'marketplaceIds' => array( (string) ( $mp['id'] ?? '' ) ),
		);
		if ( null !== $start ) {
			$body['dataStartTime'] = $start;
		}
		if ( null !== $end ) {
			$body['dataEndTime'] = $end;
		}
		if ( $options ) {
			$body['reportOptions'] = array_map( 'strval', $options );
		}
		$res = $this->client->request( 'POST', $market, self::BASE . '/reports', array(), $body, 'reports.create' );
		$id  = (string) ( $res['reportId'] ?? '' );
		if ( '' === $id ) {
			throw new \RuntimeException( 'createReport returned no reportId.' );
		}
		return $id;
	}

	/** @return array{processingStatus:string, reportDocumentId?:string} */
	public function get( string $report_id, string $market ): array {
		return $this->client->request( 'GET', $market, self::BASE . '/reports/' . rawurlencode( $report_id ), array(), null, 'reports.get' );
	}

	/** Resolve and download a document; returns decompressed raw content. */
	public function download( string $document_id, string $market ): string {
		$doc = $this->client->request( 'GET', $market, self::BASE . '/documents/' . rawurlencode( $document_id ), array(), null, 'reports.document' );
		$url = (string) ( $doc['url'] ?? '' );
		if ( '' === $url ) {
			throw new \RuntimeException( 'Report document has no download URL.' );
		}
		$res = wp_remote_get( $url, array( 'timeout' => 120 ) );
		if ( is_wp_error( $res ) ) {
			throw new \RuntimeException( 'Report download failed: ' . $res->get_error_message() );
		}
		if ( 200 !== (int) wp_remote_retrieve_response_code( $res ) ) {
			throw new \RuntimeException( 'Report download HTTP ' . wp_remote_retrieve_response_code( $res ) );
		}
		$body = (string) wp_remote_retrieve_body( $res );
		return 'GZIP' === strtoupper( (string) ( $doc['compressionAlgorithm'] ?? '' ) ) || str_starts_with( $body, "\x1f\x8b" )
			? ReportParser::maybe_gunzip( $body )
			: $body;
	}
}
