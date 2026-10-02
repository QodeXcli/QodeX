<?php
/**
 * FeedsGenerator — build Amazon Feeds API XML payloads.
 *
 * Amazon's Feeds API accepts batched updates (price, inventory, product
 * data) as XML documents. This is the correct way to push changes for
 * more than ~20 SKUs at a time — using individual Listings API calls
 * will get rate-limited fast.
 *
 * Feed types we support:
 *
 *   POST_PRODUCT_PRICING_DATA       — update offer prices in bulk
 *   POST_INVENTORY_AVAILABILITY_DATA — update available quantity in bulk
 *   POST_PRODUCT_DATA                — create/update product records
 *
 * Flow:
 *   1. FeedsGenerator builds the XML in memory.
 *   2. FeedsClient (external) uploads to SP-API via
 *      POST /feeds/2021-06-30/documents, then
 *      POST /feeds/2021-06-30/feeds.
 *   3. SQSConsumer listens for FEED_PROCESSING_FINISHED to capture result.
 *
 * For v3.2, we only build the XML. Upload logic is left for a future
 * iteration since it requires careful SP-API document upload orchestration.
 *
 * @package SevenGum\Commerce\Amazon\FeedsGenerator
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon\FeedsGenerator;

defined( 'ABSPATH' ) || exit;

final class FeedsGenerator {

	public function __construct( private string $merchant_id ) {}

	/**
	 * Build a POST_PRODUCT_PRICING_DATA feed.
	 *
	 * @param array<int, array{sku:string, price:float, currency:string, sale_price?:float, sale_start?:string, sale_end?:string}> $rows
	 */
	public function pricing_feed( array $rows ): string {
		$messages = '';
		$message_id = 1;
		foreach ( $rows as $r ) {
			$sku = htmlspecialchars( (string) $r['sku'], ENT_XML1 | ENT_QUOTES, 'UTF-8' );
			$price_amount = number_format( (float) $r['price'], 2, '.', '' );
			$currency = htmlspecialchars( (string) $r['currency'], ENT_XML1 | ENT_QUOTES, 'UTF-8' );

			$sale_block = '';
			if ( isset( $r['sale_price'], $r['sale_start'], $r['sale_end'] ) && (float) $r['sale_price'] > 0 ) {
				$sale_price = number_format( (float) $r['sale_price'], 2, '.', '' );
				$sale_start = htmlspecialchars( (string) $r['sale_start'], ENT_XML1 | ENT_QUOTES, 'UTF-8' );
				$sale_end   = htmlspecialchars( (string) $r['sale_end'],   ENT_XML1 | ENT_QUOTES, 'UTF-8' );
				$sale_block = <<<XML
      <Sale>
        <StartDate>{$sale_start}</StartDate>
        <EndDate>{$sale_end}</EndDate>
        <SalePrice>
          <Amount currency="{$currency}">{$sale_price}</Amount>
        </SalePrice>
      </Sale>
XML;
			}

			$messages .= <<<XML
  <Message>
    <MessageID>{$message_id}</MessageID>
    <OperationType>Update</OperationType>
    <Price>
      <SKU>{$sku}</SKU>
      <StandardPrice currency="{$currency}">{$price_amount}</StandardPrice>{$sale_block}
    </Price>
  </Message>
XML;
			$message_id++;
		}
		return $this->envelope( 'Price', $messages );
	}

	/**
	 * Build a POST_INVENTORY_AVAILABILITY_DATA feed.
	 *
	 * @param array<int, array{sku:string, quantity:int, fulfillment_latency?:int}> $rows
	 */
	public function inventory_feed( array $rows ): string {
		$messages = '';
		$message_id = 1;
		foreach ( $rows as $r ) {
			$sku = htmlspecialchars( (string) $r['sku'], ENT_XML1 | ENT_QUOTES, 'UTF-8' );
			$qty = max( 0, (int) $r['quantity'] );
			$latency = isset( $r['fulfillment_latency'] ) ? max( 1, (int) $r['fulfillment_latency'] ) : 1;
			$messages .= <<<XML
  <Message>
    <MessageID>{$message_id}</MessageID>
    <OperationType>Update</OperationType>
    <Inventory>
      <SKU>{$sku}</SKU>
      <Quantity>{$qty}</Quantity>
      <FulfillmentLatency>{$latency}</FulfillmentLatency>
    </Inventory>
  </Message>
XML;
			$message_id++;
		}
		return $this->envelope( 'Inventory', $messages );
	}

	/**
	 * Return Amazon feed type strings for a message type. Used by FeedsClient
	 * when calling /feeds/2021-06-30/feeds.
	 */
	public static function feed_type( string $message_type ): string {
		return match ( $message_type ) {
			'Price'     => 'POST_PRODUCT_PRICING_DATA',
			'Inventory' => 'POST_INVENTORY_AVAILABILITY_DATA',
			'Product'   => 'POST_PRODUCT_DATA',
			default     => '',
		};
	}

	private function envelope( string $message_type, string $messages ): string {
		$merchant = htmlspecialchars( $this->merchant_id, ENT_XML1 | ENT_QUOTES, 'UTF-8' );
		return <<<XML
<?xml version="1.0" encoding="UTF-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.01</DocumentVersion>
    <MerchantIdentifier>{$merchant}</MerchantIdentifier>
  </Header>
  <MessageType>{$message_type}</MessageType>
{$messages}
</AmazonEnvelope>
XML;
	}
}
