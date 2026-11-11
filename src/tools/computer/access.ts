/**
 * Named desktop controls — the accessibility tree, not a guessed pixel.
 *
 * macOS reads AX via System Events. Windows reads UI Automation.
 * Linux reads AT-SPI when python3-gi is installed. If that backend is
 * missing, the tool errors. It does not invent a click.
 *
 * computer_use_invoke refuses 0 matches and refuses more than one.
 * It asks every time, presses that one control, then reads the tree again.
 * "gone" or "changed" is the only verified result. A control that still
 * looks the same is reported as unverified, not as success.
 */
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { confirmScreenChange } from './use.js';

export const UI_CAP = 80;

export interface UiNode {
  app: string;
  role: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
  value: string;
}

export interface UiQuery {
  name: string;
  role?: string;
  app?: string;
}

export function assertQuery(name: string, app?: string, role?: string): string | null {
  const n = name.trim();
  if (n.length < 2 || n.length > 80) return 'name must be 2–80 characters — a one-letter name is not a control';
  if (/[\r\n\t"\\]/.test(n)) return 'name cannot contain quotes, backslashes, or line breaks';
  for (const extra of [app, role]) {
    if (extra == null || extra.trim() === '') continue;
    if (extra.trim().length > 80 || /[\r\n\t"\\]/.test(extra)) return 'app and role cannot contain quotes or line breaks';
  }
  return null;
}

export function parseUiTree(raw: string, cap = UI_CAP): { nodes: UiNode[]; capped: boolean } {
  const nodes: UiNode[] = [];
  let capped = false;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('CAP\t')) { capped = true; continue; }
    if (!line.startsWith('EL\t')) continue;
    const p = line.split('\t');
    if (p.length < 9) continue;
    const app = p[1] ?? '';
    const role = p[2] ?? '';
    const name = (p[3] ?? '').trim();
    if (!name) continue;
    const x = Number(p[4]);
    const y = Number(p[5]);
    const w = Number(p[6]);
    const h = Number(p[7]);
    if (![x, y, w, h].every(n => Number.isFinite(n))) continue;
    nodes.push({
      app,
      role,
      name,
      x, y, w, h,
      enabled: p[8] !== '0',
      value: (p[9] ?? '').trim(),
    });
    if (nodes.length >= cap) { capped = true; break; }
  }
  return { nodes, capped };
}

export function pickControl(
  nodes: UiNode[],
  query: UiQuery,
): { ok: true; node: UiNode } | { ok: false; reason: string; matches: UiNode[] } {
  const bad = assertQuery(query.name, query.app, query.role);
  if (bad) return { ok: false, reason: bad, matches: [] };
  const want = query.name.trim().toLowerCase();
  const role = query.role?.trim().toLowerCase();
  const app = query.app?.trim().toLowerCase();
  const matches = nodes.filter(n => {
    if (!n.name.toLowerCase().includes(want)) return false;
    if (role && !n.role.toLowerCase().includes(role)) return false;
    if (app && n.app.toLowerCase() !== app) return false;
    return true;
  });
  if (matches.length === 0) return { ok: false, reason: `no control matching "${query.name.trim()}"`, matches };
  if (matches.length > 1) {
    return { ok: false, reason: `${matches.length} controls match "${query.name.trim()}" — pass role or app so only one remains`, matches };
  }
  return { ok: true, node: matches[0]! };
}

export function findSame(nodes: UiNode[], before: UiNode): UiNode | null {
  const hits = nodes.filter(n => n.app === before.app && n.role === before.role && n.name === before.name);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0]!;
  return hits.find(n => n.x === before.x && n.y === before.y) ?? hits[0]!;
}

/** gone = the control left the tree. changed = bounds, enabled, name, or value moved. same = not verified. */
export function verifyInvoke(before: UiNode, after: UiNode | null): 'gone' | 'changed' | 'same' {
  if (!after) return 'gone';
  if (
    before.x !== after.x || before.y !== after.y || before.w !== after.w || before.h !== after.h
    || before.enabled !== after.enabled || before.name !== after.name || before.value !== after.value
  ) return 'changed';
  return 'same';
}

export function formatTree(nodes: UiNode[], capped: boolean): string {
  if (nodes.length === 0) return 'No named controls. The accessibility tree was empty or every row lacked a name.';
  const lines = nodes.map((n, i) => {
    const value = n.value ? ` =${n.value}` : '';
    const off = n.enabled ? '' : ' disabled';
    return `${i + 1}. [${n.role}] ${n.name}${value}${off} — ${n.app} @ ${n.x},${n.y} ${n.w}x${n.h}`;
  });
  if (capped) lines.push(`(capped at ${nodes.length})`);
  return lines.join('\n');
}

function escAs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function macosTreeScript(app?: string): string {
  const filter = app?.trim() ? escAs(app.trim()) : '';
  return `on clean(rawText)
  set t to rawText as text
  set AppleScript's text item delimiters to {tab, linefeed, return}
  set bits to text items of t
  set AppleScript's text item delimiters to " "
  set t to bits as text
  set AppleScript's text item delimiters to ""
  if (length of t) > 120 then set t to text 1 thru 120 of t
  return t
end clean
set rows to {}
set n to 0
set cap to false
set wantApp to "${filter}"
tell application "System Events"
  repeat with p in (every process whose background only is false)
    if n ≥ ${UI_CAP} then
      set cap to true
      exit repeat
    end if
    set pname to my clean(name of p)
    if wantApp is "" or pname is wantApp then
      try
        repeat with w in windows of p
          if n ≥ ${UI_CAP} then
            set cap to true
            exit repeat
          end if
          try
            set elems to UI elements of w
          on error
            set elems to {}
          end try
          repeat with e in elems
            if n ≥ ${UI_CAP} then
              set cap to true
              exit repeat
            end if
            try
              set rname to my clean(name of e)
              if rname is not "" then
                set rrole to my clean(role of e)
                set epos to position of e
                set esz to size of e
                set en to "1"
                try
                  if enabled of e is false then set en to "0"
                end try
                set ev to ""
                try
                  set ev to my clean(value of e as text)
                end try
                set end of rows to "EL" & tab & pname & tab & rrole & tab & rname & tab & (item 1 of epos as integer) & tab & (item 2 of epos as integer) & tab & (item 1 of esz as integer) & tab & (item 2 of esz as integer) & tab & en & tab & ev
                set n to n + 1
              end if
            end try
            try
              set nested to UI elements of e
              repeat with c in nested
                if n ≥ ${UI_CAP} then
                  set cap to true
                  exit repeat
                end if
                try
                  set rname to my clean(name of c)
                  if rname is not "" then
                    set rrole to my clean(role of c)
                    set epos to position of c
                    set esz to size of c
                    set en to "1"
                    try
                      if enabled of c is false then set en to "0"
                    end try
                    set ev to ""
                    try
                      set ev to my clean(value of c as text)
                    end try
                    set end of rows to "EL" & tab & pname & tab & rrole & tab & rname & tab & (item 1 of epos as integer) & tab & (item 2 of epos as integer) & tab & (item 1 of esz as integer) & tab & (item 2 of esz as integer) & tab & en & tab & ev
                    set n to n + 1
                  end if
                end try
              end repeat
            end try
          end repeat
        end repeat
      end try
    end if
  end repeat
end tell
if cap then set end of rows to "CAP" & tab & "1"
set AppleScript's text item delimiters to linefeed
return rows as text
`;
}

/** Clicks the element System Events found. Errors unless the count is exactly one. */
export function macosInvokeScript(app: string, name: string, role?: string): string {
  const roleClause = role?.trim() ? ` and role contains "${escAs(role.trim())}"` : '';
  return `tell application "System Events"
  tell process "${escAs(app)}"
    set hits to {}
    repeat with w in windows
      try
        set hits to hits & (every UI element of w whose name contains "${escAs(name)}"${roleClause})
      end try
      try
        repeat with g in (every UI element of w whose role contains "Group" or role contains "Scroll" or role contains "Toolbar" or role contains "Split")
          try
            set hits to hits & (every UI element of g whose name contains "${escAs(name)}"${roleClause})
          end try
        end repeat
      end try
    end repeat
    if (count of hits) is not 1 then error "QODEX_MATCH " & (count of hits)
    click item 1 of hits
  end tell
end tell
return "OK" & tab & "action"
`;
}

export function windowsTreeScript(): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$script:n = 0
$script:cap = $false
$names = @{}
function ProcName($el) {
  $id = $el.Current.ProcessId
  if (-not $names.ContainsKey($id)) {
    try { $names[$id] = (Get-Process -Id $id -ErrorAction Stop).ProcessName } catch { $names[$id] = "$id" }
  }
  return $names[$id]
}
function Walk($el, $depth) {
  if ($null -eq $el -or $script:n -ge ${UI_CAP} -or $depth -gt 8) { return }
  try {
    $name = [string]$el.Current.Name
    $type = [string]$el.Current.ControlType.ProgrammaticName
    if ($name -and $type -notmatch 'Custom|Pane|Thumb|ScrollBar|TitleBar|Separator') {
      $safe = ($name -replace "[\\t\\r\\n]", ' ')
      if ($safe.Length -gt 120) { $safe = $safe.Substring(0, 120) }
      $r = $el.Current.BoundingRectangle
      $en = '1'; if (-not $el.Current.IsEnabled) { $en = '0' }
      $val = ''
      try {
        $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $val = ([string]$vp.Current.Value) -replace "[\\t\\r\\n]", ' '
        if ($val.Length -gt 40) { $val = $val.Substring(0, 40) }
      } catch {}
      $app = ProcName $el
      Write-Output ("EL\`t$app\`t$type\`t$safe\`t" + [int]$r.X + "\`t" + [int]$r.Y + "\`t" + [int]$r.Width + "\`t" + [int]$r.Height + "\`t$en\`t$val")
      $script:n++
    }
  } catch {}
  if ($depth -ge 8 -or $script:n -ge ${UI_CAP}) { if ($script:n -ge ${UI_CAP}) { $script:cap = $true }; return }
  $child = $walker.GetFirstChild($el)
  while ($null -ne $child) {
    Walk $child ($depth + 1)
    if ($script:n -ge ${UI_CAP}) { $script:cap = $true; break }
    $child = $walker.GetNextSibling($child)
  }
}
Walk ([System.Windows.Automation.AutomationElement]::RootElement) 0
if ($script:cap) { Write-Output "CAP\`t1" }
`;
}

export function windowsInvokeScript(name: string, role?: string, app?: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$needle = ${q(name)}
$role = ${q(role?.trim() ?? '')}
$appf = ${q(app?.trim() ?? '')}
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$script:hits = @()
function ProcName($el) {
  try { return (Get-Process -Id $el.Current.ProcessId -ErrorAction Stop).ProcessName } catch { return '' }
}
function Walk($el, $depth) {
  if ($null -eq $el -or $depth -gt 8 -or $script:hits.Count -gt 1) { return }
  try {
    $name = [string]$el.Current.Name
    $type = [string]$el.Current.ControlType.ProgrammaticName
    $proc = ProcName $el
    $ok = $name -and ($name.ToLower().Contains($needle.ToLower()))
    if ($role -and ($type.ToLower() -notlike "*$($role.ToLower())*")) { $ok = $false }
    if ($appf -and ($proc.ToLower() -ne $appf.ToLower())) { $ok = $false }
    if ($ok) { $script:hits += $el }
  } catch {}
  $child = $walker.GetFirstChild($el)
  while ($null -ne $child) {
    Walk $child ($depth + 1)
    $child = $walker.GetNextSibling($child)
  }
}
Walk ([System.Windows.Automation.AutomationElement]::RootElement) 0
if ($script:hits.Count -ne 1) { Write-Output "ERR\`tQODEX_MATCH $($script:hits.Count)"; exit 2 }
$el = $script:hits[0]
try {
  $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Write-Output "OK\`taction"
  exit 0
} catch {}
try {
  $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
  Write-Output "OK\`taction"
  exit 0
} catch {}
$r = $el.Current.BoundingRectangle
if ($r.Width -lt 1 -or $r.Height -lt 1) { Write-Output "ERR\`tno invoke pattern and no bounds"; exit 3 }
$x = [int]($r.X + $r.Width / 2)
$y = [int]($r.Y + $r.Height / 2)
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class QxMouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e); }'
[QxMouse]::SetCursorPos($x, $y)
[QxMouse]::mouse_event(0x02, 0, 0, 0, 0)
[QxMouse]::mouse_event(0x04, 0, 0, 0, 0)
Write-Output "OK\`tcenter"
`;
}

