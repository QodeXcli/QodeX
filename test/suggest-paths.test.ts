import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { suggestSimilarPaths } from '../src/tools/filesystem/suggest-paths.js';

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-suggest-'));
  // Build a tree where HomePage.jsx lives under frontend, and the model might
  // look for it under backend.
  await fs.mkdir(path.join(root, 'cctv_frontend/src/pages'), { recursive: true });
  await fs.mkdir(path.join(root, 'cctv_shop/apps'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules/junk'), { recursive: true });
  await fs.writeFile(path.join(root, 'cctv_frontend/src/pages/HomePage.jsx'), 'x');
  await fs.writeFile(path.join(root, 'cctv_frontend/src/pages/ProductsPage.jsx'), 'x');
  await fs.writeFile(path.join(root, 'node_modules/junk/HomePage.jsx'), 'x'); // must be skipped
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('suggestSimilarPaths', () => {
  it('finds a file by basename when the model used the wrong directory', async () => {
    const hits = await suggestSimilarPaths(root, 'cctv_shop/HomePage.jsx');
    expect(hits).toContain('cctv_frontend/src/pages/HomePage.jsx');
  });

  it('skips node_modules', async () => {
    const hits = await suggestSimilarPaths(root, 'HomePage.jsx');
    expect(hits.some(h => h.includes('node_modules'))).toBe(false);
  });

  it('returns empty for a basename that exists nowhere', async () => {
    const hits = await suggestSimilarPaths(root, 'DoesNotExist.tsx');
    expect(hits).toEqual([]);
  });

  it('matches same stem with a different extension', async () => {
    // Looking for HomePage.tsx should still surface HomePage.jsx (same stem).
    const hits = await suggestSimilarPaths(root, 'HomePage.tsx');
    expect(hits).toContain('cctv_frontend/src/pages/HomePage.jsx');
  });
});
