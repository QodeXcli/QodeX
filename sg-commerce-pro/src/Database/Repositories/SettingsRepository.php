<?php
/**
 * SettingsRepository — typed access to plugin settings.
 *
 * Settings live in TWO places:
 *   1. wp_options['sg_commerce_settings']     general (one big array)
 *   2. wp_options['sg_commerce_secret_<key>'] one row per encrypted secret
 *
 * Why two stores? Secrets are read rarely and never autoload, while general
 * settings autoload once per request. Splitting avoids decrypting unused
 * secrets on every page view.
 *
 * @package SevenGum\Commerce\Database\Repositories
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Database\Repositories;

use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Security\Encryption;

defined( 'ABSPATH' ) || exit;

final class SettingsRepository {

	private const GENERAL_KEY = 'sg_commerce_settings';
	private const SECRET_PREFIX = 'sg_commerce_secret_';

	private const SECRETS = array(
		'amazon_client_id',
		'amazon_client_secret',
		'amazon_refresh_token',
		'amazon_seller_id',
		'openai_api_key',
		'anthropic_api_key',
		'ollama_auth_token',
	);

	private ?array $cache = null;

	public function __construct(
		private Encryption $encryption,
		private Logger $logger,
	) {}

	public function get( string $key, mixed $default = null ): mixed {
		if ( in_array( $key, self::SECRETS, true ) ) {
			return $this->get_secret( $key, $default );
		}
		$settings = $this->all();
		return $settings[ $key ] ?? $default;
	}

	public function set( string $key, mixed $value ): bool {
		if ( in_array( $key, self::SECRETS, true ) ) {
			return $this->set_secret( $key, (string) $value );
		}
		$settings         = $this->all();
		$settings[ $key ] = $value;
		$this->cache      = $settings;
		return update_option( self::GENERAL_KEY, $settings, true );
	}

	public function has( string $key ): bool {
		if ( in_array( $key, self::SECRETS, true ) ) {
			$raw = get_option( self::SECRET_PREFIX . $key, '' );
			return is_string( $raw ) && '' !== $raw;
		}
		$settings = $this->all();
		return isset( $settings[ $key ] ) && '' !== $settings[ $key ] && array() !== $settings[ $key ];
	}

	public function delete( string $key ): bool {
		if ( in_array( $key, self::SECRETS, true ) ) {
			return delete_option( self::SECRET_PREFIX . $key );
		}
		$settings = $this->all();
		unset( $settings[ $key ] );
		$this->cache = $settings;
		return update_option( self::GENERAL_KEY, $settings, true );
	}

	/** All non-secret settings as an associative array. */
	public function all(): array {
		if ( null === $this->cache ) {
			$raw = get_option( self::GENERAL_KEY, array() );
			$this->cache = is_array( $raw ) ? $raw : array();
		}
		return $this->cache;
	}

	/** Mask a secret for safe display in admin forms. */
	public function mask( string $key ): string {
		return $this->has( $key ) ? '●●●●●●●● (saved — leave blank to keep)' : '';
	}

	/** Bulk update non-secret settings (single DB write). */
	public function update_many( array $values ): bool {
		$settings = $this->all();
		foreach ( $values as $k => $v ) {
			if ( in_array( $k, self::SECRETS, true ) ) {
				continue; // secrets must use set() individually
			}
			$settings[ $k ] = $v;
		}
		$this->cache = $settings;
		return update_option( self::GENERAL_KEY, $settings, true );
	}

	private function get_secret( string $key, mixed $default ): mixed {
		$raw = get_option( self::SECRET_PREFIX . $key, '' );
		if ( ! is_string( $raw ) || '' === $raw ) {
			return $default;
		}
		try {
			return $this->encryption->decrypt( $raw );
		} catch ( \Throwable $e ) {
			$this->logger->error( "Failed to decrypt secret '{$key}': " . $e->getMessage() );
			return $default;
		}
	}

	private function set_secret( string $key, string $value ): bool {
		if ( '' === $value ) {
			return delete_option( self::SECRET_PREFIX . $key );
		}
		try {
			$encrypted = $this->encryption->encrypt( $value );
		} catch ( \Throwable $e ) {
			$this->logger->error( "Failed to encrypt secret '{$key}': " . $e->getMessage() );
			return false;
		}
		return update_option( self::SECRET_PREFIX . $key, $encrypted, false );
	}
}
