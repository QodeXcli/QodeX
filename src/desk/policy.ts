/**
 * Desk policy — the local trust boundary Grok Bot and Muse put in a cloud VM.
 *
 * QodeX does not rent you a computer. A desk is a named teammate on the machine
 * you already have. These functions decide what that teammate is allowed to
 * accept without a human, and what must stop for approval. Pure. No I/O.
 */

import { spawnSync } from 'child_process';

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

export type GuiBackend = 'macos' | 'x11' | 'windows' | 'none';

export interface DesktopTools {
  /** `xdotool` is on PATH, so click/type/key can drive an X11 session. */
  xdotool?: boolean;
  /** scrot, ImageMagick `import`, or gnome-screenshot is on PATH. */
  screenshot?: boolean;
  /** python3 can import AT-SPI. Named controls, not just pixels. */
  atspi?: boolean;
}

export type AccessBackend = 'ax' | 'uia' | 'atspi' | 'none';

/**
 * What this process can drive. Linux click/type is real when xdotool is
 * installed. Windows uses PowerShell, which ships with the OS. Named controls
 * use the accessibility tree (AX / UI Automation / AT-SPI). Anything else
 * is files, shell, and the browser — we do not invent a backend.
 */
export function describeDesktop(platform: string, tools: DesktopTools = {}): { os: string; gui: GuiBackend; access: AccessBackend; note: string } {
  if (platform === 'darwin') {
    return {
      os: 'macos',
      gui: 'macos',
      access: 'ax',
      note: 'Named controls use the accessibility tree (computer_use_tree, computer_use_invoke) and are checked again after the press. Blind click, type, and key use screencapture and System Events and wait for a sentinel yes.',
    };
  }
  if (platform === 'linux' && tools.xdotool) {
    return {
      os: 'linux',
      gui: 'x11',
      access: tools.atspi ? 'atspi' : 'none',
      note: tools.atspi
        ? 'Named controls use AT-SPI. Blind click, type, and key use xdotool. Each change waits for a sentinel yes, then it runs.'
        : 'Click, type, and key use xdotool and wait for a sentinel yes. AT-SPI is not importable, so computer_use_tree will fail until python3-gi and gir1.2-atspi-2.0 are installed. It will not invent controls.',
    };
  }
  if (platform === 'linux') {
    return {
      os: 'linux',
      gui: 'none',
      access: tools.atspi ? 'atspi' : 'none',
      note: tools.atspi
        ? 'Named controls use AT-SPI (computer_use_invoke). xdotool is not on PATH, so blind coordinate clicks are unavailable.'
        : 'Desktop control is implemented for X11, but xdotool is not on PATH and AT-SPI is not importable. Install xdotool, or python3-gi and gir1.2-atspi-2.0 for named controls. Until then the desk uses files, shell, and the browser.',
    };
  }
  if (platform === 'win32') {
    return {
      os: 'windows',
      gui: 'windows',
      access: 'uia',
      note: 'Named controls use UI Automation and are checked again after the press. Blind click, type, and key use PowerShell and Win32 and wait for a sentinel yes.',
    };
  }
  return { os: platform || 'unknown', gui: 'none', access: 'none', note: 'No desktop backend for this platform. The desk still runs files, shell, and the browser.' };
}

function binOnPath(bin: string): boolean {
  const result = spawnSync('which', [bin], { encoding: 'utf8' });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

/** describeDesktop plus a PATH check on Linux. macOS and Windows need no extra binary for named controls. */
export function probeDesktop(platform = process.platform): { os: string; gui: GuiBackend; access: AccessBackend; note: string } {
  if (platform !== 'linux') return describeDesktop(platform);
  return describeDesktop('linux', {
    xdotool: binOnPath('xdotool'),
    screenshot: binOnPath('scrot') || binOnPath('import') || binOnPath('gnome-screenshot'),
    atspi: atspiImportable(),
  });
}

function atspiImportable(): boolean {
  try {
    const result = spawnSync('python3', ['-c', 'import gi; gi.require_version("Atspi", "2.0")'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: 'ignore',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function slugDeskName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  return slug || 'desk';
}
