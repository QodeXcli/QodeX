<?php
/**
 * Logger — structured logger.
 *
 * PSR-3 inspired interface (debug/info/notice/warning/error/critical).
 * Writes to wp-content/uploads/sg-commerce-logs/YYYY-MM-DD.log with
 * one JSON object per line. Easy to grep, easy to ship to ELK later.
 *
 * Falls back to error_log() if filesystem isn't writable.
 *
 * Log level filter is read from settings, default 'info'.
 *
 * @package SevenGum\Commerce\Logging
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Logging;

defined( 'ABSPATH' ) || exit;

final class Logger {

	public const DEBUG    = 100;
	public const INFO     = 200;
	public const NOTICE   = 250;
	public const WARNING  = 300;
	public const ERROR    = 400;
	public const CRITICAL = 500;

	private const LEVEL_NAMES = array(
		self::DEBUG    => 'DEBUG',
		self::INFO     => 'INFO',
		self::NOTICE   => 'NOTICE',
		self::WARNING  => 'WARNING',
		self::ERROR    => 'ERROR',
		self::CRITICAL => 'CRITICAL',
	);

	private ?string $log_dir = null;
	private int $threshold;

	public function __construct() {
		$settings = get_option( 'sg_commerce_settings', array() );
		$level    = is_array( $settings ) ? (string) ( $settings['log_level'] ?? 'info' ) : 'info';
		$this->threshold = $this->level_from_name( $level );
	}

	public function debug   ( string $msg, array $ctx = array() ): void { $this->log( self::DEBUG,    $msg, $ctx ); }
	public function info    ( string $msg, array $ctx = array() ): void { $this->log( self::INFO,     $msg, $ctx ); }
	public function notice  ( string $msg, array $ctx = array() ): void { $this->log( self::NOTICE,   $msg, $ctx ); }
	public function warning ( string $msg, array $ctx = array() ): void { $this->log( self::WARNING,  $msg, $ctx ); }
	public function error   ( string $msg, array $ctx = array() ): void { $this->log( self::ERROR,    $msg, $ctx ); }
	public function critical( string $msg, array $ctx = array() ): void { $this->log( self::CRITICAL, $msg, $ctx ); }

	public function log( int $level, string $message, array $context = array() ): void {
		if ( $level < $this->threshold ) {
			return;
		}
		$record = array(
			'timestamp' => gmdate( 'c' ),
			'level'     => self::LEVEL_NAMES[ $level ] ?? 'UNKNOWN',
			'message'   => $message,
			'context'   => $context,
		);
		$encoded = wp_json_encode( $record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );

		$file = $this->ensure_log_file();
		if ( null !== $file ) {
			@file_put_contents( $file, $encoded . "\n", FILE_APPEND | LOCK_EX );
		} else {
			// Fallback — at least keep the record findable.
			error_log( '[SG Commerce] ' . $encoded );
		}
	}

	public function get_log_dir(): ?string {
		return $this->log_dir ?? $this->resolve_log_dir();
	}

	/**
	 * Read recent log lines for display in admin (most recent first).
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function tail( int $lines = 200 ): array {
		$file = $this->todays_file();
		if ( null === $file || ! is_readable( $file ) ) {
			return array();
		}
		$content = file( $file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES );
		if ( ! is_array( $content ) ) {
			return array();
		}
		$slice = array_slice( $content, -1 * $lines );
		$out   = array();
		foreach ( array_reverse( $slice ) as $line ) {
			$decoded = json_decode( (string) $line, true );
			if ( is_array( $decoded ) ) {
				$out[] = $decoded;
			}
		}
		return $out;
	}

	private function ensure_log_file(): ?string {
		$dir = $this->resolve_log_dir();
		if ( null === $dir ) {
			return null;
		}
		return $this->todays_file();
	}

	private function todays_file(): ?string {
		$dir = $this->log_dir ?? $this->resolve_log_dir();
		if ( null === $dir ) {
			return null;
		}
		return $dir . '/' . gmdate( 'Y-m-d' ) . '.log';
	}

	private function resolve_log_dir(): ?string {
		if ( null !== $this->log_dir ) {
			return $this->log_dir;
		}
		$uploads = wp_upload_dir( null, false );
		if ( ! empty( $uploads['error'] ) || empty( $uploads['basedir'] ) ) {
			return null;
		}
		$dir = trailingslashit( $uploads['basedir'] ) . 'sg-commerce-logs';
		if ( ! is_dir( $dir ) ) {
			if ( ! wp_mkdir_p( $dir ) ) {
				return null;
			}
			// Block direct HTTP access.
			@file_put_contents( $dir . '/.htaccess', "Deny from all\n" );
			@file_put_contents( $dir . '/index.html', '' );
		}
		$this->log_dir = $dir;
		return $dir;
	}

	private function level_from_name( string $name ): int {
		return match ( strtolower( $name ) ) {
			'debug'             => self::DEBUG,
			'info'              => self::INFO,
			'notice'            => self::NOTICE,
			'warning', 'warn'   => self::WARNING,
			'error'             => self::ERROR,
			'critical', 'crit'  => self::CRITICAL,
			default             => self::INFO,
		};
	}
}
