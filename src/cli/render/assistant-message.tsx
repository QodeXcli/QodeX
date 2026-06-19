import React from 'react';
import { Box, Text } from 'ink';

/**
 * Renders an assistant message with markdown awareness so the terminal
 * transcript looks structured and intentional — like Claude Code — instead of a
 * raw dump:
 *   - fenced code blocks (```lang … ```) render inside a bordered, padded card
 *     with a dim language label and lightweight, dependency-free syntax colour;
 *   - an UNTERMINATED fence (while the model is still streaming the block) also
 *     renders as a card, so code never flashes raw at the bottom mid-stream;
 *   - ATX headings (#…######) render with a clear visual hierarchy;
 *   - bullet / numbered lines get a tidy coloured marker;
 *   - inline **bold** and `code` are actually styled, not stripped.
 *
 * DISPLAY ONLY. The underlying message text is untouched (history/store keep the
 * original), so copy/Save and the model's own context are unaffected.
 *
 * The highlighter is intentionally conservative: it only WRAPS substrings in
 * colour, never reorders or drops a character. `tokenizeCodeLine` guarantees the
 * concatenation of its token texts equals the input line (asserted in tests), so
 * code is always rendered verbatim.
 */

type Segment =
  | { kind: 'code'; lang: string; body: string; incomplete?: boolean }
  | { kind: 'text'; body: string };

/** Split a message into alternating prose and fenced-code segments. */
export function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) {
      const prose = text.slice(last, m.index);
      if (prose.trim()) segments.push({ kind: 'text', body: prose.replace(/\n+$/, '') });
    }
    segments.push({ kind: 'code', lang: (m[1] ?? '').trim(), body: (m[2] ?? '').replace(/\n$/, '') });
    last = fence.lastIndex;
  }
  if (last < text.length) {
    const tail = text.slice(last);
    // A trailing, still-open fence (mid-stream): render what follows it as a code
    // card flagged incomplete, so streaming code is boxed as it arrives rather
    // than dumped raw until the closing ``` finally lands.
    const open = tail.match(/```([^\n`]*)\n?/);
    if (open && open.index !== undefined) {
      const before = tail.slice(0, open.index);
      if (before.trim()) segments.push({ kind: 'text', body: before.replace(/\n+$/, '') });
      const codeBody = tail.slice(open.index + open[0].length);
      segments.push({ kind: 'code', lang: (open[1] ?? '').trim(), body: codeBody.replace(/\n$/, ''), incomplete: true });
    } else if (tail.trim()) {
      segments.push({ kind: 'text', body: tail.replace(/^\n+/, '') });
    }
  }
  return segments.length ? segments : [{ kind: 'text', body: text }];
}

// ---------------------------------------------------------------------------
// Inline emphasis: render **bold** and `code` instead of stripping the markers.
// ---------------------------------------------------------------------------

/** Back-compat: strip inline markers to plain text (used by some callers/tests). */
export function stripInline(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

/** Render a prose string with inline **bold** and `code` styled. Preserves all
 *  visible characters (only the markers themselves are dropped). */
export function renderInline(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*([^*]+?)\*\*|`([^`]+?)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(<Text key={key++}>{s.slice(last, m.index)}</Text>);
    if (m[2] !== undefined) out.push(<Text key={key++} bold>{m[2]}</Text>);
    else if (m[3] !== undefined) out.push(<Text key={key++} color="cyan">{m[3]}</Text>);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(<Text key={key++}>{s.slice(last)}</Text>);
  return out.length ? out : [<Text key={0}>{s}</Text>];
}

function ProseLine({ line }: { line: string }): React.ReactElement {
  // Headings — clear hierarchy by level.
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    const level = h![1].length;
    const text = h![2];
    if (level === 1) return <Text bold color="magenta">{renderInline(text)}</Text>;
    if (level === 2) return <Text bold color="cyan">{renderInline(text)}</Text>;
    if (level === 3) return <Text bold color="blue">{renderInline(text)}</Text>;
    return <Text bold>{renderInline(text)}</Text>;
  }
  // Blockquote
  const q = line.match(/^>\s?(.*)$/);
  if (q) {
    return <Text><Text color="gray">▏ </Text><Text dimColor>{renderInline(q![1])}</Text></Text>;
  }
  // Bullets
  const b = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (b) {
    return <Text>{b![1]}<Text color="cyan">• </Text>{renderInline(b![2])}</Text>;
  }
  // Numbered list
  const n = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (n) {
    return <Text>{n![1]}<Text color="cyan">{n![2]}. </Text>{renderInline(n![3])}</Text>;
  }
  return <Text>{renderInline(line)}</Text>;
}

// ---------------------------------------------------------------------------
// Lightweight, verbatim-safe syntax highlighting.
// ---------------------------------------------------------------------------

export interface CodeToken { text: string; color?: string; dim?: boolean }

type LangFamily = 'js' | 'py' | 'sh' | 'json' | 'css' | 'go' | 'rust' | 'php' | 'sql' | 'yaml' | 'generic';

function langFamily(lang: string): LangFamily {
  const l = lang.toLowerCase();
  if (/^(js|jsx|ts|tsx|javascript|typescript|mjs|cjs)$/.test(l)) return 'js';
  if (/^(py|python)$/.test(l)) return 'py';
  if (/^(sh|bash|zsh|shell|console)$/.test(l)) return 'sh';
  if (/^(json|jsonc)$/.test(l)) return 'json';
  if (/^(css|scss|less)$/.test(l)) return 'css';
  if (/^(go|golang)$/.test(l)) return 'go';
  if (/^(rs|rust)$/.test(l)) return 'rust';
  if (/^(php)$/.test(l)) return 'php';
  if (/^(sql)$/.test(l)) return 'sql';
  if (/^(yml|yaml)$/.test(l)) return 'yaml';
  return 'generic';
}

