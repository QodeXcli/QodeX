import { describe, it, expect } from 'vitest';
import { auditHtml, extractJsonLd, analyzeSchema } from '../src/tools/web/seo-audit-logic.js';

const chinpostLike = `<!DOCTYPE html><html dir="rtl" lang="fa-IR"><head>
<title>Cargo And Shipping From China To Dubai And Iran ChinPost</title>
<meta name="description" content="${'x'.repeat(140)}">
<link rel="canonical" href="https://chinpost.com/">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="index, follow">
<meta property="og:title" content="ChinPost"><meta property="og:description" content="x">
<meta property="og:image" content="https://chinpost.com/img.webp"><meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="geo.placename" content="Guangzhou"><meta name="geo.position" content="23.1291;113.2644">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"Organization","name":"ChinPost"},{"@type":"WebSite"},{"@type":"Service","name":"Air"}]}</script>
</head><body><h1>Heading</h1></body></html>`;

const fullyOptimized = `<html lang="en"><head>
<title>Best Cargo Service From China To Iran And Dubai Today</title>
<meta name="description" content="${'x'.repeat(140)}">
<link rel="canonical" href="https://x.com/"><meta name="viewport" content="w">
<meta property="og:title" content="a"><meta property="og:description" content="b"><meta property="og:image" content="c"><meta property="og:url" content="d">
<meta name="twitter:card" content="s">
<link rel="alternate" hreflang="en" href="https://x.com/en">
<link rel="alternate" hreflang="fa" href="https://x.com/fa">
<script type="application/ld+json">{"@type":"FAQPage"}</script>
<script type="application/ld+json">{"@type":"LocalBusiness","geo":{"@type":"GeoCoordinates"},"address":{}}</script>
<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
<script type="application/ld+json">{"@type":"BlogPosting"}</script>
</head><body><h1>One</h1></body></html>`;

describe('JSON-LD extraction', () => {
  it('extracts and counts ld+json blocks', () => {
    const { blocks, parseErrors } = extractJsonLd(fullyOptimized);
    expect(blocks.length).toBe(4);
    expect(parseErrors).toBe(0);
  });
  it('counts malformed blocks without throwing', () => {
    const html = `<script type="application/ld+json">{bad json}</script>`;
    const { blocks, parseErrors } = extractJsonLd(html);
    expect(blocks.length).toBe(0);
    expect(parseErrors).toBe(1);
  });
  it('collects @type from @graph and arrays', () => {
    const { blocks } = extractJsonLd(chinpostLike);
    const s = analyzeSchema(blocks, 0);
    expect(s.types).toContain('Organization');
    expect(s.types).toContain('Service');
    expect(s.types).toContain('WebSite');
  });
});

describe('schema detection (the part the model guessed wrong)', () => {
  it('detects Organization but correctly reports NO FAQPage / LocalBusiness (chinpost-like)', () => {
    const a = auditHtml('https://chinpost.com/', chinpostLike);
    expect(a.schema.hasOrganization).toBe(true);
    expect(a.schema.hasFAQPage).toBe(false);
    expect(a.schema.hasLocalBusiness).toBe(false);
    expect(a.schema.hasService).toBe(true);
  });
  it('detects FAQPage, LocalBusiness+geo, Breadcrumb, Article when present', () => {
    const b = auditHtml('https://x.com/', fullyOptimized);
    expect(b.schema.hasFAQPage).toBe(true);
    expect(b.schema.hasLocalBusiness).toBe(true);
    expect(b.schema.localBusinessHasGeo).toBe(true);
    expect(b.schema.hasBreadcrumb).toBe(true);
    expect(b.schema.hasArticle).toBe(true);
  });
});

describe('meta + geo + issues', () => {
  it('parses geo meta and hreflang', () => {
    expect(auditHtml('https://chinpost.com/', chinpostLike).geo.geoPosition).toBe('23.1291;113.2644');
    expect(auditHtml('https://x.com/', fullyOptimized).meta.hreflang).toEqual(['en', 'fa']);
  });
  it('flags missing FAQPage as an opportunity', () => {
    const a = auditHtml('https://chinpost.com/', chinpostLike);
    expect(a.issues.some(i => /FAQPage/i.test(i.message))).toBe(true);
  });
  it('scores a fully-optimized page higher on schema than a partial one', () => {
    const a = auditHtml('https://chinpost.com/', chinpostLike);
    const b = auditHtml('https://x.com/', fullyOptimized);
    expect(b.scores.schema).toBeGreaterThan(a.scores.schema);
  });
});
