/**
 * Page observation for the QodeX Browser: accessibility snapshots with element
 * refs, set-of-marks boxes, and DOM → markdown/text/links/tables/metadata
 * extraction.
 *
 * Snapshots come from Playwright's AI aria snapshot (`ariaSnapshot({mode:'ai'})`),
 * whose lines look like `- button "Sign in" [ref=e11]` — the ref is what the
 * model passes back to browser_click / browser_type ("aria-ref=e11" locator).
 * Older Playwright versions without the AI mode fall back to an in-page DOM
 * walker that tags elements with `data-qx-ref` and prints the same line format,
 * so the pure helpers (interactive filtering, truncation, box parsing) work on
 * either output.
 *
 * tsconfig has no DOM lib, so every in-page function is built from a STRING
 * (`new Function(...)`) — Playwright serializes it with `toString()` and calls it
 * in the page with the element/argument.
 */

// ── pure helpers (unit-tested on sample strings) ────────────────────────────

/** Roles the agent can act on — kept by the interactive-only filter. */
export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider',
  'spinbutton', 'textarea',
]);

/** Short status/alert roles whose text tells the agent whether an action worked. */
const NOTICE_ROLES = new Set(['alert', 'alertdialog', 'dialog']);

const LINE_RE = /^(\s*)- (.*)$/;
const REF_IN_LINE = /\[ref=([a-z0-9]+)\]/i;

/** A ref as printed in snapshots: e12, or f1e3 inside iframe 1. */
export const REF_RE = /^(f\d+)?e\d+$/;

function roleOf(content: string): string {
  const m = /^([a-z][a-z-]*)/i.exec(content);
  return m ? m[1].toLowerCase() : '';
}

function hasQuotedName(content: string): boolean {
  return /^[a-z][a-z-]*\s+"/i.test(content);
}

/** Inline text after `: ` on a line (`- generic [ref=e5]: Click me`). */
function inlineText(content: string): string {
  const m = /\]:\s+(.+)$/.exec(content) || /^[a-z][a-z-]*:\s+(.+)$/i.exec(content);
  return m ? m[1].trim() : '';
}

/** Truncate a URL to `max` chars with an ellipsis. */
export function truncateUrl(url: string, max = 120): string {
  return url.length > max ? url.slice(0, max) + '…' : url;
}

/** Shorten `/url:` child lines longer than `max` (keeps snapshots compact; data: URLs can be huge). */
export function truncateLongUrls(text: string, max = 300): string {
  return text
    .split('\n')
    .map(line => {
      const m = /^(\s*- \/url:\s*)(.*)$/.exec(line);
      return m && m[2].length > max ? m[1] + truncateUrl(m[2], max) : line;
    })
    .join('\n');
}

/**
 * Keep only what the agent can act on: headings, ref'd lines whose role is
 * interactive (plus `cursor=pointer` click targets not nested in another kept
 * element), options of kept selects/listboxes, alerts/dialogs, and `/url:`
 * children of kept links (URLs truncated to 120 chars). Output is re-indented by
 * the depth of KEPT ancestors so it stays readable. PURE.
 */
export function filterInteractive(snapshot: string, opts: { maxOptions?: number; maxLineChars?: number } = {}): string {
  const maxOptions = opts.maxOptions ?? 25;
  const maxLine = opts.maxLineChars ?? 220;
  const lines = snapshot.split('\n');
  const out: string[] = [];
  // Ancestor stack of the input tree: indent + whether that node was kept (and its output depth).
  const stack: Array<{ indent: number; kept: boolean; depth: number; role: string; options: number; extraOptions: number }> = [];

  const flushExtraOptions = (node: (typeof stack)[number]) => {
    if (node.extraOptions > 0) {
      out.push(`${'  '.repeat(node.depth + 1)}- … ${node.extraOptions} more option(s)`);
      node.extraOptions = 0;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    let content = m[2];
    while (stack.length && stack[stack.length - 1].indent >= indent) flushExtraOptions(stack.pop()!);
    const keptAncestor = [...stack].reverse().find(s => s.kept);
    const depth = keptAncestor ? keptAncestor.depth + 1 : 0;
    const parent = stack[stack.length - 1];

    if (/^\/(url|placeholder):/.test(content)) {
      if (parent?.kept) {
        const um = /^\/url:\s*(.*)$/.exec(content);
        const text = um ? `/url: ${truncateUrl(um[1], 120)}` : content;
        out.push(`${'  '.repeat(parent.depth + 1)}- ${text}`);
      }
      continue;
    }

    const role = roleOf(content);
    const ref = REF_IN_LINE.exec(content);
    const insideKept = !!keptAncestor;
    let keep = false;
    if (role === 'heading') keep = true;
    else if (ref && INTERACTIVE_ROLES.has(role)) keep = true;
    else if (role === 'option' && parent?.kept && (parent.role === 'combobox' || parent.role === 'listbox')) {
      parent.options++;
      if (parent.options > maxOptions) { parent.extraOptions++; stack.push({ indent, kept: false, depth, role, options: 0, extraOptions: 0 }); continue; }
      keep = true;
    } else if (ref && /\[cursor=pointer\]/.test(content) && !insideKept) keep = true;
    else if (NOTICE_ROLES.has(role)) keep = true;

    if (keep) {
      // A bare trailing ':' only announces children; drop it (children we keep are indented below).
      content = content.replace(/:\s*$/, '');
      // Unnamed links/buttons: borrow the first descendant's name/text so the line is useful.
      if (!hasQuotedName(content) && !inlineText(content) && role !== 'heading') {
        const borrowed = firstDescendantText(lines, i, indent);
        if (borrowed) content += ` (text: ${borrowed})`;
      }
      if (content.length > maxLine) content = content.slice(0, maxLine) + '…';
      out.push(`${'  '.repeat(depth)}- ${content}`);
    }
    stack.push({ indent, kept: keep, depth, role, options: 0, extraOptions: 0 });
  }
  while (stack.length) flushExtraOptions(stack.pop()!);
  return out.join('\n');
}

function firstDescendantText(lines: string[], start: number, indent: number): string {
  for (let j = start + 1; j < lines.length && j < start + 12; j++) {
    const m = LINE_RE.exec(lines[j]);
    if (!m) continue;
    if (m[1].length <= indent) break;
    const c = m[2];
    if (c.startsWith('/')) continue;
    const q = /^[a-z][a-z-]*\s+"((?:[^"\\]|\\.)*)"/i.exec(c);
    if (q && q[1].trim()) return q[1].trim().slice(0, 80);
    const t = inlineText(c);
    if (t) return t.replace(/^"|"$/g, '').slice(0, 80);
  }
  return '';
}

