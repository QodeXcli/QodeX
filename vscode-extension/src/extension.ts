/**
 * QodeX VS Code extension — thin launcher.
 *
 * Philosophy: don't reimplement the agent loop or chat UI inside VS Code.
 * The terminal already runs the full QodeX CLI with all its tools and TUI.
 * The extension's job is to:
 *
 *   1. Make launching QodeX faster (Cmd+Alt+Q opens it in a terminal at the
 *      project root)
 *   2. Pass relevant editor context to QodeX as the first prompt (selection,
 *      current file path)
 *   3. Provide command-palette / right-click hooks for common tasks
 *
 * Why thin: QodeX is a CLI-first product. The full TUI works in any terminal,
 * including the VS Code integrated terminal. A 200-line extension covers the
 * 90% of "I want to ask QodeX about this code" workflow without duplicating
 * what's already in the CLI.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

interface QodexConfig {
  executablePath: string;
  terminalName: string;
  openHeadless: boolean;
}

function getConfig(): QodexConfig {
  const cfg = vscode.workspace.getConfiguration('qodex');
  return {
    executablePath: cfg.get<string>('executablePath') ?? 'qodex',
    terminalName: cfg.get<string>('terminalName') ?? 'QodeX',
    openHeadless: cfg.get<boolean>('openHeadless') ?? false,
  };
}

/**
 * Find an existing QodeX terminal or create a new one. We reuse terminals so
 * repeated commands don't pile up tabs.
 */
function getOrCreateTerminal(cwd: string): vscode.Terminal {
  const cfg = getConfig();
  const existing = vscode.window.terminals.find(t => t.name === cfg.terminalName);
  if (existing) {
    existing.show();
    return existing;
  }
  const terminal = vscode.window.createTerminal({
    name: cfg.terminalName,
    cwd,
    env: {
      ...process.env,
      // Force HOME to a sane value. Some macOS launch paths (Spotlight,
      // Applications folder, Finder double-click) leave HOME unset or set
      // to '/' in the extension host, which propagates into the spawned
      // terminal and breaks ~/.qodex resolution.
      HOME: process.env.HOME && process.env.HOME !== '/' ? process.env.HOME : os.homedir(),
      QODEX_LAUNCHED_FROM: 'vscode',
    },
  });
  terminal.show();
  return terminal;
}

/** Determine the right working directory: workspace folder if available, else file's dir, else home. */
function getCwd(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.fsPath;
  const activeFile = vscode.window.activeTextEditor?.document?.uri?.fsPath;
  if (activeFile) return path.dirname(activeFile);
  // CRITICAL: fall back to home, NOT process.cwd().
  // process.cwd() in the VS Code extension host is often '/' when VS Code was
  // launched from Spotlight / dock / Applications folder — running QodeX from
  // '/' breaks ~/.qodex resolution and is generally useless. Home is always sane.
  return os.homedir();
}

/** Quote a shell string for bash / zsh. */
function shellQuote(s: string): string {
  // Single-quote everything; escape embedded single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Command 1: open QodeX in a terminal at workspace root (interactive). */
async function openInTerminal(uri?: vscode.Uri): Promise<void> {
  const cfg = getConfig();
  const cwd = uri?.fsPath ?? getCwd();
  const term = getOrCreateTerminal(cwd);
  term.sendText(cfg.executablePath);
}

/** Command 2: ask QodeX about the current selection (or whole file). */
async function askAboutSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('QodeX: no active editor.');
    return;
  }
  const selection = editor.selection;
  const document = editor.document;
  const selectedText = selection.isEmpty ? document.getText() : document.getText(selection);
  const filePath = document.uri.fsPath;
  const lineRange = selection.isEmpty
    ? `whole file`
    : `lines ${selection.start.line + 1}-${selection.end.line + 1}`;

  // Prompt the user for their question
  const question = await vscode.window.showInputBox({
    prompt: `Ask QodeX about ${path.basename(filePath)} (${lineRange})`,
    placeHolder: 'e.g. explain this function, find bugs, suggest improvements',
  });
  if (!question) return;

  const cfg = getConfig();
  const cwd = getCwd();
  const term = getOrCreateTerminal(cwd);
  // Build a self-contained prompt: file context + user question
  // We pass via the CLI's headless mode if configured, else interactive
  const promptText =
    `Look at ${filePath} ${lineRange}:\n` +
    `\n\`\`\`\n${selectedText.slice(0, 4000)}${selectedText.length > 4000 ? '\n…[truncated]' : ''}\n\`\`\`\n\n` +
    `Question: ${question}`;
  if (cfg.openHeadless) {
    term.sendText(`${cfg.executablePath} --headless ${shellQuote(promptText)}`);
  } else {
    term.sendText(`${cfg.executablePath} ${shellQuote(promptText)}`);
  }
}

