/**
 * Tests for the web-search backends — pure parse/mapping functions (network calls
 * can't run in the sandbox, so we test the deterministic parts).
 * Run: node --experimental-strip-types test/web-backends.test.ts
 */
import { mapFirecrawlResults } from '../src/tools/web/parse.ts';
import { parseDuckDuckGoLiteHtml, parseDuckDuckGoHtml, unwrapDdgRedirect } from '../src/tools/web/parse.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— Firecrawl result mapping —');
{
  const payload = { success: true, data: [
    { title: 'A', url: 'https://a.com', description: 'desc A' },
    { title: 'B', url: 'https://b.com', description: 'desc B', markdown: '# B\nFull page body of B '.repeat(200) },
  ]};
  const r = mapFirecrawlResults(payload, 5);
  check('maps both results', r.length === 2);
  check('title/url carried', r[0].title === 'A' && r[0].url === 'https://a.com');
  check('description used when no markdown', r[0].snippet === 'desc A');
  check('markdown preferred when present', r[1].snippet.startsWith('# B'));
  check('markdown capped at 1500', r[1].snippet.length <= 1500);
}
{
  const r = mapFirecrawlResults({ success: true, data: [
    { title: 'no url', description: 'x' },
    { url: 'https://ok.com', description: 'y' },
  ]}, 5);
  check('drops results with no url', r.length === 1 && r[0].url === 'https://ok.com');
  check('respects limit', mapFirecrawlResults({ success: true, data: [{url:'a'},{url:'b'},{url:'c'}] }, 2).length === 2);
  check('empty/missing payload → []', mapFirecrawlResults(null, 5).length === 0 && mapFirecrawlResults({}, 5).length === 0);
}

console.log('— DuckDuckGo lite parser —');
{
  const html = `
    <table>
    <tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First Result</a></td></tr>
    <tr><td class="result-snippet">Snippet for the first result.</td></tr>
    <tr><td><a class="result-link" href="https://example.com/b">Second Result</a></td></tr>
    <tr><td class="result-snippet">Snippet two.</td></tr>
    </table>`;
  const r = parseDuckDuckGoLiteHtml(html, 5);
  check('parses two lite results', r.length === 2);
  check('unwraps the uddg redirect', r[0].url === 'https://example.com/a');
  check('pairs the right snippet', r[0].snippet === 'Snippet for the first result.');
  check('plain url passes through', r[1].url === 'https://example.com/b');
  check('lite respects limit', parseDuckDuckGoLiteHtml(html, 1).length === 1);
  check('empty html → []', parseDuckDuckGoLiteHtml('<html></html>', 5).length === 0);
}

console.log('— DDG main parser still works (regression) —');
{
  const html = `<a class="result__a" href="https://x.com/1">Title One</a>
    <a class="result__snippet" href="#">Snippet one</a>`;
  const r = parseDuckDuckGoHtml(html, 5);
  check('main parser parses result', r.length === 1 && r[0].title === 'Title One');
}

console.log('— redirect unwrap helper —');
{
  check('unwraps protocol-relative uddg', unwrapDdgRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fz.com') === 'https://z.com');
  check('passes through a normal url', unwrapDdgRedirect('https://plain.com/x') === 'https://plain.com/x');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
