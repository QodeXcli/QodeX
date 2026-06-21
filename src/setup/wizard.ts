/**
 * `qx setup` — interactive configuration wizard.
 *
 * Runs through six sections, each with safe defaults. In non-interactive mode
 * (`--defaults` or CI/headless detection) it applies the defaults silently.
 *
 * The wizard:
 *   1. Detects hardware → tells the user what we found
 *   2. Picks the primary model (recommended from hardware tier; user can pick anything)
 *   3. Sub-agent mode (off / sequential / parallel)
 *   4. Anthropic prompt caching (Y/n)
 *   5. Auto-snapshot for destructive commands (Y/n)
 *   6. Summary + write to ~/.qodex/config.yaml
 *
 * Side effects: ONLY writes to ~/.qodex/config.yaml. Never edits files outside ~/.qodex.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { detectHardware, formatHardwareSummary, type HardwareProfile } from './hardware-profile.js';
import { confirm, choose, section, paragraph, isInteractiveTTY, type PromptOptions } from './prompt.js';
import { QODEX_CONFIG_FILE, QODEX_HOME, DEFAULT_CONFIG, type QodexConfig } from '../config/defaults.js';
import { loadConfig } from '../config/loader.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { withLock } from '../utils/file-lock.js';
import { validateCustomProviders } from '../llm/providers/custom-config.js';
import { CustomOpenAIProvider } from '../llm/providers/custom.js';
import type { ModelInfo } from '../llm/types.js';
import {
  detectAllLocalModels,
  recommendPrimary,
  recommendSubagent,
  formatModel,
  looksVisionCapable,
  type DetectedModel,
} from './model-detector.js';

export interface SetupOptions {
  /** Use sensible defaults without prompting (for scripts / CI). */
  defaults?: boolean;
  /** Just print the detected hardware + would-be defaults, write nothing. */
  check?: boolean;
}

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  const interactive = !opts.defaults && !opts.check && isInteractiveTTY();
  const promptOpts: PromptOptions = { interactive };

  console.log('');
  console.log('QodeX setup — tune QodeX to your hardware and preferences.');
  if (interactive) {
    console.log(`This will save to ${QODEX_CONFIG_FILE}. You can re-run anytime with \`qx setup\`.`);
  } else if (opts.check) {
    console.log('(--check mode: showing detected values, NOT writing config)');
  } else {
    console.log('(--defaults / non-interactive mode: applying sensible defaults)');
  }

  // ── 1. Hardware ─────────────────────────────────────────────────────────────
  section('[1/7] Detecting hardware');
  const hw = detectHardware();
  console.log(formatHardwareSummary(hw));

  // ── 2. Primary model ────────────────────────────────────────────────────────
  section('[2/7] Primary model');
  paragraph(
    'The model that does the actual work. We just scanned your machine for what\'s\n' +
    'actually installed — those show up first. Cloud models need an API key.',
  );

  // Probe local backends (Ollama daemon + LM Studio server) for what's available
  // RIGHT NOW. Detection is bounded (~1.5s per source) and silent on failure.
  const detected = await detectAllLocalModels();
  if (detected.length > 0) {
    // Group by source so the user can see backend distribution at a glance.
    const byOllama = detected.filter(m => m.source === 'ollama');
    const byLmStudio = detected.filter(m => m.source === 'lm-studio');
    console.log(`  Detected ${detected.length} local model${detected.length === 1 ? '' : 's'} across ${
      (byOllama.length > 0 ? 1 : 0) + (byLmStudio.length > 0 ? 1 : 0)
    } backend${byOllama.length > 0 && byLmStudio.length > 0 ? 's' : ''}:`);
    if (byLmStudio.length > 0) {
      console.log('');
      console.log('  LM Studio (MLX-optimized for Apple Silicon, faster on M-series):');
      for (const m of byLmStudio) {
        const f = formatModel(m);
        console.log(`    • ${f.label}   ${f.hint}`);
      }
    }
    if (byOllama.length > 0) {
      console.log('');
      console.log('  Ollama (GGUF, broad compatibility, easier model management):');
      for (const m of byOllama) {
        const f = formatModel(m);
        console.log(`    • ${f.label}   ${f.hint}`);
      }
    }
    if (byOllama.length > 0 && byLmStudio.length > 0) {
      console.log('');
      console.log('  Two backends detected — real parallel sub-agents possible (one on each).');
    }
    console.log('');
  } else {
    console.log('  No local models detected.');
    console.log('  Checked: http://localhost:11434 (Ollama), http://127.0.0.1:1234 (LM Studio).');
    console.log('  If you expected models here:');
    console.log('    • Ollama: run `ollama serve` and `ollama list`');
    console.log('    • LM Studio: open the app and start the server (Status: Running)');
    console.log('  You can still pick a cloud model below.');
    console.log('');
  }

  // Models from any configured custom API (provider add) whose key is set — fetched
  // live from its /models endpoint so the wizard can offer them for primary/sub-agent.
  const apiModels = await detectConfiguredApiModels();
  if (apiModels.length > 0) {
    const byProvider = new Map<string, number>();
    for (const m of apiModels) byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
    console.log(`  From your configured API${byProvider.size === 1 ? '' : 's'}: ${
      [...byProvider].map(([p, n]) => `${p} (${n} model${n === 1 ? '' : 's'})`).join(', ')}`);
    console.log('');
  }

  const modelChoices = buildModelChoices(hw, detected, apiModels);
  // Default: a configured-API model first (the user just set it up), else the detector's
  // top local recommendation, else the first choice.
  const recommended = recommendPrimary(detected);
  const defaultPick = apiModels[0]
    ? `${apiModels[0].provider}/${apiModels[0].id}`
    : (recommended?.id ?? modelChoices[0]!.value);
  let primaryModel = await choose<string>(
    'Pick the model QodeX should use by default:',
    modelChoices,
    defaultPick,
    promptOpts,
  );

  // Derive provider from the chosen model id.
  // A configured-API pick arrives as "<provider>/<id>" — split it so defaults.provider
  // points at that gateway and defaults.model is the bare id. Otherwise: trust a detected
  // model's source attribution, else fall back to id-pattern heuristics.
  const apiPick = apiModels.find(m => `${m.provider}/${m.id}` === primaryModel);
  if (apiPick) primaryModel = apiPick.id;
  const detectedPick = detected.find(m => m.id === primaryModel);
  const provider: string =
    apiPick ? apiPick.provider
    : detectedPick ? detectedPick.provider
    : primaryModel.startsWith('claude-') ? 'anthropic'
    : primaryModel.startsWith('gpt-') || primaryModel.startsWith('o') ? 'openai'
    : primaryModel.startsWith('deepseek-') ? 'deepseek'
    : 'ollama';

  // ── 3. Sub-agents ───────────────────────────────────────────────────────────
  section('[3/7] Sub-agent dispatcher');
  paragraph(
    'Sub-agents let you delegate batch tasks ("refactor all test files") to isolated\n' +
    'workers, each with its own clean context. Parent only sees the summary.\n' +
    '\n' +
    '  • Same model as parent — simplest, no extra setup\n' +
    '  • Lighter local — use a smaller local model for sub-tasks (efficient)\n' +
    '  • Cloud model    — delegate to Anthropic/OpenAI/DeepSeek when parent stays local\n' +
    '  • Off            — `task` tool unavailable',
  );
  type SubagentChoice = 'same' | 'lighter-local' | 'cloud' | 'off';
  const subagentChoice = await choose<SubagentChoice>(
    'How should sub-agents work?',
    [
      { value: 'same', label: 'Same model as parent (simplest)' },
      { value: 'lighter-local', label: 'Sequential with a lighter local model (efficient)' },
      { value: 'cloud', label: 'Sequential with a cloud model (premium for hard tasks)' },
      { value: 'off', label: 'Off — never spawn sub-agents' },
    ],
    'same',
    promptOpts,
  );

  // Translate choice into (mode, role).
  // - 'same'          : mode=sequential, no role (sub-agents inherit parent model)
  // - 'lighter-local' : mode=sequential, role=ollama/<picked>
  // - 'cloud'         : mode=parallel (with auto policy: cloud sub + local parent = real parallel),
  //                     role=<cloud>/<picked>
  // - 'off'           : mode=off
  let subagentMode: 'off' | 'sequential' | 'parallel' = 'sequential';
  let subagentRole: { provider: string; model: string } | undefined;

  if (subagentChoice === 'off') {
    subagentMode = 'off';
  } else if (subagentChoice === 'same') {
    subagentMode = 'sequential';
    // No role binding — runSubagent falls back to parent default
  } else if (subagentChoice === 'lighter-local') {
    // If the parent is LM Studio (openai provider), an Ollama sub-agent means real
    // parallel: two different runtimes, two different ports, no GPU serialization
    // problem. Bump mode to parallel automatically when the math works out.
    const parentIsLMStudio = provider === 'openai' && detectedPick?.source === 'lm-studio';
    subagentMode = parentIsLMStudio ? 'parallel' : 'sequential';
    section('[3b/7] Light local model for sub-agents');
    paragraph(
      'Pick a local model. Sub-agents use this; parent stays on your primary choice.\n' +
      (parentIsLMStudio
        ? 'Parent runs on LM Studio, sub-agent on Ollama → real parallel execution.\n'
        : 'Both run via Ollama — same GPU serializes them, but context isolation\n' +
          'still helps on big tasks.\n'),
    );
    const lighter = buildLightLocalChoices(hw, primaryModel, detected);
    const recommendedSub = detectedPick
      ? recommendSubagent(detected, detectedPick)
      : undefined;
    const defaultSub = recommendedSub?.id ?? lighter[0]!.value;
    const lightModel = await choose<string>(
      'Sub-agent model:',
      lighter,
      defaultSub,
      promptOpts,
    );
    // Determine the right provider for this sub-agent (it might be from LM Studio if
    // the user has multiple LM Studio models loaded, though typically it'll be Ollama).
    const subDetected = detected.find(m => m.id === lightModel);
    subagentRole = {
      provider: subDetected?.provider ?? 'ollama',
      model: lightModel,
    };
  } else if (subagentChoice === 'cloud') {
    // Cloud sub-agent enables real parallel when parent is local.
    // "Local" includes both Ollama AND LM Studio (which uses the openai provider
    // with a custom baseUrl). detectedPick.source tells us whether the parent
    // is actually running locally, regardless of the provider label.
    const parentIsLocal = provider === 'ollama' ||
      (provider === 'openai' && detectedPick?.source === 'lm-studio');
    subagentMode = parentIsLocal ? 'parallel' : 'sequential';
    section('[3b/7] Cloud model for sub-agents');
    paragraph(
      'Pick a cloud model for sub-agents. Requires the matching API key in your env.\n' +
      'If your parent is local, this enables real parallel execution (auto policy).',
    );
    const cloudChoices: Array<{ value: string; label: string; hint?: string }> = [
      // Your configured-API models first (you just set them up), then the built-in cloud options.
      ...apiModels.map(m => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}`, hint: `API · ${m.provider}` })),
      { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5', hint: 'cheap, fast — good for batch sub-tasks' },
      { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', hint: 'premium quality, higher cost' },
      { value: 'gpt-4o-mini', label: 'gpt-4o-mini', hint: 'cheap OpenAI option' },
      { value: 'gpt-4o', label: 'gpt-4o', hint: 'premium OpenAI' },
      { value: 'deepseek-chat', label: 'deepseek-chat', hint: 'low cost, decent quality' },
    ];
    const cloudModel = await choose<string>(
      'Sub-agent model:',
      cloudChoices,
      cloudChoices[0]!.value,
      promptOpts,
    );
    const apiSub = apiModels.find(m => `${m.provider}/${m.id}` === cloudModel);
    const cloudProvider: string =
      apiSub ? apiSub.provider
      : cloudModel.startsWith('claude-') ? 'anthropic'
      : cloudModel.startsWith('gpt-') ? 'openai'
      : 'deepseek';
    subagentRole = { provider: cloudProvider, model: apiSub ? apiSub.id : cloudModel };
  }

  // ── 3c. Optional dedicated vision sub-agent ─────────────────────────────────
  // A second sub-agent role. `task({role:"vision"})` routes screenshot / UI /
  // mockup analysis here, on a vision-capable model, independent of the general
  // sub-agent above. We suggest any detected vision model (id markers: vl/vision/
  // llava/moondream/minicpm-v/bakllava); the user can also pick a cloud one.
  let visionRole: { provider: string; model: string } | undefined;
  // If the primary OR the sub-agent model can already see images, a dedicated vision
  // model is redundant — don't ask. The vision tool uses that model directly at runtime.
  const parentSees = looksVisionCapable(primaryModel) || (subagentRole ? looksVisionCapable(subagentRole.model) : false);
  if (parentSees) {
    section('[3c/7] Vision');
    const who = looksVisionCapable(primaryModel)
      ? `Primary model (${primaryModel})`
      : `Sub-agent model (${subagentRole!.model})`;
    paragraph(
      `${who} already supports images — no separate vision model needed.\n` +
      'QodeX will route screenshot / UI / mockup analysis to it automatically.',
    );
  } else if (subagentChoice !== 'off') {
    const visionModels = detected.filter(m =>
      /(?:vl\b|vl[:_-]|vision|llava|moondream|minicpm-v|bakllava)/i.test(m.id));
    section('[3c/7] Vision sub-agent (optional)');
    paragraph(
      'A dedicated worker for screenshot / UI / mockup analysis. QodeX routes\n' +
      '`task(role:"vision")` here automatically (e.g. "check this screenshot\'s layout").\n' +
      (visionModels.length > 0
        ? 'Detected a vision-capable local model — recommended.\n'
        : 'No local vision model detected; you can use a cloud one (needs its API key).\n'),
    );
    const wantVision = await confirm('Set up a dedicated vision sub-agent?', visionModels.length > 0, promptOpts);
    if (wantVision) {
      const visionChoices: Array<{ value: string; label: string; hint?: string }> = [
        ...visionModels.map(m => ({ value: m.id, label: m.label, hint: `${m.source} · vision` })),
        { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5', hint: 'cloud vision · needs ANTHROPIC_API_KEY' },
        { value: 'gpt-4o-mini', label: 'gpt-4o-mini', hint: 'cloud vision · needs OPENAI_API_KEY' },
      ];
      const visionPick = await choose<string>(
        'Vision model:',
        visionChoices,
        visionModels[0]?.id ?? 'claude-haiku-4-5',
        promptOpts,
      );
      const vd = detected.find(m => m.id === visionPick);
      const visionProvider: 'ollama' | 'anthropic' | 'openai' | 'deepseek' =
        vd?.provider ?? (visionPick.startsWith('claude-') ? 'anthropic'
          : visionPick.startsWith('gpt-') ? 'openai' : 'ollama');
      visionRole = { provider: visionProvider, model: visionPick };
    }
  }

  // ── 4. Anthropic prompt caching ─────────────────────────────────────────────
  section('[4/7] Anthropic prompt caching');
  paragraph(
    'When using the Anthropic API, QodeX can mark system + tools as cacheable. First\n' +
    'call: full price. Subsequent calls within 5 min: ~90% discount on the cached\n' +
    'portion. Free to enable; only takes effect when you\'re using Claude models.',
  );
  const anthropicCaching = await confirm(
    'Enable prompt caching for Anthropic?',
    true,
    promptOpts,
  );

  // ── 5. Auto-snapshot ────────────────────────────────────────────────────────
  section('[5/7] Auto-snapshot before destructive commands');
  paragraph(
    'Before any `rm -rf`, `git reset --hard`, or similar destructive command, QodeX can\n' +
    'quietly run `git stash` so `/undo` can roll back if needed. Silently skipped in\n' +
    'non-git directories. Snapshots auto-drop after 50 turns or session end.\n' +
    '\n' +
    'You can also manually snapshot at any time with `/snapshot` during a session.',
  );
  const autoSnapshot = await confirm(
    'Enable auto-snapshot?',
    true,
    promptOpts,
  );

  // ── 6. Summary + write ──────────────────────────────────────────────────────
  section('[6/7] Summary');
  const subRoleDisplay = subagentRole
    ? `${subagentRole.provider}/${subagentRole.model}`
    : '(same as parent)';
  const summary = [
    `  Primary model:     ${primaryModel} (${provider})`,
    `  Sub-agent mode:    ${subagentMode}`,
    `  Sub-agent model:   ${subRoleDisplay}`,
    ...(visionRole ? [`  Vision sub-agent:  ${visionRole.provider}/${visionRole.model}`] : []),
    `  Anthropic caching: ${anthropicCaching ? 'enabled' : 'disabled'}`,
    `  Auto-snapshot:     ${autoSnapshot ? 'enabled' : 'disabled'}`,
    `  Hardware tier:     ${hw.tier} (${hw.ramGb} GB RAM${hw.appleSilicon ? ', Apple Silicon' : ''})`,
  ].join('\n');
  console.log(summary);

  if (opts.check) {
    console.log('');
    console.log('(--check mode: nothing was written)');
    return;
  }

  // ── 7. Confirm & write ──────────────────────────────────────────────────────
  section('[7/7] Save configuration');
  const proceed = await confirm(
    `Save to ${QODEX_CONFIG_FILE}?`,
    true,
    promptOpts,
  );
  if (!proceed) {
    console.log('Aborted; no changes written.');
    return;
  }

  await writeConfig({
    primaryModel,
    provider,
    primaryDetected: detectedPick,
    subagentMode,
    subagentRole,
    subagentDetected: subagentRole ? detected.find(m => m.id === subagentRole!.model) : undefined,
    visionRole,
    visionDetected: visionRole ? detected.find(m => m.id === visionRole!.model) : undefined,
    anthropicCaching,
    autoSnapshot,
    hardware: hw,
  });

  console.log('');
  console.log(`✓ Saved to ${QODEX_CONFIG_FILE}`);
  console.log('  Run `qx` to start. You can toggle features any time:');
  console.log('    /snapshot off          → disable auto-snapshot for this session');
  console.log('    /subagents off         → disable sub-agents for this session');
  console.log('    qx setup               → re-run wizard');
}

/**
 * Build the model choice list.
 *
 * Order:
 *   1. Detected models (sorted by tool-call capability, then size desc) — these
 *      are guaranteed to work because the daemon told us they're installed.
 *   2. Hardware-tier recommendations not already detected — aspirational but
 *      require a `ollama pull` first.
 *   3. Cloud options.
 */
/** A model offered by a CONFIGURED custom API provider (providers.custom[] with its key set). */
export interface ApiCatalogModel { provider: string; id: string; contextWindow?: number }

/**
 * Fetch the model catalog of every configured custom provider whose API key is set,
 * by reusing the SAME `GET {baseUrl}/models` discovery the runtime uses. This is what
 * lets the wizard offer "the models of the API you set up" for primary / sub-agent —
 * previously it only saw locally-detected models. Best-effort and bounded: a provider
 * with no key, no network, or no /models support simply contributes nothing.
 */
export async function detectConfiguredApiModels(timeoutMs = 6000): Promise<ApiCatalogModel[]> {
  // The `setup` command runs the wizard WITHOUT the main bootstrap, so ~/.qodex/.env
  // hasn't been loaded into process.env yet — without this, every configured provider
  // looks key-less and we'd discover nothing. Existing env values still win (no clobber).
  try {
    const { loadEnvFileIntoProcess } = await import('./env-writer.js');
    await loadEnvFileIntoProcess();
  } catch { /* best-effort */ }

  let cfg: any;
  try { cfg = await loadConfig(process.cwd()); } catch { return []; }
  const customRaw = (cfg?.providers as any)?.custom;
  if (!Array.isArray(customRaw) || customRaw.length === 0) return [];
  const { providers: defs } = validateCustomProviders(customRaw);
  const active = defs.filter(d => !!process.env[d.apiKeyEnv]);
  if (active.length === 0) return [];

  const out: ApiCatalogModel[] = [];
  await Promise.allSettled(active.map(async def => {
    const provider = new CustomOpenAIProvider(def, process.env[def.apiKeyEnv]);
    const models = await Promise.race<ModelInfo[]>([
      provider.listModels(),
      new Promise<ModelInfo[]>(resolve => setTimeout(() => resolve([]), timeoutMs)),
    ]);
    for (const m of models) out.push({ provider: def.name, id: m.id, contextWindow: m.contextWindow });
  }));
  return out;
}

export function buildModelChoices(
  hw: HardwareProfile,
  detected: DetectedModel[],
  apiModels: ApiCatalogModel[] = [],
): Array<{ value: string; label: string; hint?: string }> {
  const choices: Array<{ value: string; label: string; hint?: string }> = [];
  const seen = new Set<string>();

  // 1. Detected — these are guaranteed working
  for (const m of detected) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const f = formatModel(m);
    choices.push({ value: m.id, label: f.label, hint: `installed · ${f.hint}` });
  }

  // 1b. Models from configured custom APIs (provider/id form so routing is unambiguous).
  for (const m of apiModels) {
    const value = `${m.provider}/${m.id}`;
    if (seen.has(value)) continue;
    seen.add(value);
    const ctx = m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : '';
    choices.push({ value, label: value, hint: `API · ${m.provider}${ctx}` });
  }

  // 2. Hardware-tier recommendations — not yet installed, will need a pull
  for (const m of hw.recommendedModels) {
    if (seen.has(m)) continue;
    seen.add(m);
    const fitNote = isModelComfortableForHardware(m, hw) ? '✓ comfortable' : 'tight — may swap';
    choices.push({
      value: m,
      label: `${m}`,
      hint: `requires \`ollama pull\` · ${fitNote}`,
    });
  }

  // 3. Cloud options — always listed last
  choices.push({ value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', hint: 'cloud, needs ANTHROPIC_API_KEY' });
  choices.push({ value: 'gpt-4o-mini', label: 'gpt-4o-mini', hint: 'cloud, needs OPENAI_API_KEY' });
  choices.push({ value: 'deepseek-coder', label: 'deepseek-coder', hint: 'cloud, needs DEEPSEEK_API_KEY' });
  return choices;
}

/** Whether a given model id is comfortable on this hardware. Heuristic. */
function isModelComfortableForHardware(modelId: string, hw: HardwareProfile): boolean {
  // Parse size from common patterns: qwen2.5-coder:32b, mixtral:8x22b, deepseek-v3 (~671B)
  const colonMatch = modelId.match(/:(\d+(?:\.\d+)?)b/i);
  const xMatch = modelId.match(/(\d+)x(\d+)b/i);
  let approxB = 0;
  if (colonMatch) approxB = parseFloat(colonMatch[1]!);
  else if (xMatch) approxB = parseInt(xMatch[1]!, 10) * parseInt(xMatch[2]!, 10) * 0.3; // MoE active params heuristic
  else if (/v3$/i.test(modelId)) approxB = 50; // DeepSeek-V3 MoE: ~37B active
  else if (/72b/.test(modelId)) approxB = 72;
  // Rough GB needed at q4 quantization
  const gbNeeded = approxB * 0.6;
  const available = hw.gpu.vramGb ?? hw.ramGb;
  return gbNeeded < available * 0.7;
}

/**
 * Build the sub-agent model choices when the user picks "lighter local".
 *
 * Logic: offer models SMALLER than what they picked for the parent. If the parent is
 * already small (7B), we still offer the same so they can change their mind.
 * The hardware tier limits us: even on a Mac Studio, no point listing models bigger
 * than the parent — that wouldn't be "lighter".
 */
function buildLightLocalChoices(
  hw: HardwareProfile,
  parentModel: string,
  detected: DetectedModel[] = [],
): Array<{ value: string; label: string; hint?: string }> {
  const parentSize = approxModelSizeB(parentModel);
  const choices: Array<{ value: string; label: string; hint?: string }> = [];
  const seen = new Set<string>();

  // First: any detected models that aren't the parent.
  // Order them by toolCallsLikely then size (closer to parent*0.7 is ideal).
  const detectedCandidates = detected
    .filter(m => m.id !== parentModel)
    .sort((a, b) => {
      const aTC = a.toolCallsLikely ? 1 : 0;
      const bTC = b.toolCallsLikely ? 1 : 0;
      if (aTC !== bTC) return bTC - aTC;
      return (b.paramsB ?? 0) - (a.paramsB ?? 0);
    });
  for (const m of detectedCandidates) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const f = formatModel(m);
    choices.push({ value: m.id, label: f.label, hint: `installed · ${f.hint}` });
  }

  // Then: hardcoded lighter candidates the user might want to pull.
  const fallbackCandidates = [
    { id: 'qwen3-coder', sizeB: 30, label: 'qwen3-coder', hint: '✓ tool-calls native, balanced' },
    { id: 'qwen2.5-coder:7b', sizeB: 7, label: 'qwen2.5-coder:7b', hint: 'best for tool use, fast' },
    { id: 'qwen2.5-coder:3b', sizeB: 3, label: 'qwen2.5-coder:3b', hint: 'fastest, lower quality' },
    { id: 'qwen2.5-coder:14b', sizeB: 14, label: 'qwen2.5-coder:14b', hint: 'balanced' },
    { id: 'deepseek-coder-v2:lite', sizeB: 16, label: 'deepseek-coder-v2:lite', hint: 'alternative perspective' },
    { id: 'llama3.2:3b', sizeB: 3, label: 'llama3.2:3b', hint: 'lean generalist' },
  ];
  const filtered = fallbackCandidates.filter(c => {
    if (seen.has(c.id)) return false;
    if (c.id === parentModel) return false;
    if (parentSize === 0) return true;
    return c.sizeB <= parentSize;
  });
  filtered.sort((a, b) => a.sizeB - b.sizeB);
  // Hardware filter
  const usable = filtered.filter(c => {
    const gb = c.sizeB * 0.6;
    const avail = hw.gpu.vramGb ?? hw.ramGb;
    return gb < avail * 0.6;
  });
  const chosenFallback = usable.length > 0 ? usable : filtered;
  for (const c of chosenFallback) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    choices.push({ value: c.id, label: c.label, hint: `requires \`ollama pull\` · ${c.hint}` });
  }
  return choices;
}

