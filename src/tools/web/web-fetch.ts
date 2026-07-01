/**
 * `web_fetch` tool — retrieve and render a single URL.
 *
 * Different from `web_search`: that finds links, this reads the actual page.
 * Different from `browser_navigate`: that loads in Chromium (heavy, stateful),
 * this is a one-shot HTTP GET + HTML→text conversion (lightweight, stateless).
 *
 * When to use each:
 *   - web_search: I need to discover URLs
 *   - web_fetch:  I have a URL and want its CONTENT to reason over
 *   - browser_*:  I need JS execution, click events, or a real DOM
 *
 * Implementation:
 *   - Plain fetch() with a 30s timeout
 *   - HTML → text via a minimal parser (tags stripped, script/style removed,
 *     whitespace collapsed). Not perfect — for JS-heavy SPAs the page will be
 *     empty; user should use browser_navigate instead.
 *   - Truncates to 25KB by default to keep agent context manageable.
 *   - Honours redirects (default follow).
 *   - Respects robots.txt? No — that's a runtime concern, not a tool concern.
 *     The agent is acting on user behalf; same trust model as the user manually
 *     opening the URL in their own browser.
 *
 * Security:
 *   - We blacklist localhost / 127.0.0.0/8 / RFC1918 ranges to prevent
 *     SSRF-style abuse where the model is tricked into hitting internal
 *     services. If user genuinely needs to fetch localhost (testing their own
 *     dev server), they should use browser_navigate.
 */

import { z } from 'zod';
import { createHash } from 'crypto';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';
import { proxyFetch } from '../../utils/proxy-fetch.js';
import { selectRelevantPassages, stripBase64Images } from './extract-select.js';

const WebFetchArgs = z.object({
  url: z.string().min(1).describe('Full URL with scheme. e.g. "https://example.com/page".'),
  query: z.string().optional().describe(
    'What you are looking for on this page. When set, a page over the char budget returns the passages MOST RELEVANT to this query (semantic extraction), not just the top of the page — so a mid-document answer comes back in one call. Omit for a plain head+tail window.'
  ),
  max_chars: z.number().int().min(500).max(200_000).optional().describe(
    'Char budget. Default 25000. Larger pages are trimmed to the most relevant passages (if `query` is set) or a head+tail window; the full clean text is stored to disk and the footer says how to read the rest.'
  ),
  format: z.enum(['text', 'html', 'markdown']).optional().describe(
    "Output format. 'text' (default) = stripped readable text, 'html' = raw HTML, 'markdown' = best-effort MD."
  ),
  timeout_ms: z.number().int().min(1000).max(60_000).optional().describe('Network timeout. Default 30000.'),
  user_agent: z.string().optional().describe('Override User-Agent header. Default mimics a regular browser.'),
});

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 QodeX/0.7';

/** Block private network ranges to avoid SSRF. */
function isPrivateOrLocal(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0') return true;
  // IPv4 literal checks
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(s => parseInt(s, 10));
    if (a === 127) return true;                   // loopback
    if (a === 10) return true;                    // RFC1918
    if (a === 192 && b === 168) return true;      // RFC1918
    if (a === 172 && b! >= 16 && b! <= 31) return true; // RFC1918
    if (a === 169 && b === 254) return true;      // link-local
  }
  // IPv6 loopback + ULA
  if (host === '::1' || host.startsWith('[::1') || host.startsWith('[fc') || host.startsWith('[fd')) return true;
  return false;
}

/** Strip HTML tags into readable text. Lightweight; doesn't preserve structure. */
function htmlToText(html: string): string {
  // Remove script/style first so their contents don't leak through
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // Convert block elements to newlines for readability
  html = html.replace(/<\/(p|div|h[1-6]|li|tr|br)[^>]*>/gi, '\n');
  html = html.replace(/<br[^>]*>/gi, '\n');
  // Strip all remaining tags
  html = html.replace(/<[^>]+>/g, '');
  // HTML entities (just the common ones)
  html = html
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  // Collapse whitespace
  html = html.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return html.trim();
}

/** Best-effort HTML→markdown. Captures headings, links, lists, code, paragraphs. */
function htmlToMarkdown(html: string): string {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // Headings
  for (let n = 1; n <= 6; n++) {
    const re = new RegExp(`<h${n}[^>]*>([\\s\\S]*?)</h${n}>`, 'gi');
    html = html.replace(re, (_m, txt) => `\n\n${'#'.repeat(n)} ${stripInner(txt).trim()}\n`);
  }
  // Code blocks
  html = html.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_m, code) => `\n\n\`\`\`\n${decodeEntities(code)}\n\`\`\`\n`);
  html = html.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, code) => `\`${decodeEntities(code)}\``);
  // Links
  html = html.replace(/<a [^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => `[${stripInner(txt).trim()}](${href})`);
  // Lists
  html = html.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, txt) => `- ${stripInner(txt).trim()}\n`);
  // Bold/italic
  html = html.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**');
  html = html.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, '*$1*');
  // Paragraphs/divs/breaks
  html = html.replace(/<\/(p|div)[^>]*>/gi, '\n\n');
  html = html.replace(/<br[^>]*>/gi, '\n');
  // Strip remaining tags
  html = html.replace(/<[^>]+>/g, '');
  html = decodeEntities(html);
  // Cleanup whitespace
  html = html.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return html.trim();
}