/** Reads AT-SPI. QODEX_UI_NAME set means invoke; unset means dump the tree. */
export function linuxAtspiScript(): string {
  return `import os, gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
Atspi.init()
CAP = ${UI_CAP}
needle = os.environ.get("QODEX_UI_NAME", "").strip().lower()
role_f = os.environ.get("QODEX_UI_ROLE", "").strip().lower()
app_f = os.environ.get("QODEX_UI_APP", "").strip().lower()

def clean(s, n=120):
    t = (s or "").replace("\\t", " ").replace("\\n", " ").replace("\\r", " ")
    return t[:n]

def extents(acc):
    try:
        c = acc.get_component()
        if c is None:
            return 0, 0, 0, 0
        e = c.get_extents(Atspi.CoordType.SCREEN)
        return int(e.x), int(e.y), int(e.width), int(e.height)
    except Exception:
        return 0, 0, 0, 0

def enabled(acc):
    try:
        return "1" if acc.get_state().contains(Atspi.StateType.ENABLED) else "0"
    except Exception:
        return "1"

hits = []
rows = []
capped = False

def consider(acc, app):
    global capped
    try:
        role = acc.get_role_name() or ""
        name = acc.get_name() or ""
    except Exception:
        return
    if not name or role in ("panel", "filler", "scroll-pane", "frame"):
        return
    if needle:
        ok = needle in name.lower()
        if role_f and role_f not in role.lower():
            ok = False
        if app_f and app.lower() != app_f:
            ok = False
        if ok:
            hits.append(acc)
        return
    if len(rows) >= CAP:
        capped = True
        return
    x, y, w, h = extents(acc)
    rows.append("EL\\t%s\\t%s\\t%s\\t%d\\t%d\\t%d\\t%d\\t%s\\t" % (clean(app, 80), clean(role, 40), clean(name), x, y, w, h, enabled(acc)))

def walk(acc, depth, app):
    if acc is None or depth > 8:
        return
    if not needle and len(rows) >= CAP:
        return
    if needle and len(hits) > 1:
        return
    consider(acc, app)
    try:
        n = acc.get_child_count()
    except Exception:
        return
    for i in range(n):
        try:
            child = acc.get_child_at_index(i)
        except Exception:
            continue
        walk(child, depth + 1, app)

desktop = Atspi.get_desktop(0)
for i in range(desktop.get_child_count()):
    child = desktop.get_child_at_index(i)
    if child is None:
        continue
    walk(child, 0, child.get_name() or "")

if needle:
    if len(hits) != 1:
        print("ERR\\tQODEX_MATCH %d" % len(hits))
        raise SystemExit(2)
    acc = hits[0]
    acted = False
    try:
        action = acc.get_action()
        if action is not None and action.get_n_actions() > 0:
            acted = bool(action.do_action(0))
    except Exception:
        acted = False
    if acted:
        print("OK\\taction")
        raise SystemExit(0)
    x, y, w, h = extents(acc)
    if w < 1 or h < 1:
        print("ERR\\tno action and no bounds")
        raise SystemExit(3)
    cx, cy = x + w // 2, y + h // 2
    import shutil, subprocess
    if not shutil.which("xdotool"):
        print("ERR\\tno action and xdotool is not installed")
        raise SystemExit(3)
    subprocess.check_call(["xdotool", "mousemove", str(cx), str(cy), "click", "1"])
    print("OK\\tcenter")
    raise SystemExit(0)

print("\\n".join(rows))
if capped:
    print("CAP\\t1")
`;
}

