import { describe, it, expect } from 'vitest';
import { dedupeFinalAgainstStreamed, isRedundantAssistantText, dedupeSelfRepeatedText } from '../src/cli/modes/final-dedupe.js';

describe('dedupeFinalAgainstStreamed', () => {
  it('handles the common case: final exactly matches streamed', () => {
    const d = dedupeFinalAgainstStreamed('Hello world.', 'Hello world.');
    expect(d.emit).toBe('');
    expect(d.closeLine).toBe(true);
  });

  it('THE BUG: streamed dropped leading whitespace but final did not — must NOT re-print', () => {
    // StreamDisplayFilter strips leading whitespace inside emit(), so what hit stdout
    // was "Hello world." not "   Hello world." — the old comparator failed and
    // re-printed the entire final on top. Whitespace-collapsed comparator catches this.
    const d = dedupeFinalAgainstStreamed('   Hello world.', 'Hello world.');
    expect(d.emit).toBe('');
    expect(d.closeLine).toBe(true);
  });

  it('appends the suffix when streamed is a prefix of final', () => {
    const d = dedupeFinalAgainstStreamed('Hello world, again.', 'Hello world');
    expect(d.emit).toBe(', again.');
    expect(d.closeLine).toBe(true);
  });

  it('prints final fresh when nothing was streamed (backend emits only final)', () => {
    const d = dedupeFinalAgainstStreamed('All the text.', '');
    expect(d.emit).toBe('All the text.');
    expect(d.closeLine).toBe(true);
  });

  it('handles empty final after thinking-only response', () => {
    const d = dedupeFinalAgainstStreamed('<thinking>internal</thinking>', '');
    expect(d.emit).toBe('');
    expect(d.closeLine).toBe(false);
  });

  it('GENUINE divergence: does NOT re-print (the fix)', () => {
    // If the model's final text is genuinely different from what was streamed
    // (e.g. the streamed text was filtered, or two parallel sub-agents' state got mixed),
    // we DO NOT re-emit the entire final on top of what the user already saw.
    const d = dedupeFinalAgainstStreamed('Completely different text.', 'Streamed text was this.');
    expect(d.emit).toBe('');
    expect(d.closeLine).toBe(true);
  });

  it('strips <thinking> from final before comparing', () => {
    const d = dedupeFinalAgainstStreamed(
      '<thinking>plan</thinking>Hello world.',
      'Hello world.',
    );
    expect(d.emit).toBe('');
    expect(d.closeLine).toBe(true);
  });

  it('strips leaked <function=…> tool-call syntax from final', () => {
    const d = dedupeFinalAgainstStreamed(
      'Hello world.<function=foo>{}</function>',
      'Hello world.',
    );
    expect(d.emit).toBe('');
    expect(d.closeLine).toBe(true);
  });

  it('collapses internal whitespace when comparing', () => {
    // The streamed path might collapse "foo  bar" (two spaces) into "foo bar" via the
    // display filter; the final might keep "foo  bar". They should compare equal.
    const d = dedupeFinalAgainstStreamed('foo  bar  baz.', 'foo bar baz.');
    expect(d.emit).toBe('');
    expect(d.closeLine).toBe(true);
  });

  it('handles streamed text with trailing whitespace vs final without', () => {
    const d = dedupeFinalAgainstStreamed('Hello.', 'Hello.   \n');
    expect(d.emit).toBe('');
    expect(d.closeLine).toBe(true);
  });

  it('handles markdown final that was streamed verbatim', () => {
    const md = '# Heading\n\n- bullet 1\n- bullet 2\n\nParagraph.';
    const d = dedupeFinalAgainstStreamed(md, md);
    expect(d.emit).toBe('');
    expect(d.closeLine).toBe(true);
  });
});

describe('isRedundantAssistantText (consecutive re-emit suppression)', () => {
  const report = '## SEO Analysis. Technical SEO 9/10, content depth excellent, GEO score 6.5, recommendations: add schema, hreflang, country pages, FAQ markup.';

  it('suppresses an identical re-emitted report', () => {
    expect(isRedundantAssistantText(report, report)).toBe(true);
  });

  it('suppresses a re-emit that only appended a trailing line (containment)', () => {
    expect(isRedundantAssistantText(report, report + '\nWould you like me to implement these?')).toBe(true);
  });

  it('does NOT suppress two genuinely different answers', () => {
    expect(isRedundantAssistantText(report, 'Sure — I will add the FAQ schema and update the sitemap now, then verify with a re-crawl.')).toBe(false);
  });

  it('does NOT suppress short acknowledgements (under 40 chars)', () => {
    expect(isRedundantAssistantText('ok done', 'ok done')).toBe(false);
    expect(isRedundantAssistantText('analysis complete', 'analysis complete')).toBe(false);
  });

  it('handles empty input safely', () => {
    expect(isRedundantAssistantText('', report)).toBe(false);
    expect(isRedundantAssistantText(report, '')).toBe(false);
  });
});