/** Command 3: tell QodeX to edit the current file. */
async function editCurrentFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('QodeX: no active editor.');
    return;
  }
  const filePath = editor.document.uri.fsPath;
  const what = await vscode.window.showInputBox({
    prompt: `What change should QodeX make to ${path.basename(filePath)}?`,
    placeHolder: 'e.g. add error handling, refactor to async/await, add JSDoc',
  });
  if (!what) return;
  const cfg = getConfig();
  const cwd = getCwd();
  const term = getOrCreateTerminal(cwd);
  const promptText = `Edit ${filePath}: ${what}. Read the file first, then make the change. Verify by running typecheck/lint if available.`;
  term.sendText(`${cfg.executablePath} ${shellQuote(promptText)}`);
}

/** Command 4: plan a change. */
async function runPlan(): Promise<void> {
  const what = await vscode.window.showInputBox({
    prompt: 'Describe the change you want QodeX to plan',
    placeHolder: 'e.g. add user authentication with JWT',
  });
  if (!what) return;
  const cfg = getConfig();
  const cwd = getCwd();
  const term = getOrCreateTerminal(cwd);
  // Use --plan flag (drops QodeX into plan mode which restricts to read-only tools)
  term.sendText(`${cfg.executablePath} --plan ${shellQuote(what)}`);
}

/** Command 5: network diagnostic. */
async function networkDiag(): Promise<void> {
  const cfg = getConfig();
  const cwd = getCwd();
  const term = getOrCreateTerminal(cwd);
  // Launch interactive and run /network immediately. We send the slash command
  // line; the user can take over after.
  term.sendText(cfg.executablePath);
  // Slight delay so the prompt is ready before we send /network
  setTimeout(() => term.sendText('/network'), 800);
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline diagnostics → QodeX. The editor's language server already computes the
// errors/warnings (the red squiggles). We read them via the Diagnostics API and
// hand them to the QodeX agent, which fixes the file ON DISK (its strength — it
// reads, reasons, edits, and verifies with the same tools + architecture gate as
// the CLI). VS Code then reflects the on-disk change. We do NOT reimplement an
// LLM inside the editor; we bridge the editor's problems to the real agent.
// ─────────────────────────────────────────────────────────────────────────────

function severityLabel(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'info';
    case vscode.DiagnosticSeverity.Hint: return 'hint';
    default: return 'issue';
  }
}

/** Collect language-server diagnostics for a file (optionally only those touching `range`). */
function collectDiagnostics(uri: vscode.Uri, range?: vscode.Range): { text: string; count: number } {
  const all = vscode.languages.getDiagnostics(uri);
  // Default to errors + warnings (skip hint/info noise). If a specific range is
  // given (e.g. the lightbulb on one squiggle), include whatever sits in it.
  let diags = all.filter(d =>
    d.severity === vscode.DiagnosticSeverity.Error ||
    d.severity === vscode.DiagnosticSeverity.Warning);
  if (range) {
    const inRange = all.filter(d => d.range.intersection(range) !== undefined);
    diags = inRange.length > 0 ? inRange : diags;
  }
  if (diags.length === 0) return { text: '', count: 0 };
  const lines = diags.slice(0, 50).map(d => {
    const L = d.range.start.line + 1;
    const C = d.range.start.character + 1;
    const code = typeof d.code === 'object' && d.code ? (d.code as any).value : d.code;
    const src = d.source ? ` (${d.source}${code != null ? ' ' + code : ''})` : '';
    return `- L${L}:${C} [${severityLabel(d.severity)}] ${d.message}${src}`;
  });
  const more = diags.length > 50 ? `\n…and ${diags.length - 50} more` : '';
  return { text: lines.join('\n') + more, count: diags.length };
}

/** Save the document (if open + dirty) so the agent reads current contents from disk. */
async function saveIfOpen(uri: vscode.Uri): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.isDirty) await doc.save();
  } catch { /* not open / not saveable — fine */ }
}

/** Command 6: let QodeX fix the editor's reported problems in a file (or one diagnostic). */
async function fixDiagnostics(documentUri?: vscode.Uri, range?: vscode.Range): Promise<void> {
  const uri = documentUri ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri) { vscode.window.showWarningMessage('QodeX: no active file.'); return; }

  const { text, count } = collectDiagnostics(uri, range);
  if (count === 0) {
    vscode.window.showInformationMessage('QodeX: no errors or warnings to fix in this file.');
    return;
  }

  const filePath = uri.fsPath;
  const scope = range ? `the problem at line ${range.start.line + 1}` : `${count} problem(s)`;
  const choice = await vscode.window.showInformationMessage(
    `Let QodeX fix ${scope} in ${path.basename(filePath)}? It edits the file on disk — use Undo or git to revert.`,
    'Fix it', 'Cancel',
  );
  if (choice !== 'Fix it') return;

  await saveIfOpen(uri);
  const prompt =
    `Fix the following ${range ? 'problem' : 'problems'} in ${filePath} reported by the editor's language server:\n\n` +
    `${text}\n\n` +
    `Read the file first. Fix the ROOT CAUSE — don't just silence the symptom or suppress the warning. ` +
    `Keep the change minimal and scoped to these issues; do not introduce new ones or refactor unrelated code. ` +
    `After editing, verify with the project's typecheck/lint if one is available.`;

  const cfg = getConfig();
  const term = getOrCreateTerminal(getCwd());
  term.sendText(`${cfg.executablePath} ${shellQuote(prompt)}`);
  vscode.window.showInformationMessage('QodeX is fixing the problem(s) in the terminal — the file will update on disk when it finishes.');
}

