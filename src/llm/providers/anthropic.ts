import Anthropic from '@anthropic-ai/sdk';
import { Provider, type CompletionRequest, type StreamEvent, type ModelInfo } from '../types.js';
import { ProviderError } from '../../utils/errors.js';
import type { Message } from '../../session/store.js';
import { logger } from '../../utils/logger.js';

const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-7', contextWindow: 200000, maxOutput: 32000, inputCostPerMillion: 15, outputCostPerMillion: 75, supportsToolCalls: true, supportsStreaming: true },
  { id: 'claude-sonnet-4-6', contextWindow: 200000, maxOutput: 32000, inputCostPerMillion: 3, outputCostPerMillion: 15, supportsToolCalls: true, supportsStreaming: true },
  { id: 'claude-haiku-4-5', contextWindow: 200000, maxOutput: 16000, inputCostPerMillion: 1, outputCostPerMillion: 5, supportsToolCalls: true, supportsStreaming: true },
];

const EPHEMERAL = { type: 'ephemeral' as const };

/**
 * Hierarchical prompt cache — place cache_control breakpoints so the SHARED, stable prefix of
 * every iteration is served from cache (0.1× input price, ~0 latency) instead of re-billed in
 * full each turn. Anthropic caches everything up to & including each marker, longest-prefix-wins,
 * max 4 markers. We use three tiers:
 *
 *   1. last tool      → caches the whole tools block (immutable for the run).
 *   2. system         → caches tools + system (the static instruction core).
 *   3. last message   → ROLLING breakpoint: caches the conversation prefix so far. THIS is what
 *      QodeX was missing — without it the growing history is re-billed at full price every
 *      iteration (the root of the ~9× burn vs. caching agents). On the next request the prior
 *      turn's content is a cached prefix.
 *
 * PURE — unit-tested by which blocks end up marked. Mutates nothing (clones what it touches).
 */
export function withCacheBreakpoints(
  systemText: string,
  messages: any[],
  tools: any[] | undefined,
): { system: any; messages: any[]; tools: any[] | undefined } {
  const system = systemText
    ? [{ type: 'text', text: systemText, cache_control: EPHEMERAL }]
    : systemText;
  const toolsOut = tools && tools.length > 0
    ? tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: EPHEMERAL } : t))
    : tools;
  return { system, messages: markLastMessage(messages), tools: toolsOut };
}

/** Add a cache breakpoint to the last content block of the last message (the rolling prefix). */
function markLastMessage(messages: any[]): any[] {
  if (!messages.length) return messages;
  const out = messages.slice();
  const last = { ...out[out.length - 1] };
  const blocks = Array.isArray(last.content)
    ? last.content.map((b: any) => ({ ...b }))
    : [{ type: 'text', text: String(last.content ?? '') }];
  if (blocks.length > 0) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
  last.content = blocks;
  out[out.length - 1] = last;
  return out;
}

export class AnthropicProvider extends Provider {
  name = 'anthropic';
  isLocal = false;
  private client: Anthropic | null = null;
  private apiKey: string | undefined;
  private useCaching: boolean;

  constructor(apiKey?: string, opts: { useCaching?: boolean } = {}) {
    super();
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.useCaching = opts.useCaching ?? false;
    if (this.apiKey) {
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) return [];
    return ANTHROPIC_MODELS;
  }

  // We use a loose type for Anthropic.MessageParam because the SDK occasionally renames
  // or restructures these. The runtime shape is the contract; the SDK validates the rest.
  private convertMessages(messages: Message[]): { system: string; messages: any[] } {
    let system = '';
    const out: any[] = [];
    let pendingToolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

    const flushToolResults = (): void => {
      if (pendingToolResults.length === 0) return;
      // Merge into the previous user message if one exists (Anthropic disallows consecutive user blocks)
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) {
        last.content = [...last.content, ...pendingToolResults] as any;
      } else {
        out.push({ role: 'user', content: pendingToolResults as any });
      }
      pendingToolResults = [];
    };

