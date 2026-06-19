/**
 * Pure, deterministic SEO/GEO audit logic — no network, no I/O, fully unit-testable.
 *
 * The whole point: where a language model GUESSES whether a page has FAQPage or
 * LocalBusiness schema (because it only saw rendered text, never the JSON-LD),
 * this module PARSES the raw HTML and reports presence/absence as a hard fact.
 *
 * Parsing is regex + JSON.parse (no cheerio dependency). JSON-LD is structured
 * data, so JSON.parse on each <script type="application/ld+json"> block is exact.
 */

export interface SchemaInfo {
  types: string[];              // every @type seen (incl. inside @graph)
  hasOrganization: boolean;
  hasLocalBusiness: boolean;
  hasFAQPage: boolean;
  hasArticle: boolean;          // Article | BlogPosting | NewsArticle
  hasService: boolean;
  hasBreadcrumb: boolean;
  hasWebSite: boolean;
  hasProduct: boolean;
  localBusinessHasGeo: boolean; // a LocalBusiness node that carries geo/address
  blockCount: number;           // how many ld+json blocks were found
  parseErrors: number;          // how many failed to JSON.parse
}

export interface MetaInfo {
  title: string | null;
  titleLength: number;
  description: string | null;
  descriptionLength: number;
  canonical: string | null;
  robots: string | null;
  viewport: string | null;
  lang: string | null;
  dir: string | null;
  ogCount: number;
  ogImage: string | null;
  twitterCount: number;
  hreflang: string[];
  h1: string[];
}

export interface GeoInfo {
  geoRegion: string | null;
  geoPlacename: string | null;
  geoPosition: string | null;
  icbm: string | null;
  hasHreflang: boolean;
  localBusinessGeo: boolean;
}

export type Severity = 'critical' | 'warning' | 'opportunity';
export type Area = 'seo' | 'geo' | 'schema' | 'technical';
export interface Issue { severity: Severity; area: Area; message: string; }

export interface AuditResult {
  url: string;
  meta: MetaInfo;
  schema: SchemaInfo;
  geo: GeoInfo;
  issues: Issue[];
  scores: { seo: number; geo: number; schema: number; overall: number };
}

// ----------------------------- small html helpers -----------------------------

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}

