/**
 * Tests for src/artifacts/store.ts — pure helpers + a real fs round-trip in a temp dir.
 * Run: node --experimental-strip-types test/artifact-store.test.ts
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  slugifyArtifactId, extensionForType, entryFileName, nextVersionNumber, buildManifest, addVersion,
  isArtifactType, createArtifact, updateArtifact, listArtifacts, getArtifact, rollbackArtifact,
} from '../src/artifacts/store.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— pure helpers —');
{
  check('slug kebabs a title', slugifyArtifactId('My Pricing Page!') === 'my-pricing-page');
  check('slug collapses dashes', slugifyArtifactId('a   b---c') === 'a-b-c');
  check('slug keeps Persian letters', slugifyArtifactId('صفحه قیمت') === 'صفحه-قیمت');
  check('slug falls back when empty', slugifyArtifactId('!!!') === 'artifact');
  check('ext for react is jsx', extensionForType('react') === 'jsx');
  check('ext for html', extensionForType('html') === 'html');
  check('react entry is App.jsx', entryFileName('react') === 'App.jsx');
  check('html entry is index.html', entryFileName('html') === 'index.html');
  check('isArtifactType true for html', isArtifactType('html'));
  check('isArtifactType false for junk', !isArtifactType('exe'));
}

console.log('— manifest math —');
{
  const m = buildManifest('x', 'X', 'html', 'v1/index.html', '2026-01-01T00:00:00Z');
  check('fresh manifest current=1', m.current === 1 && m.versions.length === 1);
  check('nextVersionNumber after v1 is 2', nextVersionNumber(m) === 2);
  const m2 = addVersion(m, 'v2/index.html', '2026-01-02T00:00:00Z', 'tweak');
  check('addVersion bumps current to 2', m2.current === 2 && m2.versions.length === 2);
  check('addVersion records note', m2.versions[1].note === 'tweak');
  check('addVersion is immutable (original untouched)', m.versions.length === 1);
}

async function main() {
  console.log('— fs round-trip —');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-artifacts-'));
  const write = async (p: string, c: string) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); };

  const { manifest: m1 } = await createArtifact(tmp, { title: 'Landing Page', type: 'html', content: '<h1>v1</h1>' }, write);
  check('create returns id', m1.id === 'landing-page');
  check('create writes v1 file', (await getArtifact(tmp, 'landing-page')).content === '<h1>v1</h1>');

  const up = await updateArtifact(tmp, { id: 'landing-page', content: '<h1>v2</h1>', note: 'bigger' }, write);
  check('update creates v2', up.version === 2);
  check('current reads v2', (await getArtifact(tmp, 'landing-page')).content === '<h1>v2</h1>');
  check('v1 still retrievable', (await getArtifact(tmp, 'landing-page', 1)).content === '<h1>v1</h1>');

  await rollbackArtifact(tmp, 'landing-page', 1, write);
  check('rollback repoints current to v1', (await getArtifact(tmp, 'landing-page')).content === '<h1>v1</h1>');
  check('rollback keeps v2 in history', (await getArtifact(tmp, 'landing-page', 2)).content === '<h1>v2</h1>');

  // duplicate title → unique id
  const { manifest: dup } = await createArtifact(tmp, { title: 'Landing Page', type: 'html', content: 'x' }, write);
  check('duplicate title gets -2 id', dup.id === 'landing-page-2');

  const list = await listArtifacts(tmp);
  check('list returns both artifacts', list.length === 2);

  // error paths
  let threw = false;
  try { await updateArtifact(tmp, { id: 'nope', content: 'x' }, write); } catch { threw = true; }
  check('update of missing id throws', threw);
  threw = false;
  try { await getArtifact(tmp, 'landing-page', 99); } catch { threw = true; }
  check('get of missing version throws', threw);

  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
