/**
 * `qodex skill ...` subcommand. Wired into the top-level commander in src/index.ts.
 *
 * Mutating commands (install/remove/enable/disable) refresh the skill registry
 * after they finish, so subsequent commands in the same process see the change.
 */

import { Command } from 'commander';
import { installSkill, removeSkill } from '../skills/installer.js';
import {
  listAllSkillsWithState,
  refreshSkillRegistry,
  setSkillEnabled,
} from '../skills/registry.js';
import { initSkillRegistry } from '../skills/registry.js';
import { seedBundledSkills } from '../skills/seed.js';

export function buildSkillCommand(): Command {
  const cmd = new Command('skill');
  cmd.description('Manage installed skills (taste, ui-ux-pro-max, ghost, OODA, etc.)');

  cmd
    .command('list')
    .alias('ls')
    .description('List every installed skill with origin, version, and enabled state')
    .action(async () => {
      // Seed bundled skills on first invocation so `qodex skill list` immediately
      // surfaces the defaults without forcing the user to launch the REPL first.
      await seedBundledSkills();
      await initSkillRegistry(process.cwd());
      const all = await listAllSkillsWithState(process.cwd());
      if (all.length === 0) {
        console.log('No skills installed. Try: qodex skill install gh:qodex-skills/taste');
        return;
      }
      console.log(`${all.length} skill(s):\n`);
      for (const s of all) {
        const flag = s.enabled ? '●' : '○';
        const ver = s.version ? ` v${s.version}` : '';
        const aliases = s.slashAliases?.length ? `  slash: ${s.slashAliases.map(a => '/' + a).join(' ')}` : '';
        console.log(`  ${flag} ${s.name}${ver}  [${s.origin}]${aliases}`);
        console.log(`      ${s.description}`);
      }
      console.log('\nLegend: ● enabled, ○ disabled');
    });

  cmd
    .command('install <source>')
    .description('Install a skill. Sources: ./path, file.tgz, gh:user/repo[@ref], npm:<pkg>')
    .option('-f, --force', 'Overwrite if a skill with the same name is already installed')
    .action(async (source: string, opts: { force?: boolean }) => {
      try {
        const result = await installSkill(source, { force: opts.force });
        console.log(`✓ Installed skill "${result.name}" from ${result.source}`);
        console.log(`  → ${result.installedTo}`);
        await refreshSkillRegistry();
      } catch (e: any) {
        console.error(`✗ ${e.message}`);
        process.exit(1);
      }
    });

  cmd
    .command('install-all <source>')
    .description('Install EVERY skill in a multi-skill repo OR every linked skill in a catalog repo (e.g. gh:abubakarsiddik31/claude-skills-collection)')
    .option('-f, --force', 'Overwrite skills already installed')
    .option('--max <n>', 'Cap the number of skills installed', (v) => parseInt(v, 10))
    .action(async (source: string, opts: { force?: boolean; max?: number }) => {
      try {
        const { installAll } = await import('../skills/bulk-installer.js');
        const result = await installAll(source, {
          force: opts.force,
          maxSkills: opts.max,
          onProgress: (m) => console.log(`  ${m}`),
        });
        console.log('');
        console.log(`✓ Installed ${result.installed.length} skill(s):`);
        for (const s of result.installed) console.log(`    ● ${s.name}  [${s.source}]`);
        if (result.skipped.length > 0) {
          console.log(`\n↷ Skipped ${result.skipped.length} (already installed — use --force to overwrite):`);
          for (const s of result.skipped) console.log(`    ○ ${s.name}`);
        }
        if (result.failed.length > 0) {
          console.log(`\n✗ Failed ${result.failed.length}:`);
          for (const f of result.failed) console.log(`    ✗ ${f.source}: ${f.error}`);
        }
        await refreshSkillRegistry();
        console.log(`\nAll installed skills are now advertised to the model. It will load any of them on demand via use_skill — or run one explicitly with /skill <name>.`);
      } catch (e: any) {
        console.error(`✗ ${e.message}`);
        process.exit(1);
      }
    });

  cmd
    .command('remove <name>')
    .alias('rm')
    .description('Remove an installed skill from ~/.qodex/skills/')
    .action(async (name: string) => {
      try {
        await removeSkill(name);
        console.log(`Removed "${name}".`);
        await refreshSkillRegistry();
      } catch (e: any) {
        console.error(`✗ ${e.message}`);
        process.exit(1);
      }
    });

  cmd
    .command('enable <name>')
    .description('Re-enable a previously disabled user-scope skill')
    .action(async (name: string) => {
      await setSkillEnabled(name, true);
      console.log(`Enabled "${name}".`);
    });

  cmd
    .command('disable <name>')
    .description('Disable a user-scope skill without uninstalling it')
    .action(async (name: string) => {
      await setSkillEnabled(name, false);
      console.log(`Disabled "${name}".`);
    });

  return cmd;
}