function approxModelSizeB(modelId: string): number {
  const colon = modelId.match(/:(\d+(?:\.\d+)?)b/i);
  if (colon) return parseFloat(colon[1]!);
  const x = modelId.match(/(\d+)x(\d+)b/i);
  if (x) return parseInt(x[1]!, 10) * parseInt(x[2]!, 10) * 0.3;
  if (/72b/.test(modelId)) return 72;
  if (/v3$/i.test(modelId)) return 50;
  return 0; // unknown
}

/** Write the assembled config to disk, merging with existing values. */
async function writeConfig(picks: {
  primaryModel: string;
  provider: string;
  primaryDetected?: DetectedModel;
  subagentMode: 'off' | 'sequential' | 'parallel';
  subagentRole?: { provider: string; model: string };
  subagentDetected?: DetectedModel;
  visionRole?: { provider: string; model: string };
  visionDetected?: DetectedModel;
  anthropicCaching: boolean;
  autoSnapshot: boolean;
  hardware: HardwareProfile;
}): Promise<void> {
  await fs.mkdir(QODEX_HOME, { recursive: true });

  await withLock(QODEX_CONFIG_FILE + '.lock', async () => {
  // Try to load existing config and merge; if missing, start from DEFAULT_CONFIG.
  let existing: QodexConfig;
  try {
    existing = await loadConfig(process.cwd());
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      // No config yet — fresh start.
      existing = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    } else {
      // A real parse/IO error (corrupt YAML, permission denied, etc.). Do NOT
      // silently reset over the user's config. Back the existing file up to a
      // timestamped copy first, warn loudly, then continue from defaults so the
      // original data is preserved on disk and recoverable.
      const backup = `${QODEX_CONFIG_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      let backedUp = false;
      try {
        await fs.copyFile(QODEX_CONFIG_FILE, backup);
        backedUp = true;
      } catch {
        // If even the backup fails, fall through to the abort below.
      }
      if (!backedUp) {
        throw new Error(
          `Could not read existing config at ${QODEX_CONFIG_FILE} (${err?.message ?? err}), ` +
          `and could not back it up before overwriting. Aborting to avoid losing your settings. ` +
          `Fix or move ${QODEX_CONFIG_FILE} aside, then re-run \`qx setup\`.`,
        );
      }
      console.error(
        `⚠ Could not read existing config at ${QODEX_CONFIG_FILE} (${err?.message ?? err}).\n` +
        `  Your previous config was backed up to ${backup} before continuing from defaults.`,
      );
      existing = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  const updated: QodexConfig = {
    ...existing,
    defaults: {
      ...existing.defaults,
      provider: picks.provider,
      model: picks.primaryModel,
    },
    providers: {
      ...existing.providers,
      anthropic: { ...existing.providers.anthropic, useCaching: picks.anthropicCaching },
      // When the user picked an LM Studio model for parent or sub-agent, make sure
      // the openai provider is wired up to talk to the local server. This is a
      // no-op if the user already had the right baseUrl, and a friendly auto-config
      // if they didn't.
      openai: (() => {
        const oai = { ...((existing.providers as any).openai ?? { apiKeyEnv: 'OPENAI_API_KEY' }) };
        const lmStudioModels = [picks.primaryDetected, picks.subagentDetected, picks.visionDetected]
          .filter((m): m is DetectedModel => !!m && m.source === 'lm-studio');
        if (lmStudioModels.length > 0) {
          oai.baseUrl = oai.baseUrl ?? 'http://127.0.0.1:1234/v1';
          // Merge extraModels — keep what the user had, add any new LM Studio ids.
          const existingExtras: any[] = Array.isArray(oai.extraModels) ? oai.extraModels : [];
          const existingIds = new Set(existingExtras.map(e => e?.id));
          const newExtras = lmStudioModels
            .filter(m => !existingIds.has(m.id))
            .map(m => ({
              id: m.id,
              // Real window detected from LM Studio's native API (or a RAM-safe
              // family heuristic) — NOT a hardcoded 32768. This was the root cause
              // of the window-thrash / OOM crashes.
              contextWindow: m.contextWindow ?? 32768,
              maxOutput: 8192,
              supportsToolCalls: m.toolCallsLikely ?? true,
              supportsStreaming: true,
            }));
          oai.extraModels = [...existingExtras, ...newExtras];
        }
        return oai;
      })(),
    },
    subagents: {
      mode: picks.subagentMode,
      maxConcurrent: existing.subagents?.maxConcurrent ?? 3,
      budgetPerSubagent: existing.subagents?.budgetPerSubagent ?? { maxIterations: 8 },
      // Auto policy: parallel works for local+cloud mix, falls back to sequential for two locals.
      // Power users can override with `force` in the YAML directly.
      concurrencyMode: (existing as any).subagents?.concurrencyMode ?? 'auto',
    },
    roles: (() => {
      type Role = { provider: string; model: string };
      const r: Record<string, Role> = { ...((existing as any).roles ?? {}) };
      // General sub-agent role: set when chosen, else clear (inherit parent next run).
      if (picks.subagentRole) {
        r.subagent = { provider: picks.subagentRole.provider, model: picks.subagentRole.model };
      } else {
        delete r.subagent;
      }
      // Vision sub-agent role: set when chosen, else clear.
      if (picks.visionRole) {
        r.vision = { provider: picks.visionRole.provider, model: picks.visionRole.model };
      } else {
        delete r.vision;
      }
      return Object.keys(r).length > 0 ? r : undefined;
    })(),
    safety: {
      autoSnapshot: picks.autoSnapshot,
      snapshotRetentionTurns: existing.safety?.snapshotRetentionTurns ?? 50,
    },
    hardware: {
      tier: picks.hardware.tier,
      ramGb: picks.hardware.ramGb,
      appleSilicon: picks.hardware.appleSilicon,
      detectedAt: new Date().toISOString(),
    },
  };

  // js-yaml's dump matches yaml.stringify semantics; lineWidth=-1 disables wrapping
  // (we keep lines un-wrapped so paths and URLs stay readable).
  const yamlOut = yaml.dump(updated, { lineWidth: -1, noRefs: true });
  // Banner so users editing this file know it's wizard-generated and how to refresh.
  const banner = [
    '# QodeX configuration',
    `# Generated by \`qx setup\` on ${new Date().toLocaleString()}`,
    '# Re-run \`qx setup\` to reconfigure interactively.',
    '# All keys are optional — sensible defaults are applied for anything missing.',
    '',
  ].join('\n');
  await writeFileAtomic(QODEX_CONFIG_FILE, banner + yamlOut);
  });
}

/** Quick check: does ~/.qodex/config.yaml exist? Used to trigger first-run wizard. */
export async function configExists(): Promise<boolean> {
  try {
    await fs.access(QODEX_CONFIG_FILE);
    return true;
  } catch {
    return false;
  }
}
