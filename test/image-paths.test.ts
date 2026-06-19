import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { findImagePaths, annotateImagePrompt, findFsPaths, splitPathsAndText } from '../src/utils/image-paths.js';

describe('image-path detection', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-img-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('detects an absolute image path with backslash-escaped spaces', async () => {
    const real = path.join(dir, 'Screenshot 2026-05-22 at 10.56.21.png');
    await fs.writeFile(real, 'x');
    const escaped = real.replaceAll(' ', '\\ ');
    const found = findImagePaths(`${escaped} please analyze the picture`, dir);
    expect(found).toEqual([real]);
  });

  it('resolves relative paths and ~ against cwd/home, keeps only existing files', async () => {
    await fs.writeFile(path.join(dir, 'pic.png'), 'x');
    expect(findImagePaths('look at pic.png', dir)).toEqual([path.join(dir, 'pic.png')]);
    // A mentioned-but-nonexistent image is ignored (don't annotate prose).
    expect(findImagePaths('the logo.png in our docs', dir)).toEqual([]);
  });

  it('annotateImagePrompt appends a vision directive when an image exists', async () => {
    const real = path.join(dir, 'shot.jpg');
    await fs.writeFile(real, 'x');
    const out = annotateImagePrompt(`${real} what is this`, dir);
    expect(out).toContain('vision_analyze');
    expect(out).toContain(real);
    expect(out.startsWith(`${real} what is this`)).toBe(true); // original preserved up front
  });

  it('leaves non-image messages untouched', () => {
    expect(annotateImagePrompt('just a normal message', dir)).toBe('just a normal message');
    expect(annotateImagePrompt('edit src/app.png.ts', dir)).toBe('edit src/app.png.ts'); // .png.ts is not an image
  });

  it('dedups repeated paths', async () => {
    const real = path.join(dir, 'a.png');
    await fs.writeFile(real, 'x');
    expect(findImagePaths(`${real} and again ${real}`, dir)).toEqual([real]);
  });

  it('detects a dropped folder as a directory attachment', async () => {
    const proj = path.join(dir, 'myproject');
    await fs.mkdir(proj);
    expect(findFsPaths(proj, dir)).toEqual([{ abs: proj, kind: 'dir', name: 'myproject' }]);
  });

  it('detects a dropped non-image file', async () => {
    const f = path.join(dir, 'functions.php');
    await fs.writeFile(f, '<?php');
    expect(findFsPaths(f, dir)).toEqual([{ abs: f, kind: 'file', name: 'functions.php' }]);
  });

  it('ignores prose words that are not real paths (no false positives)', () => {
    expect(findFsPaths('please add a breadcrumb feature to the site', dir)).toEqual([]);
  });

  it('extracts a real path embedded in a sentence', async () => {
    const proj = path.join(dir, 'site');
    await fs.mkdir(proj);
    expect(findFsPaths(`add breadcrumbs to ${proj} please`, dir).map(p => p.abs)).toEqual([proj]);
  });

  it('splitPathsAndText keeps the instruction text when a path is in the same burst', async () => {
    const proj = path.join(dir, 'chinpost');
    await fs.mkdir(proj);
    const burst = `add breadcrumb structured data, site name chinpost.com ${proj}`;
    const r = splitPathsAndText(burst, dir);
    expect(r.paths.map(p => p.abs)).toEqual([proj]);
    // The typed instruction survives (path token removed, prose intact).
    expect(r.text).toBe('add breadcrumb structured data, site name chinpost.com');
    expect(r.text).not.toContain(proj);
  });

  it('splitPathsAndText returns empty path list + untouched text for pure prose', () => {
    const r = splitPathsAndText('please add a breadcrumb feature', dir);
    expect(r.paths).toEqual([]);
    expect(r.text).toBe('please add a breadcrumb feature');
  });
});
