/**
 * `vision_analyze` tool — describe / answer questions about an image.
 *
 * Use cases:
 *   - browser_screenshot saved a PNG; ask "did the button render correctly?"
 *   - user uploaded a mockup PNG; ask "what colors and layout does this use?"
 *   - debugging a chart that looks wrong; ask "what's the issue with this y-axis?"
 *
 * Backend selection (auto-priority based on what's configured):
 *
 *   1. Anthropic Claude with vision (claude-sonnet-4-x or haiku-4-x) if ANTHROPIC_API_KEY set
 *   2. OpenAI gpt-4o or gpt-4o-mini if OPENAI_API_KEY set
 *   3. Local LM Studio model that advertises vision (e.g. Qwen2.5-VL or Qwen3-VL)
 *      if reachable on configured baseUrl
 *   4. Error — vision needs a vision-capable model
 *
 * Reads the image from disk (path arg), base64-encodes, sends as multipart
 * to whichever backend is available. Returns the textual analysis.
 *
 * Notes:
 *   - For PNG screenshots from browser_screenshot, the path is what that tool returns.
 *   - We keep the request body bounded — images >5MB are rejected to protect cost.
 *   - The user's parent model NEVER sees the image bytes (kept out of QodeX context).
 *     Only the resulting text analysis is fed back.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';
import { getActiveConfig } from '../../config/loader.js';
import { looksVisionCapable } from '../../setup/model-detector.js';

/**
 * The Ollama vision model, resolved from (in priority order):
 *   1. QODEX_OLLAMA_VISION_MODEL / QODEX_LOCAL_VISION_MODEL env vars
 *   2. config `roles.vision` (when its provider is ollama) — the intuitive place users set it
 *   3. config `roles.subagent` (when its provider is ollama) — common misconfig where the
 *      vision model was put under the sub-agent role; honored so vision still works.
 * Returns undefined if nothing usable is configured.
 */
export function resolveOllamaVisionModel(): string | undefined {
  const env = process.env.QODEX_OLLAMA_VISION_MODEL ?? process.env.QODEX_LOCAL_VISION_MODEL;
  if (env) return env;
  const roles = (getActiveConfig() as any)?.roles;
  for (const key of ['vision', 'subagent']) {
    const r = roles?.[key];
    if (r?.model && (r.provider === undefined || r.provider === 'ollama')) return r.model as string;
  }
  return undefined;
}

/**
 * Resolve a vision model served by LM Studio (the OpenAI-compat `local` backend).
 * Order of preference:
 *   1. QODEX_LOCAL_VISION_MODEL — explicit override.
 *   2. config roles.vision when its provider is `openai` (LM Studio).
 *   3. The PRIMARY model (defaults.model) when its id looks vision-capable — this is
 *      the "if the model can already see, use it directly" path the user wanted, so
 *      a Gemma-4 primary handles screenshots itself instead of spinning up a separate
 *      vision sub-agent.
 * Returns undefined when no LM-Studio vision model can be determined (the chain then
 * falls back to the Ollama vision model, e.g. qwen2.5vl).
 *
 * NOTE: capability is heuristic. If the id looks vision-capable but the weights
 * actually loaded in LM Studio are text-only, callLocal's refusal guard catches the
 * fake "I can't see images" reply and the chain falls through to the next backend.
 */
export function resolveLocalVisionModel(): string | undefined {
  const env = process.env.QODEX_LOCAL_VISION_MODEL;
  if (env) return env;
  const cfg = getActiveConfig() as any;
  const r = cfg?.roles?.vision;
  if (r?.model && r.provider === 'openai') return r.model as string;
  const primary = cfg?.defaults?.model;
  if (typeof primary === 'string' && looksVisionCapable(primary)) return primary;
  return undefined;
}

/**
 * Resolve a vision model served by ANY configured OpenAI-compatible provider — the
 * "the user set up an API; if their model can see, just use it" path. When the primary
 * (or sub-agent) model is vision-capable and its provider is a custom gateway (Gemini's
 * OpenAI endpoint, OpenRouter, …) or a custom-baseURL openai, return its endpoint so the
 * vision tool calls THAT model instead of demanding a separate ANTHROPIC/OPENAI key.
 * Returns undefined when no configured provider serves a vision-capable model.
 */
export function resolveConfiguredVisionModel(): { model: string; baseUrl: string; apiKey: string } | undefined {
  const cfg = getActiveConfig() as any;
  if (!cfg) return undefined;
  const candidates: Array<{ provider?: string; model?: string }> = [
    { provider: cfg.defaults?.provider, model: cfg.defaults?.model },        // primary first
    { provider: cfg.roles?.subagent?.provider, model: cfg.roles?.subagent?.model }, // then sub-agent
  ];
  for (const { provider, model } of candidates) {
    if (!model || typeof model !== 'string' || !looksVisionCapable(model)) continue;
    const ep = resolveProviderEndpoint(cfg, provider);
    if (ep) return { model, baseUrl: ep.baseUrl, apiKey: ep.apiKey };
  }
  return undefined;
}

