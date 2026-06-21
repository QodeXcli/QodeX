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

/** Visible width of a string: length with ANSI SGR (colour/dim) escapes removed. Pure → testable. */
export function displayWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** How many PHYSICAL terminal rows a logical line occupies once the terminal wraps
 *  it at `cols`. A line wider than the terminal wraps to ⌈width/cols⌉ rows; empty
 *  lines still take one. Pure → testable. This is what makes the in-place redraw
 *  move the cursor up by the right amount — counting logical lines undercounts when
 *  long options (e.g. long base URLs) wrap, leaving stale rows that pile up. */
export function physicalRows(s: string, cols: number): number {
  if (cols <= 0) return 1;
  return Math.max(1, Math.ceil(displayWidth(s) / cols));
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

    // Window the list so it never grows taller than the terminal. Without this, a list longer
    // than the visible rows scrolls the top options off-screen, and the in-place redraw
    // (\x1b[NA) can't reach those rows anymore — so only the bottom few stay visible and the
    // highlight appears stuck. We show a sliding window of `pageSize` rows that follows the
    // cursor, with ▲/▼ markers when there's more above/below.
    const termRows = (stdout.rows && stdout.rows > 0) ? stdout.rows : 24;
    // Reserve rows for: the question line already printed, the hint line, the optional
    // more-above / more-below markers, and a little breathing room.
    const pageSize = Math.max(3, Math.min(options.length, termRows - 5));
    const windowed = options.length > pageSize;
    let top = 0; // index of the first visible option
    // The drawn block = (more-above marker?) + visible rows + (more-below marker?) + hint line.
    let block = 0;
    let drawn = false;

    console.log(question);

    const clampWindow = (): void => {
      if (idx < top) top = idx;
      else if (idx >= top + pageSize) top = idx - pageSize + 1;
      if (top < 0) top = 0;
      if (top > Math.max(0, options.length - pageSize)) top = Math.max(0, options.length - pageSize);
    };

    const render = (): void => {
      clampWindow();
      if (drawn && block > 0) stdout.write(`\x1b[${block}A`); // jump back to the top of the block
      stdout.write('\x1b[0J');                                // clear from cursor down

      // Count PHYSICAL rows (accounting for terminal wrap), not logical lines — a long
      // option that wraps occupies >1 row, and if we undercount the cursor-up leaves the
      // top rows behind and every keypress piles up another stale copy.
      const cols = (stdout.columns && stdout.columns > 0) ? stdout.columns : 80;
      let physical = 0;
      const emit = (s: string): void => { stdout.write(s + '\n'); physical += physicalRows(s, cols); };

      const end = Math.min(options.length, top + pageSize);

      if (windowed && top > 0) emit(dim(`     ↑ ${top} more above`));
      for (let i = top; i < end; i++) {
        const opt = options[i]!;
        const sel = i === idx;
        const marker = sel ? '▸' : ' ';
        const num = String(i + 1).padStart(2);
        const label = sel ? `\x1b[36m\x1b[1m${opt.label}\x1b[0m` : opt.label;
        const hint = opt.hint ? `  ${dim(opt.hint)}` : '';
        emit(`  ${marker} ${num}. ${label}${hint}`);
      }
      if (windowed && end < options.length) emit(dim(`     ↓ ${options.length - end} more below`));

      const nav = windowed
        ? '  ↑/↓ move · Enter select · type number+Enter · Ctrl+C cancel'
        : '  ↑/↓ move · Enter select · 1-9 jump · Ctrl+C cancel';
      emit(dim(nav));

      block = physical;
      drawn = true;
    };

    const cleanup = (): void => {
      try { stdin.removeListener('keypress', onKey); } catch { /* ignore */ }
      try { if (stdin.isTTY) (stdin as any).setRawMode(false); } catch { /* ignore */ }
      stdout.write('\x1b[?25h'); // restore cursor
      try { stdin.pause(); } catch { /* ignore */ }
    };

    let numBuf = '';
    let numTimer: ReturnType<typeof setTimeout> | undefined;

    const commitNumBuf = (): void => {
      if (numBuf) {
        const n = parseInt(numBuf, 10);
        if (n >= 1 && n <= options.length) { idx = n - 1; render(); }
        numBuf = '';
      }
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        if (numTimer) clearTimeout(numTimer);
        cleanup();
        stdout.write('\n');
        process.exit(130); // SIGINT — user cancelled setup
      } else if (key.name === 'return' || key.name === 'enter') {
        if (numTimer) clearTimeout(numTimer);
        commitNumBuf();        // a pending number jump lands on that row first
        cleanup();
        resolve(options[idx]!.value);
      } else if (key.name === 'escape') {
        if (numTimer) clearTimeout(numTimer);
        cleanup();
        resolve(defaultValue);
      } else if (key.name && /^[0-9]$/.test(key.name)) {
        // Build up a (possibly multi-digit) number; move the cursor there. Enter confirms.
        // A short idle delay auto-moves so single-digit jumps still feel instant.
        numBuf += key.name;
        if (numTimer) clearTimeout(numTimer);
        const asNum = parseInt(numBuf, 10);
        // If no longer number could extend this into a valid index, commit immediately.
        const couldGrow = asNum * 10 <= options.length;
        if (!couldGrow) { commitNumBuf(); }
        else {
          if (asNum >= 1 && asNum <= options.length) { idx = asNum - 1; render(); }
          numTimer = setTimeout(() => { numBuf = ''; }, 600);
        }
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