/**
 * Cut a snapshot at a line boundary so it fits `maxChars`, appending a hint
 * that tells the model how to see the rest. PURE.
 */
export function truncateSnapshot(text: string, maxChars: number): { text: string; truncated: boolean; omittedLines: number } {
  if (text.length <= maxChars) return { text, truncated: false, omittedLines: 0 };
  const lines = text.split('\n');
  const budget = Math.max(0, maxChars - 90);
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  const omitted = lines.length - kept.length;
  kept.push(`… [${omitted} more lines — use selector=... or browser_extract]`);
  return { text: kept.join('\n'), truncated: true, omittedLines: omitted };
}

export interface MarkBox {
  ref: string;
  role: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rendered with `cursor: pointer` (a click target even without an interactive role). */
  pointer?: boolean;
}

/**
 * Parse `[box=x,y,w,h]` annotations (viewport CSS px) from an AI snapshot taken
 * with `boxes: true`. Boxes of refs inside an iframe (`f1e3`) are relative to the
 * frame, so the enclosing iframe's box offset is added. PURE.
 */
export function parseBoxes(snapshot: string): MarkBox[] {
  const out: MarkBox[] = [];
  const frames: Array<{ indent: number; x: number; y: number }> = [];
  for (const line of snapshot.split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const content = m[2];
    while (frames.length && frames[frames.length - 1].indent >= indent) frames.pop();
    const box = /\[box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/.exec(content);
    const ref = REF_IN_LINE.exec(content);
    if (!box || !ref) continue;
    const role = roleOf(content);
    const offX = frames.reduce((s, f) => s + f.x, 0);
    const offY = frames.reduce((s, f) => s + f.y, 0);
    const x = Number(box[1]) + (/^f\d+e/.test(ref[1]) ? offX : 0);
    const y = Number(box[2]) + (/^f\d+e/.test(ref[1]) ? offY : 0);
    const name = /^[a-z][a-z-]*\s+"((?:[^"\\]|\\.)*)"/i.exec(content)?.[1] ?? inlineText(content);
    if (role === 'iframe') frames.push({ indent, x: Number(box[1]), y: Number(box[2]) });
    const mark: MarkBox = { ref: ref[1], role, name: name.slice(0, 80), x, y, w: Number(box[3]), h: Number(box[4]) };
    if (/\[cursor=pointer\]/.test(content)) mark.pointer = true;
    out.push(mark);
  }
  return out;
}

/** Remove `[box=...]` annotations so a boxes snapshot reads like a normal one. PURE. */
export function stripBoxes(snapshot: string): string {
  return snapshot.replace(/ \[box=[-\d.,]+\]/g, '');
}

/** How a hidden secret field value is shown to the model. */
export const HIDDEN_VALUE = '[hidden]';

/** Playwright's YAML quoting of snapshot values (`yamlEscapeValueIfNeeded`), for matching. */
function yamlQuoted(v: string): string {
  return '"' + v.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, c => {
    switch (c) {
      case '\\': return '\\\\';
      case '"': return '\\"';
      case '\b': return '\\b';
      case '\f': return '\\f';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      default: return '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0');
    }
  }) + '"';
}

/** `- role "name" [attr]...: value` → [prefix, value]. */
const FIELD_VALUE_RE = /^(\s*- [a-z][a-z-]*(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]\n]*\])*): (.+)$/i;

/**
 * Hide the values of secret form fields in a snapshot. Playwright's aria snapshot
 * prints a textbox's VALUE (`- textbox "Password" [ref=e6]: hunter2`) — including
 * <input type=password> — so a password filled from the vault (browser_fill_secret),
 * a saved login or a card number typed by the human would otherwise reach the
 * model. `secrets` are the current values of the page's secret inputs
 * (collectSecretValues). A field line whose value equals one is shown as
 * `[hidden]`; long secrets (≥ 8 chars) are also masked anywhere else (a page that
 * echoes them back). PURE.
 */
