/**
 * ToolContext factory for the MCP server.
 *
 * When an external editor calls a QodeX tool over MCP there's no interactive TUI,
 * so we build a minimal, non-interactive context:
 *   - a real filesystem transaction (so edits are journaled and /undo-able)
 *   - the project's PermissionEngine (honors the user's allow/deny config)
 *   - askUser → auto-declines (a server can't prompt a human; tools that require
 *     confirmation simply don't get it, which is the safe default)
 *   - emit → swallowed (UI events have no terminal to render to)
 *
 * The returned context carries a `_cleanup()` to commit/close the transaction
 * after the tool call completes.
 */

import type { ToolContext } from '../../tools/base.js';
import type { QodexConfig } from '../../config/defaults.js';

export interface ServerToolContext extends ToolContext {
  _cleanup?: () => Promise<void>;
}

export async function makeServerToolContext(
  cwd: string,
  config: QodexConfig,
): Promise<ServerToolContext> {
  const { getJournal } = await import('../../filesystem/transaction.js');
  const { PermissionEngine } = await import('../../security/permissions.js');
  const path = await import('path');

  const sessionId = `mcp-server-${Date.now().toString(36)}`;
  const journal = getJournal();
  const transaction = await journal.begin(sessionId);
  const permissions = new PermissionEngine(config);

  // Rule-based auto-approval for the headless server. A server can't prompt a
  // human, so instead of blanket-declining we consult config.mcpServer.autoApprove:
  // approve if `all`, or if the operation touches an allowed path prefix, else "no".
  const aa = (config as any).mcpServer?.autoApprove ?? {};
  const approvePaths: string[] = Array.isArray(aa.paths) ? aa.paths : [];
  const approveAll = aa.all === true;

  const askUser = async (prompt: string): Promise<string> => {
    if (approveAll) return 'yes';
    // If the prompt names a path under an approved prefix, allow it.
    if (approvePaths.length > 0) {
      const lower = prompt.toLowerCase();
      for (const p of approvePaths) {
        const norm = p.replace(/\\/g, '/').toLowerCase();
        // Match either a relative prefix mention or an absolute path under cwd/prefix.
        if (lower.includes(norm) || lower.includes(path.join(cwd, p).toLowerCase().replace(/\\/g, '/'))) {
          return 'yes';
        }
      }
    }
    return 'no'; // default-safe: decline anything not explicitly whitelisted
  };

  return {
    cwd,
    sessionId,
    transaction,
    permissions,
    askUser,
    emit: () => { /* no UI sink in server mode */ },
    currentTurn: 0,
    _cleanup: async () => {
      try { await transaction.commit?.(); } catch { /* best-effort */ }
    },
  };
}
