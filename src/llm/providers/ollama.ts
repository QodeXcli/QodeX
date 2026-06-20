import { Provider, type CompletionRequest, type StreamEvent, type ModelInfo } from '../types.js';
import { ProviderError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { computeThroughput } from '../cache-layout.js';

export interface OllamaOptions {
  /** `keep_alive` — how long to keep the model resident. Default '30m'. */
  keepAlive?: string;
  /** Extra runtime options merged into every request's `options` (num_ctx, num_batch, …). */
  options?: Record<string, number>;
  /** Draft model for speculative decoding, passed through if the server supports it. */
  draftModel?: string;
}

interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
  };
}

export class OllamaProvider extends Provider {
  name = 'ollama';
  isLocal = true;
  private baseUrl: string;
  private opts: OllamaOptions;

  constructor(baseUrl = 'http://localhost:11434', opts: OllamaOptions = {}) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.opts = opts;
  }

  async isAvailable(): Promise<boolean> {
    // A genuinely-down server rejects immediately (ECONNREFUSED), so a generous
    // timeout only matters for a cold/just-woken Ollama whose first /api/tags is
    // slow. 2s used to be too tight and intermittently dropped all Ollama models
    // from the router index at startup (→ "default model not available" flaps).
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new ProviderError(`Ollama returned ${res.status}`, 'ollama', res.status);
      const data = (await res.json()) as { models: OllamaModel[] };
      return (data.models ?? []).map(m => ({
        id: m.name,
        contextWindow: this.guessContextWindow(m.name),
        maxOutput: 8192,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        supportsToolCalls: this.supportsTools(m.name),
        supportsStreaming: true,
      }));
    } catch (e: any) {
      throw new ProviderError(`Failed to list Ollama models: ${e.message}`, 'ollama');
    }
  }

  private guessContextWindow(model: string): number {
    const lower = model.toLowerCase();
    if (lower.includes('qwen2.5-coder') || lower.includes('qwen3-coder')) return 32768;
    if (lower.includes('qwen')) return 32768;
    if (lower.includes('llama3.1') || lower.includes('llama3.2') || lower.includes('llama3.3')) return 131072;
    if (lower.includes('mistral')) return 32768;
    if (lower.includes('gemma2')) return 8192;
    if (lower.includes('deepseek')) return 16384;
    return 8192;
  }

  private supportsTools(model: string): boolean {
    const lower = model.toLowerCase();
    const supported = ['qwen2.5-coder', 'qwen3-coder', 'qwen2.5', 'qwen3', 'llama3.1', 'llama3.2', 'llama3.3', 'mistral', 'firefunction'];
    return supported.some(s => lower.includes(s));
  }

  async *complete(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const startTime = Date.now();

    // Convert messages to Ollama chat format. Ollama is *mostly* OpenAI-compatible
    // but it requires `tool_calls[].function.arguments` to be an OBJECT, not a JSON
    // string. Our internal `ToolCall` follows the OpenAI shape (arguments-as-string),
    // so we re-parse it here. Strip OpenAI-only fields (`id`, `type`) — Ollama doesn't
    // accept them and may error if they look malformed in history.
    const body: any = {
      model: req.model,
      messages: req.messages.map(m => {
        const out: any = {
          role: m.role,
          content: m.content ?? '',
        };
        if (m.tool_calls && m.tool_calls.length > 0) {
          out.tool_calls = m.tool_calls.map((tc: any) => {
            // Re-parse arguments string into object. If parse fails, fall back to {}
            // — broken arguments would HTTP 400 the request anyway; better to drop them.
            let argsObj: any = {};
            const rawArgs = tc.function.arguments ?? '';
            if (rawArgs.trim()) {
              try {
                argsObj = JSON.parse(rawArgs);
              } catch {
                // Try to salvage with the same relaxed parser we use elsewhere
                try {
                  // Inline relaxed parse: escape unescaped newlines/tabs in string literals
                  let fixed = '';
                  let inString = false;
                  let escape = false;
                  for (let i = 0; i < rawArgs.length; i++) {
                    const c = rawArgs[i]!;
                    if (escape) { fixed += c; escape = false; continue; }
                    if (c === '\\') { fixed += c; escape = true; continue; }
                    if (c === '"') { fixed += c; inString = !inString; continue; }
                    if (inString) {
                      if (c === '\n') { fixed += '\\n'; continue; }
                      if (c === '\r') { fixed += '\\r'; continue; }
                      if (c === '\t') { fixed += '\\t'; continue; }
                    }
                    fixed += c;
                  }
                  argsObj = JSON.parse(fixed);
                } catch {
                  logger.warn('Could not parse tool_call arguments for Ollama; sending empty', {
                    tool: tc.function.name,
                    rawLen: rawArgs.length,
                  });
                  argsObj = {};
                }
              }
            }
            return {
              function: {
                name: tc.function.name,
                arguments: argsObj,
              },
            };
          });
        }
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.name) out.name = m.name;
        return out;
      }),
      stream: true,
      options: {
        // num_ctx FIRST so an explicit config override wins. Defaulting it to the
        // model's real context window stops Ollama from silently clamping long
        // sessions to its 2k/4k server default (a classic "it forgot everything"
        // cause) — and keeping it stable across turns preserves the KV cache.
        num_ctx: this.guessContextWindow(req.model),
        temperature: req.temperature ?? 0.3,
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
        ...(this.opts.options ?? {}),
      },
      // Longer keep_alive = the model (and its KV cache) stays warm between turns,
      // so we pay prefill once, not on every iteration. Configurable; default 30m.
      keep_alive: this.opts.keepAlive ?? '30m',
      ...(this.opts.draftModel ? { draft_model: this.opts.draftModel } : {}),
    };

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
    }

    // Constrained decoding (opt-in). Ollama's `format` accepts either the string
    // "json" or a full JSON Schema object — both force structured output, killing
    // the malformed-args failure mode at the source. Servers handle this natively;
    // when the caller sets nothing, the field is absent and behavior is unchanged.
    // (Ollama has no grammar/tool_choice knobs, so those request fields are ignored here.)
    if (req.responseFormat) {
      body.format = req.responseFormat.type === 'json_schema'
        ? req.responseFormat.json_schema.schema
        : 'json';
    }

    let res: Response;
    try {
      const { withRetry } = await import('../../utils/retry.js');
      res = await withRetry(
        async () => {
          const r = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: req.signal,
          });
          // Treat retryable HTTP statuses as throws so withRetry can see them.
          if (!r.ok && (r.status === 429 || (r.status >= 500 && r.status !== 501))) {
            const err: any = new Error(`Ollama HTTP ${r.status}`);
            err.status = r.status;
            err.headers = r.headers;
            throw err;
          }
          return r;
        },
        { signal: req.signal, label: 'ollama.complete', maxAttempts: 4 },
      );
    } catch (e: any) {
      yield { type: 'error', error: `Cannot reach Ollama at ${this.baseUrl}: ${e.message}` };
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      yield { type: 'error', error: `Ollama HTTP ${res.status}: ${text.slice(0, 200)}` };
      return;
    }

    if (!res.body) {
      yield { type: 'error', error: 'Ollama returned no body' };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const toolCallIndices = new Map<string, number>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          try {
            const chunk = JSON.parse(line);

            // Text content
            if (chunk.message?.content) {
              // Strip Qwen / ChatGLM / DeepSeek special tokens that occasionally leak
              // into the streamed text. These are training tokens (sentinels), not
              // user-facing content. We strip them HERE at the provider level so all
              // downstream consumers (agent loop, UI, recovery, dedup history) see
              // clean text.
              const cleaned = stripSpecialTokens(chunk.message.content);
              if (cleaned) yield { type: 'text_delta', delta: cleaned };
            }

            // Tool calls (Ollama returns them complete, not streamed deltas)
            if (chunk.message?.tool_calls) {
              for (const tc of chunk.message.tool_calls) {
                const fname = tc.function?.name ?? 'unknown';
                const args = typeof tc.function?.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function?.arguments ?? {});
                let idx = toolCallIndices.get(fname);
                if (idx === undefined) {
                  idx = toolCallIndices.size;
                  toolCallIndices.set(fname, idx);
                  yield {
                    type: 'tool_call_delta',
                    toolCallIndex: idx,
                    toolCallId: tc.id ?? `call_${idx}`,
                    toolName: fname,
                    toolArgsDelta: '',
                  };
                }
                yield {
                  type: 'tool_call_delta',
                  toolCallIndex: idx,
                  toolArgsDelta: args,
                };
              }
            }

            // Usage stats at end
            if (chunk.done) {
              totalInputTokens = chunk.prompt_eval_count ?? 0;
              totalOutputTokens = chunk.eval_count ?? 0;
              yield {
                type: 'usage',
                usage: { input: totalInputTokens, output: totalOutputTokens },
              };
            }
          } catch (e: any) {
            logger.debug('Failed to parse Ollama chunk', { line: line.slice(0, 100), err: e.message });
          }
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        yield { type: 'error', error: 'Cancelled by user' };
      } else {
        yield { type: 'error', error: `Ollama stream failed at ${this.baseUrl} (model=${req.model ?? '?'}): ${e?.message ?? String(e)}` };
      }
      return;
    }

    yield { type: 'done' };
    const latencyMs = Date.now() - startTime;
    logger.debug('Ollama completion done', {
      model: req.model,
      latencyMs,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      tokensPerSec: Math.round(computeThroughput(totalOutputTokens, latencyMs)),
    });
  }
}

