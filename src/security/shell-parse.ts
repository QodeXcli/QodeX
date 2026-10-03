/**
 * A small POSIX-shell parser for the permission policy. PURE (no I/O).
 *
 * It does not run anything and does not try to be bash. It answers one question well
 * enough for an approval policy: "which simple commands does this string execute, with
 * which words and which redirections?" — so a policy can look at the executable in
 * COMMAND POSITION (never a substring of a path or a commit message) and at every
 * segment of a chain (`ls && git push`), not just the first one.
 *
 * Handled: `;` `&&` `||` `|` `|&` `&` newlines, `( )` subshell groups, `$( )`, backticks,
 * `<( )` / `>( )`, `$(( ))`, single/double/ANSI-C quotes, backslash escapes, line
 * continuations, comments, `~` / `~user`, `$VAR` / `${VAR…}`, redirections (`>` `>>` `>|`
 * `&>` `&>>` `N>` `N>&M` `<` `<<` `<<-` `<<<`) including here-document bodies.
 *
 * Unbalanced quotes or parens do not throw: the parse keeps what it read and sets `error`.
 */

export type WordPart =
  /** Literal text. `quoted` = came from quotes or an escape (never a glob). */
  | { t: 'lit'; v: string; quoted: boolean }
  /** `$NAME` / `${NAME}` / `${NAME:-x}` (op/arg kept raw). Positional/special params use their symbol.
   *  `nested`: command substitutions inside the operand (`${x:-$(cmd)}`) — they RUN. */
  | { t: 'var'; name: string; quoted: boolean; op?: string; nested?: ParsedScript[] }
  /** `$( … )` or backticks — a nested script that RUNS. */
  | { t: 'sub'; body: ParsedScript }
  /** `<( … )` / `>( … )` — a nested script that runs; the word is a /dev/fd path. */
  | { t: 'proc'; body: ParsedScript }
  /** `$(( … ))` — arithmetic; `nested` holds command substitutions inside it (they RUN). */
  | { t: 'arith'; nested?: ParsedScript[] }
  /** Unquoted `~` / `~user` at the start of a word. */
  | { t: 'tilde'; user: string };

export interface Word {
  parts: WordPart[];
  /** Offsets in the owning script's `src`. */
  start: number;
  end: number;
}

export interface Redirect {
  /** '>', '>>', '>|', '&>', '&>>', '<', '<>', '<<', '<<-', '<<<', '>&', '<&'. */
  op: string;
  /** Explicit fd number before the operator (`2>`), or null. */
  fd: number | null;
  /** The file (or here-string) word. Null for fd duplication (`2>&1`, `>&-`) and here-docs. */
  target: Word | null;
  /** True for `N>&M` / `>&-` style fd duplication (no file). */
  dup: boolean;
  /** Here-document: delimiter, body text, and whether the body is expanded (unquoted delimiter). */
  heredoc?: { delim: string; body: string; expands: boolean; subs: ParsedScript[] };
}

export interface SimpleCommand {
  /** Every word, including leading `NAME=value` assignments. */
  words: Word[];
  redirects: Redirect[];
  /** Offsets of this command in the script's `src` (words and redirections, no here-doc body). */
  start: number;
  end: number;
  /** The control operator BEFORE this command: '' at the start, ';', '&&', '||', '|', '|&', '&', '\n'. */
  sep: string;
  /** `(` subshell groups opened immediately before this command. */
  opens: number;
  /** `)` subshell groups closed immediately after this command. */
  closes: number;
}

export interface ParsedScript {
  src: string;
  commands: SimpleCommand[];
  /** Set when the input was not well-formed (unterminated quote, unbalanced paren, too deep). */
  error?: string;
}

const MAX_DEPTH = 12;

/** Parse a shell command string. PURE; never throws. */
export function parseShell(src: string): ParsedScript {
  const p = new Parser(src ?? '', 0);
  const { script } = p.parseList(0, false);
  return script;
}

