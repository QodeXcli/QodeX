import OpenAI from 'openai';
import { Provider, type CompletionRequest, type StreamEvent, type ModelInfo } from '../types.js';
import type { Message } from '../../session/store.js';
import { logger } from '../../utils/logger.js';

// The `openai` SDK defaults its User-Agent to `OpenAI/JS <ver>`. Some custom
// OpenAI-compatible relays sit behind a WAF (e.g. Cloudflare) that BLOCKS that
// exact User-Agent with a 403 "Your request was blocked" — which silently
// breaks every request to such a gateway (exactly the endpoints `provider add
// <url>` exists for). We override it with our own UA so requests aren't blocked
// for impersonating the OpenAI SDK. A caller-supplied User-Agent still wins.
const QODEX_USER_AGENT = 'qodex-cli';

// OpenAI's own models. The DeepSeek models live separately so they're served ONLY
// by the dedicated DeepSeekProvider — otherwise they'd also surface under the
// `openai` provider (which shares this base list) and show up twice in --list-models.
const OPENAI_MODELS: ModelInfo[] = [
  { id: 'gpt-4o', contextWindow: 128000, maxOutput: 16384, inputCostPerMillion: 2.5, outputCostPerMillion: 10, supportsToolCalls: true, supportsStreaming: true },
  { id: 'gpt-4o-mini', contextWindow: 128000, maxOutput: 16384, inputCostPerMillion: 0.15, outputCostPerMillion: 0.6, supportsToolCalls: true, supportsStreaming: true },
  { id: 'gpt-4-turbo', contextWindow: 128000, maxOutput: 4096, inputCostPerMillion: 10, outputCostPerMillion: 30, supportsToolCalls: true, supportsStreaming: true },
];

const DEEPSEEK_MODELS: ModelInfo[] = [
  { id: 'deepseek-chat', contextWindow: 64000, maxOutput: 8000, inputCostPerMillion: 0.14, outputCostPerMillion: 0.28, supportsToolCalls: true, supportsStreaming: true },
  { id: 'deepseek-coder', contextWindow: 128000, maxOutput: 8000, inputCostPerMillion: 0.14, outputCostPerMillion: 0.28, supportsToolCalls: true, supportsStreaming: true },
];

export class OpenAIProvider extends Provider {
  name: string;
  isLocal = false;
  private client: OpenAI | null = null;
  private apiKey: string | undefined;
  private models: ModelInfo[];
  private baseURL?: string;
  private draftModel?: string;
  private specServerKind?: string;
  private samplingOptions?: {
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
  };

