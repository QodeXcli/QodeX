/**
 * Shell command analysis for the permission policy.
 *
 * Walks every simple command a shell string executes (chains, pipes, `$( )`, backticks,
 * `bash -c`, `eval`, `find -exec`, `xargs`, `ssh host cmd`, wrappers like sudo/env/nohup/
 * time/timeout/npx) and reports FINDINGS by command position — the executable, its
 * subcommand and flags — never by substring. A path called `shutdown.ts` or a commit
 * message saying "drop table" is not a finding.
 *
 * Findings:
 *   - outside           delete / overwrite / move / chmod of a path OUTSIDE the workspace roots
 *   - remote            history rewrite on a remote, deleting remote data, irreversible publish
 *                       or production deploy
 *   - system            root (sudo/su/doas), power, disks/partitions, raw devices, services
 *   - local-destructive irreversible but inside the project (rm -rf build, git reset --hard)
 *   - remote-code       downloaded code piped into a shell
 *
 * Each finding says whether manual mode treats it as irreversible (confirmed every time, no
 * standing grant) and whether auto mode asks a human. Paths resolve against the tracked
 * cwd (`cd` / `pushd` / `git -C` / `env -C` are followed), `~` and $HOME expand, and existing
 * paths are realpath'd so a symlink cannot smuggle a write out of the project.
 *
 * Unknowable values ($VARS set elsewhere, $(…) output) are treated as unknown, not as
 * outside: auto mode asks only when a command CLEARLY touches an outside path or is on the
 * remote/system lists.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseShell, commandText, type ParsedScript, type SimpleCommand, type Word } from './shell-parse.js';

export type FindingKind = 'outside' | 'remote' | 'system' | 'local-destructive' | 'remote-code';

export interface ShellFinding {
  kind: FindingKind;
  /** Human-readable reason (shown in prompts and the audit trail). */
  reason: string;
  /** Manual mode: confirmed every time, never a standing grant. */
  irreversible: boolean;
  /** Auto mode asks a human. */
  autoAsk: boolean;
}

/** One simple command that runs, as written (for allow-rule / always-ask matching). */
export interface ExecSegment {
  /** Raw text of the simple command (here-doc bodies excluded). */
  text: string;
  /** Offsets in `text` where a command word starts: the executable, and after each wrapper. */
  cmdOffsets: number[];
  /** Effective executable basename after wrappers ('' for an assignment-only segment). */
  exe: string;
  /** `text` from the first real word (shell keywords like `then`/`do` dropped) — what allow rules match. */
  ruleText: string;
  /** From `$( )`, backticks, `bash -c`, `eval`, a here-doc… rather than the top level. */
  nested: boolean;
}

export interface ShellAnalysis {
  findings: ShellFinding[];
  segments: ExecSegment[];
  /** Write targets (redirections, tee, cp/mv destinations…) outside the roots or on a raw device. */
  outsideWrites: string[];
  /** Set when the input was not well-formed. */
  parseError?: string;
}

export interface AnalyzeOptions {
  cwd: string;
  /** Workspace roots (absolute). Nothing outside them is "the project". */
  roots: readonly string[];
}

// ── public entry ─────────────────────────────────────────────────────────────

/** Analyze a shell command string. Never throws. */
export function analyzeShell(command: string, opts: AnalyzeOptions): ShellAnalysis {
  const out: ShellAnalysis = { findings: [], segments: [], outsideWrites: [] };
  try {
    const a = new Analyzer(opts, out, false);
    const script = parseShell(command ?? '');
    if (script.error) out.parseError = script.error;
    a.walk(script, a.initialState(), false);
    // Fork bomb: not a command-position shape, keep the classic signature check.
    if (/:\s*\(\s*\)\s*\{.*\}\s*;\s*:/.test(command ?? '')) {
      a.add('system', 'fork bomb', true, true);
    }
  } catch (e: any) {
    out.parseError = out.parseError ?? `analysis failed: ${e?.message ?? e}`;
  }
  return out;
}

/** Segments that never need an allow rule of their own (pure shell bookkeeping). PURE. */
export function isNeutralSegment(seg: ExecSegment): boolean {
  if (seg.exe === 'cd' || seg.exe === 'pushd' || seg.exe === 'popd' || seg.exe === 'true' || seg.exe === 'false' || seg.exe === ':') return true;
  if (seg.exe === 'set') return /^set(\s+[-+][A-Za-z]+(\s+pipefail)?)*\s*$/.test(seg.text.slice(seg.cmdOffsets[seg.cmdOffsets.length - 1] ?? 0));
  return false;
}

/** Display a path with $HOME shortened to ~. PURE. */
export function displayPath(p: string): string {
  const home = os.homedir();
  if (home && home !== '/' && (p === home || p.startsWith(home + path.sep))) return '~' + p.slice(home.length);
  return p;
}

/** Hosts that count as THIS machine for database / HTTP checks. PURE. */
export function isLocalHost(host: string | null | undefined): boolean {
  if (host === null || host === undefined) return true;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h.startsWith('/')) return true; // unix socket directory
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\./.test(h) || h.endsWith('.localhost') || h === 'host.docker.internal';
}

// ── path helpers (cached realpath) ───────────────────────────────────────────

type PathClass = 'inside' | 'outside' | 'root' | 'ancestor' | 'unknown' | 'device' | 'harmless-device';

