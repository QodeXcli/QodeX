<?php
/**
 * PdfBuilder — minimal dependency-free PDF generator.
 *
 * Just enough to emit the label layouts we need (text + filled rectangles
 * + horizontal rules + multiple pages). NOT a full PDF lib — if you need
 * images, font embedding, or RTL text, swap in TCPDF or mPDF.
 *
 * Coordinate system: PostScript points (72 per inch), origin BOTTOM-LEFT
 * of the page. Our label code uses TOP-LEFT-origin coordinates (with y
 * growing downward) because that's more intuitive; this class internally
 * flips y when writing the page stream.
 *
 * @package SevenGum\Commerce\Fulfillment\LabelGenerator
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Fulfillment\LabelGenerator;

defined( 'ABSPATH' ) || exit;

final class PdfBuilder {

	private array $pages = array();
	private string $current = '';

	public function __construct( private float $width, private float $height ) {
		$this->new_page();
	}

	public function new_page(): void {
		if ( '' !== $this->current ) {
			$this->pages[] = $this->current;
		}
		$this->current = '';
	}

	/** Place text at top-left coords $x,$y in the given font size. */
	public function text( float $x, float $y, string $text, float $size = 10 ): void {
		$pdf_y = $this->height - $y - $size;
		$escaped = str_replace( array( '\\', '(', ')' ), array( '\\\\', '\\(', '\\)' ), $text );
		$this->current .= sprintf(
			"BT /F1 %.2f Tf %.2f %.2f Td (%s) Tj ET\n",
			$size, $x, $pdf_y, $escaped
		);
	}

	public function rect_filled( float $x, float $y, float $w, float $h ): void {
		$pdf_y = $this->height - $y - $h;
		$this->current .= sprintf( "%.2f %.2f %.2f %.2f re f\n", $x, $pdf_y, $w, $h );
	}

	public function rule( float $x, float $y, float $w ): void {
		$this->rect_filled( $x, $y, $w, 0.5 );
	}

	/** Finalize and return the full PDF as a byte string. */
	public function render(): string {
		// Flush the in-progress page.
		if ( '' !== $this->current || empty( $this->pages ) ) {
			$this->pages[] = $this->current;
			$this->current = '';
		}

		$objects = array();
		$objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";

		// Build pages tree.
		$page_ids = array();
		$obj_id = 4; // Resources=3, then pages start at 4.
		foreach ( $this->pages as $content ) {
			$content_stream = "q\n0 0 0 rg\n" . $content . "Q\n";
			$content_len = strlen( $content_stream );
			$objects[ $obj_id ] = "<< /Length {$content_len} >>\nstream\n{$content_stream}endstream";
			$content_obj_id = $obj_id;
			$obj_id++;

			$objects[ $obj_id ] = sprintf(
				"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] /Resources 3 0 R /Contents %d 0 R >>",
				$this->width, $this->height, $content_obj_id
			);
			$page_ids[] = $obj_id;
			$obj_id++;
		}

		$kids = implode( ' ', array_map( static fn( $id ) => "{$id} 0 R", $page_ids ) );
		$objects[2] = "<< /Type /Pages /Kids [{$kids}] /Count " . count( $page_ids ) . " >>";
		$objects[3] = "<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>";

		// Assemble PDF byte stream.
		$pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
		$offsets = array();
		ksort( $objects );
		foreach ( $objects as $id => $body ) {
			$offsets[ $id ] = strlen( $pdf );
			$pdf .= "{$id} 0 obj\n{$body}\nendobj\n";
		}
		$xref_offset = strlen( $pdf );
		$max_id = max( array_keys( $objects ) );
		$pdf .= "xref\n0 " . ( $max_id + 1 ) . "\n";
		$pdf .= "0000000000 65535 f \n";
		for ( $i = 1; $i <= $max_id; $i++ ) {
			$off = $offsets[ $i ] ?? 0;
			$pdf .= sprintf( "%010d 00000 n \n", $off );
		}
		$pdf .= "trailer\n<< /Size " . ( $max_id + 1 ) . " /Root 1 0 R >>\n";
		$pdf .= "startxref\n{$xref_offset}\n%%EOF\n";
		return $pdf;
	}
}