/** Command 7: explain the problem(s) at the cursor (read-only — no edits). */
async function explainDiagnostic(documentUri?: vscode.Uri, range?: vscode.Range): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const uri = documentUri ?? editor?.document.uri;
  if (!uri) { vscode.window.showWarningMessage('QodeX: no active file.'); return; }
  const r = range ?? editor?.selection;
  const { text, count } = collectDiagnostics(uri, r ?? undefined);
  if (count === 0) {
    vscode.window.showInformationMessage('QodeX: no problems at the cursor.');
    return;
  }
  const prompt =
    `Explain these problems in ${uri.fsPath} and how you'd fix them. Do NOT edit anything — just explain clearly:\n\n${text}`;
  const cfg = getConfig();
  const term = getOrCreateTerminal(getCwd());
  term.sendText(`${cfg.executablePath} ${cfg.openHeadless ? '--headless ' : ''}${shellQuote(prompt)}`);
}

/**
 * Lightbulb (💡) integration: when the cursor sits on an error/warning, offer
 * "Fix with QodeX" / "Explain with QodeX" as quick-fix code actions. This is the
 * in-editor entry point — the action dispatches to the commands above, which run
 * the agent. (A future enhancement could return a WorkspaceEdit for an in-place
 * diff preview, but that needs a structured headless "propose-a-patch" mode from
 * the CLI; for now the agent fixes on disk, which reuses all its verification.)
 */
class QodexCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // 1) Diagnostic-gated quick fixes — only when the cursor sits on an error/warning.
    if (context.diagnostics && context.diagnostics.length > 0) {
      const diagRange = context.diagnostics[0].range ?? range;

      const fix = new vscode.CodeAction('Fix with QodeX', vscode.CodeActionKind.QuickFix);
      fix.command = { command: 'qodex.fixDiagnostics', title: 'Fix with QodeX', arguments: [document.uri, diagRange] };
      fix.diagnostics = [...context.diagnostics];
      fix.isPreferred = true;
      actions.push(fix);

      const explain = new vscode.CodeAction('Explain with QodeX', vscode.CodeActionKind.QuickFix);
      explain.command = { command: 'qodex.explainDiagnostic', title: 'Explain with QodeX', arguments: [document.uri, diagRange] };
      explain.diagnostics = [...context.diagnostics];
      actions.push(explain);
    }

    // 2) General actions — available on any non-empty selection, even with no error,
    // so QodeX shows up in the lightbulb the way the user expects (like other AI tools).
    if (!range.isEmpty) {
      const ask = new vscode.CodeAction('Ask QodeX about this', vscode.CodeActionKind.QuickFix);
      ask.command = { command: 'qodex.askAboutSelection', title: 'Ask QodeX about this' };
      actions.push(ask);

      const edit = new vscode.CodeAction('Edit this file with QodeX', vscode.CodeActionKind.QuickFix);
      edit.command = { command: 'qodex.editCurrentFile', title: 'Edit this file with QodeX' };
      actions.push(edit);
    }

    return actions;
  }
}

/** Status bar entry — quick launch button. */
function createStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = '$(rocket) QodeX';
  item.tooltip = 'Open QodeX in terminal (Cmd+Alt+Q)';
  item.command = 'qodex.openInTerminal';
  item.show();
  context.subscriptions.push(item);
  return item;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('qodex.openInTerminal', openInTerminal),
    vscode.commands.registerCommand('qodex.askAboutSelection', askAboutSelection),
    vscode.commands.registerCommand('qodex.editCurrentFile', editCurrentFile),
    vscode.commands.registerCommand('qodex.runPlan', runPlan),
    vscode.commands.registerCommand('qodex.networkDiag', networkDiag),
    vscode.commands.registerCommand('qodex.fixDiagnostics', fixDiagnostics),
    vscode.commands.registerCommand('qodex.explainDiagnostic', explainDiagnostic),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new QodexCodeActionProvider(),
      QodexCodeActionProvider.metadata,
    ),
  );
  createStatusBar(context);
}

export function deactivate(): void {}
