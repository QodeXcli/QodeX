/**
 * Paths for the resident. HOME is read at call time — os.homedir() is cached
 * for the life of the process, which sends tests (and a late `export HOME`)
 * at the wrong directory.
 */
import * as os from 'os';
import * as path from 'path';

export function residentHome(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.qodex');
}

export function residentStatusPath(): string {
  return path.join(residentHome(), 'resident.json');
}

export function sealCachePath(): string {
  return path.join(residentHome(), 'resident-seal.json');
}