/** realpath of `p`, or of its deepest existing ancestor + the rest. */
function realish(p: string, cache: Map<string, string>): string {
  const hit = cache.get(p);
  if (hit !== undefined) return hit;
  let cur = p;
  const tail: string[] = [];
  let real = p;
  for (let i = 0; i < 64; i++) {
    try {
      const r = fs.realpathSync.native(cur);
      real = tail.length ? path.join(r, ...tail) : r;
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) { real = p; break; }
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  cache.set(p, real);
  return real;
}

const HARMLESS_DEV = /^\/dev\/(null|zero|full|random|urandom|stdin|stdout|stderr|tty|ptmx|fd\/\d+|pts\/\d+|shm(\/.*)?)$/;

interface Val {
  /** First value (placeholders \u0001 for unknown parts). */
  v: string;
  /** All alternative values (for-loop variables). */
  alts: string[];
  /** Contains an unknown expansion. */
  dyn: boolean;
  /** Offset in the owning segment's text, or null for synthesized words. */
  off: number | null;
}

const DYN = '\u0001';

interface State {
  cwd: string | null;
  vars: Map<string, string[] | null>;
  depth: number;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish', 'busybox']);
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', '!', '{', '}', '[[', 'function', 'coproc']);
const INTERP_EVAL: Record<string, string[]> = {
  python: ['-c'], python2: ['-c'], python3: ['-c'], pypy: ['-c'], pypy3: ['-c'],
  node: ['-e', '--eval', '-p', '--print'], nodejs: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'], deno: [],
  perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], osascript: ['-e'],
};
const DESTRUCTIVE_CODE = /\b(rmtree|remove|removedirs|unlink|rmdir|rename|replace|move|rmSync|rmdirSync|unlinkSync|renameSync|writeFileSync|writeFile|appendFileSync|appendFile|copyFileSync|cpSync|truncate|truncateSync|write_text|write_bytes|copyfile|copytree|chmod|chown)\b|\bopen\s*\([^)]*['"][wax]\+?b?['"]/;

class Analyzer {
  private realCache = new Map<string, string>();
  private realRoots: string[];
  private rawRoots: string[];
  private seen = new Set<string>();

  constructor(private readonly opts: AnalyzeOptions, private readonly out: ShellAnalysis, private readonly remote: boolean, private readonly remoteHost = '') {
    this.rawRoots = opts.roots.map(r => path.resolve(r));
    this.realRoots = remote ? this.rawRoots : [...new Set([...this.rawRoots, ...this.rawRoots.map(r => realish(r, this.realCache))])];
  }

  initialState(): State {
    return { cwd: this.opts.cwd ? path.resolve(this.opts.cwd) : null, vars: new Map(), depth: 0 };
  }

  add(kind: FindingKind, reason: string, irreversible: boolean, autoAsk: boolean): void {
    const r = this.remote ? `on ${this.remoteHost}: ${reason}` : reason;
    const k = this.remote ? 'remote' : kind;
    const key = `${k}|${r}|${irreversible}|${autoAsk}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.out.findings.push({ kind: k, reason: r, irreversible: this.remote ? true : irreversible, autoAsk: this.remote ? autoAsk || irreversible || kind === 'local-destructive' : autoAsk });
  }

  // ── walking ────────────────────────────────────────────────────────────────

  walk(script: ParsedScript, st: State, nested: boolean): void {
    if (st.depth > 10) return;
    const stack: (string | null)[] = [];
    let prev: Resolved | null = null;
    for (const c of script.commands) {
      for (let k = 0; k < c.opens; k++) stack.push(st.cwd);
      const piped = c.sep === '|' || c.sep === '|&';
      const r = this.resolve(script, c, st);
      r.pipeFrom = piped ? prev : null;
      this.command(r, st, nested);
      prev = r;
      for (let k = 0; k < c.closes; k++) st.cwd = stack.length ? stack.pop()! : st.cwd;
    }
  }

  /** Analyze a nested script (subshell semantics: its cd / vars do not leak out). */
  private nested(script: ParsedScript, st: State): void {
    this.walk(script, { cwd: st.cwd, vars: new Map(st.vars), depth: st.depth + 1 }, true);
  }

  private nestedText(text: string, st: State): void {
    if (!text || st.depth > 10) return;
    this.nested(parseShell(text), st);
  }

  private resolve(script: ParsedScript, c: SimpleCommand, st: State): Resolved {
    const text = commandText(script, c);
    const lead = script.src.slice(c.start).length - script.src.slice(c.start).trimStart().length;
    const base = c.start + lead;
    // Nested scripts in words and here-doc bodies run before the command itself.
    const walkParts = (w: Word) => {
      for (const p of w.parts) {
        if (p.t === 'sub' || p.t === 'proc') this.nested(p.body, st);
        else if ((p.t === 'var' || p.t === 'arith') && p.nested) for (const b of p.nested) this.nested(b, st);
      }
    };
    for (const w of c.words) walkParts(w);
    for (const rd of c.redirects) {
      if (rd.target) walkParts(rd.target);
      for (const s of rd.heredoc?.subs ?? []) this.nested(s, st);
    }
    const assigns: { name: string; val: Val }[] = [];
    let k = 0;
    for (; k < c.words.length; k++) {
      const w = c.words[k]!;
      const first = w.parts[0];
      if (!first || first.t !== 'lit' || first.quoted) break;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(first.v);
      if (!m) break;
      const restParts = [{ ...first, v: first.v.slice(m[0].length) }, ...w.parts.slice(1)];
      // `X=~/foo` expands the tilde in an assignment value.
      const lit0 = restParts[0];
      if (lit0 && lit0.t === 'lit' && /^~(\/|$)/.test(lit0.v)) {
        restParts.splice(0, 1, { t: 'tilde', user: '' } as any, { ...lit0, v: lit0.v.slice(1) });
      }
      assigns.push({ name: m[1]!, val: this.expand({ parts: restParts as any, start: w.start, end: w.end }, st, base) });
    }
    const args = c.words.slice(k).map(w => this.expand(w, st, base));
    return { script, cmd: c, text, base, assigns, args, pipeFrom: null };
  }

  /** Expand a word with the tracked variables. */
  private expand(w: Word, st: State, base: number): Val {
    let outs: string[] = [''];
    let dyn = false;
    const home = this.remote ? '/__remote_home__' : os.homedir();
    const push = (vals: string[]) => {
      const next: string[] = [];
      for (const o of outs) for (const v of vals) { if (next.length < 32) next.push(o + v); }
      outs = next;
    };
    for (let pi = 0; pi < w.parts.length; pi++) {
      const p = w.parts[pi]!;
      if (p.t === 'lit') {
        // Brace expansion on unquoted text (`{~/a,b}` → `~/a b`; a tilde produced at the
        // start of an alternative expands too, as in bash).
        if (!p.quoted && /\{[^{}]*,[^{}]*\}/.test(p.v)) {
          const alts = braceExpand(p.v).map(s => (pi === 0 && (s === '~' || s.startsWith('~/')) ? home + s.slice(1) : s));
          push(alts);
        } else push([p.v]);
      }
      else if (p.t === 'tilde') push([p.user ? path.join(path.dirname(home), p.user) : home]);
      else if (p.t === 'var') {
        const vals = p.op && /^[#!]/.test(p.op) ? null : this.lookupVar(p.name, st, home);
        if (vals && vals.length) push(vals);
        else { dyn = true; push([DYN]); }
      } else if (p.t === 'sub') {
        const v = this.substitutionValue(p.body, st);
        if (v !== null) push([v]); else { dyn = true; push([DYN]); }
      } else if (p.t === 'proc') push(['/dev/fd/63']);
      else { dyn = true; push([DYN]); }
    }
    return { v: outs[0] ?? '', alts: outs, dyn, off: w.start - base };
  }

  private lookupVar(name: string, st: State, home: string): string[] | null {
    if (st.vars.has(name)) return st.vars.get(name) ?? null;
    if (this.remote) return name === 'HOME' ? [home] : null;
    if (name === 'HOME') return [home];
    if (name === 'PWD') return st.cwd ? [st.cwd] : null;
    if (name === 'TMPDIR') return [process.env.TMPDIR || os.tmpdir()];
    if (name === 'USER' || name === 'LOGNAME') { try { return [os.userInfo().username]; } catch { return null; } }
    if (!/^[A-Za-z_]/.test(name)) return null;
    const env = process.env[name];
    return env !== undefined && env !== '' ? [env] : null;
  }

  /** Value of `$( … )` when it is knowable: $(pwd) and $(mktemp …). */
  private substitutionValue(body: ParsedScript, st: State): string | null {
    if (body.commands.length !== 1) return null;
    const c = body.commands[0]!;
    const w0 = c.words[0];
    const exe = w0 && w0.parts.length === 1 && w0.parts[0]!.t === 'lit' ? (w0.parts[0] as any).v : '';
    if (exe === 'pwd' && c.words.length === 1) return st.cwd;
    if (exe === 'mktemp' && !this.remote) return path.join(os.tmpdir(), 'mktemp.XXXXXX');
    return null;
  }

  // ── per command ────────────────────────────────────────────────────────────

  private command(r: Resolved, st: State, nested: boolean): void {
    // Shell keywords in front of a command (`then rm …`, `do …`, `! …`) are not the command.
    let args = r.args;
    while (args.length && !args[0]!.dyn && RESERVED.has(args[0]!.v) && r.assigns.length === 0) args = args.slice(1);
    const ruleStart = args.length && args[0]!.off !== null && r.assigns.length === 0 ? args[0]!.off! : 0;
    const seg: ExecSegment = { text: r.text, cmdOffsets: [], exe: '', nested, ruleText: r.text.slice(ruleStart) };
    if (!this.remote) this.out.segments.push(seg);

    // Redirections first (they apply whatever the command is).
    for (const rd of r.cmd.redirects) {
      if (rd.dup || !rd.target) continue;
      if (rd.op === '<' || rd.op === '<<<' || rd.op === '<&') continue;
      const v = this.expand(rd.target, st, r.base);
      this.checkWrite(v, st.cwd, 'writes');
    }

    if (!args.length) {
      // Assignment-only segment: remember the values for later segments.
      for (const a of r.assigns) st.vars.set(a.name, a.val.dyn ? null : a.val.alts);
      return;
    }

    const exe = args[0]!.dyn ? '' : baseName(args[0]!.v);
    const home = this.remote ? '/__remote_home__' : os.homedir();
    if (exe === 'cd' || exe === 'pushd' || exe === 'popd' || exe === 'for' || exe === 'select' ||
        exe === 'export' || exe === 'declare' || exe === 'typeset' || exe === 'local' || exe === 'readonly') {
      seg.exe = exe;
      if (args[0]!.off !== null) seg.cmdOffsets.push(args[0]!.off);
      const rest = args.slice(1);
      if (exe === 'cd' || exe === 'pushd') {
        const target = rest.filter(x => x.v !== '-P' && x.v !== '-L' && x.v !== '--')[0];
        if (!target) st.cwd = exe === 'cd' ? home : st.cwd;
        else if (target.v === '-') st.cwd = null;
        else st.cwd = target.dyn ? null : this.resolvePath(target, st.cwd);
      } else if (exe === 'popd') {
        st.cwd = null;
      } else if (exe === 'for' || exe === 'select') {
        const name = rest[0]?.v ?? '';
        const inIdx = rest.findIndex(x => x.v === 'in');
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          const items = inIdx >= 0 ? rest.slice(inIdx + 1) : [];
          st.vars.set(name, items.length && items.every(x => !x.dyn) ? items.flatMap(x => x.alts).slice(0, 32) : null);
        }
      } else {
        for (const x of rest) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/s.exec(x.v);
          if (!m) continue;
          let val = m[2]!;
          if (val === '~' || val.startsWith('~/')) val = home + val.slice(1);
          st.vars.set(m[1]!, x.dyn ? null : [val]);
        }
      }
      return;
    }
    this.exec(args, st, r, seg);
  }

  /**
   * Classify one executed argv (after the caller's wrappers). `seg` collects command
   * offsets for the segment the argv came from (null for synthesized argv).
   */
  private exec(argv: Val[], st: State, r: Resolved | null, seg: ExecSegment | null): void {
    let a = argv;
    let cwd = st.cwd;
    for (let guard = 0; guard < 12 && a.length; guard++) {
      const w0 = a[0]!;
      if (seg && w0.off !== null) seg.cmdOffsets.push(w0.off);
      const exe = w0.dyn ? '' : baseName(w0.v);
      if (seg) seg.exe = exe;
      const next = this.unwrap(exe, a, st, r, (dir) => { cwd = dir; });
      if (next === 'stop') return;
      if (!next) break;
      a = next;
    }
    if (!a.length) return;
    this.classify(a, { ...st, cwd }, r);
  }

  /**
   * Strip a wrapper (sudo, env, nohup, time, timeout, xargs, npx, …). Returns the wrapped
   * argv, null when `exe` is not a wrapper, or 'stop' when the wrapper consumed everything.
   */
  private unwrap(exe: string, a: Val[], st: State, r: Resolved | null, setCwd: (d: string | null) => void): Val[] | null | 'stop' {
    const rest = a.slice(1);
    switch (exe) {
      case 'sudo': case 'doas': case 'pkexec': case 'run0': {
        this.add('system', `runs as root (${exe})`, false, true);
        const i = skipOpts(rest, ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--role', '--type', '--command-timeout', '--other-user']);
        return rest.slice(i);
      }
      case 'su': {
        this.add('system', 'switches user (su)', false, true);
        const ci = rest.findIndex(x => x.v === '-c' || x.v === '--command');
        if (ci >= 0 && rest[ci + 1]) this.nestedText(rest[ci + 1]!.v, st);
        return 'stop';
      }
      case 'env': {
        let i = 0;
        while (i < rest.length) {
          const t = rest[i]!.v;
          if (t === '--') { i++; break; }
          if (t === '-u' || t === '--unset') { i += 2; continue; }
          if (t === '-C' || t === '--chdir') { setCwd(this.resolvePath(rest[i + 1], st.cwd)); i += 2; continue; }
          if (t.startsWith('--chdir=')) { setCwd(this.resolvePath({ ...rest[i]!, v: t.slice(8), alts: [t.slice(8)] }, st.cwd)); i++; continue; }
          if (t === '-S' || t === '--split-string') { if (rest[i + 1]) this.nestedText(rest.slice(i + 1).map(x => x.v).join(' '), st); return 'stop'; }
          if (t.startsWith('-')) { i++; continue; }
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
          break;
        }
        return rest.slice(i);
      }
      case 'nohup': case 'command': case 'builtin': case 'exec': case 'time': case 'chronic': case 'unbuffer': case 'setsid': case 'caffeinate': case 'stdbuf': case 'nice': case 'ionice': case 'chrt': case 'taskset': case 'catchsegv': case 'strace': case 'ltrace': case 'valgrind': case 'faketime': {
        if (exe === 'command' && rest[0] && /^-[vV]$/.test(rest[0].v)) return 'stop'; // `command -v x` only looks up
        const valued: Record<string, string[]> = {
          nice: ['-n', '--adjustment'], ionice: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'], stdbuf: ['-i', '-o', '-e'],
          chrt: [], taskset: [], strace: ['-o', '-e', '-p', '-s', '-u'], ltrace: ['-o', '-e', '-p', '-s', '-u'], valgrind: [], time: ['-o', '-f', '--output', '--format'],
          exec: ['-a'], faketime: ['-f'],
        };
        let i = skipOpts(rest, valued[exe] ?? []);
        if ((exe === 'chrt' || exe === 'taskset' || exe === 'faketime') && rest[i]) i++; // priority / mask / timestamp
        return rest.slice(i);
      }
      case 'timeout': {
        let i = skipOpts(rest, ['-s', '-k', '--signal', '--kill-after']);
        if (rest[i]) i++; // duration
        return rest.slice(i);
      }
      case 'watch': {
        const i = skipOpts(rest, ['-n', '-d', '--interval', '-c', '-x']);
        this.nestedText(rest.slice(i).map(x => x.v).join(' '), st);
        return 'stop';
      }
      case 'flock': {
        const ci = rest.findIndex(x => x.v === '-c' || x.v === '--command');
        if (ci >= 0 && rest[ci + 1]) { this.nestedText(rest[ci + 1]!.v, st); return 'stop'; }
        let i = skipOpts(rest, ['-w', '--timeout', '-E', '--conflict-exit-code']);
        if (rest[i]) i++; // lock file
        return rest.slice(i);
      }
      case 'xargs': {
        const i = skipOpts(rest, ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines', '--eof', '--replace', '--max-chars', '--process-slot-var'], (t) => /^-[iIlL]./.test(t) || /^-(e|i|l)$/.test(t));
        const replI = rest.slice(0, i).findIndex(x => x.v === '-I' || x.v === '--replace' || /^-I./.test(x.v) || /^-i/.test(x.v));
        const repl = replI >= 0 ? (rest[replI]!.v === '-I' || rest[replI]!.v === '--replace' ? rest[replI + 1]?.v ?? '{}' : rest[replI]!.v.slice(2) || '{}') : null;
        const inner = rest.slice(i);
        if (!inner.length) return 'stop'; // default command is echo
        const items = r?.pipeFrom ? this.pipedItems(r.pipeFrom, st) : null;
        if (items && items.length) {
          const itemVals = items.map(p => ({ v: p, alts: [p], dyn: false, off: null }));
          let argv: Val[];
          if (repl) argv = inner.map(x => (x.v.includes(repl) ? { ...x, v: x.v.split(repl).join(items[0]!), alts: items.map(it => x.v.split(repl).join(it)), off: x.off } : x));
          else argv = [...inner, ...itemVals];
          this.exec(argv, st, null, null);
          return 'stop';
        }
        return inner;
      }
      case 'npx': case 'pnpx': case 'bunx': {
        const ci = rest.findIndex(x => x.v === '-c' || x.v === '--call');
        if (ci >= 0 && rest[ci + 1]) { this.nestedText(rest[ci + 1]!.v, st); return 'stop'; }
        const i = skipOpts(rest, ['-p', '--package']);
        return rest.slice(i);
      }
      case 'npm': case 'pnpm': case 'yarn': case 'bun': {
        const sub = rest.find(x => !x.v.startsWith('-'))?.v;
        if (sub === 'exec' || sub === 'x' || sub === 'dlx') {
          const si = rest.findIndex(x => x.v === sub);
          const after = rest.slice(si + 1);
          const ci = after.findIndex(x => x.v === '-c' || x.v === '--call');
          if (ci >= 0 && after[ci + 1]) { this.nestedText(after[ci + 1]!.v, st); return 'stop'; }
          const i = skipOpts(after, ['-p', '--package', '--filter', '-w', '--workspace']);
          return after.slice(i);
        }
        return null;
      }
      case 'uv': case 'poetry': case 'pipenv': case 'pdm': case 'hatch': case 'rye': case 'bundle': case 'pixi': {
        const sub = rest[0]?.v;
        if ((sub === 'run' && exe !== 'bundle') || (sub === 'exec' && exe === 'bundle')) {
          const after = rest.slice(1);
          const i = skipOpts(after, ['--with', '--python', '-p', '--env', '-e', '--project', '--directory', '--extra']);
          return after.slice(i);
        }
        return null;
      }
      default:
        return null;
    }
  }

  /** Paths a pipeline feeds to xargs, when the producer is recognisable. */
  private pipedItems(from: Resolved, st: State): string[] | null {
    const a = from.args;
    if (!a.length) return null;
    const exe = baseName(a[0]!.v);
    const cwd = st.cwd;
    const child = (p: string) => path.join(p, '__item__');
    if (exe === 'find') {
      const starts = findStarts(a).map(x => this.resolvePath(x, cwd)).filter((p): p is string => !!p);
      return starts.length ? starts.map(child) : null;
    }
    if (exe === 'ls') {
      const ops = a.slice(1).filter(x => !x.v.startsWith('-') && !x.dyn);
      if (!ops.length) return cwd ? [child(cwd)] : null;
      return ops.map(x => this.resolvePath(x, cwd)).filter((p): p is string => !!p);
    }
    if (exe === 'echo' || exe === 'printf') {
      const ops = a.slice(1).filter(x => !x.v.startsWith('-') && !x.dyn).flatMap(x => x.v.split(/\s+/)).filter(Boolean);
      return ops.map(v => this.resolvePath({ v, alts: [v], dyn: false, off: null }, cwd)).filter((p): p is string => !!p);
    }
    if ((exe === 'git' || exe === 'grep' || exe === 'rg' || exe === 'fd') && cwd) return [child(cwd)];
    return null;
  }

  // ── classification of one effective argv ───────────────────────────────────

  private classify(a: Val[], st: State, r: Resolved | null): void {
    // A command word built at run time (`$(echo rm) -rf ~/x`, `$CMD /etc/x`) is unknowable;
    // when it is pointed at a path clearly outside the project, ask.
    if (a[0]!.dyn) {
      for (const x of a.slice(1)) {
        if (x.dyn || !/^(~|\/|\.\.)/.test(x.v)) continue;
        const p = this.resolvePath(x, st.cwd);
        const cls = p ? this.classOf(p) : 'unknown';
        if (cls === 'outside' || cls === 'ancestor' || cls === 'device') {
          this.add('outside', `runs a command built at run time on ${displayPath(p!)} (outside the project)`, false, true);
          return;
        }
      }
      return;
    }
    const exe0 = baseName(a[0]!.v);
    const exe = exe0.replace(/\.exe$/i, '');
    const args = a.slice(1);
    const vals = args.map(x => x.v);
    const cwd = st.cwd;
    const has = (...flags: string[]) => vals.some(v => flags.includes(v));
    const shortHas = (ch: string) => vals.some(v => /^-[A-Za-z]+$/.test(v) && v.slice(1).includes(ch));
    const positional = () => args.filter(x => !x.v.startsWith('-'));

    // SQL typed straight into the shell (`DROP TABLE users;`).
    if (/^(drop|truncate)$/i.test(exe) && /^(table|database|schema)$/i.test(vals[0] ?? '')) {
      this.add('local-destructive', 'destroys database objects', true, false);
      return;
    }

    switch (exe) {
      // ── deletes / writes ──────────────────────────────────────────────────
      case 'rm': case 'unlink': case 'rmdir': case 'shred': case 'srm': {
        const ops = operands(args);
        if (exe === 'rm' && (shortHas('r') || shortHas('R') || shortHas('f') || has('--recursive', '--force'))) {
          this.add('local-destructive', 'recursive/forced delete', true, false);
        }
        if (exe === 'shred' || exe === 'srm') this.add('local-destructive', 'destroys file contents', true, false);
        if (exe === 'rmdir' && ops.some(o => o.v === '/')) this.add('local-destructive', 'removing a root directory', true, false);
        for (const o of ops) this.checkDelete(o, cwd, exe === 'shred' ? 'destroys' : 'deletes');
        return;
      }
      case 'mv': {
        const { sources, dest } = srcDest(args, ['-t', '--target-directory', '-S', '--suffix']);
        for (const s of sources) this.checkDelete(s, cwd, 'moves');
        if (dest) this.checkWrite(dest, cwd, 'moves files into');
        return;
      }
      case 'cp': case 'install': case 'ditto': {
        if (exe === 'install' && has('-d', '--directory')) return;
        const { dest } = srcDest(args, ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group']);
        if (dest) this.checkWrite(dest, cwd, 'copies onto');
        return;
      }
      case 'ln': {
        if (!(shortHas('f') || has('--force'))) return;
        const { dest } = srcDest(args, ['-t', '--target-directory', '-S', '--suffix']);
        if (dest) this.checkWrite(dest, cwd, 'replaces');
        return;
      }
      case 'tee': {
        for (const o of operands(args)) this.checkWrite(o, cwd, 'writes');
        return;
      }
      case 'truncate': {
        this.add('local-destructive', 'truncates file contents', true, false);
        for (const o of operands(args, ['-s', '--size', '-r', '--reference'])) this.checkWrite(o, cwd, 'truncates');
        return;
      }
      case 'chmod': case 'chown': case 'chgrp': case 'chattr': case 'setfacl': {
        const ref = vals.some(v => v.startsWith('--reference'));
        const ops = operands(args, ['--from']).slice(ref ? 0 : 1);
        const recursive = shortHas('R') || has('--recursive');
        if (recursive && ops.some(o => o.v === '/' || o.v === '/*')) this.add('system', `recursive ${exe} on /`, true, true);
        if (exe === 'chmod' && ops.some(o => o.v === '/') && /^[0-7]*777$/.test(vals.find(v => !v.startsWith('-')) ?? '')) this.add('system', 'world-writable root', true, true);
        for (const o of ops) this.checkPath(o, cwd, 'chmod', `changes permissions of`);
        return;
      }
      case 'dd': {
        const of = args.find(x => x.v.startsWith('of='));
        if (of || args.some(x => x.v.startsWith('if='))) this.add('local-destructive', 'raw disk write', true, false);
        if (of) {
          const v = { ...of, v: of.v.slice(3), alts: of.alts.map(s => s.replace(/^of=/, '')) };
          this.checkWrite(v, cwd, 'writes');
        }
        return;
      }
      case 'sed': case 'gsed': {
        if (!vals.some(v => /^--in-place(=.*)?$/.test(v) || /^-[nErsuz]*i/.test(v))) return;
        const scriptGiven = vals.some(v => v === '-e' || v === '-f' || v.startsWith('--expression') || v.startsWith('--file'));
        let ops = operands(args, ['-e', '-f', '--expression', '--file', '-l', '--line-length']);
        if (!scriptGiven) ops = ops.slice(1);
        for (const o of ops) this.checkWrite(o, cwd, 'edits in place');
        return;
      }
      case 'perl': {
        const inPlace = vals.some(v => /^-[A-Za-z]*i/.test(v));
        const files: Val[] = [];
        let code = false;
        for (let i = 0; i < args.length; i++) {
          const t = args[i]!.v;
          if (/^-[A-Za-z]*[eE]$/.test(t)) { if (args[i + 1]) this.codeText('perl', args[i + 1]!.v, st); code = true; i++; continue; }
          if (t.startsWith('-')) continue;
          files.push(args[i]!);
        }
        if (inPlace) for (const f of code ? files : files.slice(1)) this.checkWrite(f, cwd, 'edits in place');
        return;
      }
      case 'rimraf': case 'del': case 'del-cli': case 'trash': case 'trash-put': case 'rmtrash': {
        if (exe === 'rimraf' || exe.startsWith('del')) this.add('local-destructive', 'recursive delete', true, false);
        for (const o of operands(args)) this.checkDelete(o, cwd, 'deletes');
        return;
      }
      case 'curl': {
        for (let i = 0; i < args.length; i++) {
          const t = args[i]!.v;
          if (t === '-o' || t === '--output' || (/^-[A-Za-z]*o$/.test(t) && !t.startsWith('--'))) { if (args[i + 1]) this.checkWrite(args[i + 1]!, cwd, 'downloads onto'); i++; continue; }
          if (t.startsWith('--output=')) this.checkWrite({ ...args[i]!, v: t.slice(9), alts: [t.slice(9)] }, cwd, 'downloads onto');
          if (t === '--output-dir' && args[i + 1]) { this.checkWrite(args[i + 1]!, cwd, 'downloads into'); i++; }
        }
        const method = methodOf(vals);
        if (method === 'DELETE') {
          const host = urlHost(vals.find(v => /^https?:\/\//i.test(v)) ?? '');
          if (host !== null && !isLocalHost(host)) this.add('remote', `HTTP DELETE on ${host} (deletes remote data)`, true, true);
        }
        this.remoteCodePipe(r, st);
        return;
      }
      case 'wget': {
        for (let i = 0; i < args.length; i++) {
          const t = args[i]!.v;
          if (t === '-O' || t === '--output-document' || t === '-P' || t === '--directory-prefix') { if (args[i + 1] && args[i + 1]!.v !== '-') this.checkWrite(args[i + 1]!, cwd, 'downloads onto'); i++; continue; }
          const m = /^--(output-document|directory-prefix)=(.*)$/.exec(t);
          if (m && m[2] !== '-') this.checkWrite({ ...args[i]!, v: m[2]!, alts: [m[2]!] }, cwd, 'downloads onto');
        }
        this.remoteCodePipe(r, st);
        return;
      }
      case 'http': case 'https': case 'xh': case 'xhs': {
        const p = positional();
        if (p[0] && p[0].v.toUpperCase() === 'DELETE' && p[1]) {
          const host = urlHost(/^https?:/i.test(p[1].v) ? p[1].v : `http://${p[1].v.replace(/^:/, 'localhost:')}`);
          if (host !== null && !isLocalHost(host)) this.add('remote', `HTTP DELETE on ${host} (deletes remote data)`, true, true);
        }
        return;
      }
      case 'tar': case 'bsdtar': case 'gtar': {
        const first = vals[0] ?? '';
        const extract = has('-x', '--extract', '--get') || (/^[A-Za-z]+$/.test(first) && first.includes('x')) || shortHas('x');
        const create = has('-c', '--create') || (/^[A-Za-z]+$/.test(first) && first.includes('c')) || shortHas('c');
        if (extract) {
          const ci = args.findIndex(x => x.v === '-C' || x.v === '--directory');
          const eq = args.find(x => x.v.startsWith('--directory='));
          const dir = ci >= 0 ? args[ci + 1] : eq ? { ...eq, v: eq.v.slice(12), alts: [eq.v.slice(12)] } : null;
          if (dir) this.checkWrite(dir, cwd, 'extracts into');
        }
        if (create) {
          const fi = args.findIndex(x => x.v === '-f' || x.v === '--file' || (/^-[A-Za-z]*f$/.test(x.v)));
          if (fi >= 0 && args[fi + 1] && args[fi + 1]!.v !== '-') this.checkWrite(args[fi + 1]!, cwd, 'writes');
          else if (/^[A-Za-z]+$/.test(first) && first.includes('f')) {
            const f = args[1];
            if (f && f.v !== '-') this.checkWrite(f, cwd, 'writes');
          }
        }
        return;
      }
      case 'unzip': case 'ditto-x': {
        const di = args.findIndex(x => x.v === '-d');
        if (di >= 0 && args[di + 1]) this.checkWrite(args[di + 1]!, cwd, 'extracts into');
        return;
      }
      case 'rsync': {
        const { sources, dest } = srcDest(args, ['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--exclude-from', '--include-from', '--files-from', '--rsync-path', '--log-file', '--password-file', '--chmod', '--chown', '--backup-dir', '--partial-dir', '--temp-dir', '-T', '--compare-dest', '--copy-dest', '--link-dest', '--port', '--timeout', '--bwlimit', '--max-size', '--min-size', '--suffix']);
        const del = vals.some(v => v.startsWith('--delete') || v === '--del');
        if (dest && isRemoteSpec(dest.v)) this.add('remote', `rsync writes to ${remoteName(dest.v)}${del ? ' and deletes there' : ''}`, del, true);
        else if (dest) this.checkWrite(dest, cwd, del ? 'syncs (with deletes) into' : 'syncs onto');
        if (vals.includes('--remove-source-files')) for (const s of sources) if (!isRemoteSpec(s.v)) this.checkDelete(s, cwd, 'moves');
        return;
      }
      case 'scp': case 'sftp': {
        const { dest } = srcDest(args, ['-P', '-i', '-o', '-F', '-c', '-l', '-S', '-J', '-D', '-X']);
        if (exe === 'scp' && dest) {
          if (isRemoteSpec(dest.v)) this.add('remote', `copies files to ${remoteName(dest.v)}`, false, true);
          else this.checkWrite(dest, cwd, 'copies onto');
        }
        return;
      }
      case 'ssh': case 'mosh': {
        const i = skipOpts(args, ['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B']);
        const host = args[i]?.v;
        const remoteCmd = args.slice(i + 1).map(x => x.v).join(' ');
        if (!host || !remoteCmd.trim()) return;
        const sub: ShellAnalysis = { findings: [], segments: [], outsideWrites: [] };
        const ra = new Analyzer({ cwd: '/__remote_home__', roots: [] }, sub, true, host.replace(/^.*@/, ''));
        ra.walk(parseShell(remoteCmd), ra.initialState(), true);
        for (const f of sub.findings) this.add('remote', f.reason, f.irreversible, f.autoAsk);
        return;
      }
      case 'find': {
        const starts = findStarts(a);
        const expr = a.slice(1 + findStartIndex(a) + starts.length);
        for (let i = 0; i < expr.length; i++) {
          const t = expr[i]!.v;
          if (t === '-delete') {
            this.add('local-destructive', 'find -delete deletes files', true, false);
            for (const s of starts) this.checkDelete(childOf(s), cwd, 'deletes files under');
          } else if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
            const inner: Val[] = [];
            let j = i + 1;
            for (; j < expr.length && expr[j]!.v !== ';' && expr[j]!.v !== '+'; j++) inner.push(expr[j]!);
            i = j;
            if (!inner.length) continue;
            if (/^(rm|unlink|shred|rmdir|srm)$/.test(baseName(inner[0]!.v))) this.add('local-destructive', `find ${t} ${baseName(inner[0]!.v)} deletes every match`, true, false);
            const items = starts.map(s => childOf(s));
            const argv = inner.map(x => (x.v.includes('{}') ? { ...x, v: x.v.split('{}').join(items[0]!.v), alts: items.map(it => x.v.split('{}').join(it.v)), dyn: x.dyn || items.some(it => it.dyn), off: null } : { ...x, off: null }));
            this.exec(argv, st, null, null);
          } else if (t === '-fprint' || t === '-fprint0' || t === '-fprintf' || t === '-fls') {
            if (expr[i + 1]) this.checkWrite(expr[i + 1]!, cwd, 'writes');
            i++;
          }
        }
        return;
      }
      case 'git': return this.git(a, st);
      case 'gh': return this.gh(args);
      case 'eval': {
        if (args.every(x => !x.dyn)) this.nestedText(vals.join(' '), st);
        return;
      }
      case 'source': case '.': return;
      case 'trap': {
        // `trap 'rm -rf ~/x' EXIT` runs its first argument later.
        if (args[0] && !args[0].dyn && !args[0].v.startsWith('-')) this.nestedText(args[0].v, st);
        return;
      }
      default: break;
    }

    if (SHELLS.has(exe)) return this.shellInterp(exe, args, st, r);
    if (exe in INTERP_EVAL || /^python\d(\.\d+)?$/.test(exe)) {
      const key = exe in INTERP_EVAL ? exe : 'python3';
      // `python -m twine upload …` runs the module like a command.
      const mi = vals.indexOf('-m');
      if (key.startsWith('py') && mi >= 0 && args[mi + 1]) {
        this.classify(args.slice(mi + 1), st, r);
        return;
      }
      this.inlineCode(key, args, INTERP_EVAL[key] ?? [], st);
      if (r) for (const rd of r.cmd.redirects) if (rd.heredoc) this.codeText(key, rd.heredoc.body, st);
      return;
    }

    if (this.system(exe, args, vals)) return;
    if (this.remoteOps(exe, args, vals, st)) return;
    this.databases(exe, args, vals, r);
  }

  // ── families ───────────────────────────────────────────────────────────────

  private git(a: Val[], st: State): void {
    let i = 1;
    let gcwd: string | null = st.cwd;
    const aliases = new Map<string, string>();
    while (i < a.length) {
      const t = a[i]!.v;
      if (t === '-C') { gcwd = this.resolvePath(a[i + 1], gcwd); i += 2; continue; }
      if (t === '-c') {
        const m = /^alias\.([^=]+)=(.*)$/s.exec(a[i + 1]?.v ?? '');
        if (m) aliases.set(m[1]!, m[2]!);
        i += 2;
        continue;
      }
      if (t === '--work-tree' || t === '--git-dir' || t === '--namespace' || t === '--super-prefix' || t === '--config-env') {
        if (t === '--work-tree') gcwd = this.resolvePath(a[i + 1], gcwd);
        i += 2;
        continue;
      }
      if (t.startsWith('--work-tree=')) { gcwd = this.resolvePath({ ...a[i]!, v: t.slice(12), alts: [t.slice(12)] }, gcwd); i++; continue; }
      if (t.startsWith('-')) { i++; continue; }
      break;
    }
    let sub = a[i]?.v ?? '';
    let rest = a.slice(i + 1);
    const alias = aliases.get(sub);
    if (alias !== undefined) {
      if (alias.startsWith('!')) { this.nestedText(`${alias.slice(1)} ${rest.map(x => x.v).join(' ')}`, { ...st, cwd: gcwd }); return; }
      const toks = alias.trim().split(/\s+/).filter(Boolean).map(v => ({ v, alts: [v], dyn: false, off: null }));
      sub = toks[0]?.v ?? '';
      rest = [...toks.slice(1), ...rest];
    }
    const rv = rest.map(x => x.v);
    const short = (ch: string) => rv.some(v => /^-[A-Za-z]+$/.test(v) && v.slice(1).includes(ch));
    const local = (reason: string) => {
      const cls = gcwd ? this.classOf(gcwd) : 'unknown';
      const outside = cls === 'outside' || cls === 'ancestor';
      this.add(outside ? 'outside' : 'local-destructive', outside ? `${reason} in ${displayPath(gcwd!)} (outside the project)` : reason, true, outside);
    };
    switch (sub) {
      case 'push': {
        const valued = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
        let force = false, del = false, mirror = false, prune = false, dry = false;
        const pos: string[] = [];
        let dashdash = false;
        for (let k = 0; k < rv.length; k++) {
          const t = rv[k]!;
          if (dashdash) { pos.push(t); continue; }
          if (t === '--') { dashdash = true; continue; }
          if (valued.has(t)) { k++; continue; }
          if (/^--(force|force-with-lease|force-if-includes)(=.*)?$/.test(t)) { force = true; continue; }
          if (t === '--delete') { del = true; continue; }
          if (t === '--mirror') { mirror = true; continue; }
          if (t === '--prune') { prune = true; continue; }
          if (t === '--dry-run') { dry = true; continue; }
          if (t.startsWith('--')) continue;
          if (/^-[A-Za-z]+$/.test(t)) {
            if (t.includes('f')) force = true;
            if (t.includes('d')) del = true;
            if (t.includes('n')) dry = true;
            if (t.endsWith('o')) k++;
            continue;
          }
          pos.push(t);
        }
        for (const ref of pos.slice(1)) {
          if (ref.startsWith('+')) force = true;
          if (ref.startsWith(':')) del = true;
        }
        if (dry) return;
        if (force) this.add('remote', 'force push rewrites remote history', true, true);
        if (del) this.add('remote', 'git push --delete removes a remote branch or tag', true, true);
        if (mirror) this.add('remote', 'git push --mirror can overwrite and delete remote refs', true, true);
        if (prune) this.add('remote', 'git push --prune deletes remote branches', true, true);
        return;
      }
      case 'reset': if (rv.includes('--hard')) local('git reset --hard discards uncommitted work irrecoverably'); return;
      case 'clean': if (short('f') || rv.includes('--force')) local('git clean deletes untracked files'); return;
      case 'checkout': {
        const dd = rv.indexOf('--');
        if ((dd >= 0 && dd < rv.length - 1) || short('f') || rv.includes('--force') || rv.includes('.')) local('git checkout discards uncommitted changes');
        return;
      }
      case 'restore': if (!(rv.includes('--staged') || rv.includes('-S')) || rv.includes('--worktree') || rv.includes('-W')) local('git restore discards uncommitted changes'); return;
      case 'stash': if (rv[0] === 'drop' || rv[0] === 'clear') local('git stash drop/clear deletes stashed work'); return;
      case 'filter-branch': case 'filter-repo': local('rewrites history'); return;
      case 'rm': if (short('f') || rv.includes('--force')) local('git rm -f deletes uncommitted files'); return;
      case 'worktree': {
        if (rv[0] !== 'remove' && rv[0] !== 'rm') return;
        const target = rest.slice(1).find(x => !x.v.startsWith('-'));
        if (target) this.checkDelete(target, gcwd, 'removes the worktree');
        if (rv.includes('--force') || rv.includes('-f')) local('git worktree remove --force deletes uncommitted work');
        return;
      }
      default: return;
    }
  }

  private gh(args: Val[]): void {
    const pos = args.filter(x => !x.v.startsWith('-')).map(x => x.v);
    if (pos[0] === 'api') {
      const m = methodOf(args.map(x => x.v));
      if (m === 'DELETE') this.add('remote', 'gh api DELETE deletes data on GitHub', true, true);
      return;
    }
    if (pos[1] === 'delete' || /^(item|field)-delete$/.test(pos[1] ?? '') || (pos[0] === 'repo' && pos[1] === 'archive')) {
      this.add('remote', `gh ${pos[0]} ${pos[1]} deletes data on GitHub`, true, true);
    }
  }

  private shellInterp(exe: string, args: Val[], st: State, r: Resolved | null): void {
    let i = 0;
    for (; i < args.length; i++) {
      const t = args[i]!.v;
      if (t === '--') { i++; break; }
      if (t === '-c' || (/^-[A-Za-z]+$/.test(t) && t.includes('c') && !t.startsWith('--'))) {
        if (args[i + 1] && !args[i + 1]!.dyn) this.nestedText(args[i + 1]!.v, st);
        return;
      }
      if (t === '-o' || t === '+o' || t === '-O' || t === '+O' || t === '--rcfile' || t === '--init-file') { i++; continue; }
      if (!t.startsWith('-') && !t.startsWith('+')) break;
    }
    if (args.length > i) return; // `bash script.sh …` — a project script runs as-is.
    // Script on stdin: here-doc / here-string / `echo … | sh` / `echo … | base64 -d | sh`.
    if (r) {
      for (const rd of r.cmd.redirects) {
        if (rd.heredoc) this.nestedText(rd.heredoc.body, st);
        if (rd.op === '<<<' && rd.target) { const v = this.expand(rd.target, st, r.base); if (!v.dyn) this.nestedText(v.v, st); }
      }
      const piped = this.pipedText(r.pipeFrom, st, 0);
      if (piped) this.nestedText(piped, st);
    }
  }

  /** Text a pipeline producer writes, when it is literal (echo / printf / base64 -d of a literal). */
  private pipedText(from: Resolved | null, st: State, depth: number): string | null {
    if (!from || depth > 3 || !from.args.length) return null;
    const exe = baseName(from.args[0]!.v);
    const rest = from.args.slice(1);
    if (exe === 'echo' || exe === 'printf') {
      const ops = rest.filter(x => !/^-[neE]+$/.test(x.v));
      if (ops.some(x => x.dyn)) return null;
      return ops.map(x => x.v).join(' ').replace(/\\n/g, '\n');
    }
    if (exe === 'cat' && !rest.length) {
      for (const rd of from.cmd.redirects) if (rd.heredoc) return rd.heredoc.body;
      return null;
    }
    if ((exe === 'base64' || exe === 'openssl') && rest.some(x => /^(-d|--decode|-D|-base64)$/.test(x.v))) {
      let input = this.pipedText(from.pipeFrom, st, depth + 1);
      if (input === null) for (const rd of from.cmd.redirects) if (rd.op === '<<<' && rd.target) { const v = this.expand(rd.target, st, from.base); if (!v.dyn) input = v.v; }
      if (input === null) return null;
      try { return Buffer.from(input.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return null; }
    }
    if (exe === 'xxd' && rest.some(x => x.v === '-r') && rest.some(x => x.v === '-p' || x.v === '-ps')) {
      const input = this.pipedText(from.pipeFrom, st, depth + 1);
      if (input === null) return null;
      try { return Buffer.from(input.replace(/\s+/g, ''), 'hex').toString('utf8'); } catch { return null; }
    }
    return null;
  }

  /** `curl … | sh` style: downloaded code piped into an interpreter. */
  private remoteCodePipe(r: Resolved | null, _st: State): void {
    void _st;
    if (!r) return;
    // Find whether a later pipeline stage of THIS command is a shell: walk the script.
    const cmds = r.script.commands;
    const idx = cmds.indexOf(r.cmd);
    for (let k = idx + 1; k < cmds.length; k++) {
      const c = cmds[k]!;
      if (c.sep !== '|' && c.sep !== '|&') break;
      const words = c.words.map(w => w.parts.map(p => (p.t === 'lit' ? p.v : '')).join(''));
      let j = 0;
      while (j < words.length && /^(sudo|doas|env|-[A-Za-z]+|[A-Za-z_][A-Za-z0-9_]*=.*)$/.test(words[j]!)) j++;
      const ex = baseName(words[j] ?? '');
      if (SHELLS.has(ex) || /^python\d?(\.\d+)?$/.test(ex) || ex === 'node' || ex === 'perl' || ex === 'ruby') {
        this.add('remote-code', 'executes code downloaded from the network', true, false);
        return;
      }
    }
  }

  private inlineCode(lang: string, args: Val[], flags: string[], st: State): void {
    for (let i = 0; i < args.length; i++) {
      const t = args[i]!.v;
      if (flags.includes(t) && args[i + 1]) { this.codeText(lang, args[i + 1]!.v, st); i++; continue; }
      const glued = flags.find(f => f.length === 2 && t.startsWith(f) && t.length > 2 && !t.startsWith('--'));
      if (glued) this.codeText(lang, t.slice(2), st);
      if (lang === 'perl' && /^-[a-zA-Z]*e$/.test(t) && args[i + 1]) { this.codeText(lang, args[i + 1]!.v, st); i++; }
    }
  }

  /** Inline code heuristic: shell strings it runs, and outside paths it clearly deletes/writes. */
  private codeText(lang: string, code: string, st: State): void {
    if (!code) return;
    const shellRe = /(?:os\.system|os\.popen|subprocess\.(?:run|call|check_call|check_output|Popen)|execSync|\bexec|spawnSync|\bsystem)\s*\(\s*(["'])((?:(?!\1).){1,2000})\1/g;
    for (const m of code.matchAll(shellRe)) this.nestedText(m[2]!, st);
    if (!DESTRUCTIVE_CODE.test(code)) return;
    const strRe = /(["'`])((?:~|\/|\.\.\/)[^"'`\s]*)\1/g;
    for (const m of code.matchAll(strRe)) {
      const raw = m[2]!;
      const home = os.homedir();
      const v = raw.startsWith('~') ? home + raw.slice(1) : raw;
      const p = this.resolvePath({ v, alts: [v], dyn: false, off: null }, st.cwd);
      if (!p) continue;
      const cls = this.classOf(p);
      if (cls === 'outside' || cls === 'ancestor' || cls === 'device') {
        this.add('outside', `inline ${lang} code deletes or writes ${displayPath(p)} (outside the project)`, false, true);
      }
    }
  }

  private system(exe0: string, args: Val[], vals: string[]): boolean {
    void args;
    const exe = /^mkfs\./.test(exe0) || /^newfs_/.test(exe0) ? 'mkfs' : exe0;
    const pos = vals.filter(v => !v.startsWith('-'));
    const sys = (reason: string, irreversible = false) => { this.add('system', reason, irreversible, true); return true; };
    switch (exe) {
      case 'shutdown': case 'reboot': case 'halt': case 'poweroff':
        return sys('takes the machine down', true);
      case 'init': case 'telinit':
        return /^[06sS]$/.test(pos[0] ?? '') ? sys('takes the machine down', true) : false;
      case 'systemctl': {
        const sub = pos[0] ?? '';
        if (/^(reboot|poweroff|halt|suspend|hibernate|hybrid-sleep|kexec|emergency|rescue|soft-reboot)$/.test(sub)) return sys('takes the machine down', true);
        if (/^(status|show|cat|list-.*|is-.*|help|get-default|show-environment)$/.test(sub) || !sub) return true;
        return sys(`systemctl ${sub} changes system services`);
      }
      case 'service': case 'rc-service':
        return /^(start|stop|restart|reload|force-reload|zap)$/.test(pos[1] ?? pos[0] ?? '') ? sys(`${exe} changes system services`) : true;
      case 'update-rc.d': case 'chkconfig': case 'rc-update':
        return sys(`${exe} changes system services`);
      case 'launchctl': {
        const sub = pos[0] ?? '';
        if (/^(list|print|print-cache|print-disabled|plist|procinfo|hostinfo|resolveport|examine|version|help|managerpid|manageruid|managername|blame|dumpstate|getenv)$/.test(sub) || !sub) return true;
        return sys(`launchctl ${sub} changes system services`);
      }
      case 'mkfs': case 'mke2fs': case 'mkswap': case 'mkdosfs': case 'newfs': case 'newfs_apfs':
        return sys('formats a filesystem', true);
      case 'fdisk': case 'sfdisk': case 'gdisk': case 'sgdisk': case 'cfdisk': case 'parted': case 'wipefs': case 'blkdiscard': case 'cryptsetup': case 'mdadm': case 'lvremove': case 'vgremove': case 'pvremove': case 'zpool': case 'zfs':
        if ((exe === 'zfs' || exe === 'zpool') && /^(list|status|get|iostat|history)$/.test(pos[0] ?? '')) return true;
        if ((exe === 'fdisk' || exe === 'sfdisk' || exe === 'parted') && vals.some(v => v === '-l' || v === '--list')) return true;
        return sys('changes disks or partitions', true);
      case 'diskutil': {
        const sub = pos[0] ?? '';
        if (/^(list|info|information|activity|listFilesystems|verifyVolume|verifyDisk|apfs)$/i.test(sub) && !/^(erase|delete|resize|add|unlock)/i.test(pos[1] ?? '')) return true;
        return sys(`diskutil ${sub} changes disks or volumes`, /erase|partition|zero|random|secure/i.test(sub) || /delete|erase/i.test(pos[1] ?? ''));
      }
      case 'mount': case 'umount': case 'swapon': case 'swapoff': case 'losetup':
        if (exe === 'mount' && !pos.length) return true;
        return sys(`${exe} changes mounted filesystems`);
      case 'csrutil': case 'nvram': case 'spctl': case 'kextload': case 'kextunload': case 'kmutil': case 'modprobe': case 'rmmod': case 'insmod': case 'bless':
        if ((exe === 'csrutil' && pos[0] === 'status') || (exe === 'nvram' && vals.includes('-p')) || (exe === 'spctl' && vals.some(v => v === '--status' || v === '--assess'))) return true;
        return sys(`${exe} changes system security or boot settings`);
      case 'pmset': case 'systemsetup': case 'networksetup': case 'scutil':
        if (vals.some(v => /^-(g|get|list|print)/.test(v) || v === '--get' || v === '-r' || v === '--dns' || v === '--proxy' || v === '--nwi')) return true;
        if (exe === 'scutil' && !vals.includes('--set')) return true;
        return sys(`${exe} changes system settings`);
      case 'iptables': case 'ip6tables': case 'nft': case 'ufw': case 'pfctl': case 'firewall-cmd':
        if (vals.some(v => /^(-L|--list|-S|--list-rules|status|list)/.test(v)) || pos[0] === 'status' || pos[0] === 'list') return true;
        return sys(`${exe} changes firewall rules`);
      case 'sysctl':
        return vals.includes('-w') || pos.some(p => p.includes('=')) ? sys('sysctl changes kernel settings') : true;
      case 'passwd': case 'chpasswd': case 'useradd': case 'userdel': case 'usermod': case 'adduser': case 'deluser': case 'groupadd': case 'groupdel': case 'groupmod': case 'visudo': case 'chsh': case 'dscl': case 'sysadminctl':
        if (exe === 'dscl' && vals.some(v => /^-(read|list|search)/.test(v))) return true;
        return sys(`${exe} changes system accounts`);
      case 'crontab':
        if (vals.includes('-l')) return true;
        return sys(vals.includes('-r') ? 'crontab -r deletes your scheduled jobs' : 'crontab replaces your scheduled jobs', vals.includes('-r'));
      case 'kill':
        if (vals.includes('-1') && vals.filter(v => v === '-1').length >= 1 && pos.length === 0 && vals.length >= 2) return sys('kills every process you own', false);
        return true;
      default:
        return false;
    }
  }

  private remoteOps(exe: string, args: Val[], vals: string[], st: State): boolean {
    void st;
    const pos = positionalAfterGlobals(vals);
    const dry = vals.some(v => v === '--dry-run' || v === '--dryrun');
    const remote = (reason: string) => { this.add('remote', reason, true, true); return true; };
    const sub = pos[0] ?? '';
    switch (exe) {
      case 'npm': case 'pnpm': case 'bun':
        if ((sub === 'publish' || sub === 'unpublish') && !dry) return remote(`${exe} ${sub} publishes to a public registry`);
        return false;
      case 'yarn':
        if ((sub === 'publish' || (sub === 'npm' && pos[1] === 'publish')) && !dry) return remote('yarn publish publishes to a public registry');
        return false;
      case 'cargo':
        if ((sub === 'publish' || sub === 'yank') && !dry) return remote(`cargo ${sub} changes a public registry`);
        return false;
      case 'twine':
        if (sub === 'upload') return remote('twine upload publishes to PyPI');
        return false;
      case 'gem':
        if (sub === 'push' || sub === 'yank') return remote(`gem ${sub} changes a public registry`);
        return false;
      case 'poetry': case 'flit': case 'hatch': case 'uv': case 'pdm': case 'rye': case 'maturin':
        if ((sub === 'publish' || (exe === 'maturin' && sub === 'upload')) && !dry) return remote(`${exe} publish publishes to a package registry`);
        return false;
      case 'docker': case 'podman': case 'buildah': case 'nerdctl': {
        if (sub === 'push' || (pos[0] === 'image' && pos[1] === 'push') || (pos[0] === 'manifest' && pos[1] === 'push')) return remote(`${exe} push publishes an image`);
        if ((sub === 'build' || (sub === 'buildx' && pos[1] === 'build')) && vals.includes('--push')) return remote(`${exe} build --push publishes an image`);
        if (sub === 'volume' && (pos[1] === 'rm' || pos[1] === 'prune')) { this.add('outside', `${exe} volume ${pos[1]} deletes data volumes`, true, true); return true; }
        if (sub === 'system' && pos[1] === 'prune' && vals.includes('--volumes')) { this.add('outside', `${exe} system prune --volumes deletes data volumes`, true, true); return true; }
        return false;
      }
      case 'helm':
        if (sub === 'delete' || sub === 'uninstall') return remote(`helm ${sub} deletes cluster resources`);
        if (sub === 'push') return remote('helm push publishes a chart');
        return false;
      case 'kubectl': case 'oc':
        if (sub === 'delete' || sub === 'drain') return remote(`kubectl ${sub} deletes or evicts cluster resources`);
        return false;
      case 'terraform': case 'tofu': case 'terragrunt': {
        const s = sub === 'run-all' ? pos[1] ?? '' : sub;
        if (s === 'destroy' || s === 'apply') return remote(`${exe} ${s} changes real infrastructure`);
        if (s === 'state' && /^(rm|push|mv|replace-provider)$/.test(pos[sub === 'run-all' ? 2 : 1] ?? '')) return remote(`${exe} state changes real infrastructure state`);
        return false;
      }
      case 'pulumi':
        if (sub === 'up' || sub === 'update' || sub === 'destroy' || (sub === 'stack' && pos[1] === 'rm')) return remote(`pulumi ${sub} changes real infrastructure`);
        return false;
      case 'cdk': case 'sam': case 'serverless': case 'sls': case 'eb': case 'copilot': case 'amplify':
        if (/^(deploy|destroy|remove|delete|terminate|publish)$/.test(sub) || (sub === 'svc' && pos[1] === 'deploy')) return remote(`${exe} ${sub} changes production infrastructure`);
        return false;
      case 'aws': {
        const ep = vals.find((v, i) => vals[i - 1] === '--endpoint-url') ?? vals.find(v => v.startsWith('--endpoint-url='))?.slice(15);
        if (ep && isLocalHost(urlHost(ep))) return false;
        const svc = pos[0] ?? '';
        const op = pos[1] ?? '';
        if (svc === 's3' && (op === 'rm' || op === 'rb' || op === 'mv' || (op === 'sync' && vals.includes('--delete')))) return remote(`aws s3 ${op} deletes cloud data`);
        if (/^(delete|terminate|remove|deregister|purge|destroy)-/.test(op)) return remote(`aws ${svc} ${op} deletes cloud resources`);
        return false;
      }
      case 'gcloud': case 'gsutil': case 'az': case 'doctl': case 'linode-cli': case 'hcloud': case 'scw': case 'ibmcloud': case 'oci': {
        if (exe === 'gsutil') return /^(rm|rb)$/.test(sub) || (sub === 'rsync' && vals.includes('-d')) ? remote(`gsutil ${sub} deletes cloud data`) : false;
        if (pos.some(p => p === 'delete' || p === 'destroy' || p === 'rm' || p === 'purge')) return remote(`${exe} ${pos.slice(0, 3).join(' ')} deletes cloud resources`);
        if (exe === 'gcloud' && pos.includes('deploy')) return remote(`gcloud ${pos.slice(0, 2).join(' ')} deploys to production`);
        return false;
      }
      case 'heroku':
        if (/^(apps:destroy|destroy|apps:delete|pg:reset|addons:destroy|pg:reset)$/.test(sub)) return remote(`heroku ${sub} deletes cloud resources`);
        return false;
      case 'fly': case 'flyctl':
        if (sub === 'deploy') return remote('fly deploy deploys to production');
        if (sub === 'destroy' || (sub === 'apps' && (pos[1] === 'destroy' || pos[1] === 'delete')) || (sub === 'volumes' && (pos[1] === 'destroy' || pos[1] === 'delete'))) return remote('fly destroy deletes cloud resources');
        return false;
      case 'vercel': case 'vc':
        if (vals.includes('--prod') || vals.includes('--production')) return remote('vercel --prod deploys to production');
        if (sub === 'remove' || sub === 'rm' || (sub === 'domains' && pos[1] === 'rm') || (sub === 'env' && pos[1] === 'rm')) return remote(`vercel ${sub} deletes cloud resources`);
        return false;
      case 'netlify': case 'ntl':
        if (sub === 'deploy' && (vals.includes('--prod') || vals.includes('-p'))) return remote('netlify deploy --prod deploys to production');
        if (/^(sites:delete|env:unset)$/.test(sub)) return remote(`netlify ${sub} deletes cloud resources`);
        return false;
      case 'firebase':
        if (sub === 'deploy') return remote('firebase deploy deploys to production');
        if (/(:delete|:remove|:disable)$/.test(sub) || sub === 'projects:delete') return remote(`firebase ${sub} deletes cloud data`);
        return false;
      case 'wrangler':
        if (sub === 'deploy' || sub === 'publish' || sub === 'delete' || pos[1] === 'delete') return remote(`wrangler ${sub} changes production`);
        return false;
      case 'vsce': case 'ovsx': case 'lerna': case 'changeset':
        if (sub === 'publish' && !dry) return remote(`${exe} publish publishes to a public registry`);
        return false;
      case 'semantic-release':
        return dry ? false : remote('semantic-release publishes a release');
      case 'mvn': case 'mvnw':
        if (pos.includes('deploy') || pos.includes('release:perform')) return remote('mvn deploy publishes artifacts');
        return false;
      case 'gradle': case 'gradlew':
        if (pos.some(p => /^:?([\w-]+:)*publish/i.test(p))) return remote('gradle publish publishes artifacts');
        return false;
      case 'dotnet':
        if (sub === 'nuget' && pos[1] === 'push') return remote('dotnet nuget push publishes a package');
        return false;
      case 'pod':
        if (sub === 'trunk' && pos[1] === 'push') return remote('pod trunk push publishes a pod');
        return false;
      default:
        return false;
    }
  }

  private databases(exe: string, args: Val[], vals: string[], r: Resolved | null): void {
    const SQL_DESTRUCTIVE = /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|USER|ROLE|EXTENSION|OWNED)|TRUNCATE\b|DELETE\s+FROM)/i;
    const hostOpt = (short: string, long: string): string | null => {
      for (let i = 0; i < vals.length; i++) {
        const t = vals[i]!;
        if (t === short || t === long) return vals[i + 1] ?? null;
        if (t.startsWith(long + '=')) return t.slice(long.length + 1);
        if (short.length === 2 && t.startsWith(short) && t.length > 2 && !t.startsWith('--')) return t.slice(2);
      }
      const url = vals.find(v => /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.includes('host='));
      if (url) {
        const hm = /(?:^|\s)host=([^\s]+)/.exec(url);
        if (hm) return hm[1]!;
        return urlHost(url.replace(/^postgres(ql)?:/i, 'http:').replace(/^mysql:/i, 'http:').replace(/^mongodb(\+srv)?:/i, (_m, srv) => (srv ? 'srv:' : 'http:')).replace(/^rediss?:/i, 'http:'));
      }
      return null;
    };
    const decide = (what: string, host: string | null, envHost?: string) => {
      const h = host ?? (envHost ? process.env[envHost] ?? null : null);
      const local = isLocalHost(h);
      this.add(local ? 'local-destructive' : 'remote', local ? what : `${what} on ${h}`, true, !local);
    };
    const sqlIn = (texts: string[]) => texts.some(t => SQL_DESTRUCTIVE.test(t));
    const stdinTexts = (): string[] => {
      const out: string[] = [];
      if (r) {
        for (const rd of r.cmd.redirects) {
          if (rd.heredoc) out.push(rd.heredoc.body);
          if (rd.op === '<<<' && rd.target) out.push(rd.target.parts.map(p => (p.t === 'lit' ? p.v : '')).join(''));
        }
        const piped = r.pipeFrom ? this.pipedText(r.pipeFrom, { cwd: null, vars: new Map(), depth: 0 }, 0) : null;
        if (piped) out.push(piped);
      }
      return out;
    };
    switch (exe) {
      case 'dropdb': case 'dropuser':
        decide(`${exe} drops a database object`, hostOpt('-h', '--host'), 'PGHOST');
        return;
      case 'psql': case 'pgcli': {
        const cmds: string[] = [];
        for (let i = 0; i < vals.length; i++) {
          if (vals[i] === '-c' || vals[i] === '--command') cmds.push(vals[i + 1] ?? '');
          else if (vals[i]!.startsWith('--command=')) cmds.push(vals[i]!.slice(10));
        }
        if (sqlIn([...cmds, ...stdinTexts()])) decide('destroys database objects', hostOpt('-h', '--host'), 'PGHOST');
        return;
      }
      case 'mysql': case 'mariadb': {
        const cmds: string[] = [];
        for (let i = 0; i < vals.length; i++) {
          if (vals[i] === '-e' || vals[i] === '--execute') cmds.push(vals[i + 1] ?? '');
          else if (vals[i]!.startsWith('--execute=')) cmds.push(vals[i]!.slice(10));
          else if (/^-e./.test(vals[i]!)) cmds.push(vals[i]!.slice(2));
        }
        if (sqlIn([...cmds, ...stdinTexts()])) decide('destroys database objects', hostOpt('-h', '--host'), 'MYSQL_HOST');
        return;
      }
      case 'mongo': case 'mongosh': {
        const ev = vals.filter((v, i) => vals[i - 1] === '--eval');
        if ([...ev, ...stdinTexts()].some(t => /dropDatabase|\.drop\(|deleteMany|\.remove\(/.test(t))) decide('deletes database data', hostOpt('--host', '--host'));
        return;
      }
      case 'redis-cli': {
        if (vals.some(v => /^flush(all|db)$/i.test(v)) || stdinTexts().some(t => /\bflush(all|db)\b/i.test(t))) {
          const u = vals.find((v, i) => vals[i - 1] === '-u');
          decide('wipes a Redis database', u ? urlHost(u.replace(/^rediss?:/i, 'http:')) : hostOpt('-h', '--host'));
        }
        return;
      }
      case 'sqlite3': {
        if (sqlIn([...vals.slice(1), ...stdinTexts()])) this.add('local-destructive', 'destroys database objects', true, false);
        return;
      }
      default:
        return;
    }
  }

  // ── path checks ────────────────────────────────────────────────────────────

  /** Absolute path for a word, or null when unknowable. */
  resolvePath(v: Val | undefined, cwd: string | null): string | null {
    if (!v) return null;
    const s = v.v;
    if (!s) return null;
    if (v.dyn) {
      const cut = s.indexOf(DYN);
      const prefix = s.slice(0, cut);
      const slash = prefix.lastIndexOf('/');
      if (slash < 0) return null;
      const dir = prefix.slice(0, slash) || '/';
      if (!path.isAbsolute(dir) && !cwd) return null;
      const abs = path.resolve(cwd ?? '/', dir);
      // "Clearly outside" when the known directory is outside the roots, or a strict parent
      // of one (`rm -rf ~/$name`, `"$HOME/$x"`): a name picked at run time directly under
      // $HOME is far more likely to be anything but this project. Under the project root or
      // inside it (`$PWD/$x`, `build/$x`) it stays unknown.
      const cls = this.classOf(abs);
      return cls === 'outside' || cls === 'ancestor' ? path.join(abs, '__dynamic__') : null;
    }
    if (!path.isAbsolute(s) && !cwd) return null;
    return path.resolve(cwd ?? '/', s);
  }

  classOf(abs: string): PathClass {
    if (this.remote) return 'outside';
    if (abs.startsWith('/dev/')) return HARMLESS_DEV.test(abs) ? 'harmless-device' : 'device';
    if (/^\/proc\/(self|\d+)\/fd\//.test(abs)) return 'harmless-device';
    const real = realish(abs, this.realCache);
    const cands = abs === real ? [abs] : [real];
    for (const c of cands) {
      for (const r of this.realRoots) {
        if (c === r) return 'root';
      }
      for (const r of this.realRoots) {
        if (c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return 'inside';
      }
      for (const r of this.realRoots) {
        if (r.startsWith(c.endsWith(path.sep) ? c : c + path.sep)) return 'ancestor';
      }
    }
    return 'outside';
  }

  private checkPath(v: Val, cwd: string | null, op: 'delete' | 'write' | 'chmod', verb: string): void {
    for (const alt of v.alts) {
      const one: Val = { ...v, v: alt };
      const p = this.resolvePath(one, cwd);
      if (!p) continue;
      const cls = this.classOf(p);
      const shown = p.endsWith('__dynamic__') ? path.dirname(p) + '/…' : p.endsWith('__item__') ? path.dirname(p) + '/…' : p;
      if (cls === 'device') {
        this.add('system', `${verb} the device ${p} directly`, true, true);
        this.out.outsideWrites.push(p);
        continue;
      }
      if (cls === 'harmless-device' || cls === 'inside' || cls === 'unknown') continue;
      if (cls === 'root' && op !== 'delete') continue;
      const where = cls === 'root' ? 'a workspace root itself' : cls === 'ancestor' ? 'a parent of the project' : 'outside the project';
      this.add('outside', `${verb} ${displayPath(shown)} (${where})`, false, true);
      if (op !== 'delete') this.out.outsideWrites.push(p);
    }
  }

  private checkDelete(v: Val, cwd: string | null, verb: string): void { this.checkPath(v, cwd, 'delete', verb); }
  private checkWrite(v: Val, cwd: string | null, verb: string): void { this.checkPath(v, cwd, 'write', verb); }
}

interface Resolved {
  script: ParsedScript;
  cmd: SimpleCommand;
  text: string;
  /** Offset of `text` in script.src. */
  base: number;
  assigns: { name: string; val: Val }[];
  args: Val[];
  pipeFrom: Resolved | null;
}

// ── argv helpers ─────────────────────────────────────────────────────────────

/** Bash brace expansion of comma lists (`a{b,c}d` → abd acd), at most 32 results. PURE. */
function braceExpand(s: string, depth = 0): string[] {
  if (depth > 4) return [s];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let d = 0;
    const commas: number[] = [];
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === '{') d++;
      else if (s[j] === '}') { d--; if (d === 0) break; }
      else if (s[j] === ',' && d === 1) commas.push(j);
    }
    if (j >= s.length || !commas.length) continue;
    const pre = s.slice(0, i);
    const post = s.slice(j + 1);
    const bounds = [i, ...commas, j];
    const out: string[] = [];
    for (let k = 0; k < bounds.length - 1 && out.length < 32; k++) {
      for (const e of braceExpand(pre + s.slice(bounds[k]! + 1, bounds[k + 1]) + post, depth + 1)) {
        if (out.length < 32) out.push(e);
      }
    }
    return out;
  }
  return [s];
}

function baseName(p: string): string {
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Index after leading options (`valued` options consume the next word). */
function skipOpts(a: Val[], valued: string[], extraFlag?: (t: string) => boolean): number {
  let i = 0;
  while (i < a.length) {
    const t = a[i]!.v;
    if (t === '--') return i + 1;
    if (!t.startsWith('-') || t === '-') break;
    if (extraFlag && extraFlag(t)) { i++; continue; }
    if (valued.includes(t)) { i += 2; continue; }
    i++;
  }
  return i;
}

/** Non-option operands (after `--` everything is an operand). `valued` options consume a word. */
function operands(args: Val[], valued: string[] = []): Val[] {
  const out: Val[] = [];
  let dd = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.v;
    if (dd) { out.push(args[i]!); continue; }
    if (t === '--') { dd = true; continue; }
    if (valued.includes(t)) { i++; continue; }
    if (t.startsWith('-') && t !== '-') continue;
    out.push(args[i]!);
  }
  return out;
}

/** cp/mv/rsync style: sources + destination (`-t DIR` wins). */
function srcDest(args: Val[], valued: string[]): { sources: Val[]; dest: Val | null } {
  let target: Val | null = null;
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.v;
    if (t === '-t' || t === '--target-directory') { target = args[i + 1] ?? null; }
    else if (t.startsWith('--target-directory=')) target = { ...args[i]!, v: t.slice(19), alts: [t.slice(19)] };
  }
  const ops = operands(args, valued);
  if (target) return { sources: ops, dest: target };
  if (ops.length < 2) return { sources: ops, dest: null };
  return { sources: ops.slice(0, -1), dest: ops[ops.length - 1]! };
}

function findStartIndex(a: Val[]): number {
  let i = 1;
  while (i < a.length && /^-[HLP]$|^-O\d$|^-D$/.test(a[i]!.v)) i += a[i]!.v === '-D' ? 2 : 1;
  return i - 1;
}

/** `find` start paths (default `.`). */
function findStarts(a: Val[]): Val[] {
  const out: Val[] = [];
  for (let i = 1 + findStartIndex(a); i < a.length; i++) {
    const t = a[i]!.v;
    if (t.startsWith('-') || t === '(' || t === '!' || t === ')' || t === ',') break;
    out.push(a[i]!);
  }
  return out.length ? out : [{ v: '.', alts: ['.'], dyn: false, off: null }];
}

function childOf(v: Val): Val {
  const j = (s: string) => (s.endsWith('/') ? s + '__item__' : s + '/__item__');
  return { ...v, v: j(v.v), alts: v.alts.map(j), off: null };
}

function isRemoteSpec(s: string): boolean {
  if (/^rsync:\/\//.test(s)) return true;
  if (s.startsWith('/') || s.startsWith('.') || s.startsWith('~')) return false;
  return /^[^/:\s]+:/.test(s) && !/^[A-Za-z]:\\/.test(s);
}

function remoteName(s: string): string {
  const m = /^(?:rsync:\/\/)?(?:[^@/:]+@)?([^/:]+)/.exec(s);
  return m ? m[1]! : s;
}

function urlHost(u: string): string | null {
  try {
    if (u.startsWith('srv:')) return u.slice(4).replace(/^\/\//, '').replace(/^[^@]*@/, '').split(/[/:?]/)[0] ?? null;
    return new URL(u).hostname || null;
  } catch {
    return null;
  }
}

function methodOf(vals: string[]): string | null {
  for (let i = 0; i < vals.length; i++) {
    const t = vals[i]!;
    if (t === '-X' || t === '--request' || t === '--method') return (vals[i + 1] ?? '').toUpperCase();
    if (/^-X[A-Za-z]+$/.test(t)) return t.slice(2).toUpperCase();
    if (/^--(request|method)=/.test(t)) return t.split('=')[1]!.toUpperCase();
  }
  return null;
}

/** Positionals of a CLI that may have global `--flag value` pairs before the subcommand. */
function positionalAfterGlobals(vals: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < vals.length; i++) {
    const t = vals[i]!;
    if (t.startsWith('--') && !t.includes('=') && GLOBAL_VALUED.has(t)) { i++; continue; }
    if (/^-[A-Za-z]$/.test(t) && SHORT_VALUED.has(t)) { i++; continue; }
    if (t.startsWith('-')) continue;
    out.push(t);
  }
  return out;
}
const GLOBAL_VALUED = new Set([
  '--profile', '--region', '--output', '--endpoint-url', '--namespace', '--context', '--kubeconfig', '--cluster', '--user',
  '--project', '--account', '--configuration', '--subscription', '--resource-group', '--chdir', '--cwd', '--prefix',
  '--registry', '--tag', '--access', '--otp', '--workspace', '--filter', '--config', '--target', '--app', '--org', '--team',
  '--scope', '--token', '--env', '--stage', '--manifest-path', '--package', '--repository', '--repository-url', '--username',
  '--password', '--format', '--query', '--zone', '--location',
]);
const SHORT_VALUED = new Set(['-n', '-c', '-r', '-a', '-p', '-o', '-u', '-w', '-C', '-f', '-s', '-e', '-t', '-l']);
