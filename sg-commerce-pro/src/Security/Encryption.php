<?php
/**
 * Encryption — AES-256-GCM with versioned envelope.
 *
 * Format (base64-encoded):
 *   [version:1 byte] [nonce:12 bytes] [tag:16 bytes] [ciphertext:N bytes]
 *
 * Version byte enables future algorithm migration without breaking
 * existing ciphertexts. Currently only version 1 (AES-256-GCM) is defined.
 *
 * Key derivation:
 *   Master seed = AUTH_KEY || SECURE_AUTH_KEY || LOGGED_IN_KEY
 *   PRK         = HMAC-SHA256(salt='', ikm=seed)
 *   Key         = HMAC-SHA256(key=PRK, data=context || 0x01)  (HKDF-Expand)
 *
 * If the WordPress salts are rotated, all stored ciphertexts become
 * undecryptable. That's by design — see rotate_keys() for migration.
 *
 * @package SevenGum\Commerce\Security
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Security;

defined( 'ABSPATH' ) || exit;

final class Encryption {

	private const VERSION_AES256GCM = 0x01;
	private const CONTEXT           = 'sg-commerce/v3';

	public function encrypt( string $plaintext ): string {
		if ( '' === $plaintext ) {
			return '';
		}
		$key   = $this->derive_key();
		$nonce = random_bytes( 12 );
		$tag   = '';
		$cipher = openssl_encrypt(
			$plaintext,
			'aes-256-gcm',
			$key,
			OPENSSL_RAW_DATA,
			$nonce,
			$tag,
			'',
			16
		);
		if ( false === $cipher ) {
			throw new \RuntimeException( 'Encryption failed: openssl returned false. Check that openssl extension is loaded.' );
		}
		$envelope = chr( self::VERSION_AES256GCM ) . $nonce . $tag . $cipher;
		return base64_encode( $envelope );
	}

	public function decrypt( string $payload ): string {
		if ( '' === $payload ) {
			return '';
		}
		$raw = base64_decode( $payload, true );
		if ( false === $raw || strlen( $raw ) < 30 ) {
			throw new \RuntimeException( 'Ciphertext malformed: too short or invalid base64.' );
		}
		$version = ord( $raw[0] );
		if ( self::VERSION_AES256GCM !== $version ) {
			throw new \RuntimeException( sprintf( 'Unsupported encryption version 0x%02X.', $version ) );
		}
		$nonce  = substr( $raw, 1, 12 );
		$tag    = substr( $raw, 13, 16 );
		$cipher = substr( $raw, 29 );
		$plain  = openssl_decrypt( $cipher, 'aes-256-gcm', $this->derive_key(), OPENSSL_RAW_DATA, $nonce, $tag );
		if ( false === $plain ) {
			throw new \RuntimeException( 'Decryption failed — tampered, corrupted, or AUTH_KEY rotated.' );
		}
		return $plain;
	}

	/**
	 * Detect whether a stored value looks like our envelope. Used by
	 * SettingsRepository to handle legacy plain-text gracefully.
	 */
	public function is_encrypted( string $payload ): bool {
		if ( '' === $payload ) {
			return false;
		}
		$raw = base64_decode( $payload, true );
		if ( false === $raw || strlen( $raw ) < 30 ) {
			return false;
		}
		return self::VERSION_AES256GCM === ord( $raw[0] );
	}

	private function derive_key(): string {
		$seed = ( defined( 'AUTH_KEY' )        ? (string) \AUTH_KEY        : '' )
			. '|' . ( defined( 'SECURE_AUTH_KEY' ) ? (string) \SECURE_AUTH_KEY : '' )
			. '|' . ( defined( 'LOGGED_IN_KEY' )   ? (string) \LOGGED_IN_KEY   : '' );

		if ( '||' === $seed ) {
			throw new \RuntimeException(
				'No WordPress AUTH_KEY available. Define AUTH_KEY in wp-config.php — generate one at https://api.wordpress.org/secret-key/1.1/salt/'
			);
		}
		// HKDF-Extract → HKDF-Expand (single block, output length = 32).
		$prk = hash_hmac( 'sha256', $seed, '', true );
		return hash_hmac( 'sha256', self::CONTEXT . chr( 0x01 ), $prk, true );
	}
}