/** Map a provider NAME to its OpenAI-compatible {baseUrl, apiKey}, or undefined if it
 *  isn't an OpenAI-compatible HTTP provider with a key set. (anthropic/ollama/lm-studio
 *  are intentionally excluded — they're handled by their own dedicated backends.) */
function resolveProviderEndpoint(cfg: any, providerName?: string): { baseUrl: string; apiKey: string } | undefined {
  if (!providerName) return undefined;
  const norm = (u: string) => u.replace(/\/+$/, '');
  const custom = (cfg.providers?.custom ?? []).find((c: any) => c?.name === providerName);
  if (custom?.baseUrl && custom?.apiKeyEnv && /^https?:\/\//.test(custom.baseUrl)) {
    const key = process.env[custom.apiKeyEnv];
    if (key) return { baseUrl: norm(custom.baseUrl), apiKey: key };
  }
  if (providerName === 'openai') {
    const key = process.env[cfg.providers?.openai?.apiKeyEnv ?? 'OPENAI_API_KEY'];
    const baseUrl = cfg.providers?.openai?.baseUrl ?? 'https://api.openai.com/v1';
    if (key && /^https?:\/\//.test(baseUrl)) return { baseUrl: norm(baseUrl), apiKey: key };
  }
  return undefined;
}

const VisionAnalyzeArgs = z.object({
  image_path: z.string().min(1).describe('Path to a PNG/JPEG/WebP file on disk. Often the result of browser_screenshot.'),
  prompt: z.string().min(1).describe(
    'What you want to know about the image. Examples: "describe this UI", "is the submit button visible", "transcribe the error message", "what colors are used".'
  ),
  detail: z.enum(['low', 'auto', 'high']).optional().describe('OpenAI-style detail level. Default "auto".'),
  backend: z.enum(['configured', 'anthropic', 'openai', 'ollama', 'local', 'auto']).optional().describe('Which backend to use. Default "auto" picks the best available — preferring your own vision-capable model (primary/sub-agent) if configured.'),
});

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png'; // best guess
}

async function loadImage(imagePath: string): Promise<{ base64: string; mime: string; sizeBytes: number }> {
  const stat = await fs.stat(imagePath);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${stat.size} bytes > ${MAX_IMAGE_BYTES} cap). Resize or crop first.`);
  }
  const buf = await fs.readFile(imagePath);
  return { base64: buf.toString('base64'), mime: mimeFromPath(imagePath), sizeBytes: stat.size };
}

async function callAnthropic(base64: string, mime: string, prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const body = await res.json() as { content?: Array<{ type: string; text?: string }> };
  return (body.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
}

async function callOpenAI(base64: string, mime: string, prompt: string, detail: 'low' | 'auto' | 'high'): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${base64}`, detail },
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? '';
}

async function callOllama(base64: string, _mime: string, prompt: string): Promise<string> {
  // Native Ollama API — /api/chat with images array. This is the FIRST-CLASS path
  // for Ollama (vs the OpenAI-compat shim which has known quirks around image
  // routing in some Ollama versions).
  //
  // The `model` for this backend MUST be a vision-capable Ollama model. We use
  // QODEX_OLLAMA_VISION_MODEL (preferred) or fall back to QODEX_LOCAL_VISION_MODEL.
  // Examples that work: 'qwen2.5vl:7b', 'qwen2.5vl:32b', 'qwen2.5vl:72b',
  //                     'llama3.2-vision:11b', 'llama3.2-vision:90b', 'minicpm-v',
  //                     'qwen3-vl:4b-instruct'
  const model = resolveOllamaVisionModel();
  if (!model) {
    throw new Error(
      'Ollama vision backend not configured. Set QODEX_OLLAMA_VISION_MODEL (preferred), ' +
      'or add roles.vision: { provider: ollama, model: <id> } to ~/.qodex/config.yaml. ' +
      'Examples: qwen2.5vl:32b, llama3.2-vision:11b. The model must already be pulled (ollama pull <id>).',
    );
  }
  const baseUrl = process.env.QODEX_OLLAMA_URL ?? 'http://localhost:11434';
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: prompt,
          // Ollama-native: base64 images array on the message (NOT inside content).
          // The text instruction goes in `content`, images alongside.
          images: [base64],
        },
      ],
      // Vision models default to fairly low temperature for reliability.
      options: {
        temperature: 0.2,
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${errText.slice(0, 300)}. Is "${model}" pulled? Run: ollama pull ${model}`);
  }
  const body = await res.json() as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(`Ollama error: ${body.error}`);
  const content = body.message?.content ?? '';
  // Same refusal-pattern guard as the LM Studio path — if the model didn't
  // actually have vision weights (rare on Ollama since model names enforce it,
  // but possible if user typo'd to a text-only model), bail.
  if (looksLikeTextOnlyRefusal(content)) {
    throw new Error(
      `Ollama model "${model}" responded as if it can't see images. ` +
      `Verify the model has vision capability — try: ollama show ${model}`,
    );
  }
  return content;
}