/** Pull the content/value of a <meta> matched by name= or property= equal to `key`. */
function metaContent(html: string, key: string): string | null {
  // name="key" ... content="..."  OR  content="..." ... name="key" (either order)
  const re = new RegExp(
    `<meta[^>]*\\b(?:name|property)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*\\bcontent=["']([^"']*)["']`,
    'i',
  );
  const m = html.match(re);
  if (m) return decodeEntities(m[1]!);
  // reversed attribute order
  const re2 = new RegExp(
    `<meta[^>]*\\bcontent=["']([^"']*)["'][^>]*\\b(?:name|property)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
    'i',
  );
  const m2 = html.match(re2);
  return m2 ? decodeEntities(m2[1]!) : null;
}

function countMetaPrefix(html: string, prefix: string): number {
  const re = new RegExp(`<meta[^>]*\\b(?:name|property)=["']${prefix}[^"']*["']`, 'gi');
  return (html.match(re) || []).length;
}

// ----------------------------- JSON-LD extraction -----------------------------

export function extractJsonLd(html: string): { blocks: unknown[]; parseErrors: number } {
  const blocks: unknown[] = [];
  let parseErrors = 0;
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1]!.trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      parseErrors++;
    }
  }
  return { blocks, parseErrors };
}

/** Recursively collect every @type string from a parsed JSON-LD tree (handles @graph, arrays). */
function collectTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) { for (const n of node) collectTypes(n, out); return; }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    if (typeof t === 'string') out.add(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x);
    for (const key of Object.keys(obj)) collectTypes(obj[key], out);
  }
}

const LOCAL_BIZ = new Set([
  'LocalBusiness', 'Organization', 'Store', 'ProfessionalService',
  'MovingCompany', 'PostalService', 'FreightForwarding', 'Corporation',
]);

/** Does any node typed as a LocalBusiness-ish entity carry geo or a postal address? */
function localBusinessHasGeo(node: unknown): boolean {
  let found = false;
  const walk = (n: unknown): void => {
    if (found) return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n && typeof n === 'object') {
      const obj = n as Record<string, unknown>;
      const t = obj['@type'];
      const types = typeof t === 'string' ? [t] : Array.isArray(t) ? t : [];
      const isBiz = types.some(x => typeof x === 'string' && (x === 'LocalBusiness' || LOCAL_BIZ.has(x)));
      if (isBiz && (obj['geo'] || obj['address'])) { found = true; return; }
      for (const key of Object.keys(obj)) walk(obj[key]);
    }
  };
  walk(node);
  return found;
}

export function analyzeSchema(blocks: unknown[], parseErrors: number): SchemaInfo {
  const set = new Set<string>();
  for (const b of blocks) collectTypes(b, set);
  const has = (t: string) => set.has(t);
  const hasLocalBusiness = has('LocalBusiness') ||
    [...set].some(t => LOCAL_BIZ.has(t) && t !== 'Organization' && t !== 'Corporation');
  return {
    types: [...set].sort(),
    hasOrganization: has('Organization') || has('Corporation'),
    hasLocalBusiness,
    hasFAQPage: has('FAQPage'),
    hasArticle: has('Article') || has('BlogPosting') || has('NewsArticle'),
    hasService: has('Service'),
    hasBreadcrumb: has('BreadcrumbList'),
    hasWebSite: has('WebSite'),
    hasProduct: has('Product'),
    localBusinessHasGeo: blocks.some(localBusinessHasGeo),
    blockCount: blocks.length,
    parseErrors,
  };
}

// ----------------------------- meta + geo extraction -----------------------------

export function extractMeta(html: string): MetaInfo {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeEntities(stripTags(titleM[1]!)) : null;
  const description = metaContent(html, 'description');
  const canonicalM = html.match(/<link[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["']/i);
  const langM = html.match(/<html[^>]*\blang=["']([^"']+)["']/i);
  const dirM = html.match(/<html[^>]*\bdir=["']([^"']+)["']/i);

  const hreflang: string[] = [];
  const hrefRe = /<link[^>]*\brel=["']alternate["'][^>]*\bhreflang=["']([^"']+)["']/gi;
  let hm: RegExpExecArray | null;
  while ((hm = hrefRe.exec(html)) !== null) hreflang.push(hm[1]!);

  const h1: string[] = [];
  const h1Re = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
  let h1m: RegExpExecArray | null;
  while ((h1m = h1Re.exec(html)) !== null) {
    const t = decodeEntities(stripTags(h1m[1]!));
    if (t) h1.push(t);
  }

  return {
    title,
    titleLength: title ? title.length : 0,
    description,
    descriptionLength: description ? description.length : 0,
    canonical: canonicalM ? canonicalM[1]! : null,
    robots: metaContent(html, 'robots'),
    viewport: metaContent(html, 'viewport'),
    lang: langM ? langM[1]! : null,
    dir: dirM ? dirM[1]! : null,
    ogCount: countMetaPrefix(html, 'og:'),
    ogImage: metaContent(html, 'og:image'),
    twitterCount: countMetaPrefix(html, 'twitter:'),
    hreflang,
    h1,
  };
}

export function extractGeo(html: string, schema: SchemaInfo, meta: MetaInfo): GeoInfo {
  return {
    geoRegion: metaContent(html, 'geo.region'),
    geoPlacename: metaContent(html, 'geo.placename'),
    geoPosition: metaContent(html, 'geo.position'),
    icbm: metaContent(html, 'ICBM'),
    hasHreflang: meta.hreflang.length > 0,
    localBusinessGeo: schema.localBusinessHasGeo,
  };
}

// ----------------------------- issue detection (the "algorithm") ----------------

export function findIssues(meta: MetaInfo, schema: SchemaInfo, geo: GeoInfo): Issue[] {
  const out: Issue[] = [];
  const add = (severity: Severity, area: Area, message: string) => out.push({ severity, area, message });

  // SEO
  if (!meta.title) add('critical', 'seo', 'No <title> tag.');
  else if (meta.titleLength < 30) add('warning', 'seo', `Title is short (${meta.titleLength} chars; aim 30–60).`);
  else if (meta.titleLength > 60) add('warning', 'seo', `Title is long (${meta.titleLength} chars; aim 30–60).`);

  if (!meta.description) add('critical', 'seo', 'No meta description.');
  else if (meta.descriptionLength < 120) add('opportunity', 'seo', `Meta description short (${meta.descriptionLength}; aim 120–160).`);
  else if (meta.descriptionLength > 160) add('warning', 'seo', `Meta description long (${meta.descriptionLength}; aim 120–160).`);

  if (!meta.canonical) add('warning', 'seo', 'No canonical link.');
  if (!meta.viewport) add('warning', 'technical', 'No viewport meta (mobile).');
  if (meta.h1.length === 0) add('warning', 'seo', 'No H1 heading found.');
  else if (meta.h1.length > 1) add('opportunity', 'seo', `${meta.h1.length} H1 headings (usually want exactly 1).`);
  if (meta.ogCount === 0) add('opportunity', 'seo', 'No Open Graph tags (poor social sharing).');
  if (meta.twitterCount === 0) add('opportunity', 'seo', 'No Twitter Card tags.');
  if (meta.robots && /\bnoindex\b/i.test(meta.robots)) add('critical', 'seo', 'Page is set to noindex.');

  // Schema
  if (schema.blockCount === 0) add('critical', 'schema', 'No JSON-LD structured data at all.');
  if (schema.parseErrors > 0) add('warning', 'schema', `${schema.parseErrors} JSON-LD block(s) failed to parse (malformed).`);
  if (!schema.hasOrganization) add('opportunity', 'schema', 'No Organization schema.');
  if (!schema.hasFAQPage) add('opportunity', 'schema', 'No FAQPage schema — if the page has an FAQ section, add FAQPage markup for rich results.');
  if (!schema.hasBreadcrumb) add('opportunity', 'schema', 'No BreadcrumbList schema.');
  if (!schema.hasWebSite) add('opportunity', 'schema', 'No WebSite schema (no sitelinks searchbox).');

  // GEO
  if (!meta.lang) add('warning', 'geo', 'No lang attribute on <html>.');
  if (!geo.hasHreflang) add('opportunity', 'geo', 'No hreflang tags (multi-region/multi-language targeting).');
  if (!schema.hasLocalBusiness) add('opportunity', 'geo', 'No LocalBusiness schema (local-pack / map eligibility).');
  else if (!schema.localBusinessHasGeo) add('opportunity', 'geo', 'LocalBusiness present but without geo coordinates / address.');
  if (!geo.geoPosition && !geo.icbm) add('opportunity', 'geo', 'No geo.position / ICBM meta tags.');

  return out;
}

export function scoreAudit(meta: MetaInfo, schema: SchemaInfo, geo: GeoInfo): AuditResult['scores'] {
  let seo = 0;
  if (meta.title && meta.titleLength >= 30 && meta.titleLength <= 60) seo += 20; else if (meta.title) seo += 10;
  if (meta.description && meta.descriptionLength >= 120 && meta.descriptionLength <= 160) seo += 20; else if (meta.description) seo += 10;
  if (meta.canonical) seo += 10;
  if (meta.ogCount >= 4) seo += 15; else if (meta.ogCount > 0) seo += 8;
  if (meta.twitterCount > 0) seo += 10;
  if (meta.viewport) seo += 10;
  if (meta.h1.length === 1) seo += 15; else if (meta.h1.length > 1) seo += 8;

  let sc = 0;
  if (schema.hasOrganization) sc += 20;
  if (schema.hasArticle || schema.hasService) sc += 20;
  if (schema.hasFAQPage) sc += 20;
  if (schema.hasBreadcrumb) sc += 15;
  if (schema.hasWebSite) sc += 10;
  if (schema.hasLocalBusiness) sc += 15;

  let g = 0;
  if (meta.lang) g += 20;
  if (geo.hasHreflang) g += 30;
  if (geo.geoPosition || geo.icbm) g += 20;
  if (schema.localBusinessHasGeo) g += 30;

  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  const seoC = clamp(seo), scC = clamp(sc), gC = clamp(g);
  const overall = clamp(seoC * 0.45 + scC * 0.3 + gC * 0.25);
  return { seo: seoC, geo: gC, schema: scC, overall };
}

/** End-to-end: parse a raw HTML string into a full deterministic audit. */
export function auditHtml(url: string, html: string): AuditResult {
  const { blocks, parseErrors } = extractJsonLd(html);
  const schema = analyzeSchema(blocks, parseErrors);
  const meta = extractMeta(html);
  const geo = extractGeo(html, schema, meta);
  const issues = findIssues(meta, schema, geo);
  const scores = scoreAudit(meta, schema, geo);
  return { url, meta, schema, geo, issues, scores };
}