  constructor(opts: {
    apiKey?: string;
    baseURL?: string;
    providerName?: string;
    models?: ModelInfo[];
    /** Extra models to merge into the catalog. Useful when a self-hosted gateway exposes additional model ids. */
    extraModels?: ModelInfo[];
    /** Extra HTTP headers (e.g. for gateways that require an Authorization scheme other than Bearer). */
    defaultHeaders?: Record<string, string>;
    /** Draft model for speculative decoding on a local OpenAI-compatible server (LM Studio).
     *  Sent as an extra `draft_model` body field; ignored by servers that don't support it. */
    draftModel?: string;
    /** Which local server kind, for emitting the correct speculative-decoding
     *  field name: 'lmstudio' | 'llamacpp' | 'vllm' | 'auto'. Default 'auto'. */
    specServerKind?: string;
    /** Sampling overrides — useful for local servers (LM Studio, llama.cpp) where the
     *  defaults cause repetition collapse on long completions.
     *  - temperature: 0.0–2.0 (0.3 is a sensible coding default; 0.7 for prose)
     *  - top_p: 0.0–1.0 (typical 0.9)
     *  - frequency_penalty: -2.0–2.0 (positive values discourage repetition; ~0.5
     *    is roughly equivalent to llama.cpp's repeat_penalty ≈ 1.15)
     *  - presence_penalty: -2.0–2.0 (positive values encourage new topics)
     */
    samplingOptions?: {
      temperature?: number;
      top_p?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
    };
  } = {}) {
    super();
    this.name = opts.providerName ?? 'openai';
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseURL = opts.baseURL;
    this.draftModel = opts.draftModel;
    this.specServerKind = opts.specServerKind;
    // A loopback baseURL means this "openai" provider is really a local server
    // (e.g. LM Studio / llama.cpp) — traffic stays on the machine and is free.
    this.isLocal = !!opts.baseURL &&
      /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i.test(opts.baseURL);
    this.samplingOptions = opts.samplingOptions;
    const base = opts.models ?? OPENAI_MODELS;
    this.models = opts.extraModels && opts.extraModels.length > 0
      ? [...base, ...opts.extraModels]
      : base;
    if (this.apiKey) {
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: opts.baseURL,
        defaultHeaders: { 'User-Agent': QODEX_USER_AGENT, ...opts.defaultHeaders },
      });
      // Flag custom baseURL so users are reminded their traffic is routing through a non-Anthropic/OpenAI host
      if (opts.baseURL && !opts.baseURL.includes('openai.com') && !opts.baseURL.includes('deepseek.com')) {
        logger.warn(`${this.name} provider configured with custom baseURL: ${opts.baseURL}`);
        logger.warn('All prompts (including file contents from your tools) will be sent through this endpoint. Make sure you trust it.');
        if (this.samplingOptions) {
          logger.info(`${this.name} sampling overrides active: ${JSON.stringify(this.samplingOptions)}`);
        }
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) return [];
    return this.models;
  }

  private convertMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(m => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id!,
          content: m.content ?? '',
        };
      }
      if (m.role === 'assistant') {
        const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: m.content ?? null,
        };
        if (m.tool_calls) {
          msg.tool_calls = m.tool_calls.map((tc: any) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
        }
        return msg;
      }
      return { role: m.role, content: m.content ?? '' } as OpenAI.Chat.ChatCompletionMessageParam;
    });
  }

  async *complete(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    if (!this.client) {
      yield { type: 'error', error: `No API key for ${this.name}` };
      return;
    }

    const messages = this.convertMessages(req.messages);
    const tools = req.tools?.map(t => ({
      type: 'function' as const,
      function: t.function,
    }));

    try {
      // Optional sampling params — provider config may set these for local-server
      // backends (LM Studio, llama.cpp) where the defaults cause repetition collapse.
      // These map to the OpenAI chat completions API, which LM Studio honors.
      const sampling: Record<string, number | undefined> = {};
      if (this.samplingOptions?.frequency_penalty != null) {
        sampling.frequency_penalty = this.samplingOptions.frequency_penalty;
      }
      if (this.samplingOptions?.presence_penalty != null) {
        sampling.presence_penalty = this.samplingOptions.presence_penalty;
      }
      if (this.samplingOptions?.top_p != null) {
        sampling.top_p = this.samplingOptions.top_p;
      }

      // Constrained-decoding extras (opt-in, see src/llm/constrained.ts):
      //   - tool_choice 'required'/'none' lets the loop force or forbid a tool call.
      //   - response_format pins output to JSON / a JSON Schema (LM Studio honors this).
      //   - grammar is a llama.cpp GBNF — not in the OpenAI types, passed through as an
      //     extra body field (LM Studio reads it; vanilla OpenAI ignores unknown fields).
      // All are no-ops unless the caller set them, so default behavior is byte-identical.
      const toolChoice = tools && tools.length
        ? (req.toolChoice ?? 'auto')
        : undefined;
      const extra: Record<string, unknown> = {};
      if (req.responseFormat) extra.response_format = req.responseFormat;
      if (req.grammar) extra.grammar = req.grammar;
      // Reasoning effort for models that support it. Unknown field elsewhere → ignored.
      if (req.reasoningEffort) extra.reasoning_effort = req.reasoningEffort;
      // Speculative decoding hints. Different local servers (LM Studio,
      // llama.cpp, vLLM) read different field names; buildSpecDecodeExtras emits
      // the right one(s). All are ignored by servers/endpoints that don't speak
      // them, so a remote OpenAI endpoint is unaffected.
      if (this.draftModel && this.isLocal) {
        const { buildSpecDecodeExtras } = await import('../speculative.js');
        const lookahead = (req as any).specLookahead ?? 5;
        const serverKind = (this.specServerKind as any) ?? 'auto';
        Object.assign(extra, buildSpecDecodeExtras(this.draftModel, lookahead, serverKind));
      }

      // Open the stream with connection-phase retry. We retry ONLY the
      // create() call (and only if nothing has been yielded yet); once deltas
      // start flowing, a mid-stream failure can't be safely retried without
      // duplicating already-emitted text, so that surfaces as an error event.
      const { withRetry } = await import('../../utils/retry.js');
      const stream = await withRetry(
        () => this.client!.chat.completions.create({
          model: req.model,
          messages,
          tools,
          tool_choice: toolChoice,
          temperature: req.temperature ?? this.samplingOptions?.temperature ?? 0.3,
          max_tokens: req.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...sampling,
          ...extra,
        } as any, { signal: req.signal }) as unknown as Promise<AsyncIterable<any>>,
        { signal: req.signal, label: `${this.name}.complete`, maxAttempts: 4 },
      );

      // Diagnostic counters — surface in qodex.log so we can tell at a glance whether
      // a remote endpoint actually emitted any tool_calls deltas for this turn.
      let sawToolCallDelta = false;
      let textChars = 0;
      let finishReason: string | undefined;

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;

        if (delta?.content) {
          textChars += delta.content.length;
          yield { type: 'text_delta', delta: delta.content };
        }

        if (delta?.tool_calls) {
          sawToolCallDelta = true;
          for (const tc of delta.tool_calls) {
            yield {
              type: 'tool_call_delta',
              toolCallIndex: tc.index,
              toolCallId: tc.id,
              toolName: tc.function?.name,
              toolArgsDelta: tc.function?.arguments ?? '',
            };
          }
        }

        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens },
          };
        }
      }

      // The high-signal diagnostic: tools were sent but none came back. Either the model
      // chose not to use them, OR the endpoint stripped them (common with mismatched proxies
      // that adapt Anthropic responses to OpenAI shape and forget tool_use blocks).
      if (tools && tools.length > 0 && !sawToolCallDelta) {
        logger.info(`[${this.name}] stream finished WITHOUT tool_calls`, {
          model: req.model,
          finishReason,
          textChars,
          toolsSent: tools.length,
          baseURL: this.baseURL ?? '(default)',
          hint: this.baseURL && !this.baseURL.includes('openai.com')
            ? 'Custom baseURL in use — if you expected a tool call, the proxy may be stripping tool_calls. Try a direct OpenAI/Anthropic endpoint to confirm.'
            : 'Model declined to call a tool. The prompt may not have made tool use obvious enough.',
        });
      }

      yield { type: 'done' };
    } catch (e: any) {
      yield { type: 'error', error: e.message ?? String(e) };
    }
  }
}

export class DeepSeekProvider extends OpenAIProvider {
  constructor(opts: {
    apiKey?: string;
    baseURL?: string;
    extraModels?: ModelInfo[];
    defaultHeaders?: Record<string, string>;
  } = {}) {
    super({
      apiKey: opts.apiKey ?? process.env.DEEPSEEK_API_KEY,
      baseURL: opts.baseURL ?? 'https://api.deepseek.com',
      providerName: 'deepseek',
      models: DEEPSEEK_MODELS,
      extraModels: opts.extraModels,
      defaultHeaders: { 'User-Agent': QODEX_USER_AGENT, ...opts.defaultHeaders },
    });
  }
}