async function callLocal(base64: string, mime: string, prompt: string): Promise<string> {
  // CRITICAL: only call this if the user has EXPLICITLY configured a vision model.
  // Otherwise the request hits whatever text model is currently loaded in LM Studio
  // (e.g. Qwen3-Coder, which is text-only), and the model returns a confused
  // "I can't see images" response that LOOKS like a real analysis to the parent agent.
  //
  // We therefore require QODEX_LOCAL_VISION_MODEL to be set. The default LM Studio
  // port is fine, but the model id MUST be explicit — there's no way for us to
  // tell from the response alone whether the loaded model supports vision.
  const explicitModel = resolveLocalVisionModel();
  if (!explicitModel) {
    throw new Error(
      'Local vision backend not configured. Set QODEX_LOCAL_VISION_MODEL to the id ' +
      'of a vision-capable model loaded in LM Studio (e.g. "qwen2.5-vl-7b" or "qwen3-vl-32b"), ' +
      'point roles.vision at an openai-provider model, or run a vision-capable primary model. ' +
      'Without this, requests would hit your text model and return fake analysis.',
    );
  }
  const baseUrl = process.env.QODEX_LOCAL_VISION_URL ?? 'http://127.0.0.1:1234/v1';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: explicitModel,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Local vision backend HTTP ${res.status}: ${errText.slice(0, 300)}. Ensure a vision-capable model is loaded in LM Studio.`);
  }
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content ?? '';

  // Heuristic: if the response sounds like a text-only model apologizing about not
  // being able to see images, treat it as a backend failure so the chain falls through.
  // This catches the case where the user set QODEX_LOCAL_VISION_MODEL but actually
  // a non-vision model is loaded under that id (LM Studio doesn't enforce capabilities).
  if (looksLikeTextOnlyRefusal(content)) {
    throw new Error(
      `Local model '${explicitModel}' responded as if it can't see images. ` +
      `Verify a real vision model is loaded in LM Studio (Qwen2.5-VL, Qwen3-VL, etc) — ` +
      `the model id alone isn't enough; the loaded weights must support vision.`,
    );
  }
  return content;
}

/**
 * Pattern-match common phrases text-only models use when they get an image they
 * can't process. We're deliberately strict — only flag clear refusals, not
 * legitimate analyses that happen to mention these words.
 */
/** Send an OpenAI-compatible vision request to the user's configured provider (Gemini's
 *  OpenAI endpoint, OpenRouter, a custom-baseURL openai, …) whose primary/sub-agent model
 *  can see. This is the "you already configured a vision-capable model — use it" backend. */
async function callConfigured(base64: string, mime: string, prompt: string): Promise<string> {
  const v = resolveConfiguredVisionModel();
  if (!v) throw new Error('No configured vision-capable model (primary/sub-agent is text-only or its provider has no key).');
  const res = await fetch(`${v.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${v.apiKey}`, 'User-Agent': 'qodex-cli' },
    body: JSON.stringify({
      model: v.model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
      ] }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Configured vision backend HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content ?? '';
  if (looksLikeTextOnlyRefusal(content)) {
    throw new Error(`Configured model '${v.model}' responded as if it can't see images — its weights may be text-only despite the id.`);
  }
  return content;
}

function looksLikeTextOnlyRefusal(text: string): boolean {
  const lower = text.toLowerCase();
  const refusalPatterns = [
    "i don't have access to",
    "i cannot see",
    "i can't see",
    "i'm unable to see",
    "i am unable to see",
    "i cannot view",
    "i can't view",
    "please share",
    "please provide the",
    'as a text-based',
    'as a language model, i',
  ];
  // Need at least one strong pattern AND no clear sign the model actually described an image
  const hasRefusal = refusalPatterns.some(p => lower.includes(p));
  if (!hasRefusal) return false;
  // Quick check for image-description vocabulary — if present, the model probably did see it
  const visualVocab = ['pixel', 'color palette', 'top of the image', 'bottom of the image', 'foreground', 'background of the image'];
  const hasVisualVocab = visualVocab.some(v => lower.includes(v));
  return !hasVisualVocab;
}