export function maskSecretValues(snapshot: string, secrets: string[]): string {
  const vals = Array.from(new Set(secrets.filter(s => typeof s === 'string' && s.length > 0)));
  if (!vals.length) return snapshot;
  const exact = new Set<string>();
  for (const v of vals) { exact.add(v); exact.add(yamlQuoted(v)); }
  const long = vals.filter(v => v.length >= 8).sort((a, b) => b.length - a.length);
  return snapshot
    .split('\n')
    .map(line => {
      const m = FIELD_VALUE_RE.exec(line);
      if (m && exact.has(m[2].trim())) return `${m[1]}: ${HIDDEN_VALUE}`;
      let out = line;
      for (const v of long) {
        for (const form of [v, yamlQuoted(v).slice(1, -1)]) {
          if (form && out.includes(form)) out = out.split(form).join(HIDDEN_VALUE);
        }
      }
      return out;
    })
    .join('\n');
}

/**
 * In-page (one frame): current values of secret inputs — password fields and
 * autocomplete current/new-password, one-time-code, cc-number, cc-csc — including
 * inside open shadow roots. The values only travel to QodeX (to mask them), never
 * into a tool result.
 */
const COLLECT_SECRETS_FN: (...args: unknown[]) => unknown = new Function(`
  var out = [];
  var SECRET_AC = /(^|\\s)(current-password|new-password|one-time-code|cc-number|cc-csc)(\\s|$)/i;
  function scan(root, depth) {
    if (!root || depth > 8 || out.length >= 50) return;
    var inputs = root.querySelectorAll('input');
    for (var i = 0; i < inputs.length && out.length < 50; i++) {
      var el = inputs[i];
      var t = String(el.getAttribute('type') || '').toLowerCase();
      var ac = String(el.getAttribute('autocomplete') || '');
      var v = '';
      try { v = String(el.value || ''); } catch (e) { v = ''; }
      if (v && (t === 'password' || el.type === 'password' || SECRET_AC.test(ac))) out.push(v);
    }
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) scan(all[j].shadowRoot, depth + 1);
  }
  scan(document, 0);
  return out;
`) as any;

/**
 * Current values of the page's secret inputs across ALL frames (Playwright can
 * evaluate in cross-origin frames too). Best-effort: a frame that cannot be
 * evaluated contributes nothing.
 */
export async function collectSecretValues(page: any, timeoutMs = 2000): Promise<string[]> {
  let frames: any[] = [];
  try { frames = typeof page?.frames === 'function' ? page.frames() : []; } catch { frames = []; }
  if (!frames.length) {
    try { frames = page?.mainFrame ? [page.mainFrame()] : []; } catch { frames = []; }
  }
  const results = await Promise.all(frames.slice(0, 50).map((f: any) => new Promise<string[]>(resolve => {
    const t = setTimeout(() => resolve([]), timeoutMs);
    (t as any).unref?.();
    Promise.resolve()
      .then(() => f.evaluate(COLLECT_SECRETS_FN))
      .then(
        (r: unknown) => { clearTimeout(t); resolve(Array.isArray(r) ? r.filter((x: unknown): x is string => typeof x === 'string') : []); },
        () => { clearTimeout(t); resolve([]); },
      );
  })));
  return results.flat();
}

/**
 * Mask secrets in free-form tool output (e.g. a browser_evaluate result): the
 * whole text equal to a secret, JSON-quoted occurrences of any length, and
 * everything maskSecretValues covers. PURE.
 */
export function maskSecretText(text: string, secrets: string[]): string {
  const vals = Array.from(new Set(secrets.filter(s => typeof s === 'string' && s.length > 0)));
  if (!vals.length) return text;
  if (vals.includes(text.trim())) return HIDDEN_VALUE;
  let out = text;
  for (const v of vals.sort((a, b) => b.length - a.length)) {
    const q = JSON.stringify(v);
    if (out.includes(q)) out = out.split(q).join(JSON.stringify(HIDDEN_VALUE));
  }
  return maskSecretValues(out, vals);
}

/** Mask the current secret field values of `page` in `text` (see maskSecretText). */
export async function maskPageSecrets(page: any, text: string): Promise<string> {
  return maskSecretText(text, await collectSecretValues(page));
}

// ── in-page sources ─────────────────────────────────────────────────────────

/**
 * `function (el) → ElementInfo-like | null`, evaluated IN THE PAGE. Shared by
 * describeRef/describeSelector, human-click introspection and the DOM walker.
 * Never returns the value of an input (passwords, card numbers stay in the page).
 */
