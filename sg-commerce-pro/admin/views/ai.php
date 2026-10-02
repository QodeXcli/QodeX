<?php
/**
 * View — AI configuration.
 *
 * @var \SevenGum\Commerce\Core\Container $container
 */

defined( 'ABSPATH' ) || exit;

use SevenGum\Commerce\AI\PromptRegistry;
use SevenGum\Commerce\Admin\AdminModule;
use SevenGum\Commerce\Database\Repositories\SettingsRepository;

$settings = $container->get( SettingsRepository::class );
$prompts  = $container->get( PromptRegistry::class );

$active_provider = (string) $settings->get( 'ai_provider', 'ollama' );
$ollama_url      = (string) $settings->get( 'ollama_url', 'http://127.0.0.1:11434' );
$ollama_model    = (string) $settings->get( 'ollama_model', 'llama3.1:8b' );
$temperature     = (float)  $settings->get( 'ai_temperature', 0.7 );
$brand_voice     = (string) $settings->get( 'ai_brand_voice', 'modern, clean, playful but confident' );
?>
<div class="wrap sg-admin">
	<div class="sg-hero">
		<h1>AI <span><?php esc_html_e( 'Provider', 'sg-commerce' ); ?></span></h1>
		<p class="sg-subtitle"><?php esc_html_e( 'Pick your AI backend. Ollama runs locally with no per-token cost.', 'sg-commerce' ); ?></p>
	</div>

	<?php AdminModule::render_flash(); ?>

	<div class="sg-grid-2">
		<form class="sg-card" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" autocomplete="off">
			<h2><?php esc_html_e( 'Configuration', 'sg-commerce' ); ?></h2>

			<?php wp_nonce_field( 'sg_save_ai', AdminModule::NONCE ); ?>
			<input type="hidden" name="action" value="sg_save_ai" />

			<label><?php esc_html_e( 'Provider', 'sg-commerce' ); ?>
				<select name="ai_provider">
					<option value="ollama" <?php selected( $active_provider, 'ollama' ); ?>>Ollama (local)</option>
					<option value="openai" disabled>OpenAI (coming in v3.1)</option>
					<option value="anthropic" disabled>Anthropic Claude (coming in v3.1)</option>
				</select>
			</label>

			<label>Ollama URL
				<input type="url" name="ollama_url" value="<?php echo esc_attr( $ollama_url ); ?>" placeholder="http://127.0.0.1:11434" />
			</label>
			<p class="sg-muted" style="margin:4px 0 16px; font-size:12px;">
				<?php esc_html_e( 'On Hostinger: ensure Ollama listens on 0.0.0.0:11434 if WordPress runs in a separate container/host.', 'sg-commerce' ); ?>
			</p>

			<label><?php esc_html_e( 'Default model', 'sg-commerce' ); ?>
				<input type="text" name="ollama_model" value="<?php echo esc_attr( $ollama_model ); ?>" placeholder="llama3.1:8b" />
			</label>
			<p class="sg-muted" style="margin:4px 0 16px; font-size:12px;">
				<?php esc_html_e( 'Recommended:', 'sg-commerce' ); ?>
				<code>llama3.1:8b</code> · <code>gemma2:9b-instruct-q4_K_M</code> · <code>qwen2.5:7b</code>
			</p>

			<label>Auth token (optional)
				<input type="password" name="ollama_auth_token"
					placeholder="<?php echo esc_attr( $settings->mask( 'ollama_auth_token' ) ?: 'Only if Ollama sits behind an auth proxy' ); ?>" />
			</label>

			<label><?php esc_html_e( 'Temperature', 'sg-commerce' ); ?>
				<input type="number" step="0.1" min="0" max="2" name="ai_temperature" value="<?php echo esc_attr( (string) $temperature ); ?>" />
			</label>
			<p class="sg-muted" style="margin:4px 0 16px; font-size:12px;">
				<?php esc_html_e( '0.0 = deterministic; 0.7 = balanced; 1.5 = creative.', 'sg-commerce' ); ?>
			</p>

			<label><?php esc_html_e( 'Brand voice', 'sg-commerce' ); ?>
				<textarea name="ai_brand_voice" rows="2"><?php echo esc_textarea( $brand_voice ); ?></textarea>
			</label>

			<div class="sg-actions">
				<button type="submit" class="sg-btn sg-btn-primary"><?php esc_html_e( 'Save AI settings', 'sg-commerce' ); ?></button>
			</div>
		</form>

		<div class="sg-card">
			<h2><?php esc_html_e( 'Connection test', 'sg-commerce' ); ?></h2>
			<p class="sg-muted"><?php esc_html_e( 'Lists models installed on your Ollama server.', 'sg-commerce' ); ?></p>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<?php wp_nonce_field( 'sg_test_ai', AdminModule::NONCE ); ?>
				<input type="hidden" name="action" value="sg_test_ai" />
				<div class="sg-actions">
					<button type="submit" class="sg-btn"><?php esc_html_e( 'Test Ollama', 'sg-commerce' ); ?></button>
				</div>
			</form>

			<hr />

			<h3><?php esc_html_e( 'Get Ollama running', 'sg-commerce' ); ?></h3>
			<ol class="sg-steps sg-steps-compact">
				<li><span class="sg-step-num">1</span><div>Install: <code>curl -fsSL https://ollama.com/install.sh | sh</code></div></li>
				<li><span class="sg-step-num">2</span><div>Pull a model: <code>ollama pull llama3.1:8b</code></div></li>
				<li><span class="sg-step-num">3</span><div>Verify: <code>curl http://127.0.0.1:11434/api/tags</code></div></li>
				<li><span class="sg-step-num">4</span><div><?php esc_html_e( 'Click Test Ollama above.', 'sg-commerce' ); ?></div></li>
			</ol>
		</div>
	</div>

	<div class="sg-card">
		<h2><?php esc_html_e( 'Prompt templates', 'sg-commerce' ); ?></h2>
		<p class="sg-muted"><?php esc_html_e( 'These are the exact prompts sent to your AI provider.', 'sg-commerce' ); ?></p>

		<h3><?php esc_html_e( 'System / brand context', 'sg-commerce' ); ?></h3>
<pre class="sg-code"><?php echo esc_html( $prompts->brand_system() ); ?></pre>

		<h3 style="margin-top:24px;"><?php esc_html_e( 'Describe (English)', 'sg-commerce' ); ?></h3>
<pre class="sg-code"><?php echo esc_html( $prompts->describe_product( array(
	'sku' => '{sku}', 'asin' => '{asin}', 'product_name' => '{name}', 'market' => '{market}'
) ) ); ?></pre>

		<h3 style="margin-top:24px;"><?php esc_html_e( 'Translate', 'sg-commerce' ); ?></h3>
<pre class="sg-code"><?php echo esc_html( $prompts->translate( '{english_text}', '{target_language}' ) ); ?></pre>
	</div>
</div>
