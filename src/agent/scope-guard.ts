/**
 * Scope guard. We watched the model finish the requested work (writing/redesigning files) and then,
 * unprompted, wander into starting a dev server and running `pnpm install` / `pnpm add vite` — none
 * of which the user asked for. That wandering is where the 90-minute, 5.6M-token thrash happened.
 *
 * This is intentionally conservative and ADVISORY: it fires a one-time nudge reminding the model to
 * finish the edits and ask before running servers or installing packages. It does NOT hard-block —
 * the real circuit-breaker is the soft-failure loop detector (recovery.looksFutile), which stops the
 * thrash even if the model ignores this nudge. Layered, not brittle.
 */

// Did the user actually ask for execution (run / serve / install / test / build / deploy)?
const EXECUTION_INTENT = new RegExp(
  '\\b(run|runs|running|serve|serving|start|launch|preview|dev server|devserver|' +
  'install|reinstall|build|rebuild|compile|test|tests|deploy|boot up|spin up)\\b|' +
  'اجرا|اجرایی|نصب|بیلد|تست|دیپلوی|سرور|راه.?اندازی|بالا.?بیار',
  'i',
);

export function userWantsExecution(prompt: string): boolean {
  if (!prompt) return false;
  return EXECUTION_INTENT.test(prompt);
}

// Is this tool call an "execution"/environment action (start a server, install deps)?
export function isExecutionAction(toolName: string, argsJson: string): boolean {
  if (/dev_server|run_dev|preview|^serve$/i.test(toolName)) return true;
  if (toolName === 'shell' || toolName === 'bash' || toolName === 'run_command') {
    return /\b(pnpm|npm|yarn|bun)\s+(install|add|i|ci|run\s+dev|run\s+start|run\s+serve)\b|\bnpx\b|(^|\s|\/)vite(\s|$)/i.test(
      argsJson || '',
    );
  }
  return false;
}
