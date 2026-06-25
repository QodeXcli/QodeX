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

  // ── Skill-learning loop: capture → candidate → (judge) → promote ──

  cmd
    .command('candidates')
    .description('List machine-captured CANDIDATE skills awaiting review (quarantined; not active)')
    .action(async () => {
      const { listCandidates } = await import('../skills/learning/candidate-store.js');
      const cands = await listCandidates();
      if (cands.length === 0) {
        console.log('No candidate skills. Enable capture with learning.enabled in ~/.qodex/config.yaml.');
        return;
      }
      console.log(`${cands.length} candidate(s) awaiting review:\n`);
      for (const c of cands) {
        const conf = typeof c.confidence === 'number' ? `  [confidence ${c.confidence}/100]` : '';
        console.log(`  ◇ ${c.name}${conf}${c.capturedAt ? `  (captured ${c.capturedAt})` : ''}`);
        console.log(`      ${c.description}`);
      }
      console.log('\nPromote:  qodex skill promote <name>   ·   Reject:  qodex skill reject <name>   ·   Auto-judge:  qodex skill curate');
    });

  cmd
    .command('learning-stats')
    .description('Show learning-loop metrics: captured / promoted / rejected / merged, promotion rate, avg confidence')
    .action(async () => {
      const { readLearningEvents, aggregateStats } = await import('../skills/learning/ledger.js');
      const { listCandidates } = await import('../skills/learning/candidate-store.js');
      const events = await readLearningEvents();
      const pending = (await listCandidates()).length;
      const s = aggregateStats(events, pending);
      console.log('Skill-learning metrics');
      console.log('──────────────────────');
      console.log(`  Captured:        ${s.captured}`);
      console.log(`  Promoted:        ${s.promoted}`);
      console.log(`  Rejected:        ${s.rejected}`);
      console.log(`  Merged:          ${s.merged}`);
      console.log(`  Promotion rate:  ${(s.promotionRate * 100).toFixed(0)}%  (of judged candidates)`);
      console.log(`  Avg confidence:  ${s.avgConfidence === null ? '—' : `${s.avgConfidence}/100`}`);
      console.log(`  Pending review:  ${s.pendingCandidates}`);
      if (s.lastEventAt) console.log(`  Last activity:   ${s.lastEventAt}`);
      if (s.captured + s.promoted + s.rejected + s.merged === 0) {
        console.log('\nNo activity yet. Enable with learning.enabled in ~/.qodex/config.yaml.');
      }
    });

  cmd
    .command('promote <name>')
    .description('Promote a candidate skill to active (you are the independent reviewer). Refuses to overwrite a human-authored skill.')
    .action(async (name: string) => {
      const { promoteCandidate } = await import('../skills/learning/candidate-store.js');
      const res = await promoteCandidate(name, process.cwd());
      if (res.promoted) {
        console.log(`✓ Promoted "${name}" → active (${res.dest}).`);
        await refreshSkillRegistry();
      } else {
        console.error(`✗ ${res.reason}`);
        process.exit(1);
      }
    });

  cmd
    .command('reject <name>')
    .description('Discard a candidate skill')
    .action(async (name: string) => {
      const { archiveCandidate } = await import('../skills/learning/candidate-store.js');
      const ok = await archiveCandidate(name);
      console.log(ok ? `Rejected and removed candidate "${name}".` : `No candidate named "${name}".`);
    });

  cmd
    .command('snapshots')
    .description('List skills-directory snapshots (rollback points taken before curation)')
    .action(async () => {
      const { listSkillSnapshots } = await import('../skills/learning/snapshot.js');
      const snaps = await listSkillSnapshots();
      if (snaps.length === 0) { console.log('No skills snapshots yet.'); return; }
      console.log(`${snaps.length} snapshot(s) (newest first):`);
      for (const s of snaps) console.log(`  ${s}`);
      console.log('\nRestore the whole skills dir from one with:  qodex skill restore <path>');
    });

  cmd
    .command('restore <archive>')
    .description('Roll the entire user skills dir back to a snapshot archive (.tar.gz)')
    .action(async (archive: string) => {
      try {
        const { restoreSkillsSnapshot } = await import('../skills/learning/snapshot.js');
        await restoreSkillsSnapshot(archive);
        console.log(`✓ Skills directory restored from ${archive}.`);
        await refreshSkillRegistry();
      } catch (e: any) {
        console.error(`✗ ${e.message}`);
        process.exit(1);
      }
    });

  cmd
    .command('curate')
    .description('Run the INDEPENDENT judge over candidate skills and promote the ones it approves (snapshots first; never overwrites a human skill)')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async () => {
      try {
        const { curateCandidates } = await import('../skills/learning/curator.js');
        const res = await curateCandidates(process.cwd(), { onProgress: m => console.log(`  ${m}`) });
        console.log(`\nCurate complete: ${res.promoted.length} promoted, ${res.rejected.length} kept/rejected, ${res.skipped.length} skipped.`);
        if (res.snapshot) console.log(`Rollback point: ${res.snapshot}`);
        if (res.promoted.length) await refreshSkillRegistry();
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