function stripInner(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Store the full clean text so an omitted middle is recoverable via read_file. Best-effort. */
async function storeFullText(url: string, text: string): Promise<string | null> {
  try {
    const { QODEX_HOME } = await import('../../config/defaults.js');
    const { promises: fs } = await import('fs');
    const dir = path.join(QODEX_HOME, 'cache', 'web');
    await fs.mkdir(dir, { recursive: true });
    const slug = (() => {
      try { return new URL(url).hostname.replace(/[^a-z0-9.]+/gi, '-').slice(0, 40); } catch { return 'page'; }
    })();
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 10);
    const file = path.join(dir, `${slug}-${hash}.md`);
    await fs.writeFile(file, text);
    return file;
  } catch { return null; }
}

export class WebFetchTool extends Tool<z.infer<typeof WebFetchArgs>> {
  name = 'web_fetch';
  description = 'Fetch a single URL and return its content. Use when you have a URL and want to read its content. Pass `query` (what you are looking for) so a long page returns the MOST RELEVANT passages — not just its top — in one call; the full text is stored to disk and the footer says how to read the rest. Defaults to stripped text; format="html" for raw, format="markdown" for structured. Read-only. For JS-heavy sites use browser_navigate instead.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = WebFetchArgs;

  async execute(args: z.infer<typeof WebFetchArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (isPrivateOrLocal(args.url)) {
      return {
        content: `[WEB_FETCH_BLOCKED] ${args.url} is a private/local address. Use browser_navigate if this is your own dev server, or dev_server_log to read its output.`,
        isError: true,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.timeout_ms ?? 30_000);

    try {
      const response = await proxyFetch(args.url, {
        signal: ctx.signal ? mergeAbortSignals(ctx.signal, controller.signal) : controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': args.user_agent ?? DEFAULT_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) {
        return {
          content: `[WEB_FETCH_ERROR] HTTP ${response.status} ${response.statusText} for ${args.url}`,
          isError: true,
        };
      }

      const contentType = response.headers.get('content-type') ?? '';

      // Guard against binary payloads. Reading an image/PDF/font/archive as text
      // dumps garbage bytes into the model's context (and burns tokens). Detect
      // by content-type and bail with a useful message instead of the raw bytes.
      const isBinary = /^(image|audio|video|font)\//i.test(contentType)
        || /(application\/(octet-stream|pdf|zip|gzip|x-tar|x-7z|wasm|x-protobuf)|application\/[^;]*\+(zip|octet))/i.test(contentType);
      if (isBinary) {
        const lenHeader = response.headers.get('content-length');
        return {
          content: `URL: ${response.url}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n[binary content — not fetched as text]\n` +
            `This is a binary file (${contentType}${lenHeader ? `, ${lenHeader} bytes` : ''}). web_fetch returns text only; ` +
            `it won't read images, PDFs, fonts, or archives. If you need to analyze an image, note its URL and describe what you need — don't re-fetch it.`,
          metadata: { url: response.url, status: response.status, contentType, binary: true },
        };
      }

      const body = await response.text();
      const format = args.format ?? 'text';
      const maxChars = args.max_chars ?? 25_000;

      let output: string;
      if (format === 'html' || !contentType.includes('html')) {
        output = body;
      } else if (format === 'markdown') {
        output = stripBase64Images(htmlToMarkdown(body));   // drop base64 token-bombs; keep http image links
      } else {
        output = htmlToText(body);
      }

      const truncated = output.length > maxChars;
      let finalContent = output;
      let mode: string | undefined;
      let storedPath: string | null = null;

      if (truncated) {
        // Store the full clean text so nothing is lost, then return the most relevant slice.
        storedPath = await storeFullText(response.url, output);
        const sel = selectRelevantPassages(output, { query: args.query, budget: maxChars });
        mode = sel.mode;
        const recovery = storedPath
          ? `Full clean text (${output.length} chars) stored at:\n${storedPath}\nRead the omitted parts with: read_file path="${storedPath}" offset=<line> limit=<n>`
          : `Full page is ${output.length} chars; re-fetch with a higher max_chars${args.query ? '' : ' or a `query` to target the relevant passages'} to see more.`;
        const modeNote = sel.mode === 'semantic'
          ? `Returned the ${output.length > sel.keptChars ? 'passages most relevant to' : 'content for'} your query "${args.query}" (semantic extraction), in document order.`
          : `Returned a head+tail window (no query given — pass \`query\` to get the passages most relevant to what you need).`;
        finalContent = `${sel.content}\n\n———\n${modeNote}\n${recovery}`;
      }

      return {
        content: `URL: ${response.url}\nStatus: ${response.status}\nContent-Type: ${contentType}\nFormat: ${format}\nLength: ${output.length} chars${mode ? ` · extract: ${mode}` : ''}\n\n${finalContent}`,
        metadata: {
          finalUrl: response.url,
          status: response.status,
          contentType,
          fullLength: output.length,
          truncated,
          extractMode: mode,
          storedPath: storedPath ?? undefined,
        },
      };
    } catch (e: any) {
      const msg = controller.signal.aborted ? `timeout after ${args.timeout_ms ?? 30_000}ms` : (e?.message ?? String(e));
      return { content: `[WEB_FETCH_ERROR] ${msg}`, isError: true };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Merge two AbortSignals so cancellation from either fires the result. */
function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const merged = new AbortController();
  const onAbort = () => merged.abort();
  if (a.aborted || b.aborted) merged.abort();
  else {
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  }
  return merged.signal;
}
