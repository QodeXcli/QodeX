/**
 * `qodex re <path>` — static read of a Mac or Windows program.
 */
import { Command } from 'commander';
import { formatReport, inspectPath } from '../re/inspect.js';

export function buildReCommand(): Command {
  const cmd = new Command('re');
  cmd
    .description('Read a local executable or Mac .app: architecture, linked libraries, sections, imports. Not a decompiler.')
    .argument('<path>', 'Executable, DLL, or .app bundle')
    .option('--json', 'Print the structured report')
    .action(async (file: string, opts: { json?: boolean }) => {
      const report = await inspectPath(file);
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatReport(report));
      if (report.notes.includes('file not found') || report.format === 'unknown') process.exitCode = 2;
    });
  return cmd;
}
