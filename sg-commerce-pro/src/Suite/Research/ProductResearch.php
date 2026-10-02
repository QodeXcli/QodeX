<?php
/**
 * ProductResearch — Jungle Scout / Helium 10 "Black Box"-style research
 * built only on official SP-API data:
 *
 *   GET  /catalog/2022-04-01/items?keywords=…&includedData=summaries,salesRanks,images
 *   GET  /products/pricing/v0/competitivePrice?Asins=…&ItemType=Asin
 *   POST /products/fees/v0/items/{Asin}/feesEstimate
 *
 * Monthly sales are ESTIMATED from Best Sellers Rank with a power-law
 * curve (units ≈ a·rank^−b) calibrated per display group. Treat it as a
 * ±40 % directional signal — every paid tool does the same, none has
 * Amazon's real unit data for other sellers' ASINs.
 *
 * @package SevenGum\Commerce\Suite\Research
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Suite\Research;

use SevenGum\Commerce\Amazon\AmazonClient;

defined( 'ABSPATH' ) || exit;

final class ProductResearch {

	/** Display-group → volume multiplier relative to Grocery (US calibration). */
	private const GROUP_FACTOR = array(
		'grocery' => 1.0, 'gourmet' => 1.0, 'home' => 1.6, 'kitchen' => 1.4, 'beauty' => 1.2, 'hpc' => 1.3,
		'health' => 1.3, 'sports' => 0.9, 'toy' => 1.0, 'pet' => 0.7, 'office' => 0.6, 'electronics' => 0.9,
		'wireless' => 0.9, 'baby' => 0.5, 'lawn' => 0.8, 'garden' => 0.8, 'home_improvement' => 0.8,
		'apparel' => 1.8, 'fashion' => 1.8, 'shoes' => 1.2, 'automotive' => 0.7, 'books' => 1.5,
	);

	public function __construct( private AmazonClient $client ) {}

	public function search( string $keywords, string $market ): array {
		$mp  = $this->client->marketplace_info( $market );
		$res = $this->client->request( 'GET', $market, '/catalog/2022-04-01/items', array(
			'keywords'       => $keywords,
			'marketplaceIds' => (string) ( $mp['id'] ?? '' ),
			'includedData'   => 'summaries,salesRanks,images',
			'pageSize'       => 20,
		), null, 'catalog.search' );

		$items = array();
		foreach ( (array) ( $res['items'] ?? array() ) as $it ) {
			$asin = (string) ( $it['asin'] ?? '' );
			$sum  = (array) ( $it['summaries'][0] ?? array() );
			[ $rank, $group ] = self::top_rank( (array) ( $it['salesRanks'][0] ?? array() ) );
			$img = '';
			foreach ( (array) ( $it['images'][0]['images'] ?? array() ) as $im ) {
				if ( 'MAIN' === ( $im['variant'] ?? '' ) || '' === $img ) {
					$img = (string) ( $im['link'] ?? '' );
				}
			}
			$items[ $asin ] = array(
				'asin'       => $asin,
				'title'      => (string) ( $sum['itemName'] ?? '' ),
				'brand'      => (string) ( $sum['brand'] ?? $sum['brandName'] ?? '' ),
				'category'   => (string) ( $sum['browseClassification']['displayName'] ?? $group ),
				'image'      => $img,
				'bsr'        => $rank,
				'est_units'  => null !== $rank ? self::estimate_monthly_units( $rank, $group ) : null,
				'price'      => null,
				'offers'     => null,
				'est_revenue'=> null,
			);
		}
		if ( $items ) {
			try {
				$pr = $this->client->request( 'GET', $market, '/products/pricing/v0/competitivePrice', array(
					'MarketplaceId' => (string) ( $mp['id'] ?? '' ),
					'Asins'         => implode( ',', array_slice( array_keys( $items ), 0, 20 ) ),
					'ItemType'      => 'Asin',
				), null, 'pricing.competitivePricing' );
				foreach ( (array) ( $pr['payload'] ?? array() ) as $p ) {
					$asin = (string) ( $p['ASIN'] ?? '' );
					if ( ! isset( $items[ $asin ] ) ) {
						continue;
					}
					$cp = (array) ( $p['Product']['CompetitivePricing'] ?? array() );
					foreach ( (array) ( $cp['CompetitivePrices'] ?? array() ) as $price ) {
						$items[ $asin ]['price'] = (float) ( $price['Price']['LandedPrice']['Amount'] ?? $price['Price']['ListingPrice']['Amount'] ?? 0 ) ?: null;
						break;
					}
					$count = 0;
					foreach ( (array) ( $cp['NumberOfOfferListings'] ?? array() ) as $n ) {
						$count += (int) ( $n['Count'] ?? 0 );
					}
					$items[ $asin ]['offers'] = $count;
				}
			} catch ( \Throwable ) {
				// Pricing is enrichment only; search still returns.
			}
		}
		foreach ( $items as &$i ) {
			if ( null !== $i['price'] && null !== $i['est_units'] ) {
				$i['est_revenue'] = round( $i['price'] * $i['est_units'], 2 );
			}
		}
		unset( $i );
		$list = array_values( $items );
		$units = array_filter( array_column( $list, 'est_units' ) );
		$revs  = array_filter( array_column( $list, 'est_revenue' ) );
		$prices = array_filter( array_column( $list, 'price' ) );
		return array(
			'items'   => $list,
			'summary' => array(
				'results'          => count( $list ),
				'avg_price'        => $prices ? round( array_sum( $prices ) / count( $prices ), 2 ) : null,
				'avg_units'        => $units ? (int) round( array_sum( $units ) / count( $units ) ) : null,
				'total_revenue'    => $revs ? round( array_sum( $revs ), 2 ) : null,
				'top3_share_pct'   => $revs ? round( array_sum( array_slice( self::rsorted( $revs ), 0, 3 ) ) / max( 1, array_sum( $revs ) ) * 100, 1 ) : null,
				'opportunity'      => self::opportunity( $list ),
			),
		);
	}

	public function fees( string $asin, float $price, string $market ): array {
		$mp  = $this->client->marketplace_info( $market );
		$cur = (string) ( $mp['currency'] ?? 'USD' );
		$res = $this->client->request( 'POST', $market, '/products/fees/v0/items/' . rawurlencode( $asin ) . '/feesEstimate', array(), array(
			'FeesEstimateRequest' => array(
				'MarketplaceId'       => (string) ( $mp['id'] ?? '' ),
				'IsAmazonFulfilled'   => true,
				'PriceToEstimateFees' => array(
					'ListingPrice' => array( 'CurrencyCode' => $cur, 'Amount' => round( $price, 2 ) ),
					'Shipping'     => array( 'CurrencyCode' => $cur, 'Amount' => 0 ),
				),
				'Identifier'          => 'sg-' . wp_generate_password( 8, false ),
			),
		), 'fees.estimate' );
		$est = (array) ( $res['payload']['FeesEstimateResult'] ?? array() );
		if ( 'Success' !== ( $est['Status'] ?? 'Success' ) ) {
			throw new \RuntimeException( (string) ( $est['Error']['Message'] ?? 'Fee estimate failed.' ) );
		}
		$details = array();
		$referral = 0.0;
		$fba = 0.0;
		foreach ( (array) ( $est['FeesEstimate']['FeeDetailList'] ?? array() ) as $d ) {
			$amt = (float) ( $d['FinalFee']['Amount'] ?? $d['FeeAmount']['Amount'] ?? 0 );
			$type = (string) ( $d['FeeType'] ?? '' );
			$details[] = array( 'type' => $type, 'amount' => $amt );
			if ( 'ReferralFee' === $type ) {
				$referral += $amt;
			} elseif ( str_contains( $type, 'FBA' ) ) {
				$fba += $amt;
			}
		}
		return array(
			'asin'     => $asin,
			'price'    => $price,
			'currency' => $cur,
			'total'    => (float) ( $est['FeesEstimate']['TotalFeesEstimate']['Amount'] ?? array_sum( array_column( $details, 'amount' ) ) ),
			'referral' => $referral,
			'fba'      => $fba,
			'details'  => $details,
		);
	}

	/**
	 * Pure profitability calculator (FBA revenue calculator +).
	 *
	 * @param array{price:float, unit_cost:float, inbound:float, referral_pct?:float, referral?:float, fba_fee:float, storage_per_unit?:float, tacos_pct?:float, return_pct?:float, cvr_pct?:float} $in
	 */
	public static function calc( array $in ): array {
		$price    = max( 0.0, (float) ( $in['price'] ?? 0 ) );
		$referral = isset( $in['referral'] ) && $in['referral'] > 0 ? (float) $in['referral'] : $price * (float) ( $in['referral_pct'] ?? 15 ) / 100;
		$fba      = (float) ( $in['fba_fee'] ?? 0 );
		$storage  = (float) ( $in['storage_per_unit'] ?? 0 );
		$cogs     = (float) ( $in['unit_cost'] ?? 0 ) + (float) ( $in['inbound'] ?? 0 );
		$ads      = $price * (float) ( $in['tacos_pct'] ?? 0 ) / 100;
		// Returns: lose the sale on return_pct of units; referral is mostly refunded, FBA fee is not.
		$ret      = (float) ( $in['return_pct'] ?? 0 ) / 100;
		$returns  = $ret * ( $price - $referral * 0.8 );
		$fees     = $referral + $fba + $storage;
		$profit   = $price - $fees - $cogs - $ads - $returns;
		$pre_ads  = $price - $fees - $cogs - $returns;
		$cvr      = (float) ( $in['cvr_pct'] ?? 10 ) / 100;
		return array(
			'price'             => round( $price, 2 ),
			'amazon_fees'       => round( $fees, 2 ),
			'referral'          => round( $referral, 2 ),
			'cogs'              => round( $cogs, 2 ),
			'ads_per_unit'      => round( $ads, 2 ),
			'returns_per_unit'  => round( $returns, 2 ),
			'profit_per_unit'   => round( $profit, 2 ),
			'margin_pct'        => $price > 0 ? round( $profit / $price * 100, 2 ) : null,
			'roi_pct'           => $cogs > 0 ? round( $profit / $cogs * 100, 2 ) : null,
			'breakeven_acos'    => $price > 0 ? round( max( 0, $pre_ads ) / $price * 100, 2 ) : null,
			'max_cpc'           => round( max( 0, $pre_ads ) * $cvr, 2 ),
			'breakeven_price'   => self::breakeven_price( $in ),
		);
	}

	/** Units/month from BSR (power law, display-group adjusted). */
	public static function estimate_monthly_units( int $rank, string $group ): int {
		if ( $rank <= 0 ) {
			return 0;
		}
		$factor = 1.0;
		$g = strtolower( $group );
		foreach ( self::GROUP_FACTOR as $k => $f ) {
			if ( str_contains( $g, $k ) ) {
				$factor = $f;
				break;
			}
		}
		return (int) max( 0, round( $factor * 417000 * pow( $rank, -0.89 ) ) );
	}

	/** @return array{0:?int, 1:string} */
	private static function top_rank( array $sales_ranks ): array {
		foreach ( (array) ( $sales_ranks['displayGroupRanks'] ?? array() ) as $r ) {
			return array( (int) ( $r['rank'] ?? 0 ) ?: null, (string) ( $r['websiteDisplayGroup'] ?? $r['title'] ?? '' ) );
		}
		foreach ( (array) ( $sales_ranks['classificationRanks'] ?? array() ) as $r ) {
			return array( (int) ( $r['rank'] ?? 0 ) ?: null, (string) ( $r['title'] ?? '' ) );
		}
		return array( null, '' );
	}

	private static function rsorted( array $v ): array {
		rsort( $v );
		return $v;
	}

	/** 0–100: demand high, competition (offers, top-3 concentration) low, price in the sweet spot. */
	private static function opportunity( array $items ): ?int {
		if ( ! $items ) {
			return null;
		}
		$units  = array_filter( array_column( $items, 'est_units' ) );
		$prices = array_filter( array_column( $items, 'price' ) );
		$offers = array_filter( array_column( $items, 'offers' ), static fn( $v ) => null !== $v );
		$demand = $units ? min( 40, ( array_sum( $units ) / count( $units ) ) / 25 ) : 0;
		$comp   = $offers ? max( 0, 30 - ( array_sum( $offers ) / count( $offers ) ) * 3 ) : 15;
		$avg_p  = $prices ? array_sum( $prices ) / count( $prices ) : 0;
		$price  = $avg_p >= 15 && $avg_p <= 60 ? 30 : ( $avg_p >= 10 ? 18 : 8 );
		return (int) round( min( 100, $demand + $comp + $price ) );
	}

	private static function breakeven_price( array $in ): ?float {
		$cogs = (float) ( $in['unit_cost'] ?? 0 ) + (float) ( $in['inbound'] ?? 0 );
		$fixed = (float) ( $in['fba_fee'] ?? 0 ) + (float) ( $in['storage_per_unit'] ?? 0 ) + $cogs;
		$pct = ( (float) ( $in['referral_pct'] ?? 15 ) + (float) ( $in['tacos_pct'] ?? 0 ) ) / 100;
		return $pct < 1 ? round( $fixed / ( 1 - $pct ), 2 ) : null;
	}
}
