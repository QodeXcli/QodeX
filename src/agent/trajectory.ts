/**
 * Local Data Flywheel — successful-trajectory recorder.
 *
 * Every successful sandbox task is a high-value training example: a real prompt
 * against THIS codebase, the model's reasoning, the dead-ends it recovered from,
 * and the final code that compiled + passed review + got squash-merged. Today
 * that's thrown away when the sandbox branch is deleted. This module persists it
 * to a local `~/.qodex/trajectories/<project-hash>.jsonl` so it can later seed a
 * clean QLoRA fine-tune — the model gets (positively) overfit to the project's
 * conventions and methodology, WITHOUT a single bit of code leaving the machine.
 *
 * Privacy & scope:
 *   - Strictly local. Never uploaded. One file per project (hashed path).
 *   - Opt-in (`config.flywheel.enabled`). Off by default — recording code is a
 *     deliberate choice, not a silent default.
 *   - Only SUCCESSFUL trajectories are written (compiled + merged). Failed
 *     experiments aren't training signal we want to reinforce.
 *
 * Format: one JSON object per line (JSONL), shaped for instruction fine-tuning:
 *   { ts, project, prompt, reasoning[], filesChanged[], finalDiffSummary,
 *     criticPassed, sandboxBacktracks, messages: [{role, content}] }
 * The `messages` array is a ready-to-train chat transcript (system/user/assistant).
 *
 * This module is pure I/O over a structured record; the loop decides WHEN to
 * record (only on a clean merged finish), keeping concerns separated.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';

export interface TrajectoryRecord {
  ts: string;
  project: string;
  prompt: string;
  /** The model's <thinking> blocks, in order — the reasoning trace. */
  reasoning: string[];
  /** Files the task created/edited. */
  filesChanged: string[];
  /** Short human summary of the final change. */
  finalSummary: string;
  /** Whether the LLM critic passed (when enabled). */
  criticPassed?: boolean;
  /** How many autonomous backtracks happened in the sandbox. */
  sandboxBacktracks?: number;
  /** A ready-to-train chat transcript. */
  messages: Array<{ role: string; content: string }>;
}

function trajectoryPath(projectRoot: string): string {
  const hash = createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.qodex', 'trajectories', `${hash}.jsonl`);
}

/**
 * Append one successful trajectory. Best-effort: a write failure is logged and
 * swallowed — recording must never break a task that already succeeded.
 */
export async function recordTrajectory(
  projectRoot: string,
  rec: Omit<TrajectoryRecord, 'ts' | 'project'>,
): Promise<void> {
  try {
    const full = trajectoryPath(projectRoot);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      project: projectRoot,
      ...rec,
    });
    await fs.appendFile(full, line + '\n', 'utf-8');
    logger.info('Trajectory recorded', { file: full, files: rec.filesChanged.length });
  } catch (e: any) {
    logger.debug('Trajectory record failed (ignored)', { err: e?.message });
  }
}

/** Count trajectories recorded for a project (for the /flywheel status command). */
export async function countTrajectories(projectRoot: string): Promise<number> {
  try {
    const full = trajectoryPath(projectRoot);
    const content = await fs.readFile(full, 'utf-8');
    return content.split('\n').filter(l => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Absolute path to a project's trajectory dataset (for export / fine-tune tooling). */
export function getTrajectoryDatasetPath(projectRoot: string): string {
  return trajectoryPath(projectRoot);
}
