/**
 * Hand root-swallowed flags back to the subcommand they were written after.
 *
 * The root program declares headless-run flags (-p/--print, --profile, --json,
 * -m/--model, -y/--yes, --scope, ...). Under commander's default (non-positional)
 * parsing the ROOT consumes its own flags anywhere on the line, so a flag written
 * AFTER a subcommand that declares the same flag never reaches it:
 *
 *   qodex workflow run search -p query=x   root -p is --print     → no --param
 *   qodex browser open --profile work      root --profile overlay → "Unknown profile"
 *   qodex mission status <id> --json       root --json            → text output
 *
 * main's convention is that actions read cmd.optsWithGlobals() (which sees a
 * same-named root value), but that cannot help when the flag MEANS something else
 * on the subcommand (-p, --profile, --scope) or the action reads its own opts.
 * This walks the command line instead: every flag written after the action
 * command's name that the root swallowed AND the action command itself declares
 * (matched by the flag as typed, short or long; a flag it does not declare at all
 * goes to its option of the same name, e.g. -m to its --model) is re-emitted on the action
 * command, so commander applies it with that option's own parsing (repeatable
 * collectors, choices, booleans), and the root forgets it (it was never the root's:
 * no config overlay, no --print). Flags written BEFORE the subcommand stay the
 * root's. Not using enablePositionalOptions: root flags after a subcommand that
 * does not declare them keep reaching the root (optsWithGlobals()).
 *
 * Runs as the root's FIRST preAction hook. Commander checks a subcommand's
 * mandatory options before preAction, so a requiredOption must not share a flag
 * with the root.
 */
import type { EventEmitter } from 'events';
import type { Command, Option } from 'commander';

const isOptionToken = (t: string): boolean => t.length > 1 && t[0] === '-' && t !== '--';
const takesValue = (o: Option): boolean => o.required || o.optional;

interface FlagToken {
  /** The flag as written: "-p", "--param". */
  flag: string;
  /** Value attached to the token ("--x=1", "-p1"), else undefined. */
  attached?: string;
}

/** Split "--long=value" / "-sVALUE" into flag + attached value; "-s" / "--long" stay whole. */
function splitToken(tok: string, lookup: (flag: string) => Option | undefined): FlagToken {
  if (tok.startsWith('--')) {
    const eq = tok.indexOf('=');
    return eq > 2 ? { flag: tok.slice(0, eq), attached: tok.slice(eq + 1) } : { flag: tok };
  }
  if (tok.length > 2) {
    const short = tok.slice(0, 2);
    const o = lookup(short);
    // Only a value-taking short option swallows the rest of the token (commander's rule).
    if (o && takesValue(o)) return { flag: short, attached: tok.slice(2) };
  }
  return { flag: tok };
}

function findOption(cmds: readonly Command[], flag: string): Option | undefined {
  for (const c of cmds) {
    const o = c.options.find(x => x.short === flag || x.long === flag);
    if (o) return o;
  }
  return undefined;
}

function names(c: Command): string[] {
  return [c.name(), ...c.aliases()];
}

/**
 * Index in `args` of the action command's name (or of its deepest ancestor named
 * on the line, when the action is a default subcommand such as `telegram` →
 * `status`), or -1 when the line names none of them.
 */
function subcommandBoundary(root: Command, chain: readonly Command[], args: readonly string[]): number {
  let boundary = -1;
  let j = 0;
  for (let i = 0; i < args.length && j < chain.length; i++) {
    const tok = args[i]!;
    if (tok === '--') break;
    if (isOptionToken(tok)) {
      // Skip the value of an option of the root or of a command already named.
      const scope = [root, ...chain.slice(0, j)];
      const { flag, attached } = splitToken(tok, f => findOption(scope, f));
      const o = findOption(scope, flag);
      if (o && attached === undefined) {
        if (o.required) i++;
        else if (o.optional && i + 1 < args.length && !isOptionToken(args[i + 1]!)) i++;
      }
      continue;
    }
    if (names(chain[j]!).includes(tok)) {
      boundary = i;
      j++;
    }
  }
  return boundary;
}

/**
 * Move root-consumed flags written after the subcommand to `action` (see the file
 * header). `args` are the user's arguments (process.argv without node + script).
 * Returns the attribute names handed back (for tests / debugging).
 */
export function handBackRootFlags(root: Command, action: Command, args: readonly string[]): string[] {
  if (action === root) return [];
  const chain: Command[] = [];
  for (let c: Command | null = action; c && c !== root; c = c.parent) chain.unshift(c);
  const start = subcommandBoundary(root, chain, args);
  if (start < 0) return [];

  // Every occurrence of a root flag on the line (the root consumed them all), in order.
  const occurrences: Array<{ opt: Option; value?: string; handed: boolean }> = [];
  const handed: string[] = [];
  const emitOn = (cmd: Command, opt: Option, value: string | undefined): void => {
    // Commander applies `option:<name>` events with the option's own handling (parseArg,
    // collectors, choices, booleans). A Command is an EventEmitter; its typings omit it.
    const emitter = cmd as unknown as EventEmitter;
    if (takesValue(opt)) emitter.emit(`option:${opt.name()}`, value);
    else emitter.emit(`option:${opt.name()}`);
  };

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === '--') break;
    if (!isOptionToken(tok)) continue;
    const after = i > start;
    const { flag: rootFlag, attached: rootAttached } = splitToken(tok, f => findOption([root], f));
    const rootOpt = findOption([root], rootFlag);
    const { flag: subFlag, attached: subAttached } = splitToken(tok, f => findOption([action], f));
    const subByFlag = after ? findOption([action], subFlag) : undefined;

    if (!rootOpt) {
      // Not the root's (the subcommand parsed it itself): skip its separate value token.
      if (subByFlag && subAttached === undefined && subByFlag.required) i++;
      continue;
    }
    // The root consumed this token (and its value token, if it takes one).
    let value: string | undefined = rootAttached;
    if (takesValue(rootOpt) && value === undefined) {
      if (rootOpt.required || (i + 1 < args.length && !isOptionToken(args[i + 1]!))) value = args[++i];
    }
    // The action command's option for it: the one declaring the flag as typed (root -p is
    // --print, `workflow run -p` is --param); for a flag it does not declare at all, the
    // one named like the root option (-m → its --model, -y → its --yes). Same arity only.
    let subOpt: Option | undefined;
    if (after) {
      subOpt = subByFlag
        ? (subFlag === rootFlag ? subByFlag : undefined)
        : action.options.find(o => !o.negate && o.attributeName() === rootOpt.attributeName());
    }
    const back = !!subOpt && takesValue(rootOpt) === takesValue(subOpt);
    occurrences.push({ opt: rootOpt, value, handed: back });
    if (back) {
      emitOn(action, subOpt!, value);
      handed.push(subOpt!.attributeName());
    }
  }

  // The root keeps only what was really its own: recompute each root option that gave
  // something away from its remaining occurrences (none → back to its default; deleted,
  // not set to undefined, since optsWithGlobals() would let an own `undefined` win).
  const rootOpts = root.opts() as Record<string, unknown>;
  for (const opt of new Set(occurrences.filter(o => o.handed).map(o => o.opt))) {
    const key = opt.attributeName();
    if (opt.defaultValue === undefined) delete rootOpts[key];
    else root.setOptionValueWithSource(key, opt.defaultValue, 'default');
    for (const o of occurrences) if (o.opt === opt && !o.handed) emitOn(root, opt, o.value);
  }
  return handed;
}
