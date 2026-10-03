/**
 * Slash commands added by mods ($.command.register). Dependency-free so the slash catalog
 * (help, Tab completion) can read it without loading the mods runtime.
 */

export interface ModCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** Runs while a turn is in progress (the TUI sends it instead of queueing it). */
  immediate: boolean;
  /** The mod that registered it. */
  plugin: string;
}

const commands = new Map<string, ModCommand>();

export function addModCommand(cmd: ModCommand): void {
  commands.set(cmd.name, cmd);
}

export function getModCommand(name: string): ModCommand | undefined {
  return commands.get(name);
}

/** Every mod command, by name. */
export function listModCommands(): ModCommand[] {
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Drop the commands of one mod (it unloaded). */
export function removeModCommands(plugin: string): void {
  for (const [name, c] of [...commands]) if (c.plugin === plugin) commands.delete(name);
}

/** True for a mod command registered with `immediate: true`. */
export function isImmediateModCommand(name: string): boolean {
  return commands.get(name)?.immediate === true;
}

export function clearModCommandsForTesting(): void {
  commands.clear();
}