export const DESCRIBE_ELEMENT_JS = String.raw`function describeElement(el) {
  if (!el || el.nodeType !== 1) return null;
  var doc = el.ownerDocument || document;
  var tag = el.tagName.toLowerCase();
  function clean(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 120); }
  function attr(n) { return el.getAttribute(n); }
  var type = tag === 'input' ? String(attr('type') || 'text').toLowerCase() : undefined;
  function implicitRole() {
    switch (tag) {
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button': case 'summary': return 'button';
      case 'select': return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'option': return 'option';
      case 'img': return attr('alt') === '' ? 'presentation' : 'img';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'form': return 'form';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'dialog': return 'dialog';
      case 'input':
        switch (type) {
          case 'button': case 'submit': case 'reset': case 'image': case 'file': return 'button';
          case 'checkbox': return 'checkbox';
          case 'radio': return 'radio';
          case 'range': return 'slider';
          case 'number': return 'spinbutton';
          case 'search': return 'searchbox';
          case 'hidden': return 'none';
          default: return attr('list') ? 'combobox' : 'textbox';
        }
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  }
  var explicit = String(attr('role') || '').trim().split(/\s+/)[0];
  var role = explicit || implicitRole();
  function labelText() {
    var lb = attr('aria-labelledby');
    if (lb) {
      var parts = [];
      lb.split(/\s+/).forEach(function (id) { var n = doc.getElementById(id); if (n) parts.push(n.textContent || ''); });
      if (parts.join('').trim()) return clean(parts.join(' '));
    }
    var al = attr('aria-label');
    if (al && al.trim()) return clean(al);
    if (el.labels && el.labels.length) {
      return clean(Array.prototype.map.call(el.labels, function (l) { return l.innerText || l.textContent || ''; }).join(' '));
    }
    return '';
  }
  var isField = tag === 'input' || tag === 'textarea' || tag === 'select';
  var name = labelText();
  if (!name) {
    if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset')) name = clean(el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''));
    else if (tag === 'img' || (tag === 'input' && type === 'image')) name = clean(attr('alt'));
    else if (!isField) name = clean(el.innerText || el.textContent);
  }
  if (!name) name = clean(attr('placeholder') || attr('title') || attr('alt') || '');
  var ac = attr('autocomplete') || undefined;
  var isPassword = type === 'password' || /(^|\s)(current-password|new-password)(\s|$)/i.test(ac || '');
  var form = el.form || (el.closest ? el.closest('form') : null);
  var href;
  if (tag === 'a' || tag === 'area') href = el.href ? String(el.href) : (attr('href') || undefined);
  var text = isField ? (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset') ? clean(el.value, 200) : '') : clean(el.innerText || el.textContent, 200);
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }
  function unique(sel) { try { return doc.querySelectorAll(sel).length === 1; } catch (e) { return false; } }
  function quote(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
  function buildSelector() {
    if (el.id) { var s1 = '#' + cssEscape(el.id); if (unique(s1)) return s1; }
    var testAttrs = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
    for (var i = 0; i < testAttrs.length; i++) {
      var v = attr(testAttrs[i]);
      if (v) { var s2 = '[' + testAttrs[i] + '=' + quote(v) + ']'; if (unique(s2)) return s2; }
    }
    var nm = attr('name');
    if (nm) {
      var base = tag + '[name=' + quote(nm) + ']';
      if (form && form.id) { var s3 = '#' + cssEscape(form.id) + ' ' + base; if (unique(s3)) return s3; }
      if (unique(base)) return base;
    }
    if (role && name && role !== 'generic' && role !== 'none' && role !== 'presentation') {
      return 'role=' + role + '[name=' + quote(name) + ']';
    }
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== doc.documentElement) {
      if (cur.id && unique('#' + cssEscape(cur.id))) { parts.unshift('#' + cssEscape(cur.id)); break; }
      var part = cur.tagName.toLowerCase();
      var parent = cur.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }
  var info = { role: role, name: name, tag: tag, isPassword: isPassword, selector: buildSelector() };
  if (type) info.inputType = type;
  if (ac) info.autocomplete = ac;
  if (href) info.href = href;
  if (text) info.text = text;
  if (form && form.action) info.formAction = String(form.action);
  return info;
}`;

/** In-page: describe `el` (Locator.evaluate passes the element as the first arg). */
export const DESCRIBE_ELEMENT_FN: (...args: unknown[]) => unknown =
  new Function('el', `return (${DESCRIBE_ELEMENT_JS})(el);`) as any;

/** In-page: describe the element at viewport point {x, y} (human clicks in the control center). */
export const DESCRIBE_AT_POINT_FN: (...args: unknown[]) => unknown = new Function('p', `
  var el = document.elementFromPoint(p.x, p.y);
  return el ? (${DESCRIBE_ELEMENT_JS})(el) : null;
`) as any;

/**
 * In-page (one frame): what has keyboard focus in THIS frame's document —
 * `{state:'none'|'frame'|'el', focus, info?}`. 'frame' means focus is inside a
 * child <iframe>/<frame> (its document must be probed separately — Playwright can
 * evaluate in cross-origin frames, page JS cannot). `focus` = document.hasFocus().
 */
export const FOCUS_PROBE_FN: (...args: unknown[]) => unknown = new Function(`
  var el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  var focus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  if (!el || el === document.body || el === document.documentElement) return { state: 'none', focus: focus };
  var t = el.tagName;
  if (t === 'IFRAME' || t === 'FRAME') return { state: 'frame', focus: focus };
  return { state: 'el', focus: focus, info: (${DESCRIBE_ELEMENT_JS})(el) };
`) as any;

/** In-page, on an <iframe> element: viewport origin of its content box (for point → frame coordinates). */
export const FRAME_CONTENT_ORIGIN_FN: (...args: unknown[]) => unknown = new Function('el', `
  var r = el.getBoundingClientRect();
  var cs = getComputedStyle(el);
  return {
    x: r.left + el.clientLeft + (parseFloat(cs.paddingLeft) || 0),
    y: r.top + el.clientTop + (parseFloat(cs.paddingTop) || 0),
    w: r.width, h: r.height, left: r.left, top: r.top,
  };
`) as any;