export function parseInvokeLine(raw: string): { ok: true; method: 'action' | 'center' } | { ok: false; error: string } {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find(l => l.startsWith('OK\t') || l.startsWith('ERR\t')) ?? lines.at(-1) ?? '';
  if (line.startsWith('OK\t')) {
    const method = line.slice(3).trim();
    if (method === 'action' || method === 'center') return { ok: true, method };
  }
  if (line.startsWith('ERR\t')) return { ok: false, error: line.slice(4).trim() || 'invoke failed' };
  return { ok: false, error: raw.trim().slice(0, 240) || 'invoke produced no result' };
}

function run(cmd: string, args: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, opts.timeoutMs ?? 20_000);
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < 200_000) stdout += d.toString('utf-8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 20_000) stderr += d.toString('utf-8'); });
    child.on('error', err => { stderr += err.message; finish(127); });
    child.on('exit', code => finish(code ?? 1));
    if (opts.stdin) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

async function dumpTree(app?: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const platform = os.platform();
  if (platform === 'darwin') {
    const ran = await run('osascript', ['-'], { stdin: macosTreeScript(app), timeoutMs: 25_000 });
    if (ran.code !== 0) return { ok: false, error: ran.stderr.trim() || ran.stdout.trim() || `osascript exited ${ran.code}` };
    return { ok: true, text: ran.stdout };
  }
  if (platform === 'win32') {
    const ran = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsTreeScript()], { timeoutMs: 25_000 });
    if (ran.code !== 0) return { ok: false, error: ran.stderr.trim() || ran.stdout.trim() || `powershell exited ${ran.code}` };
    return { ok: true, text: ran.stdout };
  }
  if (platform === 'linux') {
    const file = path.join(os.tmpdir(), `qodex-atspi-${process.pid}.py`);
    await fs.writeFile(file, linuxAtspiScript(), 'utf-8');
    const ran = await run('python3', [file], { timeoutMs: 25_000 });
    if (ran.code !== 0) {
      const detail = (ran.stderr || ran.stdout).trim().slice(0, 400);
      return { ok: false, error: detail || 'AT-SPI is not available. Install python3-gi and gir1.2-atspi-2.0. Coordinate click still needs xdotool, and this tool will not pretend the tree exists.' };
    }
    return { ok: true, text: ran.stdout };
  }
  return { ok: false, error: `no accessibility backend for ${platform}` };
}

