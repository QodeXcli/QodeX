<?php
/**
 * ReviewRequester — automated "Request a Review" via the Solicitations API.
 *
 *   GET  /solicitations/v1/orders/{amazonOrderId}?marketplaceIds=…
 *   POST /solicitations/v1/orders/{amazonOrderId}/solicitations/productReviewAndSellerFeedback?marketplaceIds=…
 *
 * This is the same Amazon-templated request as the button in Seller
 * Central — fully Terms-of-Service compliant (no custom text, no incentives).
 * Amazon only allows it 5–30 days after delivery, once per order.
 *
 * Selection: shipped orders whose estimated delivery + delay_days has
 * passed and that are still inside the 30-day window, excluding orders
 * that were refunded or returned (no point asking an unhappy buyer).
 *
 * @package SevenGum\Commerce\Suite\Reviews
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Reviews;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Suite\SuiteSettings;
use SevenGum\Commerce\Suite\Support\Db;

defined( 'ABSPATH' ) || exit;

final class ReviewRequester {

	private const ACTION = 'productReviewAndSellerFeedback';

	public function __construct(
		private AmazonClient $client,
		private SuiteSettings $settings,
		private Logger $logger,
	) {}

	/** Orders eligible right now (not yet attempted). */
	public function candidates( int $limit, ?int $now = null ): array {
		$now   = $now ?? time();
		$delay = max( 5, $this->settings->int( 'suite_reviews_delay_days' ) );
		// Delivery estimate: latest_delivery, else earliest_delivery, else purchase + 7 days.
		$ready_before = gmdate( 'Y-m-d H:i:s', $now - $delay * DAY_IN_SECONDS );
		$too_old      = gmdate( 'Y-m-d H:i:s', $now - 29 * DAY_IN_SECONDS );
		$skip_refunds = $this->settings->bool( 'suite_reviews_skip_refunded' );

		$sql = "SELECT o.amazon_order_id, o.market,
		               COALESCE(o.latest_delivery, o.earliest_delivery, DATE_ADD(o.purchase_date, INTERVAL 7 DAY)) AS delivered
		        FROM {t:orders} o
		        LEFT JOIN {t:solicitations} s ON s.amazon_order_id = o.amazon_order_id
		        WHERE o.status = 'Shipped' AND o.is_demo = 0 AND s.id IS NULL
		          AND COALESCE(o.latest_delivery, o.earliest_delivery, DATE_ADD(o.purchase_date, INTERVAL 7 DAY)) <= %s
		          AND COALESCE(o.latest_delivery, o.earliest_delivery, DATE_ADD(o.purchase_date, INTERVAL 7 DAY)) >= %s";
		if ( $skip_refunds ) {
			$sql .= " AND NOT EXISTS (SELECT 1 FROM {t:fin_events} f WHERE f.amazon_order_id = o.amazon_order_id AND f.event_type = 'Refund')
			          AND NOT EXISTS (SELECT 1 FROM {t:returns} r WHERE r.amazon_order_id = o.amazon_order_id)";
		}
		$sql .= ' ORDER BY delivered ASC LIMIT %d';
		return Db::rows( $sql, array( $ready_before, $too_old, $limit ) );
	}

	/** @return array{sent:int, ineligible:int, errors:int} */
	public function run(): array {
		$stats = array( 'sent' => 0, 'ineligible' => 0, 'errors' => 0 );
		if ( ! $this->settings->bool( 'suite_reviews_enabled' ) || ! $this->client->has_credentials() ) {
			return $stats;
		}
		$sent_today = (int) Db::var(
			"SELECT COUNT(*) FROM {t:solicitations} WHERE status = 'sent' AND attempted_at >= %s",
			array( gmdate( 'Y-m-d 00:00:00' ) )
		);
		$budget = max( 0, $this->settings->int( 'suite_reviews_daily_cap' ) - $sent_today );
		// Each order needs 2 calls at 1 rps; cap per tick to stay inside cron time limits.
		foreach ( $this->candidates( min( $budget, 40 ) ) as $o ) {
			$r = $this->request_one( (string) $o['amazon_order_id'], (string) $o['market'] );
			$stats[ $r ]++;
			if ( 'errors' === $r && $stats['errors'] >= 3 ) {
				break;
			}
		}
		return $stats;
	}

	/** @return 'sent'|'ineligible'|'errors' */
	public function request_one( string $order_id, string $market ): string {
		$mp  = $this->client->marketplace_info( $market );
		$q   = array( 'marketplaceIds' => (string) ( $mp['id'] ?? '' ) );
		$base = '/solicitations/v1/orders/' . rawurlencode( $order_id );
		try {
			$actions = $this->client->request( 'GET', $market, $base, $q, null, 'solicitations' );
			$available = false;
			foreach ( (array) ( $actions['_links']['actions'] ?? array() ) as $a ) {
				if ( str_contains( (string) ( $a['href'] ?? '' ), self::ACTION ) || self::ACTION === ( $a['name'] ?? '' ) ) {
					$available = true;
				}
			}
			if ( ! $available ) {
				$this->record( $order_id, $market, 'ineligible', 'Amazon reports no review request available (outside window or already requested).' );
				return 'ineligible';
			}
			$this->client->request( 'POST', $market, $base . '/solicitations/' . self::ACTION, $q, array(), 'solicitations' );
			$this->record( $order_id, $market, 'sent', '' );
			return 'sent';
		} catch ( \Throwable $e ) {
			$msg = $e->getMessage();
			// 403 here means the order is not eligible (e.g. already requested in Seller Central).
			$status = str_contains( $msg, '403' ) || str_contains( $msg, 'not eligible' ) ? 'ineligible' : 'error';
			$this->record( $order_id, $market, $status, mb_substr( $msg, 0, 250 ) );
			return 'ineligible' === $status ? 'ineligible' : 'errors';
		}
	}

	public function record( string $order_id, string $market, string $status, string $message, bool $demo = false ): void {
		Db::upsert( 'solicitations', array(
			'market'          => $market,
			'amazon_order_id' => $order_id,
			'status'          => $status,
			'message'         => $message,
			'attempted_at'    => Db::now(),
			'is_demo'         => $demo ? 1 : 0,
		) );
	}

	/** Allow errored orders to be retried. */
	public function retry_errors(): int {
		return Db::exec( "DELETE FROM {t:solicitations} WHERE status = 'error'" );
	}

	public function stats( int $days = 30 ): array {
		$since = gmdate( 'Y-m-d H:i:s', time() - $days * DAY_IN_SECONDS );
		$by = array( 'sent' => 0, 'ineligible' => 0, 'error' => 0 );
		foreach ( Db::rows( 'SELECT status, COUNT(*) AS n FROM {t:solicitations} WHERE attempted_at >= %s GROUP BY status', array( $since ) ) as $r ) {
			$by[ (string) $r['status'] ] = (int) $r['n'];
		}
		$daily = Db::rows(
			"SELECT DATE(attempted_at) AS d, SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent FROM {t:solicitations}
			 WHERE attempted_at >= %s GROUP BY DATE(attempted_at) ORDER BY d",
			array( $since )
		);
		return array(
			'by_status' => $by,
			'daily'     => $daily,
			'pending'   => count( $this->candidates( 500 ) ),
			'recent'    => Db::rows( 'SELECT * FROM {t:solicitations} ORDER BY attempted_at DESC LIMIT 100' ),
		);
	}
}
