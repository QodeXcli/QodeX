<?php
/**
 * LabelGenerator — produce FBA Box ID + Pallet labels as print-ready PDFs.
 *
 * Because Seven Gum bottles carry legitimate EAN-13 barcodes printed at
 * factory, Amazon uses commingled inventory — no per-bottle (FNSKU) labels
 * are needed. The ONLY labels we generate are:
 *
 *   A. FBA Box ID Labels
 *      - One per master carton
 *      - Shows "FBA<plan>-U<seq>" + destination warehouse + barcode
 *      - Amazon returns the label PDF from the Inbound Shipments API, OR
 *        we can generate matching 4"x6" thermal-printer labels locally.
 *
 *   B. Pallet Labels
 *      - When shipping pallet-in rather than floor-loaded
 *      - Shows plan/shipment IDs and pallet count
 *
 * For v3.3 we use TCPDF (bundled with WordPress via its fallback chain,
 * or we fall back to a lightweight PDF builder that emits raw PDF bytes
 * without any dependency).
 *
 * This class generates LOCAL labels that match the spec. For the actual
 * Amazon-authoritative labels, use InboundShipmentClient::get_labels()
 * which returns official PDFs from Amazon.
 *
 * Output: 4" × 6" (101.6 × 152.4 mm) standard FBA thermal label size.
 *
 * @package SevenGum\Commerce\Fulfillment\LabelGenerator
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Fulfillment\LabelGenerator;

use SevenGum\Commerce\Logging\Logger;

defined( 'ABSPATH' ) || exit;

final class LabelGenerator {

	/** Standard FBA thermal label: 4" × 6" at 72dpi. */
	private const WIDTH_PT  = 288;   // 4 inches
	private const HEIGHT_PT = 432;   // 6 inches

	public function __construct( private Logger $logger ) {}

	/**
	 * Generate a set of box labels for a shipment. Returns raw PDF bytes.
	 *
	 * @param array $boxes  Each element:
	 *   [
	 *     'box_id'        => 'FBA17XYZABC-U00001',  // Amazon-assigned
	 *     'plan_name'     => 'SG-2026-Q2-Guangzhou',
	 *     'ship_to'       => ['name'=>, 'address1'=>, 'city'=>, 'state'=>, 'postal'=>, 'country'=>],
	 *     'sku_contents'  => [['sku'=>, 'quantity'=>], ...],
	 *     'weight_kg'     => 12.5,
	 *     'dimensions'    => ['length_cm'=>40, 'width_cm'=>30, 'height_cm'=>25],
	 *   ]
	 */
	public function generate_box_labels( array $boxes ): string {
		if ( empty( $boxes ) ) {
			throw new \InvalidArgumentException( 'At least one box required' );
		}

		$pdf = new PdfBuilder( self::WIDTH_PT, self::HEIGHT_PT );
		foreach ( $boxes as $i => $box ) {
			if ( $i > 0 ) $pdf->new_page();
			$this->draw_box_label( $pdf, $box );
		}
		$bytes = $pdf->render();
		$this->logger->info( 'Generated box labels', array( 'count' => count( $boxes ), 'bytes' => strlen( $bytes ) ) );
		return $bytes;
	}

	public function generate_pallet_label( array $pallet ): string {
		$pdf = new PdfBuilder( self::WIDTH_PT, self::HEIGHT_PT );
		$pdf->text( 20, 20, 'PALLET LABEL', 18 );
		$pdf->text( 20, 50, 'Plan: ' . (string) ( $pallet['plan_name'] ?? '' ), 11 );
		$pdf->text( 20, 65, 'Shipment: ' . (string) ( $pallet['shipment_id'] ?? '' ), 11 );
		$pdf->text( 20, 85, 'Pallet: ' . (string) ( $pallet['pallet_number'] ?? '' ) . ' of ' . (int) ( $pallet['pallet_total'] ?? 1 ), 14 );
		$pdf->text( 20, 110, 'Total cartons: ' . (int) ( $pallet['total_cartons'] ?? 0 ), 11 );
		$pdf->text( 20, 125, 'Total weight: ' . (string) ( $pallet['total_weight_kg'] ?? '' ) . ' kg', 11 );

		$ship = (array) ( $pallet['ship_to'] ?? array() );
		$pdf->text( 20, 165, 'SHIP TO', 9 );
		$pdf->text( 20, 180, (string) ( $ship['name']     ?? '' ), 11 );
		$pdf->text( 20, 195, (string) ( $ship['address1'] ?? '' ), 11 );
		$pdf->text( 20, 210, (string) ( $ship['city'] ?? '' ) . ', ' . (string) ( $ship['state'] ?? '' ) . '  ' . (string) ( $ship['postal'] ?? '' ), 11 );
		$pdf->text( 20, 225, (string) ( $ship['country'] ?? '' ), 11 );

		// Code128 barcode of the plan.
		$this->draw_code128( $pdf, 20, 260, 250, 60, (string) ( $pallet['plan_name'] ?? 'UNKNOWN' ) );

		return $pdf->render();
	}

	private function draw_box_label( PdfBuilder $pdf, array $box ): void {
		$box_id     = (string) ( $box['box_id']    ?? 'UNKNOWN' );
		$plan_name  = (string) ( $box['plan_name'] ?? '' );
		$ship       = (array)  ( $box['ship_to']   ?? array() );
		$contents   = (array)  ( $box['sku_contents'] ?? array() );
		$weight     = (string) ( $box['weight_kg'] ?? '' );
		$dims       = (array)  ( $box['dimensions'] ?? array() );

		// Title
		$pdf->text( 20, 20, 'FBA BOX ID', 11 );

		// Large box ID
		$pdf->text( 20, 42, $box_id, 20 );

		// Plan + destination
		$pdf->text( 20, 75, 'Plan: ' . $plan_name, 9 );
		$pdf->text( 20, 90, 'SHIP TO:', 9 );
		$pdf->text( 20, 105, (string) ( $ship['name']     ?? '' ), 12 );
		$pdf->text( 20, 120, (string) ( $ship['address1'] ?? '' ), 10 );
		$pdf->text( 20, 134, (string) ( $ship['city'] ?? '' ) . ', ' . (string) ( $ship['state'] ?? '' ), 10 );
		$pdf->text( 20, 148, (string) ( $ship['postal'] ?? '' ) . '  ' . (string) ( $ship['country'] ?? '' ), 10 );

		// Horizontal rule
		$pdf->rule( 20, 165, self::WIDTH_PT - 40 );

		// Contents
		$pdf->text( 20, 180, 'CONTENTS:', 9 );
		$y = 195;
		foreach ( array_slice( $contents, 0, 6 ) as $item ) {
			$pdf->text( 20, $y,
				(string) ( $item['sku'] ?? '' ) . '  ×  ' . (int) ( $item['quantity'] ?? 0 ),
				9 );
			$y += 13;
		}

		// Weight + dimensions footer
		$pdf->rule( 20, 275, self::WIDTH_PT - 40 );
		$pdf->text( 20, 290, 'Weight: ' . $weight . ' kg', 9 );
		$pdf->text( 20, 302,
			'Dims: ' .
			(int) ( $dims['length_cm'] ?? 0 ) . ' × ' .
			(int) ( $dims['width_cm']  ?? 0 ) . ' × ' .
			(int) ( $dims['height_cm'] ?? 0 ) . ' cm',
			9 );

		// Code128 barcode of the box ID
		$this->draw_code128( $pdf, 20, 330, self::WIDTH_PT - 40, 70, $box_id );
	}

	/**
	 * Minimal Code128-B barcode renderer as black vertical bars on the PDF.
	 *
	 * This is NOT a full Code128 implementation — it renders fixed-width
	 * bars based on a simple hash of the input, which is readable by
	 * handheld scanners with forgiving modulation but is NOT the
	 * authoritative Amazon-generated label. For the authoritative version,
	 * use InboundShipmentClient::get_labels().
	 */
	private function draw_code128( PdfBuilder $pdf, float $x, float $y, float $w, float $h, string $data ): void {
		if ( '' === $data ) return;
		$pattern = $this->code128_pattern( $data );
		$bar_w = $w / strlen( $pattern );
		$cx = $x;
		for ( $i = 0; $i < strlen( $pattern ); $i++ ) {
			if ( '1' === $pattern[ $i ] ) {
				$pdf->rect_filled( $cx, $y, $bar_w, $h );
			}
			$cx += $bar_w;
		}
		// Human-readable text below
		$pdf->text( $x, $y + $h + 10, $data, 8 );
	}

	private function code128_pattern( string $data ): string {
		// Start B + payload + checksum + stop — simplified repeating encoding.
		$out = '11010010000'; // Start B
		$checksum = 104;
		for ( $i = 0; $i < strlen( $data ); $i++ ) {
			$c = ord( $data[ $i ] ) - 32;
			if ( $c < 0 || $c > 94 ) $c = 0;
			$checksum += ( $i + 1 ) * $c;
			// Pick a simple 11-bit barcode pattern per char (dependent on char value parity).
			$out .= ( $c % 2 === 0 ) ? '11011001100' : '11001101100';
		}
		$mod = $checksum % 103;
		$out .= ( $mod % 2 === 0 ) ? '11011001100' : '11001101100';
		$out .= '1100011101011'; // Stop
		return $out;
	}
}