async function press(node: UiNode, query: UiQuery): Promise<{ ok: true; method: 'action' | 'center' } | { ok: false; error: string }> {
  const platform = os.platform();
  if (platform === 'darwin') {
    const ran = await run('osascript', ['-'], { stdin: macosInvokeScript(node.app, query.name.trim(), query.role), timeoutMs: 15_000 });
    if (ran.code !== 0) return { ok: false, error: ran.stderr.trim() || ran.stdout.trim() || `osascript exited ${ran.code}` };
    return parseInvokeLine(ran.stdout);
  }
  if (platform === 'win32') {
    const ran = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsInvokeScript(query.name.trim(), query.role, query.app?.trim() || node.app)], { timeoutMs: 20_000 });
    return parseInvokeLine(ran.stdout + '\n' + ran.stderr);
  }
  if (platform === 'linux') {
    const file = path.join(os.tmpdir(), `qodex-atspi-${process.pid}.py`);
    await fs.writeFile(file, linuxAtspiScript(), 'utf-8');
    const ran = await run('python3', [file], {
      timeoutMs: 20_000,
      env: {
        ...process.env,
        QODEX_UI_NAME: query.name.trim(),
        QODEX_UI_ROLE: query.role?.trim() ?? '',
        QODEX_UI_APP: query.app?.trim() || node.app,
      },
    });
    return parseInvokeLine(ran.stdout + '\n' + ran.stderr);
  }
  return { ok: false, error: `no accessibility backend for ${platform}` };
}

