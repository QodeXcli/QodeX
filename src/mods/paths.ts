/**
 * Where mods live on disk. Everything hangs off ~/.qodex (QODEX_HOME); tests point it at a
 * temp dir with setModsHomeForTesting instead of re-importing defaults.ts.
 *
 *   ~/.qodex/mods/<name>/          user mods
 *   <cwd>/.qodex/mods/<name>/      project mods (trust-gated)
 *   src|dist/mods/builtin/<name>/  built-in mods shipped with QodeX
 *   ~/.qodex/mods.json             enabled / disabled / trusted / config per mod
 *   ~/.qodex/mods-store/<name>.json  each mod's $.store
 *   ~/.qodex/cache/mods/<hash>.mjs   TypeScript entries with the types stripped
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { QODEX_HOME } from '../config/defaults.js';

let homeOverride: string | null = null;

/** Tests only: use `dir` as ~/.qodex for every mods path (null restores the real one). */
export function setModsHomeForTesting(dir: string | null): void {
  homeOverride = dir;
}

export function modsQodexHome(): string {
  return homeOverride ?? QODEX_HOME;
}

export function userModsDir(): string {
  return path.join(modsQodexHome(), 'mods');
}

export function projectModsDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.qodex', 'mods');
}

export function modsStateFile(): string {
  return path.join(modsQodexHome(), 'mods.json');
}

export function modsStoreDir(): string {
  return path.join(modsQodexHome(), 'mods-store');
}

export function modsCacheDir(): string {
  return path.join(modsQodexHome(), 'cache', 'mods');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Candidate directories of the built-in mods: next to this module (src/mods/builtin under
 * tsx, dist/mods/builtin when the build copies them) and the package's src/mods/builtin.
 */
export function builtinModsDirs(): string[] {
  const dirs = [path.join(HERE, 'builtin'), path.resolve(HERE, '..', '..', 'src', 'mods', 'builtin')];
  return [...new Set(dirs)];
}
