/**
 * Desk policy — the local trust boundary Grok Bot and Muse put in a cloud VM.
 *
 * QodeX does not rent you a computer. A desk is a named teammate on the machine
 * you already have. These functions decide what that teammate is allowed to
 * accept without a human, and what must stop for approval. Pure. No I/O.
 */

export const MAX_DESKS = 6;
export const MAX_HANDOFF_DEPTH = 3;
export const MAX_ROUTINE_STEPS = 24;

export type SensitiveKind = 'credential' | 'spend' | 'delete' | 'send' | 'publish';

export interface SensitiveHit {
  sensitive: true;
  kind: SensitiveKind;
  reason: string;
}

export interface SensitiveClear {
  sensitive: false;
}

export type SensitiveVerdict = SensitiveHit | SensitiveClear;

/** Most severe first. A goal that both sends and spends is a spend. */
const RULES: Array<{ kind: SensitiveKind; re: RegExp; reason: string }> = [
  {
    kind: 'credential',
    re: /\b(password|passphrase|api[ _-]?key|secret|access[ _-]?token|private[ _-]?key)\b|\b(?:password|api[_-]?key|secret|token)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]+PRIVATE KEY-----|رمز(?:\s*عبور)?/i,
    reason: 'touches a credential — a desk never handles secrets on its own',
  },
  {
    kind: 'spend',
    re: /\b(pay|purchase|buy|checkout|charge|subscribe|invoice)\b|خرید|پرداخت/i,
    reason: 'would spend money or start a purchase',
  },
  {
    kind: 'delete',
    re: /\b(delete|wipe|drop\s+table|rm\s+-[a-z]*r[a-z]*|remove\s+all)\b|حذف/i,
    reason: 'would delete or destroy something',
  },
  {
    kind: 'send',
    re: /\b(send(?:\s+an)?\s+email|e-?mail\s+\S|dm\b|whatsapp|slack\s+message)\b|ایمیل|بفرست/i,
    reason: 'would send a message as you',
  },
  {
    kind: 'publish',
    re: /\b(git\s+push|publish|tweet|post\s+publicly|deploy\s+to\s+prod)\b|منتشر/i,
    reason: 'would publish or push beyond this machine',
  },
];

/** Classify a goal the way Muse's Sentinel does: send / spend / delete stop. */
export function classifySensitive(text: string): SensitiveVerdict {
  const body = text ?? '';
  for (const rule of RULES) {
    if (rule.re.test(body)) return { sensitive: true, kind: rule.kind, reason: rule.reason };
  }
  return { sensitive: false };
}

const SECRET_RES: RegExp[] = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\b(password|api[_-]?key|secret|token)\s*[:=]\s*\S+/gi,
];

/** Strip credentials out of a handoff packet. Desks share work, not keys. */
export function scrubPacket(text: string): { text: string; redacted: number } {
  let out = text ?? '';
  let redacted = 0;
  for (const re of SECRET_RES) {
    out = out.replace(re, () => {
      redacted++;
      return '[redacted]';
    });
  }
  return { text: out, redacted };
}

export interface HandoffCheck {
  ok: boolean;
  reason: string;
}

export function canHandoff(input: {
  fromId: string;
  toId: string;
  depth: number;
  knownIds: string[];
}): HandoffCheck {
  if (!input.fromId || !input.toId) return { ok: false, reason: 'handoff needs both desks' };
  if (input.fromId === input.toId) return { ok: false, reason: 'a desk cannot hand work to itself' };
  if (!input.knownIds.includes(input.fromId) || !input.knownIds.includes(input.toId)) {
    return { ok: false, reason: 'both desks must already exist' };
  }
  if (input.depth >= MAX_HANDOFF_DEPTH) {
    return { ok: false, reason: `handoff depth ${input.depth} is at the cap (${MAX_HANDOFF_DEPTH}) — a human has to pick it up` };
  }
  return { ok: true, reason: 'ok' };
}

export interface RoutineStep {
  tool: string;
  summary: string;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/;

export function validateRoutine(steps: RoutineStep[]): { ok: true; steps: RoutineStep[] } | { ok: false; reason: string } {
  if (!Array.isArray(steps) || steps.length < 2) {
    return { ok: false, reason: 'a routine needs at least two steps — one action is not a workflow' };
  }
  if (steps.length > MAX_ROUTINE_STEPS) {
    return { ok: false, reason: `a routine is capped at ${MAX_ROUTINE_STEPS} steps` };
  }
  const clean: RoutineStep[] = [];
  for (const step of steps) {
    const tool = String(step?.tool ?? '').trim();
    const summary = String(step?.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!TOOL_NAME.test(tool)) return { ok: false, reason: `bad tool name "${tool}"` };
    if (!summary) return { ok: false, reason: `step ${tool} has no summary` };
    clean.push({ tool, summary });
  }
  return { ok: true, steps: clean };
}

export type GuiBackend = 'macos' | 'linux' | 'windows' | 'none';

/**
 * What this machine can actually drive. We do not pretend Windows/Linux have
 * the macOS computer-use tools. The desk still runs files, shell, and browser.
 */
export function describeDesktop(platform: string): { os: string; gui: GuiBackend; note: string } {
  if (platform === 'darwin') {
    return {
      os: 'macos',
      gui: 'macos',
      note: 'Screen, click, and type are available through computer_use_* after you grant Accessibility.',
    };
  }
  if (platform === 'linux') {
    return {
      os: 'linux',
      gui: 'none',
      note: 'No native click/type backend yet. The desk still owns files, shell, browser, and schedules on this machine.',
    };
  }
  if (platform === 'win32') {
    return {
      os: 'windows',
      gui: 'none',
      note: 'No native click/type backend yet. The desk still owns files, shell, browser, and schedules on this machine.',
    };
  }
  return { os: platform || 'unknown', gui: 'none', note: 'Unknown platform. Desk runs as a local agent, not a GUI driver.' };
}

export function slugDeskName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  return slug || 'desk';
}
