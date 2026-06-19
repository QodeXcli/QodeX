/**
 * Copy the skills bundled with the QodeX package into ~/.qodex/skills/ on first
 * run so the model has working examples (taste, ui-ux-pro-max, ghost, OODA,
 * L99, god-mode, artifacts) without the user having to install anything.
 *
 * Idempotent: a skill is seeded ONLY if the target directory doesn't already
 * exist. We never overwrite — users can edit their copy freely, and re-running
 * QodeX won't clobber their changes. A `.seeded` marker inside the skill dir
 * records that QodeX wrote it; manual installs lack the marker and are also
 * preserved on subsequent runs.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { userSkillsDir } from './loader.js';
import { logger } from '../utils/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Two levels up from <root>/dist/skills (or src/skills via tsx) lands at the package root.
const BUNDLED_SKILLS_DIR = path.resolve(HERE, '..', '..', 'examples', 'skills');

export async function seedBundledSkills(): Promise<void> {
  let sources;
  try {
    sources = await fs.readdir(BUNDLED_SKILLS_DIR, { withFileTypes: true });
  } catch {
    logger.debug('No bundled skills directory found; skipping seed', { path: BUNDLED_SKILLS_DIR });
    return;
  }

  const targetRoot = userSkillsDir();
  await fs.mkdir(targetRoot, { recursive: true });

  for (const ent of sources) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const src = path.join(BUNDLED_SKILLS_DIR, ent.name);
    const dst = path.join(targetRoot, ent.name);
    try {
      await fs.stat(dst);
      // Already present — don't touch.
      continue;
    } catch {
      // Not installed yet
    }
    try {
      await fs.mkdir(dst, { recursive: true });
      await copyTree(src, dst);
      await fs.writeFile(path.join(dst, '.seeded'), new Date().toISOString());
      logger.info('Seeded bundled skill', { name: ent.name, dst });
    } catch (e: any) {
      logger.warn('Failed to seed bundled skill', { name: ent.name, err: e?.message });
    }
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name.startsWith('.DS_')) continue;
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) {
      await fs.mkdir(dst, { recursive: true });
      await copyTree(src, dst);
    } else if (ent.isFile()) {
      await fs.copyFile(src, dst);
    }
  }
}
