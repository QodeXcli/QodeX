<?php
/**
 * ProviderInterface — contract for any AI text generation backend.
 *
 * Implementations: OllamaProvider, OpenAIProvider, AnthropicProvider.
 * Plugin code talks to this interface, never to a concrete provider —
 * that's how the user can swap providers from the AI Settings page
 * without touching code anywhere else.
 *
 * @package SevenGum\Commerce\AI
 */

declare( strict_types = 1 );

namespace SevenGum\Commerce\AI;

defined( 'ABSPATH' ) || exit;

interface ProviderInterface {

	/** Stable id used in settings ('ollama', 'openai', 'anthropic'). */
	public function id(): string;

	/** Human-readable name for the admin UI. */
	public function name(): string;

	/**
	 * Generate text. Returns the full response string.
	 *
	 * @param string  $prompt        User prompt.
	 * @param array   $options {
	 *     @type ?string $system       System/role prompt (optional).
	 *     @type ?string $model        Model identifier override.
	 *     @type ?float  $temperature  0.0–2.0 randomness.
	 *     @type ?int    $max_tokens   Output cap.
	 * }
	 *
	 * @return array{
	 *   text: string,
	 *   provider: string,
	 *   model: string,
	 *   tokens: int,
	 *   duration_ms: int,
	 * }
	 *
	 * @throws \RuntimeException  On provider/network failure.
	 */
	public function generate( string $prompt, array $options = array() ): array;

	/**
	 * Lightweight reachability check — returns true if the provider is
	 * configured and responding. May make a tiny test request.
	 */
	public function is_reachable(): bool;

	/**
	 * List models available on this provider, if discoverable.
	 *
	 * @return array<int, array{id:string, name:string, size?:int}>
	 */
	public function list_models(): array;
}