/**
 * In-page DOM walker used when Playwright has no AI snapshot mode. Tags elements
 * with `data-qx-ref="eN"` and prints aria-snapshot-like lines. Args: (root, opts).
 */
const DOM_WALK_FN: (...args: unknown[]) => unknown = new Function('root', 'opts', `
  var doc = root.ownerDocument || document;
  var describe = (${DESCRIBE_ELEMENT_JS});
  Array.prototype.forEach.call(doc.querySelectorAll('[data-qx-ref]'), function (n) { n.removeAttribute('data-qx-ref'); });
  var INTERACTIVE = { button:1, link:1, textbox:1, searchbox:1, checkbox:1, radio:1, combobox:1, listbox:1, option:1, menuitem:1, menuitemcheckbox:1, menuitemradio:1, tab:1, switch:1, slider:1, spinbutton:1 };
  var SKIP = { SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, HEAD:1, META:1, LINK:1, SVG:1 };
  var n = 0; var lines = [];
  function q(s) { return '"' + String(s).replace(/"/g, '\\\\"') + '"'; }
  function visible(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    var st = getComputedStyle(el);
    if (st.display === 'contents') return true;
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  function walk(el, depth) {
    if (SKIP[el.tagName] || !visible(el)) return;
    var pad = new Array(depth + 1).join('  ');
    var info = describe(el) || { role: 'generic', name: '' };
    var role = info.role;
    var isHeading = role === 'heading';
    var interactive = INTERACTIVE[role] || (el.tagName === 'INPUT' && info.inputType !== 'hidden') || el.isContentEditable;
    var pointer = !interactive && getComputedStyle(el).cursor === 'pointer' &&
      !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer');
    if (interactive || isHeading || pointer) {
      var ref = 'e' + (++n);
      el.setAttribute('data-qx-ref', ref);
      var line = pad + '- ' + role + (info.name ? ' ' + q(info.name) : '');
      if (isHeading) line += ' [level=' + el.tagName.slice(1) + ']';
      if (el.checked) line += ' [checked]';
      if (el.disabled) line += ' [disabled]';
      line += ' [ref=' + ref + ']';
      if (pointer) line += ' [cursor=pointer]';
      lines.push(line);
      if (info.href) lines.push(pad + '  - /url: ' + info.href);
      if (el.tagName === 'SELECT') {
        Array.prototype.forEach.call(el.options, function (o) { lines.push(pad + '  - option ' + q(o.label || o.text) + (o.selected ? ' [selected]' : '')); });
      }
      return;
    }
    if (!opts.interactiveOnly) {
      var own = '';
      Array.prototype.forEach.call(el.childNodes, function (c) { if (c.nodeType === 3) own += c.textContent; });
      own = own.replace(/\\s+/g, ' ').trim();
      if (own) lines.push(pad + '- text: ' + own.slice(0, 300));
    }
    Array.prototype.forEach.call(el.children, function (c) { walk(c, depth); });
  }
  walk(root, 0);
  return lines.join('\\n');
`) as any;

