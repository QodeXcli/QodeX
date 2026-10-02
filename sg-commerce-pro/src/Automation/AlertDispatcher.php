<?php
/**
 * AlertDispatcher — alert/notification feed.
 *
 * Static helpers because alerts are written from many call sites and
 * we don't want to drag the container through every single path.
 *
 * @package SevenGum\Commerce\Automation
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Automation;

defined( 'ABSPATH' ) || exit;

final class AlertDispatcher {

	public static function create(
		string $level,
		string $category,
		string $title,
		string $message = '',
		array $context = array(),
		?int $product_id = null
	): bool {
		global $wpdb;
		$result = $wpdb->insert(
			$wpdb->prefix . 'sg_alerts',
			array(
				'level'      => $level,
				'category'   => $category,
				'title'      => $title,
				'message'    => $message,
				'context'    => wp_json_encode( $context ),
				'product_id' => $product_id,
				'is_read'    => 0,
				'created_at' => current_time( 'mysql', true ),
			),
			array( '%s', '%s', '%s', '%s', '%s', '%d', '%d', '%s' )
		);
		return false !== $result;
	}

	public static function unread_count(): int {
		global $wpdb;
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}sg_alerts WHERE is_read = 0" );
	}

	public static function recent( int $limit = 50 ): array {
		global $wpdb;
		$rows = $wpdb->get_results( $wpdb->prepare(
			"SELECT * FROM {$wpdb->prefix}sg_alerts ORDER BY created_at DESC LIMIT %d",
			$limit
		), ARRAY_A );
		return is_array( $rows ) ? $rows : array();
	}

	public static function mark_read( int $id ): bool {
		global $wpdb;
		$result = $wpdb->update(
			$wpdb->prefix . 'sg_alerts',
			array( 'is_read' => 1 ),
			array( 'id' => $id ),
			array( '%d' ),
			array( '%d' )
		);
		return false !== $result;
	}

	public static function mark_all_read(): int {
		global $wpdb;
		$rows = $wpdb->query( "UPDATE {$wpdb->prefix}sg_alerts SET is_read = 1 WHERE is_read = 0" );
		return is_numeric( $rows ) ? (int) $rows : 0;
	}
}
