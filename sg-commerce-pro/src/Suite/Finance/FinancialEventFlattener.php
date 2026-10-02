<?php
/**
 * FinancialEventFlattener — turns SP-API Finances v0 `FinancialEvents` into
 * flat ledger lines (one line per charge / fee / promotion component).
 *
 * Every line is categorised so the P&L can be built with simple SUMs:
 *
 *   revenue        Principal, shipping & gift-wrap charges on shipments
 *   tax            Taxes collected (and withheld by marketplace facilitator)
 *   fee            Referral, FBA fulfilment, closing, storage, subscription…
 *   promo          Promotions / coupons / deals paid by the seller
 *   refund         Principal & shipping returned to buyers
 *   ads            Sponsored-ads invoices (ProductAdsPaymentEventList)
 *   reimbursement  FBA inventory reimbursements, SAFE-T, retrocharges credited
 *   adjustment     Everything else in AdjustmentEventList
 *   other          Liquidations etc.
 *
 * Signs are preserved exactly as Amazon reports them (fees negative,
 * revenue positive) so Σ(amount) == net payout for the window.
 *
 * Pure — no WordPress dependencies.
 *
 * @package SevenGum\Commerce\Suite\Finance
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Finance;

final class FinancialEventFlattener {

	private const TAX_TYPES = array(
		'Tax', 'ShippingTax', 'GiftWrapTax', 'TCS-CGST', 'TCS-SGST', 'TCS-IGST', 'TCS-UTGST',
		'MarketplaceFacilitatorTax-Principal', 'MarketplaceFacilitatorTax-Shipping',
		'MarketplaceFacilitatorTax-Giftwrap', 'MarketplaceFacilitatorTax-Other',
		'MarketplaceFacilitatorVAT-Principal', 'MarketplaceFacilitatorVAT-Shipping',
		'LowValueGoodsTax-Principal', 'LowValueGoodsTax-Shipping',
	);

	/**
	 * @param array  $events     payload.FinancialEvents
	 * @param string $fallback_posted  ISO date used when an event has no PostedDate
	 *                                 (ServiceFeeEvent has none in the v0 model).
	 * @return array<int, array{posted:string, event_type:string, order_id:string, sku:string, charge_type:string, category:string, amount:float, currency:string, qty:int, marketplace:string}>
	 */
	public static function flatten( array $events, string $fallback_posted ): array {
		$out = array();

		foreach ( (array) ( $events['ShipmentEventList'] ?? array() ) as $ev ) {
			self::shipment_like( $out, $ev, 'Shipment', $fallback_posted, false );
		}
		foreach ( (array) ( $events['RefundEventList'] ?? array() ) as $ev ) {
			self::shipment_like( $out, $ev, 'Refund', $fallback_posted, true );
		}
		foreach ( (array) ( $events['GuaranteeClaimEventList'] ?? array() ) as $ev ) {
			self::shipment_like( $out, $ev, 'GuaranteeClaim', $fallback_posted, true );
		}
		foreach ( (array) ( $events['ChargebackEventList'] ?? array() ) as $ev ) {
			self::shipment_like( $out, $ev, 'Chargeback', $fallback_posted, true );
		}

		foreach ( (array) ( $events['ServiceFeeEventList'] ?? array() ) as $ev ) {
			foreach ( (array) ( $ev['FeeList'] ?? array() ) as $fee ) {
				[ $amt, $cur ] = self::amount( $fee['FeeAmount'] ?? null );
				if ( 0.0 === $amt ) {
					continue;
				}
				$out[] = self::line(
					(string) ( $ev['PostedDate'] ?? $fallback_posted ), 'ServiceFee',
					(string) ( $ev['AmazonOrderId'] ?? '' ), (string) ( $ev['SellerSKU'] ?? '' ),
					(string) ( $fee['FeeType'] ?? ( $ev['FeeReason'] ?? 'ServiceFee' ) ), 'fee', $amt, $cur, 0, ''
				);
			}
		}

		foreach ( (array) ( $events['AdjustmentEventList'] ?? array() ) as $ev ) {
			$type   = (string) ( $ev['AdjustmentType'] ?? 'Adjustment' );
			$cat    = self::adjustment_category( $type );
			$posted = (string) ( $ev['PostedDate'] ?? $fallback_posted );
			$items  = (array) ( $ev['AdjustmentItemList'] ?? array() );
			if ( $items ) {
				foreach ( $items as $it ) {
					[ $amt, $cur ] = self::amount( $it['TotalAmount'] ?? null );
					if ( 0.0 === $amt ) {
						continue;
					}
					$out[] = self::line( $posted, 'Adjustment', '', (string) ( $it['SellerSKU'] ?? '' ), $type, $cat, $amt, $cur, (int) ( $it['Quantity'] ?? 0 ), '' );
				}
			} else {
				[ $amt, $cur ] = self::amount( $ev['AdjustmentAmount'] ?? null );
				if ( 0.0 !== $amt ) {
					$out[] = self::line( $posted, 'Adjustment', '', '', $type, $cat, $amt, $cur, 0, '' );
				}
			}
		}

		foreach ( (array) ( $events['ProductAdsPaymentEventList'] ?? array() ) as $ev ) {
			[ $amt, $cur ] = self::amount( $ev['transactionValue'] ?? null );
			if ( 0.0 === $amt ) {
				continue;
			}
			// Amazon reports ad charges as positive transactionValue for type "Charge".
			$signed = 'Refund' === ( $ev['transactionType'] ?? '' ) ? abs( $amt ) : -abs( $amt );
			$out[]  = self::line( (string) ( $ev['postedDate'] ?? $fallback_posted ), 'ProductAdsPayment', '', '', 'AdsInvoice:' . (string) ( $ev['invoiceId'] ?? '' ), 'ads', $signed, $cur, 0, '' );
		}

		foreach ( (array) ( $events['SellerDealPaymentEventList'] ?? array() ) as $ev ) {
			[ $amt, $cur ] = self::amount( $ev['totalAmount'] ?? null );
			if ( 0.0 !== $amt ) {
				$out[] = self::line( (string) ( $ev['postedDate'] ?? $fallback_posted ), 'SellerDealPayment', '', '', 'DealFee:' . (string) ( $ev['dealId'] ?? '' ), 'promo', $amt, $cur, 0, '' );
			}
		}

		foreach ( (array) ( $events['CouponPaymentEventList'] ?? array() ) as $ev ) {
			[ $amt, $cur ] = self::amount( $ev['TotalAmount'] ?? null );
			if ( 0.0 !== $amt ) {
				$out[] = self::line( (string) ( $ev['PostedDate'] ?? $fallback_posted ), 'CouponPayment', '', '', 'Coupon:' . (string) ( $ev['CouponId'] ?? '' ), 'promo', $amt, $cur, 0, '' );
			}
		}

		foreach ( (array) ( $events['SAFETReimbursementEventList'] ?? array() ) as $ev ) {
			[ $amt, $cur ] = self::amount( $ev['ReimbursedAmount'] ?? null );
			if ( 0.0 !== $amt ) {
				$out[] = self::line( (string) ( $ev['PostedDate'] ?? $fallback_posted ), 'SAFETReimbursement', '', '', 'SAFE-T:' . (string) ( $ev['SAFETClaimId'] ?? '' ), 'reimbursement', $amt, $cur, 0, '' );
			}
		}

		foreach ( (array) ( $events['RetrochargeEventList'] ?? array() ) as $ev ) {
			foreach ( array( 'BaseTax', 'ShippingTax' ) as $k ) {
				[ $amt, $cur ] = self::amount( $ev[ $k ] ?? null );
				if ( 0.0 !== $amt ) {
					$out[] = self::line( (string) ( $ev['PostedDate'] ?? $fallback_posted ), 'Retrocharge', (string) ( $ev['AmazonOrderId'] ?? '' ), '', 'Retrocharge:' . $k, 'tax', $amt, $cur, 0, '' );
				}
			}
		}

		foreach ( (array) ( $events['FBALiquidationEventList'] ?? array() ) as $ev ) {
			foreach ( array( 'LiquidationProceedsAmount' => 'other', 'LiquidationFeeAmount' => 'fee' ) as $k => $cat ) {
				[ $amt, $cur ] = self::amount( $ev[ $k ] ?? null );
				if ( 0.0 !== $amt ) {
					$out[] = self::line( (string) ( $ev['PostedDate'] ?? $fallback_posted ), 'FBALiquidation', '', '', $k, $cat, $amt, $cur, 0, '' );
				}
			}
		}

		return $out;
	}

	/** Deterministic hash so re-fetching a window is idempotent. */
	public static function hash( array $line, int $ordinal ): string {
		return sha1( implode( '|', array(
			$line['posted'], $line['event_type'], $line['order_id'], $line['sku'],
			$line['charge_type'], number_format( $line['amount'], 4, '.', '' ), $line['currency'], $ordinal,
		) ) );
	}

	public static function adjustment_category( string $type ): string {
		// Amazon mixes styles: "FBAInventoryReimbursement", "WAREHOUSE_DAMAGE", "MISSING_FROM_INBOUND".
		$t = (string) preg_replace( '/[^a-z]/', '', strtolower( $type ) );
		if ( str_contains( $t, 'reimbursement' ) || str_contains( $t, 'warehousedamage' ) || str_contains( $t, 'warehouselost' )
			|| str_contains( $t, 'missingfrominbound' ) || str_contains( $t, 'compensatedclawback' ) || str_contains( $t, 'freereplacementrefund' ) ) {
			return 'reimbursement';
		}
		if ( str_contains( $t, 'storage' ) || str_contains( $t, 'fee' ) || str_contains( $t, 'postage' ) ) {
			return 'fee';
		}
		return 'adjustment';
	}

	public static function charge_category( string $charge_type, bool $is_refund ): string {
		if ( in_array( $charge_type, self::TAX_TYPES, true ) || str_contains( $charge_type, 'Tax' ) || str_contains( $charge_type, 'VAT' ) ) {
			return 'tax';
		}
		return $is_refund ? 'refund' : 'revenue';
	}

	private static function shipment_like( array &$out, array $ev, string $type, string $fallback, bool $is_refund ): void {
		$posted   = (string) ( $ev['PostedDate'] ?? $fallback );
		$order_id = (string) ( $ev['AmazonOrderId'] ?? '' );
		$mkt      = (string) ( $ev['MarketplaceName'] ?? '' );
		$items    = $is_refund
			? (array) ( $ev['ShipmentItemAdjustmentList'] ?? array() )
			: (array) ( $ev['ShipmentItemList'] ?? array() );

		// Order-level charges/fees (rare: e.g. shipping on multi-item orders).
		foreach ( (array) ( $ev['OrderChargeList'] ?? $ev['OrderChargeAdjustmentList'] ?? array() ) as $ch ) {
			[ $amt, $cur ] = self::amount( $ch['ChargeAmount'] ?? null );
			if ( 0.0 !== $amt ) {
				$ct    = (string) ( $ch['ChargeType'] ?? '' );
				$out[] = self::line( $posted, $type, $order_id, '', $ct, self::charge_category( $ct, $is_refund ), $amt, $cur, 0, $mkt );
			}
		}
		foreach ( (array) ( $ev['ShipmentFeeList'] ?? $ev['ShipmentFeeAdjustmentList'] ?? array() ) as $fee ) {
			[ $amt, $cur ] = self::amount( $fee['FeeAmount'] ?? null );
			if ( 0.0 !== $amt ) {
				$out[] = self::line( $posted, $type, $order_id, '', (string) ( $fee['FeeType'] ?? '' ), 'fee', $amt, $cur, 0, $mkt );
			}
		}

		foreach ( $items as $it ) {
			$sku = (string) ( $it['SellerSKU'] ?? '' );
			$qty = (int) ( $it['QuantityShipped'] ?? 0 );
			$first = true;

			$charges = $is_refund ? ( $it['ItemChargeAdjustmentList'] ?? array() ) : ( $it['ItemChargeList'] ?? array() );
			foreach ( (array) $charges as $ch ) {
				[ $amt, $cur ] = self::amount( $ch['ChargeAmount'] ?? null );
				if ( 0.0 === $amt ) {
					continue;
				}
				$ct  = (string) ( $ch['ChargeType'] ?? '' );
				$cat = self::charge_category( $ct, $is_refund );
				// Attribute the unit count to the Principal line only, so SUM(qty) == units.
				$line_qty = ( 'Principal' === $ct && $first ) ? ( $is_refund ? -abs( $qty ) : $qty ) : 0;
				if ( 'Principal' === $ct ) {
					$first = false;
				}
				$out[] = self::line( $posted, $type, $order_id, $sku, $ct, $cat, $amt, $cur, $line_qty, $mkt );
			}

			$fees = $is_refund ? ( $it['ItemFeeAdjustmentList'] ?? array() ) : ( $it['ItemFeeList'] ?? array() );
			foreach ( (array) $fees as $fee ) {
				[ $amt, $cur ] = self::amount( $fee['FeeAmount'] ?? null );
				if ( 0.0 !== $amt ) {
					$out[] = self::line( $posted, $type, $order_id, $sku, (string) ( $fee['FeeType'] ?? '' ), 'fee', $amt, $cur, 0, $mkt );
				}
			}

			$promos = $is_refund ? ( $it['PromotionAdjustmentList'] ?? array() ) : ( $it['PromotionList'] ?? array() );
			foreach ( (array) $promos as $p ) {
				[ $amt, $cur ] = self::amount( $p['PromotionAmount'] ?? null );
				if ( 0.0 !== $amt ) {
					$out[] = self::line( $posted, $type, $order_id, $sku, 'Promotion:' . (string) ( $p['PromotionType'] ?? '' ), $is_refund ? 'refund' : 'promo', $amt, $cur, 0, $mkt );
				}
			}

			foreach ( (array) ( $it['ItemTaxWithheldList'] ?? array() ) as $tw ) {
				foreach ( (array) ( $tw['TaxesWithheld'] ?? array() ) as $ch ) {
					[ $amt, $cur ] = self::amount( $ch['ChargeAmount'] ?? null );
					if ( 0.0 !== $amt ) {
						$out[] = self::line( $posted, $type, $order_id, $sku, 'Withheld:' . (string) ( $ch['ChargeType'] ?? '' ), 'tax', $amt, $cur, 0, $mkt );
					}
				}
			}
		}
	}

	/** @return array{0: float, 1: string} */
	private static function amount( mixed $money ): array {
		if ( ! is_array( $money ) ) {
			return array( 0.0, '' );
		}
		$v = $money['CurrencyAmount'] ?? $money['Amount'] ?? $money['amount'] ?? $money['currencyAmount'] ?? 0;
		$c = $money['CurrencyCode'] ?? $money['currencyCode'] ?? '';
		return array( round( (float) $v, 4 ), (string) $c );
	}

	private static function line( string $posted, string $type, string $order, string $sku, string $charge, string $cat, float $amt, string $cur, int $qty, string $mkt ): array {
		return array(
			'posted'      => $posted,
			'event_type'  => $type,
			'order_id'    => $order,
			'sku'         => $sku,
			'charge_type' => substr( $charge, 0, 64 ),
			'category'    => $cat,
			'amount'      => $amt,
			'currency'    => $cur,
			'qty'         => $qty,
			'marketplace' => $mkt,
		);
	}
}
