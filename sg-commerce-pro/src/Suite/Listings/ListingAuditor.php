<?php
/**
 * ListingAuditor — listing quality score + change detection.
 *
 * Source: Listings Items API 2021-08-01
 *   GET /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=…&includedData=summaries,attributes,issues
 *
 * Scoring follows Amazon's published style guides and the 2025 title
 * policy (≤ 200 chars, no word more than twice, no !$?_{}^¬¦ decoration),
 * plus conversion best practice used by paid listing graders:
 *   Title 25 · Bullets 25 · Description 10 · Backend keywords 10 ·
 *   Images 20 · Health (issues/suppression) 10 = 100
 *
 * `score()` is pure. A content hash per audit lets the monitor raise a
 * "listing changed" alert when Amazon or another seller edits the
 * detail page (a classic hijack/catalog-overwrite signal).
 *
 * @package SevenGum\Commerce\Suite\Listings
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Listings;

use SevenGum\Commerce\Amazon\AmazonClient;
use SevenGum\Commerce\Suite\Support\SuiteAlerts;
use SevenGum\Commerce\Logging\Logger;
use SevenGum\Commerce\Suite\SuiteSettings;
use SevenGum\Commerce\Suite\Support\Db;

defined( 'ABSPATH' ) || exit;

final class ListingAuditor {

	private const BANNED_CHARS = array( '!', '$', '?', '_', '{', '}', '^', '¬', '¦' );
	private const STOP_WORDS   = array( 'and', 'or', 'for', 'the', 'a', 'an', 'of', 'with', 'in', 'to', 'by', 'on', 'at', '&', '-', '|', ',', 'x', 'pack', 'count' );
	private const CLAIMS       = array(
		'best seller', 'best-seller', 'bestseller', '#1', 'number one', 'top rated', 'top-rated', 'free shipping',
		'100% satisfaction', 'satisfaction guaranteed', 'money back', 'guarantee', 'fda approved', 'cure', 'cures',
		'treats', 'prevents', 'anti-bacterial', 'antibacterial', 'antimicrobial', 'eco-friendly', 'non-toxic',
		'hot sale', 'sale', 'limited time', 'cheapest', 'buy now', 'clinically proven',
	);

	public function __construct(
		private AmazonClient $client,
		private SuiteSettings $settings,
		private Logger $logger,
	) {}

	/** Fetch + score + persist one SKU. */
	public function audit( string $market, string $sku, array $keywords = array() ): array {
		$seller = $this->settings->seller_id();
		if ( '' === $seller ) {
			throw new \RuntimeException( 'Enter your Seller ID (Merchant Token) in Amazon Suite → Settings to audit listings.' );
		}
		$mp  = $this->client->marketplace_info( $market );
		$res = $this->client->request(
			'GET', $market,
			'/listings/2021-08-01/items/' . rawurlencode( $seller ) . '/' . rawurlencode( $sku ),
			array( 'marketplaceIds' => (string) ( $mp['id'] ?? '' ), 'includedData' => 'summaries,attributes,issues' ),
			null, 'listings.get'
		);
		$content = self::extract( $res );
		$result  = self::score( $content, $keywords );
		self::store( $market, $sku, $content, $result );
		return $result + array( 'content' => $content );
	}

	public static function store( string $market, string $sku, array $content, array $result, bool $demo = false ): void {
		$hash = sha1( wp_json_encode( array( $content['title'], $content['bullets'], $content['description'], $content['images'] ) ) );
		$prev = Db::row( 'SELECT content_hash FROM {t:listing_audits} WHERE market = %s AND sku = %s', array( $market, $sku ) );
		if ( ! $demo && null !== $prev && '' !== (string) $prev['content_hash'] && $prev['content_hash'] !== $hash ) {
			SuiteAlerts::raise(
				'warning', 'suite_listing',
				sprintf( 'Listing content changed: %s (%s)', $sku, $content['asin'] ),
				'Title, bullets, description or images differ from the last audit. If you did not make this change, check for a catalog contribution from Amazon or another seller.',
				array( 'market' => $market, 'sku' => $sku )
			);
		}
		Db::upsert( 'listing_audits', array(
			'market'       => $market,
			'sku'          => $sku,
			'asin'         => (string) $content['asin'],
			'score'        => (int) $result['score'],
			'status'       => (string) $result['status'],
			'content_hash' => $hash,
			'findings'     => wp_json_encode( $result['findings'] ),
			'snapshot'     => wp_json_encode( $content ),
			'audited_at'   => Db::now(),
			'is_demo'      => $demo ? 1 : 0,
		) );
	}

	/** Normalise a Listings API response into plain content fields. */
	public static function extract( array $res ): array {
		$attr = (array) ( $res['attributes'] ?? array() );
		$sum  = (array) ( $res['summaries'][0] ?? array() );
		$val  = static fn( string $k ): string => (string) ( $attr[ $k ][0]['value'] ?? '' );
		$bullets = array();
		foreach ( (array) ( $attr['bullet_point'] ?? array() ) as $b ) {
			if ( '' !== trim( (string) ( $b['value'] ?? '' ) ) ) {
				$bullets[] = (string) $b['value'];
			}
		}
		$images = array();
		if ( ! empty( $attr['main_product_image_locator'][0]['media_location'] ) ) {
			$images[] = (string) $attr['main_product_image_locator'][0]['media_location'];
		} elseif ( ! empty( $sum['mainImage']['link'] ) ) {
			$images[] = (string) $sum['mainImage']['link'];
		}
		for ( $i = 1; $i <= 8; $i++ ) {
			$loc = $attr[ 'other_product_image_locator_' . $i ][0]['media_location'] ?? '';
			if ( '' !== $loc ) {
				$images[] = (string) $loc;
			}
		}
		$issues = array();
		foreach ( (array) ( $res['issues'] ?? array() ) as $is ) {
			$issues[] = array(
				'code'     => (string) ( $is['code'] ?? '' ),
				'severity' => strtoupper( (string) ( $is['severity'] ?? 'INFO' ) ),
				'message'  => (string) ( $is['message'] ?? '' ),
			);
		}
		return array(
			'asin'        => (string) ( $sum['asin'] ?? '' ),
			'title'       => '' !== $val( 'item_name' ) ? $val( 'item_name' ) : (string) ( $sum['itemName'] ?? '' ),
			'brand'       => $val( 'brand' ),
			'bullets'     => $bullets,
			'description' => $val( 'product_description' ),
			'backend'     => $val( 'generic_keyword' ),
			'images'      => $images,
			'status'      => array_values( array_map( 'strval', (array) ( $sum['status'] ?? array() ) ) ),
			'issues'      => $issues,
			'product_type'=> (string) ( $sum['productType'] ?? '' ),
		);
	}

	/**
	 * @param array $c  extract() output
	 * @param string[] $keywords  tracked keywords for coverage scoring
	 * @return array{score:int, grade:string, status:string, findings:array, sections:array, keyword_coverage:?array}
	 */
	public static function score( array $c, array $keywords = array() ): array {
		$f = array();
		$sec = array( 'title' => 25, 'bullets' => 25, 'description' => 10, 'backend' => 10, 'images' => 20, 'health' => 10 );
		$hit = static function ( string $section, int $pts, string $sev, string $msg ) use ( &$sec, &$f ): void {
			$sec[ $section ] = max( 0, $sec[ $section ] - $pts );
			$f[] = array( 'section' => $section, 'severity' => $sev, 'message' => $msg );
		};

		// Title.
		$title = trim( (string) $c['title'] );
		$tlen  = mb_strlen( $title );
		if ( '' === $title ) {
			$hit( 'title', 25, 'error', 'Title is missing.' );
		} else {
			if ( $tlen > 200 ) {
				$hit( 'title', 10, 'error', "Title is {$tlen} characters — Amazon's limit is 200; longer titles get suppressed." );
			} elseif ( $tlen < 80 ) {
				$hit( 'title', 6, 'warning', "Title is only {$tlen} characters. 80–200 lets you cover brand + product + key features + size/count." );
			}
			$bad = array_values( array_filter( self::BANNED_CHARS, static fn( $ch ) => str_contains( $title, $ch ) ) );
			if ( $bad ) {
				$hit( 'title', 5, 'error', 'Title contains decorative characters not allowed by Amazon policy: ' . implode( ' ', $bad ) );
			}
			$repeats = self::repeated_words( $title );
			if ( $repeats ) {
				$hit( 'title', 5, 'error', 'Words used more than twice in title (policy violation): ' . implode( ', ', $repeats ) );
			}
			if ( '' !== $c['brand'] && ! str_starts_with( mb_strtolower( $title ), mb_strtolower( (string) $c['brand'] ) ) ) {
				$hit( 'title', 3, 'warning', 'Title should start with the brand name ("' . $c['brand'] . '").' );
			}
			if ( preg_match( '/\b[A-Z]{4,}\b.*\b[A-Z]{4,}\b.*\b[A-Z]{4,}\b/', $title ) ) {
				$hit( 'title', 3, 'warning', 'Avoid ALL-CAPS words in the title.' );
			}
			$claims = self::claims( $title );
			if ( $claims ) {
				$hit( 'title', 5, 'error', 'Prohibited promotional/medical claims in title: ' . implode( ', ', $claims ) );
			}
		}

		// Bullets.
		$bullets = (array) $c['bullets'];
		$nb = count( $bullets );
		if ( 0 === $nb ) {
			$hit( 'bullets', 25, 'error', 'No bullet points.' );
		} else {
			if ( $nb < 5 ) {
				$hit( 'bullets', ( 5 - $nb ) * 4, 'warning', "Only {$nb} of 5 bullet points used." );
			}
			foreach ( $bullets as $i => $b ) {
				$len = mb_strlen( $b );
				$n   = $i + 1;
				if ( $len < 60 ) {
					$hit( 'bullets', 2, 'warning', "Bullet {$n} is short ({$len} chars) — aim for 150–250 to explain a benefit." );
				} elseif ( $len > 500 ) {
					$hit( 'bullets', 2, 'warning', "Bullet {$n} is {$len} chars; many categories truncate above 500 bytes." );
				}
				if ( preg_match( '/[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]/u', $b ) ) {
					$hit( 'bullets', 3, 'error', "Bullet {$n} contains emoji/special symbols (prohibited)." );
				}
				$claims = self::claims( $b );
				if ( $claims ) {
					$hit( 'bullets', 3, 'error', "Bullet {$n} has prohibited claims: " . implode( ', ', $claims ) );
				}
			}
		}

		// Description.
		$dlen = mb_strlen( self::plain( (string) $c['description'] ) );
		if ( 0 === $dlen ) {
			$hit( 'description', 10, 'warning', 'No product description (A+ Content replaces it on the page, but the text is still indexed).' );
		} elseif ( $dlen < 500 ) {
			$hit( 'description', 5, 'warning', "Description is {$dlen} characters — 1000–2000 performs better." );
		} elseif ( $dlen > 2000 ) {
			$hit( 'description', 4, 'error', "Description is {$dlen} characters; the limit is 2000." );
		}

		// Backend search terms.
		$backend = trim( (string) $c['backend'] );
		$bytes   = strlen( $backend );
		if ( '' === $backend ) {
			$hit( 'backend', 10, 'warning', 'Backend search terms (generic_keyword) are empty — free indexing left on the table.' );
		} else {
			if ( $bytes > 249 ) {
				$hit( 'backend', 8, 'error', "Backend search terms are {$bytes} bytes; anything over 249 bytes is NOT indexed at all." );
			} elseif ( $bytes < 150 ) {
				$hit( 'backend', 3, 'warning', "Backend search terms use only {$bytes}/249 bytes." );
			}
			if ( preg_match( '/\bB0[A-Z0-9]{8}\b/i', $backend ) ) {
				$hit( 'backend', 4, 'error', 'Backend search terms must not contain ASINs.' );
			}
			$dupes = array_intersect( self::words( $backend ), self::words( $title ) );
			if ( count( $dupes ) >= 3 ) {
				$hit( 'backend', 2, 'info', 'Backend terms repeat title words (' . implode( ', ', array_slice( array_unique( $dupes ), 0, 6 ) ) . ') — those bytes are wasted.' );
			}
		}

		// Images.
		$ni = count( (array) $c['images'] );
		if ( 0 === $ni ) {
			$hit( 'images', 20, 'error', 'No images.' );
		} elseif ( $ni < 7 ) {
			$hit( 'images', ( 7 - $ni ) * 3, 'warning', "{$ni} images — use all 7+ slots (main, infographics, lifestyle, size, packaging)." );
		}

		// Health.
		$errors = array_filter( (array) $c['issues'], static fn( $i ) => 'ERROR' === $i['severity'] );
		$warns  = array_filter( (array) $c['issues'], static fn( $i ) => 'WARNING' === $i['severity'] );
		foreach ( $errors as $i ) {
			$hit( 'health', 5, 'error', 'Amazon issue ' . $i['code'] . ': ' . $i['message'] );
		}
		foreach ( $warns as $i ) {
			$hit( 'health', 2, 'warning', 'Amazon warning ' . $i['code'] . ': ' . $i['message'] );
		}
		$status_list = (array) $c['status'];
		$buyable = in_array( 'BUYABLE', $status_list, true );
		if ( $status_list && ! $buyable ) {
			$hit( 'health', 10, 'error', 'Listing is NOT buyable (inactive or suppressed).' );
		}

		// Keyword coverage.
		$coverage = null;
		if ( $keywords ) {
			$haystack = mb_strtolower( $title . ' ' . implode( ' ', $bullets ) . ' ' . $backend . ' ' . $c['description'] );
			$found = array();
			$missing = array();
			foreach ( $keywords as $kw ) {
				$kw = mb_strtolower( trim( (string) $kw ) );
				if ( '' === $kw ) {
					continue;
				}
				$all = true;
				foreach ( preg_split( '/\s+/', $kw ) as $w ) {
					if ( ! str_contains( $haystack, $w ) ) {
						$all = false;
						break;
					}
				}
				$all ? $found[] = $kw : $missing[] = $kw;
			}
			$total = count( $found ) + count( $missing );
			$coverage = array(
				'pct'     => $total > 0 ? (int) round( count( $found ) / $total * 100 ) : 0,
				'found'   => $found,
				'missing' => $missing,
			);
			if ( $missing ) {
				$f[] = array( 'section' => 'keywords', 'severity' => 'info', 'message' => 'Tracked keywords not present anywhere in the listing: ' . implode( ', ', array_slice( $missing, 0, 10 ) ) );
			}
		}

		$score = array_sum( $sec );
		return array(
			'score'            => $score,
			'grade'            => $score >= 90 ? 'A' : ( $score >= 80 ? 'B' : ( $score >= 65 ? 'C' : ( $score >= 50 ? 'D' : 'F' ) ) ),
			'status'           => ! $status_list ? 'unknown' : ( $buyable ? 'active' : 'suppressed' ),
			'findings'         => $f,
			'sections'         => $sec,
			'keyword_coverage' => $coverage,
		);
	}

	/** @return string[] */
	public static function repeated_words( string $text ): array {
		$counts = array_count_values( self::words( $text ) );
		return array_keys( array_filter( $counts, static fn( $n ) => $n > 2 ) );
	}

	/** @return string[] lower-case content words */
	public static function words( string $text ): array {
		$parts = preg_split( '/[^\p{L}\p{N}]+/u', mb_strtolower( $text ) ) ?: array();
		return array_values( array_filter( $parts, static fn( $w ) => '' !== $w && mb_strlen( $w ) > 1 && ! in_array( $w, self::STOP_WORDS, true ) && ! is_numeric( $w ) ) );
	}

	/** Strip HTML without WordPress (keeps the scorer unit-testable). */
	public static function plain( string $s ): string {
		$s = (string) preg_replace( '#<(script|style)[^>]*?>.*?</\\1>#si', '', $s );
		return trim( (string) preg_replace( '/\s+/', ' ', strip_tags( $s ) ) );
	}

	/** @return string[] */
	public static function claims( string $text ): array {
		$t = ' ' . mb_strtolower( $text ) . ' ';
		$out = array();
		foreach ( self::CLAIMS as $claim ) {
			if ( preg_match( '/(^|[^\p{L}])' . preg_quote( $claim, '/' ) . '([^\p{L}]|$)/u', $t ) ) {
				$out[] = $claim;
			}
		}
		return $out;
	}
}

