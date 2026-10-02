<?php
/**
 * SuiteAlerts — raises an alert in the core feed and optionally emails it.
 *
 * Email goes to `suite_alert_email` (falls back to the site admin email)
 * for the levels listed in `suite_alert_email_levels` (comma separated,
 * default "critical"), throttled to one email per title per 6 hours.
 *
 * @package SevenGum\Commerce\Suite\Support
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Support;

use SevenGum\Commerce\Automation\AlertDispatcher;

defined( 'ABSPATH' ) || exit;

final class SuiteAlerts {

	public static function raise( string $level, string $category, string $title, string $message = '', array $context = array() ): void {
		AlertDispatcher::create( $level, $category, $title, $message, $context );

		$settings = get_option( 'sg_commerce_settings', array() );
		$settings = is_array( $settings ) ? $settings : array();
		$levels   = array_map( 'trim', explode( ',', (string) ( $settings['suite_alert_email_levels'] ?? 'critical' ) ) );
		if ( ! in_array( $level, $levels, true ) ) {
			return;
		}
		$key = 'sg_suite_mail_' . md5( $title );
		if ( get_transient( $key ) ) {
			return;
		}
		set_transient( $key, 1, 6 * HOUR_IN_SECONDS );
		$to = (string) ( $settings['suite_alert_email'] ?? '' );
		$to = is_email( $to ) ? $to : (string) get_option( 'admin_email' );
		if ( '' === $to ) {
			return;
		}
		wp_mail(
			$to,
			'[Amazon Suite] ' . $title,
			$message . "\n\n" . admin_url( 'admin.php?page=sg-suite#/alerts' )
		);
	}
}
