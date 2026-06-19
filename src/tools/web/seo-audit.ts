import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { auditHtml, type AuditResult, type Issue } from './seo-audit-logic.js';

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 QodeX/0.7';

/** Block private network ranges to avoid SSRF (mirrors web_fetch). */
function isPrivateOrLocal(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0') return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(s => parseInt(s, 10));
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  if (host === '::1' || host.startsWith('[::1') || host.startsWith('[fc') || host.startsWith('[fd')) return true;
  return false;
}

async function fetchText(url: string, signal?: AbortSignal, timeoutMs = 30000): Promise<{ ok: boolean; status: number; body: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, 'Accept': 'text/html,application/xhtml+xml,*/*' }, signal: ctrl.signal, redirect: 'follow' });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

const SeoAuditArgs = z.object({
  url: z.string().describe('The page URL to audit (https://...). The exact page given is fetched as raw HTML.'),
  check_robots: z.boolean().optional().describe('Also fetch /robots.txt and report presence. Default true.'),
  check_sitemap: z.boolean().optional().describe('Also fetch /sitemap.xml and report presence. Default true.'),
});

const SEV_ICON: Record<Issue['severity'], string> = { critical: '❌', warning: '⚠️', opportunity: '📈' };

function presence(label: string, present: boolean): string {
  return `  ${present ? '✓' : '✗'} ${label}: ${present ? 'PRESENT' : 'ABSENT'}`;
}

function renderReport(a: AuditResult, robots: string | null, sitemap: string | null): string {
  const L: string[] = [];
  L.push(`SEO/GEO AUDIT — ${a.url}`);
  L.push(`Scores (0–100): overall ${a.scores.overall} · SEO ${a.scores.seo} · Schema ${a.scores.schema} · GEO ${a.scores.geo}`);
  L.push('');
  L.push('STRUCTURED DATA (parsed from JSON-LD — these are facts, not guesses):');
  L.push(`  JSON-LD blocks found: ${a.schema.blockCount}${a.schema.parseErrors ? ` (${a.schema.parseErrors} malformed)` : ''}`);
  if (a.schema.types.length) L.push(`  @types present: ${a.schema.types.join(', ')}`);
  L.push(presence('Organization', a.schema.hasOrganization));
  L.push(presence('WebSite', a.schema.hasWebSite));
  L.push(presence('LocalBusiness', a.schema.hasLocalBusiness) + (a.schema.hasLocalBusiness ? ` (geo/address: ${a.schema.localBusinessHasGeo ? 'yes' : 'NO'})` : ''));
  L.push(presence('FAQPage', a.schema.hasFAQPage));
  L.push(presence('BreadcrumbList', a.schema.hasBreadcrumb));
  L.push(presence('Article/BlogPosting', a.schema.hasArticle));
  L.push(presence('Service', a.schema.hasService));
  L.push(presence('Product', a.schema.hasProduct));
  L.push('');
  L.push('META / ON-PAGE:');
  L.push(`  title (${a.meta.titleLength} chars): ${a.meta.title ?? '— none —'}`);
  L.push(`  meta description (${a.meta.descriptionLength} chars): ${a.meta.description ? a.meta.description.slice(0, 120) + (a.meta.description.length > 120 ? '…' : '') : '— none —'}`);
  L.push(`  canonical: ${a.meta.canonical ?? '— none —'}`);
  L.push(`  robots meta: ${a.meta.robots ?? '— none —'}`);
  L.push(`  H1 count: ${a.meta.h1.length}${a.meta.h1.length ? ` (first: "${a.meta.h1[0]!.slice(0, 60)}")` : ''}`);
  L.push(`  Open Graph tags: ${a.meta.ogCount} · Twitter tags: ${a.meta.twitterCount}`);
  L.push(`  <html lang>: ${a.meta.lang ?? '— none —'} · dir: ${a.meta.dir ?? '—'}`);
  L.push('');
  L.push('GEO / LOCAL:');
  L.push(`  geo.position: ${a.geo.geoPosition ?? '—'} · geo.placename: ${a.geo.geoPlacename ?? '—'} · geo.region: ${a.geo.geoRegion ?? '—'} · ICBM: ${a.geo.icbm ?? '—'}`);
  L.push(`  hreflang alternates: ${a.meta.hreflang.length ? a.meta.hreflang.join(', ') : '— none —'}`);
  L.push(`  LocalBusiness with coordinates: ${a.geo.localBusinessGeo ? 'yes' : 'NO'}`);
  if (robots !== null) L.push(`  robots.txt: ${robots}`);
  if (sitemap !== null) L.push(`  sitemap.xml: ${sitemap}`);
  L.push('');
  const crit = a.issues.filter(i => i.severity === 'critical');
  const warn = a.issues.filter(i => i.severity === 'warning');
  const opp = a.issues.filter(i => i.severity === 'opportunity');
  L.push(`ISSUES (${crit.length} critical · ${warn.length} warning · ${opp.length} opportunity):`);
  for (const i of [...crit, ...warn, ...opp]) L.push(`  ${SEV_ICON[i.severity]} [${i.area}] ${i.message}`);
  L.push('');
  L.push('NOTE: Schema presence above is parsed from the raw JSON-LD and is authoritative. Do NOT claim a schema type is missing if it is listed PRESENT, or vice versa.');
  return L.join('\n');
}

export class SeoAuditTool extends Tool<z.infer<typeof SeoAuditArgs>> {
  name = 'seo_audit';
  description = 'Deterministically audit a web page for SEO and GEO (local/geographic) signals. Fetches the raw HTML and PARSES the JSON-LD structured data, meta tags, Open Graph, hreflang, and geo tags — reporting which schema types (Organization, LocalBusiness, FAQPage, BreadcrumbList, Article, etc.) are actually present as hard facts, plus a scored issue list. Use this instead of guessing from rendered text. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = SeoAuditArgs;

  async execute(args: z.infer<typeof SeoAuditArgs>, ctx: ToolContext): Promise<ToolResult> {
    const { url } = args;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { content: `Invalid URL: ${url}`, isError: true }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { content: `Only http/https URLs are supported (got ${parsed.protocol}).`, isError: true };
    }
    if (isPrivateOrLocal(url)) {
      return { content: `Refusing to fetch a private/local address: ${parsed.hostname}`, isError: true };
    }

    const page = await fetchText(url, ctx.signal);
    if (!page.ok || !page.body) {
      return { content: `Failed to fetch ${url} (HTTP ${page.status}). ${page.status === 0 ? page.body : ''}`.trim(), isError: true };
    }

    const audit = auditHtml(url, page.body);

    // Optional: robots.txt / sitemap.xml presence
    let robots: string | null = null;
    let sitemap: string | null = null;
    const origin = `${parsed.protocol}//${parsed.host}`;
    if (args.check_robots !== false) {
      const r = await fetchText(`${origin}/robots.txt`, ctx.signal, 10000);
      robots = r.ok && /user-agent/i.test(r.body) ? `present (${r.body.split('\n').length} lines)` : `missing or empty (HTTP ${r.status})`;
    }
    if (args.check_sitemap !== false) {
      const s = await fetchText(`${origin}/sitemap.xml`, ctx.signal, 10000);
      sitemap = s.ok && /<(urlset|sitemapindex|url|sitemap)\b/i.test(s.body) ? 'present' : `missing or not XML (HTTP ${s.status})`;
    }

    return {
      content: renderReport(audit, robots, sitemap),
      metadata: { audit, robots, sitemap },
    };
  }
}