describe('dedupeSelfRepeatedText (whole answer emitted twice in one block)', () => {
  const report = [
    '## SEO/GEO Visibility Analysis: sevengum.com',
    '',
    "Based on my analysis of sevengum.com, here's a comprehensive assessment:",
    '',
    '### SEO Performance: STRONG FOUNDATION',
    'Technical SEO excellent. Mobile-first responsive design with proper viewport meta tags.',
    'Fast font loading with preconnect hints. Modern image formats. Service worker for PWA.',
    'On-page SEO very good with clear H1 and keyword integration. Content quality excellent.',
    '',
    '### Recommendations',
    'Create sitemap. Add schema. Build backlinks. Create geo-targeted pages.',
    '',
    'Would you like me to help implement any of these recommendations?',
  ].join('\n');

  it('collapses a verbatim double-emit to a single copy', () => {
    const doubled = report + '\n\n\n' + report;
    const out = dedupeSelfRepeatedText(doubled);
    expect(out.length).toBeLessThan(doubled.length * 0.6);
    expect((out.match(/STRONG FOUNDATION/g) ?? []).length).toBe(1);
  });

  it('collapses two near-identical copies that differ only in the trailing line', () => {
    // Real-world case: the model re-emits the answer but the first copy ends with
    // "Would you like…?" and the second is truncated/different at the very end.
    const v1 = report + '\n\nWould you like me to implement any of these fixes for you right now?';
    const v2 = report + '\n\n---';
    const doubled = v1 + '\n\n\n' + v2;
    const out = dedupeSelfRepeatedText(doubled);
    expect(out.length).toBeLessThan(doubled.length * 0.7);
    expect((out.match(/STRONG FOUNDATION/g) ?? []).length).toBe(1);
  });

  it('leaves a normal (non-repeated) report untouched', () => {
    expect(dedupeSelfRepeatedText(report)).toBe(report);
  });

  it('leaves short text untouched', () => {
    const short = 'ok done, the task is complete now.';
    expect(dedupeSelfRepeatedText(short)).toBe(short);
  });

  it('does NOT collapse when the opening line recurs but content differs', () => {
    const tricky = [
      'The analysis shows several findings about the website structure today.',
      '',
      'A long unique section about technical SEO: meta tags, viewport, fonts, images, service workers, and other details not repeated anywhere else in this document at all whatsoever.',
      '',
      'The analysis shows several findings about the website structure today.',
      'But this continuation is different — pricing, shipping, international markets, fresh topics sharing nothing with the first half beyond that one coincidental opening sentence.',
    ].join('\n');
    expect(dedupeSelfRepeatedText(tricky)).toBe(tricky);
  });
});

import { isRedundantAssistantText as isRedundant2 } from '../src/cli/modes/final-dedupe.js';

describe('isRedundantAssistantText — tolerant cross-block re-emit', () => {
  const full = 'Based on my comprehensive analysis here is a detailed bug report for the hero section. Critical bugs. Bug one HeroSection and HeroVideo are defined but not used in HomePage only HeroRobot is active. Bug two the wobble animation condition on line 237 is wrong. Medium bugs. Bug three the video total calculation on line 51 is incorrect for a 500vh section. Summary table and fix suggestions follow.';
  const reemitTruncated = 'Based on my comprehensive analysis here is a detailed bug report for the hero section. Critical bugs. Bug one HeroSection and HeroVideo are defined but not used in HomePage only HeroRobot is active. Bug two the wobble animation condition on line 237 is wrong. Medium bugs.';

  it('suppresses a regenerated/truncated re-emit that is NOT byte-identical', () => {
    expect(isRedundant2(full, reemitTruncated)).toBe(true);
  });

  it('does not suppress a genuinely different follow-up sharing topic words', () => {
    const fix = 'Here is the fix for bug one. I changed the wobble condition to trigger at enterAt and the video calculation now uses the correct section height. Applying these changes to the files now and running the build to verify.';
    expect(isRedundant2(full, fix)).toBe(false);
  });

  it('still catches exact re-emits and ignores short acks', () => {
    expect(isRedundant2(full, full)).toBe(true);
    expect(isRedundant2(full, 'Done!')).toBe(false);
  });
});