    for (const m of messages) {
      if (m.role === 'system') {
        system += (system ? '\n\n' : '') + (m.content ?? '');
        continue;
      }

      if (m.role === 'tool') {
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: m.tool_call_id!,
          content: m.content ?? '',
        });
        continue;
      }

      // Any non-tool message: flush buffered tool results first
      flushToolResults();

      if (m.role === 'assistant') {
        // Use a loose type here: the Anthropic SDK has churned through several names
        // for the content-block param type (ContentBlockParam, RawContentBlockParam,
        // etc.). The runtime shape is what we care about; the SDK validates server-side.
        const content: Array<{ type: string; [k: string]: any }> = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            // Parse arguments. CRITICAL: do NOT silently swallow JSON errors —
            // if parsing fails, surface that to the model via an explanatory text block
            // so it can self-correct on the next turn instead of repeating the bad JSON.
            let parsed: unknown;
            let parseFailed = false;
            const raw = tc.function.arguments ?? '';
            if (!raw.trim()) {
              parsed = {};
            } else {
              try {
                parsed = JSON.parse(raw);
              } catch {
                parsed = {};
                parseFailed = true;
              }
            }
            if (parseFailed) {
              content.push({
                type: 'text',
                text:
                  `[CALL_NOTE] My previous attempt to call '${tc.function.name}' had invalid JSON ` +
                  `arguments. Raw text was: ${raw.slice(0, 300)}${raw.length > 300 ? '...' : ''}. ` +
                  `I will re-output the arguments as strict JSON on my next attempt.`,
              });
            }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parsed,
            });
          }
        }
        // If empty (rare), put a placeholder so Anthropic doesn't reject
        if (content.length === 0) content.push({ type: 'text', text: '(no content)' });
        // Merge with previous assistant if alternation is broken (defensive)
        const last = out[out.length - 1];
        if (last?.role === 'assistant') {
          last.content = [
            ...(Array.isArray(last.content) ? last.content : [{ type: 'text' as const, text: String(last.content) }]),
            ...content,
          ] as any;
        } else {
          out.push({ role: 'assistant', content });
        }
        continue;
      }

      // user
      const last = out[out.length - 1];
      if (last?.role === 'user') {
        // Merge consecutive user text into one block
        const existing = Array.isArray(last.content)
          ? last.content
          : [{ type: 'text' as const, text: String(last.content) }];
        last.content = [...existing, { type: 'text', text: m.content ?? '' }] as any;
      } else {
        out.push({ role: 'user', content: m.content ?? '' });
      }
    }

    flushToolResults();

    // Anthropic requires the first message to be from the user
    while (out.length > 0 && out[0]!.role !== 'user') {
      out.shift();
    }

    return { system, messages: out };
  }

  async *complete(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    if (!this.client) {
      yield { type: 'error', error: 'No Anthropic API key set. Set ANTHROPIC_API_KEY.' };
      return;
    }

    const { system, messages } = this.convertMessages(req.messages);

    const tools = req.tools?.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as any,
    }));

    // Hierarchical prompt-caching (see withCacheBreakpoints): cache the static prefix (tools +
    // system) AND a rolling breakpoint on the conversation so far, so iterations 2..N read the
    // shared prefix from cache instead of re-billing it. Without the message breakpoint the
    // growing history is full-price every turn — the core of the high token burn.
    //
    // Typing note: cache_control is a beta-ish field the SDK types don't always declare; we
    // pass through as any since the wire format is what matters.
    let systemForApi: any = system;
    let toolsForApi: any = tools;
    let messagesForApi: any = messages;
    if (this.useCaching && system) {
      const prepped = withCacheBreakpoints(system, messages, tools);
      systemForApi = prepped.system;
      messagesForApi = prepped.messages;
      toolsForApi = prepped.tools;
    }

    try {
      const { withRetry } = await import('../../utils/retry.js');
      const stream = await withRetry(
        () => this.client!.messages.create({
          model: req.model,
          system: systemForApi as any,
          messages: messagesForApi,
          tools: toolsForApi,
          max_tokens: req.maxTokens ?? 8192,
          temperature: req.temperature ?? 0.3,
          stream: true,
        }, { signal: req.signal } as any),
        { signal: req.signal, label: 'anthropic.complete', maxAttempts: 4 },
      );

      let inputTokens = 0;
      let outputTokens = 0;
      const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();

      for await (const event of stream) {
        if (req.signal?.aborted) {
          yield { type: 'error', error: 'Cancelled' };
          return;
        }

        if (event.type === 'message_start') {
          inputTokens = event.message.usage.input_tokens;
          // Capture cache metrics — present when prompt caching is in use.
          // cache_creation: tokens written to cache this call (priced at 1.25x base input)
          // cache_read:     tokens served from cache this call (priced at 0.1x base input)
          const cacheCreation = (event.message.usage as any).cache_creation_input_tokens ?? 0;
          const cacheRead = (event.message.usage as any).cache_read_input_tokens ?? 0;
          if (this.useCaching && (cacheCreation > 0 || cacheRead > 0)) {
            // Log it so users can confirm caching is actually hitting in production.
            // (Cost adjustment is handled by the budget tracker via these fields.)
            logger.info('Anthropic prompt cache', {
              cacheCreation, cacheRead,
              fullInput: inputTokens,
              hitRate: inputTokens > 0 ? Math.round(100 * cacheRead / inputTokens) + '%' : 'n/a',
            });
          }
        } else if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            toolCallBuffers.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              args: '',
            });
            yield {
              type: 'tool_call_delta',
              toolCallIndex: event.index,
              toolCallId: event.content_block.id,
              toolName: event.content_block.name,
              toolArgsDelta: '',
            };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', delta: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            const buf = toolCallBuffers.get(event.index);
            if (buf) {
              buf.args += event.delta.partial_json;
              yield {
                type: 'tool_call_delta',
                toolCallIndex: event.index,
                toolArgsDelta: event.delta.partial_json,
              };
            }
          }
        } else if (event.type === 'message_delta') {
          outputTokens = event.usage.output_tokens;
        }
      }

      yield { type: 'usage', usage: { input: inputTokens, output: outputTokens } };
      yield { type: 'done' };
    } catch (e: any) {
      yield {
        type: 'error',
        error: `[${this.name}] stream failed (model=${req.model ?? '?'}): ${e?.message ?? String(e)}`,
      };
    }
  }
}
