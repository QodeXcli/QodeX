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
    .alias('stats')
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
    .command('eval <name>')
    .description('Replay a skill\'s original task in a clean git worktree and check the produced code against the real verifier (writes the result into the skill)')
    .option('--no-cache', 'Re-evaluate even if the skill is unchanged and was evaluated recently')
    .action(async (name: string, opts: { cache?: boolean }) => {
      const { readCandidate, candidatesDir } = await import('../skills/learning/candidate-store.js');
      const { loadSkillByName } = await import('../skills/loader.js');
      const { evalSkillMd } = await import('../skills/learning/eval.js');
      const { formatEvalSection, upsertEvalSection, skillContentHash } = await import('../skills/learning/eval-record.js');
      const { recordLearningEvent } = await import('../skills/learning/ledger.js');
      const { loadConfig } = await import('../config/loader.js');
      const { promises: fs } = await import('fs');
      const path = await import('path');

      // Find the skill: a candidate first, else an active one.
      let md = await readCandidate(name);
      let filePath: string | null = md ? path.join(candidatesDir(), name, 'SKILL.md') : null;
      if (!md) {
        const active = await loadSkillByName(name, process.cwd());
        if (active) { md = await fs.readFile(path.join(active.dir, 'SKILL.md'), 'utf-8'); filePath = path.join(active.dir, 'SKILL.md'); }
      }
      if (!md || !filePath) { console.error(`✗ no candidate or active skill named "${name}"`); process.exit(1); }

      const config = await loadConfig(process.cwd());
      const ttlMs = Number((config as any).learning?.evalCacheTtlHours ?? 24) * 3600_000;
      const { result, skipped, reason } = await evalSkillMd(process.cwd(), md, { noCache: opts.cache === false, cacheTtlMs: ttlMs, onProgress: m => console.log(`  ${m}`) });
      if (skipped) { console.log(`↷ Skipped: ${reason}. Use --no-cache to force.`); return; }
      if (!result) { console.error('✗ eval produced no result'); process.exit(1); }

      const section = formatEvalSection(result, skillContentHash(md));
      await fs.writeFile(filePath, upsertEvalSection(md, section), 'utf-8');
      await recordLearningEvent({ event: 'eval', name, evalStatus: result.status, judge: result.model });
      const icon = result.status === 'pass' ? '✓' : result.status === 'fail' ? '✗' : result.status === 'inconclusive' ? '◌' : '⚠';
      console.log(`\n${icon} ${name}: ${result.status}${result.note ? ` — ${result.note}` : ''}`);
      console.log(`  recorded in ${filePath}`);
    });

  cmd
    .command('versions <name>')
    .description('Show a skill\'s version history, champion/challenger, and per-version stats (UCB1 A/B)')
    .action(async (name: string) => {
      const { loadSkillByName } = await import('../skills/loader.js');
      const { readManifest } = await import('../skills/learning/versioned-store.js');
      const { routeSkillVersion, ucbScores } = await import('../skills/learning/skill-versioning.js');
      const { loadConfig } = await import('../config/loader.js');
      const spec = await loadSkillByName(name, process.cwd());
      if (!spec) { console.error(`✗ no skill named "${name}"`); process.exit(1); }
      const m = await readManifest(spec.dir);
      if (!m) { console.log(`"${name}" is a single-version (legacy) skill — no version history yet.`); return; }
      const vcfg = (await loadConfig(process.cwd()) as any).learning?.versioning ?? {};
      const opts = {
        explorationFactor: vcfg.ucbExplorationFactor,
        minChallengerTrials: vcfg.minChallengerTrials,
        weights: vcfg.rewardWeights ? { success: vcfg.rewardWeights.success ?? 0.7, token: vcfg.rewardWeights.token ?? 0.15, time: vcfg.rewardWeights.time ?? 0.15 } : undefined,
      };
      const routed = routeSkillVersion(m, opts);
      const scores = new Map(ucbScores(m, opts).map(s => [s.version, s]));
      console.log(`Skill "${m.skillId}"  ·  strategy: ${m.routingStrategy}  ·  routed this turn → ${routed}\n`);
      for (const v of Object.values(m.versions).sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))) {
        const tag = v.version === m.activeVersion ? '★ champion' : v.version === m.challengerVersion ? '⚡ challenger' : v.retired ? '✗ retired' : '';
        const rate = v.stats.executions ? `${Math.round((v.stats.successes / v.stats.executions) * 100)}% over ${v.stats.executions}` : 'untested';
        const avgMs = v.stats.executions && v.stats.totalDurationMs ? `  ·  ${Math.round(v.stats.totalDurationMs / v.stats.executions)}ms/run` : '';
        console.log(`  ${v.version}  [${v.author}]  ${tag}`);
        console.log(`      success: ${rate}  ·  tokens: ${v.stats.totalTokensUsed}${avgMs}  ·  confidence: ${v.confidence}`);
        const s = scores.get(v.version);
        if (s) console.log(`      UCB: reward ${s.reward.toFixed(3)} + bonus ${s.bonus === Infinity ? '∞' : s.bonus.toFixed(3)} = ${s.ucb === Infinity ? '∞' : s.ucb.toFixed(3)}`);
      }
    });

  cmd
    .command('rollback <name> <version>')
    .description('Roll a versioned skill\'s champion back to an earlier version (e.g. v1) — drops any challenger')
    .action(async (name: string, version: string) => {
      const { loadSkillByName } = await import('../skills/loader.js');
      const { rollbackToVersion } = await import('../skills/learning/versioned-store.js');
      const spec = await loadSkillByName(name, process.cwd());
      if (!spec) { console.error(`✗ no skill named "${name}"`); process.exit(1); }
      const ver = version.startsWith('v') ? version : `v${version}`;
      const ok = await rollbackToVersion(spec.dir, ver);
      if (ok) {
        console.log(`✓ "${name}" rolled back — champion is now ${ver}.`);
        await refreshSkillRegistry();
      } else {
        console.error(`✗ "${name}" has no version ${ver} (or isn't versioned). Run \`qodex skill versions ${name}\`.`);
        process.exit(1);
      }
    });

  cmd
    .command('lessons')
    .description('Show "learned cautions" mined from your RECURRING tool failures (failure-driven learning)')
    .option('--clear', 'Erase the failure log and start over')
    .action(async (opts: { clear?: boolean }) => {
      const { readFailures, detectFailurePatterns, buildLesson } = await import('../skills/learning/failures.js');
      const { loadConfig } = await import('../config/loader.js');
      const os = await import('os'); const path = await import('path'); const { promises: fs } = await import('fs');
      if (opts.clear) {
        await fs.rm(path.join(os.homedir(), '.qodex', 'failures.jsonl'), { force: true });
        console.log('Failure log cleared.');
        return;
      }
      const cfg = (await loadConfig(process.cwd()) as any).learning?.failureLessons ?? {};
      const events = await readFailures();
      const patterns = detectFailurePatterns(events, { minOccurrences: cfg.minOccurrences ?? 3, minDistinctTasks: cfg.minDistinctTasks ?? 2 });
      console.log(`${events.length} failure(s) logged · ${patterns.length} recurring pattern(s) learned\n`);
      if (patterns.length === 0) {
        console.log('No recurring patterns yet. (Enable with learning.failureLessons.enabled; cautions appear once a failure repeats across tasks.)');
        return;
      }
      for (const p of patterns) console.log(`  ⚠ ${buildLesson(p)}`);
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
    .command('export <name>')
    .description('Export a skill in the agentskills.io open standard (to a directory, or stdout)')
    .option('--out <dir>', 'Write <name>/SKILL.md under this directory (default: print to stdout)')
    .action(async (name: string, opts: { out?: string }) => {
      const { promises: fs } = await import('fs');
      const path = await import('path');
      const { userSkillsDir, projectSkillsDir } = await import('../skills/loader.js');
      const { toAgentSkill } = await import('../skills/interop.js');
      let md = '';
      for (const c of [path.join(userSkillsDir(), name, 'SKILL.md'), path.join(projectSkillsDir(process.cwd()), name, 'SKILL.md')]) {
        try { md = await fs.readFile(c, 'utf-8'); break; } catch { /* try next */ }
      }
      if (!md) { console.error(`No skill "${name}".`); process.exit(1); }
      const std = toAgentSkill(md, name);
      if (opts.out) {
        const dir = path.join(opts.out, name); await fs.mkdir(dir, { recursive: true });
        const dest = path.join(dir, 'SKILL.md'); await fs.writeFile(dest, std);
        console.log(`✓ Exported "${name}" (agentskills.io standard) → ${dest}`);
      } else { console.log(std); }
    });

  cmd
    .command('import <file>')
    .description('Import an agentskills.io-standard SKILL.md into your skills (security-scanned, provenance: imported)')
    .action(async (file: string) => {
      const { promises: fs } = await import('fs');
      const path = await import('path');
      const { userSkillsDir } = await import('../skills/loader.js');
      const { fromAgentSkill, skillSlug } = await import('../skills/interop.js');
      const { scanSkillContent, formatScanReport } = await import('../skills/security-scan.js');
      let raw = '';
      try { raw = await fs.readFile(file, 'utf-8'); } catch { console.error(`Can't read ${file}.`); process.exit(1); }
      const scan = scanSkillContent(raw);
      if (scan.severity === 'dangerous') { console.error(`✗ Import blocked — security scan:\n${formatScanReport(scan, file)}`); process.exit(1); }
      if (scan.severity === 'suspicious') console.error(`⚠ ${formatScanReport(scan, file)}\n(importing anyway — review it.)`);
      const slug = skillSlug(raw, path.basename(file).replace(/\.md$/i, ''));
      const dir = path.join(userSkillsDir(), slug); await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), fromAgentSkill(raw, { name: slug }));
      console.log(`✓ Imported "${slug}" → ${dir} (provenance: imported)`);
      await refreshSkillRegistry();
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