/** In-page extraction (root, {format}) → string. */
const EXTRACT_FN: (...args: unknown[]) => unknown = new Function('root', 'opts', `
  var doc = root.ownerDocument || document;
  var fmt = opts.format;
  function clean(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); }
  function abs(u) { try { return new URL(u, doc.baseURI).href; } catch (e) { return u || ''; } }
  if (fmt === 'metadata') {
    var out = [];
    function meta(sel, attr) { var m = doc.querySelector(sel); return m ? (m.getAttribute(attr || 'content') || '') : ''; }
    out.push('title: ' + clean(doc.title));
    var d = meta('meta[name="description" i]'); if (d) out.push('description: ' + clean(d));
    var kw = meta('meta[name="keywords" i]'); if (kw) out.push('keywords: ' + clean(kw));
    var canon = doc.querySelector('link[rel="canonical" i]'); if (canon) out.push('canonical: ' + abs(canon.getAttribute('href')));
    var lang = doc.documentElement.getAttribute('lang'); if (lang) out.push('lang: ' + lang);
    out.push('url: ' + doc.location.href);
    Array.prototype.forEach.call(doc.querySelectorAll('meta[property^="og:" i], meta[name^="twitter:" i]'), function (m) {
      var k = m.getAttribute('property') || m.getAttribute('name'); var v = m.getAttribute('content');
      if (k && v) out.push(k + ': ' + clean(v));
    });
    var h1s = Array.prototype.map.call(doc.querySelectorAll('h1'), function (h) { return clean(h.innerText || h.textContent); }).filter(Boolean);
    if (h1s.length) out.push('h1: ' + h1s.join(' | '));
    return out.join('\\n');
  }
  var SKIP = { SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, SVG:1, CANVAS:1, IFRAME:1, NAV:1, FOOTER:1, HEAD:1, META:1, LINK:1, OBJECT:1, EMBED:1 };
  function hidden(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    var st = getComputedStyle(el);
    if (st.display === 'contents') return false;
    return st.display === 'none' || st.visibility === 'hidden';
  }
  function skip(el) { return el !== root && (SKIP[el.tagName] || hidden(el)); }
  if (fmt === 'text') return String(root.innerText || root.textContent || '');
  if (fmt === 'links') {
    var seen = {}; var links = [];
    Array.prototype.forEach.call(root.querySelectorAll('a[href]'), function (a) {
      var href = abs(a.getAttribute('href'));
      if (!href || /^javascript:/i.test(href)) return;
      var p = a; while (p && p !== root) { if (hidden(p)) return; p = p.parentElement; }
      var text = clean(a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '');
      var key = href + '|' + text; if (seen[key]) return; seen[key] = 1;
      links.push((links.length + 1) + '. [' + (text || href).replace(/[\\[\\]]/g, '') + '](' + href + ')');
    });
    return links.join('\\n');
  }
  function cell(c) { return clean(c.innerText || c.textContent).replace(/\\|/g, '\\\\|'); }
  function table(t) {
    var rows = Array.prototype.slice.call(t.rows, 0, 200);
    if (!rows.length) return '';
    var cols = 0; rows.forEach(function (r) { cols = Math.max(cols, r.cells.length); });
    if (!cols) return '';
    var lines = [];
    rows.forEach(function (r, i) {
      var cells = Array.prototype.map.call(r.cells, cell);
      while (cells.length < cols) cells.push('');
      lines.push('| ' + cells.join(' | ') + ' |');
      if (i === 0) lines.push('|' + new Array(cols + 1).join(' --- |'));
    });
    if (t.rows.length > 200) lines.push('… ' + (t.rows.length - 200) + ' more rows');
    var cap = t.caption ? clean(t.caption.innerText) : '';
    return (cap ? '**' + cap + '**\\n\\n' : '') + lines.join('\\n');
  }
  if (fmt === 'tables') {
    var ts = Array.prototype.filter.call(root.querySelectorAll('table'), function (t) { return !hidden(t); });
    if (root.tagName === 'TABLE') ts = [root];
    return ts.map(function (t, i) { return '### Table ' + (i + 1) + '\\n\\n' + table(t); }).join('\\n\\n');
  }
  // markdown
  var BLOCK = { P:1, DIV:1, SECTION:1, ARTICLE:1, MAIN:1, HEADER:1, ASIDE:1, FORM:1, FIGURE:1, FIGCAPTION:1, FIELDSET:1, DETAILS:1, SUMMARY:1, DL:1, DT:1, DD:1, ADDRESS:1, CENTER:1, BODY:1, HTML:1, LI:1 };
  var out = []; var para = '';
  function flush() { var t = para.replace(/[ \\t]+/g, ' ').replace(/ *\\n */g, '\\n').trim(); if (t) out.push(t); para = ''; }
  function inline(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\\s+/g, ' ');
    if (node.nodeType !== 1 || skip(node)) return '';
    var tag = node.tagName;
    if (tag === 'BR') return '\\n';
    if (tag === 'IMG') { var alt = clean(node.getAttribute('alt')); var src = node.getAttribute('src') || ''; return alt && !/^data:/.test(src) ? '![' + alt + '](' + abs(src) + ')' : ''; }
    var inner = Array.prototype.map.call(node.childNodes, inline).join('');
    if (tag === 'A') {
      var h = node.getAttribute('href');
      var t = clean(inner);
      if (!h || /^javascript:/i.test(h) || h === '#') return inner;
      return '[' + (t || abs(h)) + '](' + abs(h) + ')';
    }
    if (tag === 'STRONG' || tag === 'B') return clean(inner) ? '**' + clean(inner) + '**' : '';
    if (tag === 'EM' || tag === 'I') return clean(inner) ? '*' + clean(inner) + '*' : '';
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') return clean(inner) ? '\\x60' + clean(inner) + '\\x60' : '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return '';
    return inner;
  }
  function list(el, depth) {
    var ordered = el.tagName === 'OL'; var i = 0;
    Array.prototype.forEach.call(el.children, function (li) {
      if (li.tagName !== 'LI' || skip(li)) return;
      i++;
      var text = ''; var nested = [];
      Array.prototype.forEach.call(li.childNodes, function (c) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(c);
        else text += inline(c);
      });
      out.push(new Array(depth + 1).join('  ') + (ordered ? i + '. ' : '- ') + clean(text));
      nested.forEach(function (n) { list(n, depth + 1); });
    });
  }
  function block(el) {
    Array.prototype.forEach.call(el.childNodes, function (c) {
      if (c.nodeType === 3) { para += c.textContent; return; }
      if (c.nodeType !== 1 || skip(c)) return;
      var tag = c.tagName;
      if (/^H[1-6]$/.test(tag)) { flush(); var ht = clean(inline(c)); if (ht) out.push(new Array(+tag[1] + 1).join('#') + ' ' + ht); return; }
      if (tag === 'UL' || tag === 'OL') { flush(); list(c, 0); return; }
      if (tag === 'PRE') { flush(); out.push('\\x60\\x60\\x60\\n' + (c.innerText || c.textContent).replace(/\\n+$/, '') + '\\n\\x60\\x60\\x60'); return; }
      if (tag === 'TABLE') { flush(); var tb = table(c); if (tb) out.push(tb); return; }
      if (tag === 'BLOCKQUOTE') { flush(); var q = clean(c.innerText || c.textContent); if (q) out.push('> ' + q); return; }
      if (tag === 'HR') { flush(); out.push('---'); return; }
      if (tag === 'P') { flush(); para = inline(c); flush(); return; }
      if (BLOCK[tag]) { flush(); block(c); flush(); return; }
      para += inline(c);
    });
  }
  block(root);
  flush();
  return out.join('\\n\\n');
`) as any;

