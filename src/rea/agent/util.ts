/**
 * Shared helpers for the in-process REA agents (GumJS).
 *
 * `Module.findExportByName` as a two-argument static does not exist in the
 * typed GumJS API: the statics are `Module.findGlobalExportByName(name)`
 * (any loaded module) and `Module.load(name)` + instance
 * `findExportByName(name)` (one named module, throws when not loaded).
 * This helper wraps both behind the `findExportByName(module, export)`
 * shape the agents want, returning null instead of throwing.
 */
export function findExport(moduleName: string | null, exportName: string): NativePointer | null {
  if (moduleName === null) {
    return Module.findGlobalExportByName(exportName);
  }
  try {
    return Module.load(moduleName).findExportByName(exportName);
  } catch {
    return null;
  }
}
