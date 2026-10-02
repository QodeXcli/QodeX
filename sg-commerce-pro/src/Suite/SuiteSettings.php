<?php
/**
 * SuiteSettings — typed defaults for every suite knob.
 *
 * Stored inside the core `sg_commerce_settings` array under `suite_*` keys
 * so the existing SettingsRepository (and its uninstall path) owns them.
 * Ads API secrets are stored encrypted via SettingsRepository secrets.
 *
 * @package SevenGum\Commerce\Suite
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite;

use SevenGum\Commerce\Database\Repositories\SettingsRepository;

defined( 'ABSPATH' ) || exit;

final class SuiteSettings {

	/** Secrets (encrypted at rest, never returned to the browser). */
	public const SECRETS = array( 'ads_client_id', 'ads_client_secret', 'ads_refresh_token' );

	/** key => [type, default] */
	public const SCHEMA = array(
		// Sync
		'suite_sync_enabled'          => array( 'bool', true ),
		'suite_backfill_days'         => array( 'int', 60 ),
		'suite_order_items_per_run'   => array( 'int', 25 ),
		// Profit
		'suite_default_unit_cost'     => array( 'float', 0.0 ),
		'suite_include_tax'           => array( 'bool', false ),
		// Restock
		'suite_lead_time_days'        => array( 'int', 30 ),
		'suite_safety_days'           => array( 'int', 14 ),
		'suite_target_cover_days'     => array( 'int', 60 ),
		'suite_overstock_days'        => array( 'int', 180 ),
		// Ads
		'suite_ads_enabled'           => array( 'bool', false ),
		'suite_ads_region'            => array( 'string', 'na' ),
		'suite_ads_profile_id'        => array( 'string', '' ),
		'suite_ads_target_acos'       => array( 'float', 30.0 ),
		'suite_ads_lookback_days'     => array( 'int', 14 ),
		'suite_ads_min_clicks'        => array( 'int', 12 ),
		'suite_ads_max_step_pct'      => array( 'float', 20.0 ),
		'suite_ads_min_bid'           => array( 'float', 0.20 ),
		'suite_ads_max_bid'           => array( 'float', 4.00 ),
		'suite_ads_raise_low_impr'    => array( 'bool', true ),
		'suite_ads_neg_min_clicks'    => array( 'int', 15 ),
		'suite_ads_harvest_min_orders'=> array( 'int', 2 ),
		'suite_ads_harvest_ad_group'  => array( 'string', '' ),
		'suite_ads_harvest_campaign'  => array( 'string', '' ),
		'suite_ads_auto_apply'        => array( 'bool', false ),
		// Reviews
		'suite_reviews_enabled'       => array( 'bool', false ),
		'suite_reviews_delay_days'    => array( 'int', 7 ),
		'suite_reviews_daily_cap'     => array( 'int', 150 ),
		'suite_reviews_skip_refunded' => array( 'bool', true ),
		// Monitor
		'suite_monitor_enabled'       => array( 'bool', true ),
		'suite_monitor_price_drop_pct'=> array( 'float', 10.0 ),
		'suite_monitor_extra_asins'   => array( 'string', '' ),
		// Alerts
		'suite_alert_email'           => array( 'string', '' ),
		'suite_alert_email_levels'    => array( 'string', 'critical' ),
	);

	public function __construct( private SettingsRepository $repo ) {}

	public function get( string $key ): mixed {
		if ( ! isset( self::SCHEMA[ $key ] ) ) {
			return null;
		}
		[ $type, $default ] = self::SCHEMA[ $key ];
		return self::cast( $type, $this->repo->get( $key, $default ) );
	}

	public function int( string $key ): int       { return (int) $this->get( $key ); }
	public function float( string $key ): float   { return (float) $this->get( $key ); }
	public function bool( string $key ): bool     { return (bool) $this->get( $key ); }
	public function string( string $key ): string { return (string) $this->get( $key ); }

	/** All public settings + secret presence flags (safe for REST). */
	public function export(): array {
		$out = array();
		foreach ( array_keys( self::SCHEMA ) as $k ) {
			$out[ $k ] = $this->get( $k );
		}
		foreach ( self::SECRETS as $s ) {
			$out[ 'has_' . $s ] = $this->has_secret( $s );
		}
		$out['seller_id_set'] = '' !== (string) $this->repo->get( 'amazon_seller_id', '' );
		return $out;
	}

	/**
	 * Persist from untrusted input. Unknown keys are ignored; values are
	 * cast to their declared type. Empty secrets keep the stored value.
	 *
	 * @return string[] keys saved
	 */
	public function save( array $input ): array {
		$values = array();
		foreach ( self::SCHEMA as $k => [ $type ] ) {
			if ( array_key_exists( $k, $input ) ) {
				$v = self::cast( $type, $input[ $k ] );
				if ( 'string' === $type ) {
					$v = sanitize_text_field( (string) $v );
				}
				$values[ $k ] = $v;
			}
		}
		if ( $values ) {
			$this->repo->update_many( $values );
		}
		$saved = array_keys( $values );
		foreach ( self::SECRETS as $s ) {
			$v = isset( $input[ $s ] ) ? trim( (string) $input[ $s ] ) : '';
			if ( '' !== $v ) {
				$this->repo->set( $s, $v );
				$saved[] = $s;
			}
		}
		if ( isset( $input['amazon_seller_id'] ) && '' !== trim( (string) $input['amazon_seller_id'] ) ) {
			$this->repo->set( 'amazon_seller_id', sanitize_text_field( (string) $input['amazon_seller_id'] ) );
			$saved[] = 'amazon_seller_id';
		}
		return $saved;
	}

	public function secret( string $key ): string {
		return (string) $this->repo->get( $key, '' );
	}

	public function has_secret( string $key ): bool {
		return $this->repo->has( $key );
	}

	public function seller_id(): string {
		return (string) $this->repo->get( 'amazon_seller_id', '' );
	}

	private static function cast( string $type, mixed $v ): mixed {
		return match ( $type ) {
			'int'    => (int) $v,
			'float'  => (float) $v,
			'bool'   => is_string( $v ) ? in_array( strtolower( $v ), array( '1', 'true', 'yes', 'on' ), true ) : (bool) $v,
			default  => is_scalar( $v ) ? (string) $v : '',
		};
	}
}