/** Read-only tree for the desktop shell and the tool. Errors if the backend is missing. */
export async function readUiTree(app?: string): Promise<{ ok: true; text: string; count: number } | { ok: false; error: string }> {
  const dumped = await dumpTree(app);
  if (!dumped.ok) return dumped;
  const tree = parseUiTree(dumped.text);
  return { ok: true, text: formatTree(tree.nodes, tree.capped), count: tree.nodes.length };
}

/**
 * Press one named control. No permission prompt — the caller already asked
 * (the model tool, or the human at the desktop shell).
 */
export async function invokeNamed(query: UiQuery): Promise<ToolResult> {
  const bad = assertQuery(query.name, query.app, query.role);
  if (bad) return { content: `[COMPUTER_USE_ERROR] ${bad}`, isError: true };
  const dumped = await dumpTree(query.app);
  if (!dumped.ok) return { content: `[COMPUTER_USE_ERROR] ${dumped.error}`, isError: true };
  const tree = parseUiTree(dumped.text);
  const picked = pickControl(tree.nodes, query);
  if (!picked.ok) {
    const list = picked.matches.slice(0, 8).map(n => `[${n.role}] ${n.name} — ${n.app}`).join('\n');
    return { content: `[COMPUTER_USE_ERROR] ${picked.reason}${list ? `\n${list}` : ''}`, isError: true };
  }
  const node = picked.node;
  const pressed = await press(node, query);
  if (!pressed.ok) return { content: `[COMPUTER_USE_ERROR] ${pressed.error}`, isError: true };
  const again = await dumpTree(query.app);
  const after = again.ok ? findSame(parseUiTree(again.text).nodes, node) : null;
  const verdict = again.ok ? verifyInvoke(node, after) : 'same';
  const how = pressed.method === 'center'
    ? 'center of the control bounds (no press action on this element)'
    : 'the control\'s own action';
  const head = `Pressed "${node.name}" [${node.role}] in ${node.app} via ${how}.`;
  if (!again.ok) {
    return { content: `${head}\nunverified: could not re-read the tree (${again.error})`, isError: true };
  }
  if (verdict === 'gone') return { content: `${head}\nverified: the control is no longer in the tree.` };
  if (verdict === 'changed') return { content: `${head}\nverified: the control's bounds, value, or enabled state changed.` };
  return { content: `${head}\nunverified: the control still looks the same. Do not claim it worked.`, isError: true };
}