/**
 * Strip vendor-specific special tokens from text content.
 *
 * Small/quantized open models (Qwen 2.5 in particular under aggressive sampling)
 * sometimes leak their chat-template sentinel tokens into the response body. These
 * are meant to be eaten by the tokenizer, not shown to humans:
 *
 *   <|im_start|>  <|im_end|>     ChatML (Qwen, Yi, several others)
 *   <|user|>      <|assistant|>  Generic chat templates
 *   <|endoftext|>                Universal EOS leak
 *   <|tool_call_begin|>          ChatML tool variants
 *   <|FunctionCallBegin|>        ChatGLM/GLM-4
 *
 * We strip these at the provider boundary so they never enter:
 *   - the agent loop (which would treat them as content),
 *   - history (which would feed them BACK to the model and reinforce the leak),
 *   - the UI (which would just render them as gibberish).
 *
 * Conservative: only strips the exact known tokens. Doesn't touch normal angle-bracket
 * content like JSX, XML, or shell redirects.
 */
function stripSpecialTokens(text: string): string {
  if (!text) return text;
  return text
    .replace(/<\|im_start\|>/g, '')
    .replace(/<\|im_end\|>/g, '')
    .replace(/<\|endoftext\|>/g, '')
    .replace(/<\|user\|>/g, '')
    .replace(/<\|assistant\|>/g, '')
    .replace(/<\|system\|>/g, '')
    .replace(/<\|tool_call_begin\|>/g, '')
    .replace(/<\|tool_call_end\|>/g, '')
    .replace(/<\|FunctionCallBegin\|>/g, '')
    .replace(/<\|FunctionCallEnd\|>/g, '')
    .replace(/<\|tool_call\|>/g, '')
    .replace(/<\|\/tool_call\|>/g, '')
    .replace(/<｜tool▁call▁begin｜>/g, '')
    .replace(/<｜tool▁call▁end｜>/g, '');
}