const KEYWORDS: Record<string, Set<string>> = {
  js: new Set(['const','let','var','function','return','if','else','for','while','do','switch','case','break','continue','class','extends','new','this','super','import','from','export','default','async','await','try','catch','finally','throw','typeof','instanceof','in','of','delete','void','yield','interface','type','enum','implements','public','private','protected','readonly','static','as','namespace','declare','null','undefined','true','false']),
  py: new Set(['def','class','return','if','elif','else','for','while','import','from','as','try','except','finally','with','lambda','None','True','False','and','or','not','in','is','pass','yield','raise','global','nonlocal','async','await','assert','del','break','continue','self']),
  go: new Set(['func','return','if','else','for','range','switch','case','break','continue','package','import','var','const','type','struct','interface','map','chan','go','defer','select','nil','true','false','make','new']),
  rust: new Set(['fn','let','mut','return','if','else','for','while','loop','match','struct','enum','impl','trait','pub','use','mod','const','static','move','async','await','self','Self','true','false','Some','None','Ok','Err']),
  php: new Set(['function','return','if','else','elseif','for','foreach','while','switch','case','break','continue','class','new','public','private','protected','static','use','namespace','echo','true','false','null','as']),
  sql: new Set(['SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','ALTER','DROP','JOIN','LEFT','RIGHT','INNER','OUTER','ON','AS','AND','OR','NOT','NULL','ORDER','BY','GROUP','LIMIT','primary','key','select','from','where','insert','into','values','update','set','delete','create','table','join','on','and','or']),
};

function commentMarker(fam: LangFamily): string | null {
  if (fam === 'py' || fam === 'sh' || fam === 'yaml') return '#';
  if (fam === 'sql') return '--';
  if (fam === 'js' || fam === 'go' || fam === 'rust' || fam === 'php' || fam === 'css') return '//';
  return null;
}

/**
 * Tokenize a single code line into coloured spans. CONTRACT: the concatenation
 * of every returned token's `text` exactly equals `line` (tested). The function
 * only ever wraps slices of the input in colour; it never invents, drops, or
 * reorders characters.
 */
export function tokenizeCodeLine(line: string, lang: string): CodeToken[] {
  const fam = langFamily(lang);
  const tokens: CodeToken[] = [];
  const kw = KEYWORDS[fam];
  const cmt = commentMarker(fam);
  let plain = '';
  const flush = () => { if (plain) { tokens.push({ text: plain }); plain = ''; } };
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    // Line comment to end of line.
    if (cmt && rest.startsWith(cmt)) { flush(); tokens.push({ text: rest, dim: true }); break; }
    // Same-line block comment (or to EOL if unterminated).
    if ((fam === 'js' || fam === 'css' || fam === 'go' || fam === 'rust' || fam === 'php') && rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      const seg = end >= 0 ? rest.slice(0, end + 2) : rest;
      flush(); tokens.push({ text: seg, dim: true }); i += seg.length; continue;
    }
    const ch = line[i]!;
    // Strings (double, single, backtick). Unterminated → consume to EOL (still verbatim).
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === ch) { j++; break; }
        j++;
      }
      flush(); tokens.push({ text: line.slice(i, j), color: 'green' }); i = j; continue;
    }
    // Numbers.
    if (ch >= '0' && ch <= '9') {
      const nm = rest.match(/^\d[\d_]*\.?\d*([eExX][+-]?[0-9a-fA-F]+)?/);
      if (nm) { flush(); tokens.push({ text: nm[0], color: 'yellow' }); i += nm[0].length; continue; }
    }
    // Identifiers / keywords.
    if (/[A-Za-z_$]/.test(ch)) {
      const idm = rest.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)!;
      const word = idm[0];
      if (kw && kw.has(word)) { flush(); tokens.push({ text: word, color: 'magenta' }); }
      else { plain += word; }
      i += word.length; continue;
    }
    plain += ch; i++;
  }
  flush();
  return tokens.length ? tokens : [{ text: line }];
}

function CodeBlock({ lang, body, incomplete }: { lang: string; body: string; incomplete?: boolean }): React.ReactElement {
  const lines = body.split('\n');
  return (
    <Box flexDirection="column" marginY={1}>
      <Box paddingX={1}>
        <Text dimColor>{lang || 'code'}{incomplete ? ' ·' : ''}</Text>
      </Box>
      <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        {lines.map((ln, i) => {
          if (!ln.length) return <Text key={i}> </Text>;
          const toks = tokenizeCodeLine(ln, lang);
          return (
            <Text key={i}>
              {toks.map((t, j) => (
                <Text key={j} color={t.color} dimColor={t.dim}>{t.text}</Text>
              ))}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

export function AssistantMessage({ text }: { text: string }): React.ReactElement {
  const segments = parseSegments(text);
  return (
    <Box flexDirection="column" marginY={1}>
      {segments.map((seg, i) =>
        seg.kind === 'code' ? (
          <CodeBlock key={i} lang={seg.lang} body={seg.body} incomplete={seg.incomplete} />
        ) : (
          <Box key={i} flexDirection="column">
            {seg.body.split('\n').map((ln, j) => (
              <ProseLine key={j} line={ln} />
            ))}
          </Box>
        ),
      )}
    </Box>
  );
}
