/**
 * Audio transcription — turn a voice message into text so you can TALK to the agent from
 * your phone, not just type. Local-first with a cloud fallback, the same shape as web-search
 * and vision:
 *
 *   1. LOCAL (preferred) — any command you wire via QODEX_TRANSCRIBE_CMD. A `{file}`
 *      placeholder is replaced with the audio path; the command's STDOUT is the transcript.
 *      This is tool-agnostic on purpose: point it at whisper.cpp, faster-whisper, whisper-cli,
 *      a shell script — anything that prints text. Stays fully offline.
 *   2. CLOUD (fallback) — OpenAI's transcription endpoint when OPENAI_API_KEY is set.
 *   3. Neither ⇒ a clear, actionable error (callers degrade to "type instead").
 *
 * Settings come from the environment (like every other key/secret — ~/.qodex/.env), so the
 * thin chat adapters don't have to thread config through. The selection + command-building
 * logic is PURE and unit-tested; only `transcribeAudio` does I/O.
 */
import { spawn } from 'cross-spawn';
import { promises as fs } from 'fs';
import { logger } from '../utils/logger.js';

export type TranscribeBackend = 'command' | 'openai';

export interface TranscribeSettings {
  /** Local command template; `{file}` is substituted with the audio path. STDOUT = transcript. */
  command?: string;
  /** OpenAI key for the cloud fallback. */
  openaiKey?: string;
  /** OpenAI transcription model (default 'whisper-1'). */
  openaiModel?: string;
}

/** Read transcription settings from env. */
export function readTranscribeSettings(env: NodeJS.ProcessEnv = process.env): TranscribeSettings {
  return {
    command: env.QODEX_TRANSCRIBE_CMD?.trim() || undefined,
    openaiKey: env.OPENAI_API_KEY?.trim() || undefined,
    openaiModel: env.QODEX_TRANSCRIBE_MODEL?.trim() || 'whisper-1',
  };
}

/** Which backend will be used — local command wins, else cloud, else none. PURE. */
export function chooseBackend(s: TranscribeSettings): TranscribeBackend | null {
  if (s.command) return 'command';
  if (s.openaiKey) return 'openai';
  return null;
}

/** Build the local argv from a template + file path. Substitutes `{file}`; appends it when the
 *  template has no placeholder. Returns `['sh','-c', …]` so a normal command line Just Works. PURE. */
export function buildCommand(template: string, filePath: string): string[] {
  const line = template.includes('{file}')
    ? template.replaceAll('{file}', shellQuote(filePath))
    : `${template} ${shellQuote(filePath)}`;
  return ['sh', '-c', line];
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Transcribe an audio file to text. Throws with guidance when no backend is configured.
 * `settings` defaults to the environment.
 */
export async function transcribeAudio(filePath: string, settings?: TranscribeSettings): Promise<string> {
  const s = settings ?? readTranscribeSettings();
  const backend = chooseBackend(s);
  if (!backend) {
    throw new Error('No transcription backend. Set QODEX_TRANSCRIBE_CMD (local, e.g. whisper.cpp) or OPENAI_API_KEY.');
  }
  if (backend === 'command') return runCommand(s.command!, filePath);
  return runOpenAI(filePath, s.openaiKey!, s.openaiModel ?? 'whisper-1');
}

function runCommand(template: string, filePath: string): Promise<string> {
  const argv = buildCommand(template, filePath);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e: any) => reject(new Error(`transcribe command failed: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`transcribe command exited ${code}${err ? `: ${err.slice(0, 200).trim()}` : ''}`));
    });
  });
}

async function runOpenAI(filePath: string, apiKey: string, model: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'text');
  form.append('file', new Blob([new Uint8Array(bytes)]), filePath.split('/').pop() ?? 'audio.ogg');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI transcription failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const text = (await res.text()).trim();           // response_format=text returns raw text
  logger.debug('transcribed via openai', { chars: text.length });
  return text;
}
