<?php
/**
 * JobQueue — async job queueing.
 *
 * Prefers Action Scheduler (battle-tested, used by WooCommerce). Falls back
 * to single-shot wp_schedule_single_event when Action Scheduler isn't loaded.
 *
 * Usage:
 *   $queue->enqueue('sg_commerce_describe_product', ['id' => 42]);
 *   add_action('sg_commerce_describe_product', fn($args) => ...);
 *
 * @package SevenGum\Commerce\Queue
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Queue;

use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class JobQueue {

	public function __construct( private Logger $logger ) {}

	/**
	 * Enqueue a job for immediate (next tick) async execution.
	 *
	 * @param string  $hook   Hook name to fire.
	 * @param array   $args   Single-element array passed to the listener.
	 * @param int     $delay  Seconds to wait before firing.
	 */
	public function enqueue( string $hook, array $args = array(), int $delay = 0 ): void {
		$timestamp = time() + max( 0, $delay );

		if ( function_exists( 'as_schedule_single_action' ) ) {
			as_schedule_single_action( $timestamp, $hook, array( $args ), 'sg_commerce' );
			$this->logger->debug( 'Job queued via Action Scheduler', array( 'hook' => $hook, 'delay' => $delay ) );
			return;
		}

		// Fallback: single-shot wp-cron. Note: less reliable on low-traffic sites.
		wp_schedule_single_event( $timestamp, $hook, array( $args ) );
		$this->logger->debug( 'Job queued via wp-cron fallback', array( 'hook' => $hook, 'delay' => $delay ) );
	}

	/**
	 * Schedule a recurring job. Idempotent: silently no-ops if already scheduled.
	 */
	public function recurring( string $hook, string $recurrence, array $args = array() ): void {
		if ( function_exists( 'as_schedule_recurring_action' ) && ! as_next_scheduled_action( $hook, null, 'sg_commerce' ) ) {
			$interval = $this->recurrence_to_seconds( $recurrence );
			as_schedule_recurring_action( time() + 60, $interval, $hook, array( $args ), 'sg_commerce' );
			return;
		}
		if ( ! wp_next_scheduled( $hook, array( $args ) ) ) {
			wp_schedule_event( time() + 60, $recurrence, $hook, array( $args ) );
		}
	}

	public function cancel( string $hook ): void {
		if ( function_exists( 'as_unschedule_all_actions' ) ) {
			as_unschedule_all_actions( $hook, null, 'sg_commerce' );
		}
		wp_clear_scheduled_hook( $hook );
	}

	/** Pending job count for admin display. */
	public function pending( string $hook ): int {
		if ( ! function_exists( 'as_get_scheduled_actions' ) ) {
			return 0;
		}
		$actions = as_get_scheduled_actions(
			array(
				'hook'   => $hook,
				'status' => 'pending',
				'group'  => 'sg_commerce',
				'per_page' => 1000,
			),
			'ids'
		);
		return is_array( $actions ) ? count( $actions ) : 0;
	}

	private function recurrence_to_seconds( string $recurrence ): int {
		return match ( $recurrence ) {
			'sg_five_minutes'    => 5 * MINUTE_IN_SECONDS,
			'sg_fifteen_minutes' => 15 * MINUTE_IN_SECONDS,
			'sg_six_hours'       => 6 * HOUR_IN_SECONDS,
			'hourly'             => HOUR_IN_SECONDS,
			'twicedaily'         => 12 * HOUR_IN_SECONDS,
			'daily'              => DAY_IN_SECONDS,
			default              => HOUR_IN_SECONDS,
		};
	}
}
