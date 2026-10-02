<?php
/**
 * RetryableException — marker for transient errors worth retrying.
 *
 * @package SevenGum\Commerce\Amazon
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\Amazon;

defined( 'ABSPATH' ) || exit;

final class RetryableException extends \RuntimeException {}