/** In-page set-of-marks overlay: (marks) → count drawn. */
const DRAW_MARKS_FN: (...args: unknown[]) => unknown = new Function('marks', `
  var old = document.getElementById('__qx_marks__'); if (old) old.remove();
  var host = document.createElement('div');
  host.id = '__qx_marks__';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  var colors = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000'];
  marks.forEach(function (m, i) {
    var c = colors[i % colors.length];
    var b = document.createElement('div');
    b.style.cssText = 'position:absolute;box-sizing:border-box;pointer-events:none;border:2px solid ' + c + ';left:' + (m.x + window.scrollX) + 'px;top:' + (m.y + window.scrollY) + 'px;width:' + Math.max(m.w, 4) + 'px;height:' + Math.max(m.h, 4) + 'px;';
    var l = document.createElement('span');
    l.textContent = m.ref;
    l.style.cssText = 'position:absolute;left:-2px;top:-15px;background:' + c + ';color:#fff;font:bold 11px/14px monospace;padding:0 3px;border-radius:2px;white-space:nowrap;';
    b.appendChild(l);
    host.appendChild(b);
  });
  document.documentElement.appendChild(host);
  return marks.length;
`) as any;

const CLEAR_MARKS_EXPR = "(() => { const h = document.getElementById('__qx_marks__'); if (h) h.remove(); return true; })()";

// ── page-level operations ───────────────────────────────────────────────────

export interface SnapshotOptions {
  /** Keep only actionable elements (+ headings, link URLs). */
  interactiveOnly?: boolean;
  /** Playwright selector of a subtree to snapshot. */
  selector?: string;
  /** Cap on the snapshot body (header excluded). Default 12000. */
  maxChars?: number;
  /** Tab strip info for the header; derived from the page's context when absent. */
  tabs?: { count: number; active: number };
  timeoutMs?: number;
}

export interface SnapshotResult {
  /** Header + body, ready for the model. */
  text: string;
  /** Snapshot lines only. */
  body: string;
  /** 'aria' = Playwright AI snapshot (aria-ref refs), 'dom' = fallback walker (data-qx-ref refs). */
  mode: 'aria' | 'dom';
  title: string;
  url: string;
  truncated: boolean;
  /** Number of refs in the (untruncated) body. */
  refCount: number;
}

function firstLine(e: unknown): string {
  const msg = (e as any)?.message ?? String(e);
  return String(msg).split('\n')[0].slice(0, 300);
}

async function pageHeader(page: any, tabs?: { count: number; active: number }): Promise<{ header: string; title: string; url: string }> {
  let title = '';
  try { title = await page.title(); } catch { /* keep '' */ }
  let url = '';
  try { url = page.url(); } catch { /* keep '' */ }
  let t = tabs;
  if (!t) {
    try {
      const pages = page.context().pages();
      t = { count: pages.length, active: Math.max(0, pages.indexOf(page)) };
    } catch { t = { count: 1, active: 0 }; }
  }
  const header = `Page: ${title || '(untitled)'}\nURL: ${url || 'about:blank'}\nTabs: ${t.count} (active ${t.active})`;
  return { header, title, url };
}

async function tryAria(target: any, opts: { boxes?: boolean; timeoutMs?: number }): Promise<string | null> {
  if (typeof target?.ariaSnapshot !== 'function') return null;
  const run = () => target.ariaSnapshot({ mode: 'ai', ...(opts.boxes ? { boxes: true } : {}), timeout: opts.timeoutMs ?? 10_000 });
  try {
    return String(await run());
  } catch (e) {
    // A navigation can destroy the execution context mid-snapshot: retry once.
    if (/context was destroyed|navigat/i.test(firstLine(e))) {
      try { return String(await run()); } catch { /* fall through */ }
    }
    return null;
  }
}

