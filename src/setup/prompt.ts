/**
 * Tiny prompt helpers for the setup wizard. We deliberately don't pull in Ink here:
 * the wizard runs before the main TUI is mounted, and using readline keeps the surface
 * area tiny and CI/headless detection trivial (`process.stdin.isTTY === undefined`).
 *
 * All prompts respect a hard "default" so non-interactive callers (CI, --defaults flag,
 * scripts) can drive them by passing `{interactive: false}` and getting deterministic
 * answers.
 */
import * as readline from 'readline';

export interface PromptOptions {
  interactive: boolean;
}

/** Yes/no prompt. Default is the answer used in non-interactive mode and on bare Enter. */
export async function confirm(
  question: string,
  defaultYes: boolean,
  opts: PromptOptions,
): Promise<boolean> {
  if (!opts.interactive) return defaultYes;
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const ans = (await readLine(`${question} ${hint} `)).trim().toLowerCase();
  if (ans === '') return defaultYes;
  return ans === 'y' || ans === 'yes';
}

/** Resolve the starting index for a select list from its default value. Pure → testable. */
export function initialIndex<T extends string>(
  options: Array<{ value: T }>,
  defaultValue: T,
): number {
  const i = options.findIndex(o => o.value === defaultValue);
  return i >= 0 ? i : 0;
}

/** Compute the next highlighted index for a keypress. Returns the same index for no-op keys. Pure → testable. */
export function moveSelection(current: number, keyName: string | undefined, len: number): number {
  if (len <= 0) return 0;
  if (keyName === 'up' || keyName === 'k') return (current - 1 + len) % len;
  if (keyName === 'down' || keyName === 'j') return (current + 1) % len;
  if (keyName && /^[1-9]$/.test(keyName)) {
    const n = parseInt(keyName, 10);
    if (n >= 1 && n <= len) return n - 1;
  }
  return current;
}

/**
 * Single-choice from a list. Returns the chosen value (not index).
 * Interactive TTY → arrow-key navigation (↑/↓ or j/k, Enter to select, 1-9 to jump).
 * Non-raw terminals / pipes → falls back to the numbered prompt (no regression).
 */
export async function choose<T extends string>(
  question: string,
  options: Array<{ value: T; label: string; hint?: string }>,
  defaultValue: T,
  opts: PromptOptions,
): Promise<T> {
  if (!opts.interactive) return defaultValue;
  const canRaw = typeof (process.stdin as any).setRawMode === 'function' && process.stdin.isTTY;
  return canRaw
    ? chooseInteractive(question, options, defaultValue)
    : chooseNumbered(question, options, defaultValue);
}

/** Arrow-key driven selector. Redraws the list in place as the highlight moves. */
function chooseInteractive<T extends string>(
  question: string,
  options: Array<{ value: T; label: string; hint?: string }>,
  defaultValue: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let idx = initialIndex(options, defaultValue);
    const stdin = process.stdin;
    const stdout = process.stdout;
    const block = options.length + 1; // option lines + one hint line
    let drawn = false;

    console.log(question);

    const render = (): void => {
      if (drawn) stdout.write(`\x1b[${block}A`); // jump back to the top of the block
      stdout.write('\x1b[0J');                    // clear from cursor down
      options.forEach((opt, i) => {
        const sel = i === idx;
        const marker = sel ? '▸' : ' ';
        const num = String(i + 1).padStart(2);
        const label = sel ? `\x1b[36m\x1b[1m${opt.label}\x1b[0m` : opt.label;
        const hint = opt.hint ? `  ${dim(opt.hint)}` : '';
        stdout.write(`  ${marker} ${num}. ${label}${hint}\n`);
      });
      stdout.write(dim('  ↑/↓ move · Enter select · 1-9 jump · Ctrl+C cancel') + '\n');
      drawn = true;
    };

    const cleanup = (): void => {
      try { stdin.removeListener('keypress', onKey); } catch { /* ignore */ }
      try { if (stdin.isTTY) (stdin as any).setRawMode(false); } catch { /* ignore */ }
      stdout.write('\x1b[?25h'); // restore cursor
      try { stdin.pause(); } catch { /* ignore */ }
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup();
        stdout.write('\n');
        process.exit(130); // SIGINT — user cancelled setup
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(options[idx]!.value);
      } else if (key.name === 'escape') {
        cleanup();
        resolve(defaultValue);
      } else if (key.name && /^[1-9]$/.test(key.name)) {
        const n = parseInt(key.name, 10);
        if (n >= 1 && n <= options.length) { cleanup(); resolve(options[n - 1]!.value); }
      } else {
        const next = moveSelection(idx, key.name, options.length);
        if (next !== idx) { idx = next; render(); }
      }
    };

    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) (stdin as any).setRawMode(true);
    stdin.resume();
    stdout.write('\x1b[?25l'); // hide cursor while navigating
    render();
    stdin.on('keypress', onKey);
  });
}

/** Numbered fallback for non-raw terminals (CI-ish TTYs, some remote shells). */
function chooseNumbered<T extends string>(
  question: string,
  options: Array<{ value: T; label: string; hint?: string }>,
  defaultValue: T,
): Promise<T> {
  return (async () => {
    console.log(question);
    options.forEach((opt, i) => {
      const marker = opt.value === defaultValue ? '▸' : ' ';
      const num = String(i + 1).padStart(2);
      const hint = opt.hint ? `  ${dim(opt.hint)}` : '';
      console.log(`  ${marker} ${num}. ${opt.label}${hint}`);
    });
    while (true) {
      const raw = (await readLine(`Enter 1-${options.length}, or press Enter for default: `)).trim();
      if (raw === '') return defaultValue;
      const n = parseInt(raw, 10);
      if (!isNaN(n) && n >= 1 && n <= options.length) {
        return options[n - 1]!.value;
      }
      console.log(dim('  ↳ Invalid choice, try again.'));
    }
  })();
}

/** Free-text prompt with default. */
export async function text(
  question: string,
  defaultValue: string,
  opts: PromptOptions,
): Promise<string> {
  if (!opts.interactive) return defaultValue;
  const hint = defaultValue ? ` (default: ${defaultValue})` : '';
  const ans = (await readLine(`${question}${hint}: `)).trim();
  return ans || defaultValue;
}

/** Render a section header. Output-only — no I/O wait. */
export function section(title: string): void {
  console.log('');
  console.log(divider());
  console.log(`  ${title}`);
  console.log(divider());
}

/** Render a paragraph of explanatory text indented under a section. */
export function paragraph(text: string): void {
  const wrapped = text.split('\n').map(l => `  ${l}`).join('\n');
  console.log(wrapped);
}

function divider(): string {
  return '─'.repeat(70);
}

function dim(s: string): string {
  // ANSI dim — only if stdout is a TTY, otherwise plain
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

/** Detect whether we have an interactive TTY. CI environments / pipes return false. */
export function isInteractiveTTY(): boolean {
  if (process.env.QODEX_SKIP_SETUP === '1') return false;
  if (!process.stdin.isTTY) return false;
  if (!process.stdout.isTTY) return false;
  // Common CI env vars
  if (process.env.CI === 'true' || process.env.CI === '1') return false;
  if (process.env.GITHUB_ACTIONS) return false;
  return true;
}

/** Single-line read from stdin, returning the user's input without the trailing newline. */
function readLine(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