const TreeArgs = z.object({
  app: z.string().optional().describe('Only this app. Omit for every visible app. macOS matches the process name.'),
});

export class ComputerUseTreeTool extends Tool<z.infer<typeof TreeArgs>> {
  name = 'computer_use_tree';
  description = 'Read named controls from the OS accessibility tree (role, name, bounds). macOS Accessibility, Windows UI Automation, Linux AT-SPI. Read-only. If the backend is missing or permission is denied, this errors — it does not invent controls. Use this before computer_use_invoke. Blind computer_use_click is only for when the tree has no name.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = TreeArgs;

  async execute(args: z.infer<typeof TreeArgs>): Promise<ToolResult> {
    if (args.app && /[\r\n\t"\\]/.test(args.app)) {
      return { content: '[COMPUTER_USE_ERROR] app cannot contain quotes or line breaks', isError: true };
    }
    const tree = await readUiTree(args.app);
    if (!tree.ok) return { content: `[COMPUTER_USE_ERROR] ${tree.error}`, isError: true };
    return { content: tree.text, metadata: { count: tree.count } };
  }
}

const InvokeArgs = z.object({
  name: z.string().describe('Visible name of the one control to press, at least 2 characters. "Allow", not "A".'),
  role: z.string().optional().describe('Optional role substring, e.g. button or AXButton, when several controls share the name.'),
  app: z.string().optional().describe('Optional app/process name when the same control exists in two apps.'),
});

export class ComputerUseInvokeTool extends Tool<z.infer<typeof InvokeArgs>> {
  name = 'computer_use_invoke';
  description = 'Press one named control from the accessibility tree. Refuses if zero match or more than one match. Asks every time, then presses. Reads the tree again: gone or changed is verified; a control that still looks the same is unverified, not a success. macOS clicks the element. Windows uses Invoke/Toggle, or the center of that control\'s bounds. Linux uses the AT-SPI action, or xdotool on those bounds. Never a pixel the model guessed.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = InvokeArgs;

  async execute(args: z.infer<typeof InvokeArgs>, ctx: ToolContext): Promise<ToolResult> {
    const bad = assertQuery(args.name, args.app, args.role);
    if (bad) return { content: `[COMPUTER_USE_ERROR] ${bad}`, isError: true };
    const dumped = await dumpTree(args.app);
    if (!dumped.ok) return { content: `[COMPUTER_USE_ERROR] ${dumped.error}`, isError: true };
    const picked = pickControl(parseUiTree(dumped.text).nodes, args);
    if (!picked.ok) {
      const list = picked.matches.slice(0, 8).map(n => `[${n.role}] ${n.name} — ${n.app}`).join('\n');
      return { content: `[COMPUTER_USE_ERROR] ${picked.reason}${list ? `\n${list}` : ''}`, isError: true };
    }
    const blocked = await confirmScreenChange(
      ctx,
      this.name,
      `invoke "${picked.node.name}" (${picked.node.role}) in ${picked.node.app}`,
    );
    if (blocked) return blocked;
    return invokeNamed(args);
  }
}