/** Snapshot the page (or a subtree) — see SnapshotResult. Throws `[BROWSER_ERROR]` on a bad selector. */
export async function takeSnapshotDetailed(page: any, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  const maxChars = opts.maxChars ?? 12_000;
  let target: any = page;
  if (opts.selector) {
    let count = 0;
    try { count = await page.locator(opts.selector).count(); } catch (e) {
      throw new Error(`[BROWSER_ERROR] invalid selector "${opts.selector}": ${firstLine(e)}`);
    }
    if (count === 0) {
      throw new Error(`[BROWSER_ERROR] selector "${opts.selector}" matched no element — call browser_snapshot without a selector to see the page.`);
    }
    target = page.locator(opts.selector).first();
  }

  let mode: 'aria' | 'dom' = 'aria';
  let raw = await tryAria(target, { timeoutMs: opts.timeoutMs });
  if (raw !== null && opts.selector) {
    // A subtree snapshot only registers refs inside that subtree; refresh the
    // page-wide ref map so refs from earlier snapshots stay valid (refs are
    // stable per element, so the subtree's refs are unchanged).
    await tryAria(page, { timeoutMs: opts.timeoutMs });
  }
  if (raw === null) {
    mode = 'dom';
    const root = opts.selector ? target : page.locator('body').first();
    try {
      raw = String(await root.evaluate(DOM_WALK_FN, { interactiveOnly: !!opts.interactiveOnly }) ?? '');
    } catch (e) {
      throw new Error(`[BROWSER_ERROR] could not snapshot the page: ${firstLine(e)}`);
    }
  }

  // The AI snapshot prints field VALUES, password inputs included: hide secrets
  // (vault fills, saved logins, card numbers) before anything reaches the model.
  const secrets = await collectSecretValues(page);
  raw = maskSecretValues(raw, secrets);
  const refCount = (raw.match(/\[ref=/g) || []).length;
  let body = opts.interactiveOnly ? filterInteractive(raw) : truncateLongUrls(raw, 300);
  if (!body.trim()) body = opts.interactiveOnly ? '(no interactive elements visible)' : '(empty page)';
  const cut = truncateSnapshot(body, maxChars);
  const ph = await pageHeader(page, opts.tabs);
  const header = maskSecretValues(ph.header, secrets);
  return { text: `${header}\n\n${cut.text}`, body: cut.text, mode, title: maskSecretValues(ph.title, secrets), url: ph.url, truncated: cut.truncated, refCount };
}

/** Header (`Page:`/`URL:`/`Tabs:`) + snapshot text. */
export async function takeSnapshot(page: any, opts: SnapshotOptions = {}): Promise<string> {
  return (await takeSnapshotDetailed(page, opts)).text;
}

/**
 * Snapshot with element boxes for set-of-marks overlays. In AI mode boxes come
 * from `[box=...]`; in fallback mode from the DOM walker's tagged elements.
 */
export async function snapshotWithBoxes(page: any, opts: { timeoutMs?: number } = {}): Promise<{ text: string; marks: MarkBox[]; mode: 'aria' | 'dom' }> {
  const aria = await tryAria(page, { boxes: true, timeoutMs: opts.timeoutMs });
  if (aria !== null) {
    // Unnamed fields borrow their inline VALUE as the mark name: mask secrets first.
    const raw = maskSecretValues(aria, await collectSecretValues(page));
    return { text: stripBoxes(raw), marks: parseBoxes(raw), mode: 'aria' };
  }
  const text = String(await page.locator('body').first().evaluate(DOM_WALK_FN, { interactiveOnly: true }) ?? '');
  const marks: MarkBox[] = await page.evaluate(new Function(`
    return Array.prototype.map.call(document.querySelectorAll('[data-qx-ref]'), function (el) {
      var r = el.getBoundingClientRect();
      var d = (${DESCRIBE_ELEMENT_JS})(el) || {};
      return { ref: el.getAttribute('data-qx-ref'), role: d.role || 'generic', name: String(d.name || '').slice(0, 80), x: r.x, y: r.y, w: r.width, h: r.height, pointer: getComputedStyle(el).cursor === 'pointer' };
    });
  `) as any);
  return { text, marks: Array.isArray(marks) ? marks : [], mode: 'dom' };
}

/** Only marks worth drawing: interactive, non-empty, intersecting the viewport. PURE. */
export function selectDrawableMarks(marks: MarkBox[], viewport: { width: number; height: number } | null, limit = 150): MarkBox[] {
  const vw = viewport?.width ?? Infinity;
  const vh = viewport?.height ?? Infinity;
  return marks
    .filter(m => (INTERACTIVE_ROLES.has(m.role) || (m.pointer === true && m.role !== 'img')) && m.w > 0 && m.h > 0)
    .filter(m => m.x + m.w > 0 && m.y + m.h > 0 && m.x < vw && m.y < vh)
    .slice(0, limit);
}

export async function drawMarks(page: any, marks: MarkBox[]): Promise<number> {
  return Number(await page.evaluate(DRAW_MARKS_FN, marks)) || 0;
}

export async function clearMarks(page: any): Promise<void> {
  try { await page.evaluate(CLEAR_MARKS_EXPR); } catch { /* page may have navigated */ }
}

export type ExtractFormat = 'markdown' | 'text' | 'links' | 'tables' | 'metadata';

/** DOM → markdown / text / links / tables / metadata, truncated to `maxChars`. */
export async function extractContent(page: any, opts: { format: ExtractFormat; selector?: string; maxChars?: number }): Promise<{ content: string; length: number; truncated: boolean }> {
  const max = opts.maxChars ?? 20_000;
  let root: any;
  if (opts.selector && opts.format !== 'metadata') {
    let count = 0;
    try { count = await page.locator(opts.selector).count(); } catch (e) {
      throw new Error(`[BROWSER_ERROR] invalid selector "${opts.selector}": ${firstLine(e)}`);
    }
    if (count === 0) throw new Error(`[BROWSER_ERROR] selector "${opts.selector}" matched no element.`);
    root = page.locator(opts.selector).first();
  } else {
    root = page.locator(opts.format === 'metadata' ? 'html' : 'body').first();
  }
  const raw = String(await root.evaluate(EXTRACT_FN, { format: opts.format }) ?? '').replace(/\n{3,}/g, '\n\n').trim();
  if (raw.length <= max) return { content: raw, length: raw.length, truncated: false };
  return {
    content: `${raw.slice(0, max)}\n… [truncated ${raw.length - max} more chars — use selector=... to narrow, or raise max_chars]`,
    length: raw.length,
    truncated: true,
  };
}