/** Literal text of a word when it has no expansions (quotes removed), else null. PURE. */
export function literalWord(w: Word): string | null {
  let s = '';
  for (const p of w.parts) {
    if (p.t === 'lit') s += p.v;
    else return null;
  }
  return s;
}

/** Raw source text of a command (no here-doc body). PURE. */
export function commandText(script: ParsedScript, c: SimpleCommand): string {
  return script.src.slice(c.start, c.end).trim();
}

const SEP_CHARS = new Set([';', '&', '|', '<', '>', '(', ')', '\n']);
const BLANK = new Set([' ', '\t', '\r']);
const REDIR_RE = /^(\d{0,9})(&>>|&>|>>|>\||>&|<<<|<<-|<<|<>|<&|>|<)/;

class Parser {
  private pendingHeredocs: Redirect[] = [];
  constructor(private readonly src: string, private readonly depth: number) {}

  /**
   * Parse a list of commands from `i`. With `untilParen`, stop at the `)` that closes the
   * enclosing `$(`/`<(` (returned `end` points just past it).
   */
  parseList(i: number, untilParen: boolean): { script: ParsedScript; end: number } {
    const src = this.src;
    const script: ParsedScript = { src, commands: [] };
    if (this.depth > MAX_DEPTH) {
      script.error = 'nesting too deep';
      return { script, end: src.length };
    }
    let sep = '';
    let opens = 0;
    let groupDepth = 0;
    let closedParen = !untilParen;
    while (i < src.length) {
      const c = src[i]!;
      if (BLANK.has(c)) { i++; continue; }
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === '#') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '\n') {
        i++;
        i = this.readHeredocBodies(i);
        if (script.commands.length) sep = '\n';
        continue;
      }
      if (c === ';') {
        i += src[i + 1] === ';' ? 2 : 1;
        sep = ';';
        continue;
      }
      if (c === '&' && src[i + 1] === '&') { i += 2; sep = '&&'; continue; }
      if (c === '|' && src[i + 1] === '|') { i += 2; sep = '||'; continue; }
      if (c === '|' && src[i + 1] === '&') { i += 2; sep = '|&'; continue; }
      if (c === '|') { i++; sep = '|'; continue; }
      if (c === '&' && src[i + 1] !== '>') { i++; sep = '&'; continue; }
      if (c === '(' && src[i + 1] === '(') {
        // `(( arithmetic ))` command — no executable, but `$( )` inside it runs: keep it as
        // a command whose only word is the arithmetic (so the substitutions are analyzed).
        const start = i;
        const end = this.skipArith(i + 2);
        const nested = this.substitutionsIn(src.slice(i + 2, Math.max(i + 2, end - 2)));
        script.commands.push({
          words: [{ parts: [{ t: 'arith', ...(nested.length ? { nested } : {}) }], start, end }],
          redirects: [], start, end, sep, opens, closes: 0,
        });
        sep = '';
        opens = 0;
        i = end;
        continue;
      }
      if (c === '(') { i++; opens++; groupDepth++; continue; }
      if (c === ')') {
        if (untilParen && groupDepth === 0) { closedParen = true; i++; break; }
        i++;
        if (groupDepth > 0) groupDepth--;
        const last = script.commands[script.commands.length - 1];
        if (last) last.closes++;
        continue;
      }
      const { cmd, end } = this.parseCommand(i);
      i = end;
      if (cmd) {
        cmd.sep = sep;
        cmd.opens = opens;
        script.commands.push(cmd);
        opens = 0;
        sep = '';
      } else if (end === i) {
        i++; // never spin
      }
    }
    if (!closedParen) script.error = script.error ?? 'unterminated $( … )';
    if (this.err && !script.error) script.error = this.err;
    return { script, end: i };
  }

  private err: string | undefined;

  private parseCommand(start: number): { cmd: SimpleCommand | null; end: number } {
    const src = this.src;
    const words: Word[] = [];
    const redirects: Redirect[] = [];
    let i = start;
    let last = start;
    while (i < src.length) {
      const c = src[i]!;
      if (BLANK.has(c)) { i++; continue; }
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === '#' && (i === start || BLANK.has(src[i - 1]!))) {
        while (i < src.length && src[i] !== '\n') i++;
        break;
      }
      // Process substitution starts a word, not a redirection.
      if ((c === '<' || c === '>') && src[i + 1] === '(') {
        const r = this.parseWord(i);
        words.push(r.word);
        i = last = r.end;
        continue;
      }
      const rm = /\d|<|>|&/.test(c) ? REDIR_RE.exec(src.slice(i, i + 16)) : null;
      if (rm && (rm[1] === '' || /[<>&]/.test(rm[2]![0]!))) {
        // A digit run is an fd only when directly followed by the operator (`2>`), and only
        // at the start of a word — `a2>x` never reaches here because `a2` is read as a word.
        const fd = rm[1] ? Number(rm[1]) : null;
        const op = rm[2]!;
        i += rm[0].length;
        while (i < src.length && BLANK.has(src[i]!)) i++;
        if (op === '<<' || op === '<<-') {
          const r = this.parseWord(i);
          const delimLit = r.word.parts.map(p => (p.t === 'lit' ? p.v : '')).join('');
          const quoted = r.word.parts.some(p => p.t === 'lit' && p.quoted);
          const redir: Redirect = { op, fd, target: null, dup: false, heredoc: { delim: delimLit, body: '', expands: !quoted, subs: [] } };
          redirects.push(redir);
          this.pendingHeredocs.push(redir);
          i = last = r.end;
          continue;
        }
        if ((op === '>&' || op === '<&') && /^(\d+|-)(?=$|[\s;&|<>()])/.test(src.slice(i))) {
          const m = /^(\d+|-)/.exec(src.slice(i))!;
          redirects.push({ op, fd, target: null, dup: true });
          i = last = i + m[0].length;
          continue;
        }
        if (i >= src.length || SEP_CHARS.has(src[i]!) && !(src[i] === '<' || src[i] === '>')) {
          redirects.push({ op, fd, target: null, dup: false });
          last = i;
          continue;
        }
        const r = this.parseWord(i);
        redirects.push({ op, fd, target: r.word, dup: false });
        i = last = r.end;
        continue;
      }
      if (SEP_CHARS.has(c)) break;
      const r = this.parseWord(i);
      if (r.end === i) { i++; continue; }
      words.push(r.word);
      i = last = r.end;
    }
    if (!words.length && !redirects.length) return { cmd: null, end: i };
    return { cmd: { words, redirects, start, end: last, sep: '', opens: 0, closes: 0 }, end: i };
  }

  /** Read one word starting at `i` (stops at unquoted blank or operator). */
  private parseWord(i: number): { word: Word; end: number } {
    const src = this.src;
    const start = i;
    const parts: WordPart[] = [];
    const lit = (v: string, quoted: boolean) => {
      const prev = parts[parts.length - 1];
      if (prev && prev.t === 'lit' && prev.quoted === quoted) prev.v += v;
      else parts.push({ t: 'lit', v, quoted });
    };
    // Tilde expansion: unquoted `~` or `~user` at the start of the word.
    if (src[i] === '~') {
      const m = /^~([A-Za-z0-9._-]*)(?=$|[/\s;&|<>():])/.exec(src.slice(i));
      if (m) {
        parts.push({ t: 'tilde', user: m[1]! });
        i += m[0].length;
      }
    }
    while (i < src.length) {
      const c = src[i]!;
      if (BLANK.has(c) || c === '\n') break;
      if ((c === '<' || c === '>') && src[i + 1] === '(' ) {
        if (i !== start) break;
        const r = new Parser(src, this.depth + 1).parseList(i + 2, true);
        if (r.script.error) this.err = this.err ?? r.script.error;
        parts.push({ t: 'proc', body: r.script });
        i = r.end;
        continue;
      }
      if (SEP_CHARS.has(c)) break;
      if (c === '\\') {
        if (src[i + 1] === '\n') { i += 2; continue; }
        if (i + 1 < src.length) lit(src[i + 1]!, true);
        i += 2;
        continue;
      }
      if (c === "'") {
        const j = src.indexOf("'", i + 1);
        if (j < 0) { this.err = this.err ?? 'unterminated quote'; lit(src.slice(i + 1), true); i = src.length; break; }
        lit(src.slice(i + 1, j), true);
        i = j + 1;
        continue;
      }
      if (c === '$' && src[i + 1] === "'") {
        const r = readAnsiC(src, i + 2);
        if (r.unterminated) this.err = this.err ?? 'unterminated quote';
        lit(r.value, true);
        i = r.end;
        continue;
      }
      if (c === '"') {
        const r = this.parseDoubleQuoted(i + 1, '"');
        for (const p of r.parts) {
          if (p.t === 'lit') lit(p.v, true); else parts.push(p);
        }
        i = r.end;
        continue;
      }
      if (c === '$' || c === '`') {
        const r = this.parseDollar(i, false);
        if (r) {
          if (r.part.t === 'lit') lit(r.part.v, false); else parts.push(r.part);
          i = r.end;
          continue;
        }
      }
      lit(c, false);
      i++;
    }
    return { word: { parts, start, end: i }, end: i };
  }

  /** Content of "…" (or an unquoted here-doc body when `term` is null). */
  parseDoubleQuoted(i: number, term: '"' | null): { parts: WordPart[]; end: number } {
    const src = this.src;
    const parts: WordPart[] = [];
    let buf = '';
    const flush = () => { if (buf) { parts.push({ t: 'lit', v: buf, quoted: true }); buf = ''; } };
    while (i < src.length) {
      const c = src[i]!;
      if (term && c === term) { flush(); return { parts, end: i + 1 }; }
      if (c === '\\' && i + 1 < src.length) {
        const n = src[i + 1]!;
        if (n === '\n') { i += 2; continue; }
        if (n === '$' || n === '`' || n === '"' || n === '\\') { buf += n; i += 2; continue; }
        buf += c;
        i++;
        continue;
      }
      if (c === '$' || c === '`') {
        const r = this.parseDollar(i, true);
        if (r) {
          if (r.part.t === 'lit') buf += r.part.v;
          else { flush(); parts.push(r.part); }
          i = r.end;
          continue;
        }
      }
      buf += c;
      i++;
    }
    flush();
    if (term) this.err = this.err ?? 'unterminated quote';
    return { parts, end: i };
  }

  /** `$…` / backtick expansion at `i`. Null when `$` is just a literal dollar. */
  private parseDollar(i: number, quoted: boolean): { part: WordPart; end: number } | null {
    const src = this.src;
    if (src[i] === '`') {
      // Backticks: find the closing unescaped backtick, unescape \` \\ \$, parse separately.
      let j = i + 1;
      let inner = '';
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\' && (src[j + 1] === '`' || src[j + 1] === '\\' || src[j + 1] === '$')) { inner += src[j + 1]; j += 2; continue; }
        inner += src[j];
        j++;
      }
      if (j >= src.length) this.err = this.err ?? 'unterminated backtick';
      const body = new Parser(inner, this.depth + 1).parseList(0, false).script;
      if (body.error) this.err = this.err ?? body.error;
      return { part: { t: 'sub', body }, end: Math.min(j + 1, src.length) };
    }
    const n = src[i + 1];
    if (n === '(' && src[i + 2] === '(') {
      const end = this.skipArith(i + 3);
      const nested = this.substitutionsIn(src.slice(i + 3, Math.max(i + 3, end - 2)));
      return { part: { t: 'arith', ...(nested.length ? { nested } : {}) }, end };
    }
    if (n === '(') {
      const r = new Parser(src, this.depth + 1).parseList(i + 2, true);
      if (r.script.error) this.err = this.err ?? r.script.error;
      return { part: { t: 'sub', body: r.script }, end: r.end };
    }
    if (n === '{') {
      const j = matchBrace(src, i + 2);
      const inner = src.slice(i + 2, j < 0 ? src.length : j);
      if (j < 0) this.err = this.err ?? 'unterminated ${';
      const m = /^([#!]?)([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(.*)$/s.exec(inner);
      const name = m ? m[2]! : inner;
      const op = m && (m[1] || m[3]) ? `${m[1]}${m[3] ? m[3].slice(0, 2) : ''}` : undefined;
      const nested = op || !m ? this.substitutionsIn(m ? m[3]! : inner) : [];
      return { part: { t: 'var', name, quoted, ...(op ? { op } : {}), ...(nested.length ? { nested } : {}) }, end: j < 0 ? src.length : j + 1 };
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-])/.exec(src.slice(i + 1));
    if (m) return { part: { t: 'var', name: m[1]!, quoted }, end: i + 1 + m[1]!.length };
    return null;
  }

  /** Command substitutions (`$( )`, backticks) anywhere in `text` — they run. */
  private substitutionsIn(text: string): ParsedScript[] {
    if (!/\$\(|`/.test(text) || this.depth > MAX_DEPTH) return [];
    const out: ParsedScript[] = [];
    const collect = (parts: WordPart[]) => {
      for (const p of parts) {
        if (p.t === 'sub' || p.t === 'proc') out.push(p.body);
        else if ((p.t === 'var' || p.t === 'arith') && p.nested) out.push(...p.nested);
      }
    };
    collect(new Parser(text, this.depth + 1).parseDoubleQuoted(0, null).parts);
    return out;
  }

  /** Skip `(( … ))` / `$(( … ))` content; `i` is just inside the opening parens. */
  private skipArith(i: number): number {
    const src = this.src;
    let depth = 2;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    return i;
  }

  /** After a newline: consume the bodies of here-documents opened on the previous line. */
  private readHeredocBodies(i: number): number {
    const src = this.src;
    while (this.pendingHeredocs.length) {
      const r = this.pendingHeredocs.shift()!;
      const hd = r.heredoc!;
      const lines: string[] = [];
      let found = false;
      while (i < src.length) {
        const nl = src.indexOf('\n', i);
        const lineEnd = nl < 0 ? src.length : nl;
        const line = src.slice(i, lineEnd);
        i = nl < 0 ? src.length : nl + 1;
        const cmp = r.op === '<<-' ? line.replace(/^\t+/, '') : line;
        if (cmp === hd.delim || cmp.trimEnd() === hd.delim) { found = true; break; }
        lines.push(line);
      }
      hd.body = lines.join('\n');
      if (!found) this.err = this.err ?? 'unterminated here-document';
      if (hd.expands && /[$`]/.test(hd.body)) {
        const sub = new Parser(hd.body, this.depth + 1).parseDoubleQuoted(0, null);
        for (const p of sub.parts) if (p.t === 'sub') hd.subs.push(p.body);
      }
    }
    return i;
  }
}

function matchBrace(src: string, i: number): number {
  let depth = 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') { i += 2; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** `$'…'` ANSI-C quoting: decode the common escapes (obfuscation like $'\x72\x6d' = rm). */
function readAnsiC(src: string, i: number): { value: string; end: number; unterminated: boolean } {
  let out = '';
  while (i < src.length) {
    const c = src[i]!;
    if (c === "'") return { value: out, end: i + 1, unterminated: false };
    if (c === '\\' && i + 1 < src.length) {
      const n = src[i + 1]!;
      const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
      if (simple[n] !== undefined) { out += simple[n]; i += 2; continue; }
      if (n === 'x') {
        const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 2));
        if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
      }
      if (n === 'u' || n === 'U') {
        const m = (n === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(src.slice(i + 2));
        if (m) { out += String.fromCodePoint(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
      }
      if (/[0-7]/.test(n)) {
        const m = /^[0-7]{1,3}/.exec(src.slice(i + 1))!;
        out += String.fromCharCode(parseInt(m[0], 8));
        i += 1 + m[0].length;
        continue;
      }
      out += n;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return { value: out, end: i, unterminated: true };
}
