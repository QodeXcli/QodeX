<?php
/**
 * SQSConsumer — polls an Amazon SQS queue for real-time SP-API notifications.
 *
 * Amazon SP-API Notifications API lets you subscribe to event types
 * (ORDER_CHANGE, ANY_OFFER_CHANGED, FBA_INVENTORY_AVAILABILITY_CHANGES)
 * and have Amazon push them to your SQS queue. This is FAR better than
 * polling the API every hour:
 *
 *   - Instant (< 1 minute from the event happening)
 *   - No API throttle consumed
 *   - Fewer false-positive "changes" to process
 *
 * Setup (done once, outside this plugin):
 *   1. Create SQS queue in AWS Console
 *   2. Give Amazon's principal (arn:aws:iam::437568002678:root) SendMessage
 *      permission on it
 *   3. Call SP-API /notifications/v1/subscriptions for each event type you
 *      want, with destinationId = SQS queue ARN
 *
 * This class then polls the queue, dispatches each message through our
 * EventDispatcher, and deletes the message on success.
 *
 * Messages come wrapped in Amazon's notification envelope:
 *   { "NotificationType": "ANY_OFFER_CHANGED",
 *     "EventTime": "2026-04-17T10:00:00Z",
 *     "Payload": { ... } }
 *
 * @package SevenGum\Commerce\Amazon\SQSConsumer
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon\SQSConsumer;

use SevenGum\Commerce\Core\Container;
use SevenGum\Commerce\Core\Module;
use SevenGum\Commerce\Database\Repositories\ProductRepository;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;
use SevenGum\Commerce\Events\EventDispatcher;
use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Security\Encryption;

defined( 'ABSPATH' ) || exit;

final class SQSConsumer implements Module {

	private const CRON_HOOK = 'sg_commerce_sqs_poll';

	public function __construct( private Container $container ) {}

	public function id(): string {
		return 'sqs';
	}

	public function register(): void {
		add_action( self::CRON_HOOK, array( $this, 'poll' ) );

		$settings = $this->container->get( SettingsRepository::class );
		if ( $settings->get( 'sqs_enabled', false ) ) {
			if ( ! wp_next_scheduled( self::CRON_HOOK ) ) {
				wp_schedule_event( time() + 60, 'sg_five_minutes', self::CRON_HOOK );
			}
		}
	}

	/**
	 * Poll SQS. Runs until queue is empty OR 25 messages processed (whichever
	 * comes first) to stay under the default PHP max_execution_time.
	 */
	public function poll(): int {
		$settings = $this->container->get( SettingsRepository::class );
		$logger   = $this->container->get( Logger::class );
		$enc      = $this->container->get( Encryption::class );

		$queue_url  = (string) $settings->get( 'sqs_queue_url', '' );
		$region     = (string) $settings->get( 'sqs_region', 'us-east-1' );
		$access_key = (string) $settings->get( 'sqs_access_key', '' );

		if ( '' === $queue_url || '' === $access_key ) {
			return 0;
		}
		$secret_key_enc = (string) $settings->get( 'sqs_secret_key_enc', '' );
		try {
			$secret_key = '' !== $secret_key_enc ? $enc->decrypt( $secret_key_enc ) : '';
		} catch ( \Throwable $e ) {
			$logger->error( 'SQS: secret key decrypt failed' );
			return 0;
		}
		if ( '' === $secret_key ) return 0;

		$signer = new SignatureV4( $access_key, $secret_key, $region );
		$events = $this->container->get( EventDispatcher::class );

		$processed = 0;
		$loop_cap  = 3; // Up to 3 receive batches × 10 messages = 30 per cron tick.

		for ( $i = 0; $i < $loop_cap; $i++ ) {
			$messages = $this->receive_messages( $signer, $queue_url );
			if ( empty( $messages ) ) break;

			foreach ( $messages as $msg ) {
				try {
					$body = json_decode( (string) $msg['body'], true );
					if ( ! is_array( $body ) ) {
						$logger->warning( 'SQS: unparseable message body' );
					} else {
						$this->handle_notification( $body, $events );
					}
					$this->delete_message( $signer, $queue_url, (string) $msg['receipt_handle'] );
					$processed++;
				} catch ( \Throwable $e ) {
					$logger->error( 'SQS message processing failed', array( 'err' => $e->getMessage() ) );
					// Leave the message; SQS visibility timeout will re-deliver it.
				}
			}
			if ( count( $messages ) < 10 ) break; // Queue drained.
		}
		if ( $processed > 0 ) {
			$logger->info( 'SQS poll complete', array( 'processed' => $processed ) );
		}
		return $processed;
	}

	/**
	 * Dispatch a single notification envelope to appropriate domain events
	 * and side effects.
	 */
	private function handle_notification( array $body, EventDispatcher $events ): void {
		$type    = strtoupper( (string) ( $body['NotificationType'] ?? $body['notificationType'] ?? '' ) );
		$payload = (array) ( $body['Payload'] ?? $body['payload'] ?? array() );

		// Emit as a generic event first.
		$events->dispatch( 'sqs.' . strtolower( $type ), $payload );

		switch ( $type ) {
			case 'ANY_OFFER_CHANGED':
				$this->handle_offer_change( $payload );
				break;
			case 'ORDER_CHANGE':
				$events->dispatch( 'order.changed', $payload );
				break;
			case 'FBA_INVENTORY_AVAILABILITY_CHANGES':
				$this->handle_inventory_change( $payload );
				break;
			case 'FEED_PROCESSING_FINISHED':
				$events->dispatch( 'feed.finished', $payload );
				break;
			case 'REPORT_PROCESSING_FINISHED':
				$events->dispatch( 'report.finished', $payload );
				break;
		}
	}

	/**
	 * Incremental Buy Box update — patches one SKU without re-syncing all.
	 */
	private function handle_offer_change( array $payload ): void {
		$offer = $payload['AnyOfferChangedNotification']['OfferChangeTrigger'] ?? null;
		if ( ! is_array( $offer ) ) return;
		$asin = (string) ( $offer['ASIN'] ?? '' );
		$marketplace_id = (string) ( $offer['MarketplaceId'] ?? '' );
		if ( '' === $asin || '' === $marketplace_id ) return;

		// Map marketplace ID → market code.
		$mp      = $this->container->get( \SevenGum\Commerce\Amazon\Marketplaces::class );
		$market  = $mp->code_by_id( $marketplace_id );
		if ( '' === $market ) return;

		// Extract new Buy Box from the summary.
		$summary = (array) ( $payload['AnyOfferChangedNotification']['Summary'] ?? array() );
		$buybox  = (array) ( $summary['BuyBoxPrices'][0] ?? array() );
		if ( empty( $buybox ) ) return;

		$price    = (float) ( $buybox['ListingPrice']['Amount'] ?? 0 );
		$currency = (string) ( $buybox['ListingPrice']['CurrencyCode'] ?? '' );

		// Patch DB by ASIN+market.
		global $wpdb;
		$wpdb->query( $wpdb->prepare(
			"UPDATE {$wpdb->prefix}sg_products
			 SET buybox_price = %f, buybox_currency = %s, updated_at = UTC_TIMESTAMP()
			 WHERE asin = %s AND market = %s",
			$price, $currency, $asin, $market
		) );

		$this->container->get( Logger::class )->info( 'BuyBox patched from SQS', array(
			'asin' => $asin, 'market' => $market, 'price' => $price,
		) );
	}

	private function handle_inventory_change( array $payload ): void {
		$sku = (string) ( $payload['FBAInventoryAvailabilityNotification']['SellerSku'] ?? '' );
		if ( '' === $sku ) return;
		$qty = (int) ( $payload['FBAInventoryAvailabilityNotification']['FulfillableQuantity'] ?? 0 );
		$marketplace_id = (string) ( $payload['FBAInventoryAvailabilityNotification']['MarketplaceId'] ?? '' );
		$mp = $this->container->get( \SevenGum\Commerce\Amazon\Marketplaces::class );
		$market = $mp->code_by_id( $marketplace_id );
		if ( '' === $market ) return;

		global $wpdb;
		$wpdb->query( $wpdb->prepare(
			"UPDATE {$wpdb->prefix}sg_products
			 SET fulfillable_qty = %d, updated_at = UTC_TIMESTAMP()
			 WHERE sku = %s AND market = %s",
			$qty, $sku, $market
		) );
	}

	private function receive_messages( SignatureV4 $signer, string $queue_url ): array {
		$signed = $signer->sign_get( $queue_url, array(
			'Action'              => 'ReceiveMessage',
			'Version'             => '2012-11-05',
			'MaxNumberOfMessages' => 10,
			'WaitTimeSeconds'     => 5, // Long-poll briefly to avoid empty responses.
		) );

		$response = wp_remote_get( $signed['url'], array(
			'headers' => $signed['headers'],
			'timeout' => 15,
		) );
		if ( is_wp_error( $response ) ) {
			throw new \RuntimeException( 'SQS receive failed: ' . $response->get_error_message() );
		}
		$code = wp_remote_retrieve_response_code( $response );
		if ( 200 !== (int) $code ) {
			throw new \RuntimeException( 'SQS receive HTTP ' . $code );
		}

		$xml = simplexml_load_string( (string) wp_remote_retrieve_body( $response ) );
		if ( false === $xml ) return array();

		$out = array();
		foreach ( $xml->ReceiveMessageResult->Message ?? array() as $m ) {
			$out[] = array(
				'message_id'     => (string) $m->MessageId,
				'receipt_handle' => (string) $m->ReceiptHandle,
				'body'           => (string) $m->Body,
			);
		}
		return $out;
	}

	private function delete_message( SignatureV4 $signer, string $queue_url, string $receipt_handle ): void {
		$signed = $signer->sign_get( $queue_url, array(
			'Action'        => 'DeleteMessage',
			'Version'       => '2012-11-05',
			'ReceiptHandle' => $receipt_handle,
		) );
		wp_remote_get( $signed['url'], array(
			'headers' => $signed['headers'],
			'timeout' => 10,
		) );
	}
}