export class VisionAnalyzeTool extends Tool<z.infer<typeof VisionAnalyzeArgs>> {
  name = 'vision_analyze';
  description = 'Analyze an image file with a vision-capable model. Returns a text description / answer to your prompt. Use after browser_screenshot to verify UI rendering, or to read mockups/diagrams uploaded by the user. Configure ONE backend: QODEX_OLLAMA_VISION_MODEL (e.g. qwen2.5vl:32b — recommended for local), ANTHROPIC_API_KEY (Claude Haiku), OPENAI_API_KEY (gpt-4o-mini), or QODEX_LOCAL_VISION_MODEL (LM Studio vision model). Returns [VISION_NOT_CONFIGURED] with setup instructions if none set — in that case fall back to browser_get_text for textual content.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = VisionAnalyzeArgs;

  async execute(args: z.infer<typeof VisionAnalyzeArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const { base64, mime, sizeBytes } = await loadImage(args.image_path);
      const requested = args.backend ?? 'auto';
      const detail = args.detail ?? 'auto';

      // Build the candidate chain. In 'auto' mode we ONLY include backends with
      // visible credentials/config — never silently fall through to a text-only
      // local model.
      let order: Array<'configured' | 'anthropic' | 'openai' | 'ollama' | 'local'>;
      if (requested === 'configured') order = ['configured'];
      else if (requested === 'anthropic') order = ['anthropic'];
      else if (requested === 'openai') order = ['openai'];
      else if (requested === 'ollama') order = ['ollama'];
      else if (requested === 'local') order = ['local'];
      else {
        // auto: chain everything that's actually configured.
        // Priority: if the user's OWN model (primary or sub-agent) can already see —
        // including a configured API like Gemini/OpenRouter — use it FIRST; no separate
        // vision model needed. Then LM Studio/Ollama vision, then dedicated cloud keys.
        order = [];
        const configuredVision = resolveConfiguredVisionModel();
        const localVision = resolveLocalVisionModel();
        const ollamaVision = resolveOllamaVisionModel();
        if (configuredVision) order.push('configured');
        // Only lead with `local` when it's the vision-capable PRIMARY (or an explicit
        // LM Studio vision model) — not when local would just hit a loaded text model.
        if (localVision) order.push('local');
        if (ollamaVision) order.push('ollama');
        if (process.env.ANTHROPIC_API_KEY) order.push('anthropic');
        if (process.env.OPENAI_API_KEY) order.push('openai');
        if (order.length === 0) {
          return {
            content:
              `[VISION_NOT_CONFIGURED] No vision backend available.\n\n` +
              `Pick ONE of these setups:\n\n` +
              `  Local (Ollama, recommended — works fully offline):\n` +
              `    ollama pull qwen2.5vl:32b\n` +
              `    export QODEX_OLLAMA_VISION_MODEL="qwen2.5vl:32b"\n` +
              `    (or add to ~/.qodex/config.yaml → roles.vision: { provider: ollama, model: qwen2.5vl:32b })\n\n` +
              `  Cloud (Anthropic Claude):\n` +
              `    export ANTHROPIC_API_KEY="sk-ant-..."\n\n` +
              `  Cloud (OpenAI gpt-4o-mini):\n` +
              `    export OPENAI_API_KEY="sk-..."\n\n` +
              `  Local (LM Studio, if you already have a vision model loaded):\n` +
              `    export QODEX_LOCAL_VISION_MODEL="qwen2.5-vl-7b"\n\n` +
              `Without one of these, use browser_get_text instead — it reads the visible\n` +
              `page text and is usually enough for "what does this site say" questions.`,
            isError: true,
          };
        }
      }

      const failures: string[] = [];
      for (const backend of order) {
        try {
          let result: string;
          if (backend === 'configured') result = await callConfigured(base64, mime, args.prompt);
          else if (backend === 'anthropic') result = await callAnthropic(base64, mime, args.prompt);
          else if (backend === 'openai') result = await callOpenAI(base64, mime, args.prompt, detail);
          else if (backend === 'ollama') result = await callOllama(base64, mime, args.prompt);
          else result = await callLocal(base64, mime, args.prompt);
          return {
            content: `[via ${backend}, ${(sizeBytes / 1024).toFixed(1)}KB]\n\n${result}`,
            metadata: { backend, imageSize: sizeBytes },
          };
        } catch (e: any) {
          failures.push(`${backend}: ${e?.message ?? String(e)}`);
          logger.debug(`vision backend ${backend} failed, trying next`, { err: e?.message });
        }
      }
      return {
        content: `[VISION_ERROR] All ${order.length} backend(s) failed:\n${failures.map(f => '  - ' + f).join('\n')}`,
        isError: true,
      };
    } catch (e: any) {
      return { content: `[VISION_ERROR] ${e?.message ?? String(e)}`, isError: true };
    }
  }
}
