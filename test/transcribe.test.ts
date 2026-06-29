import { describe, it, expect } from 'vitest';
import { readTranscribeSettings, chooseBackend, buildCommand, transcribeAudio } from '../src/audio/transcribe.ts';

describe('transcribe — backend selection (local-first)', () => {
  it('reads settings from env, defaulting the model', () => {
    const s = readTranscribeSettings({ QODEX_TRANSCRIBE_CMD: 'whisper {file}', OPENAI_API_KEY: 'sk-x' } as any);
    expect(s.command).toBe('whisper {file}');
    expect(s.openaiKey).toBe('sk-x');
    expect(s.openaiModel).toBe('whisper-1');
    const s2 = readTranscribeSettings({ QODEX_TRANSCRIBE_MODEL: 'gpt-4o-mini-transcribe' } as any);
    expect(s2.openaiModel).toBe('gpt-4o-mini-transcribe');
    expect(s2.command).toBeUndefined();
  });

  it('prefers a local command, falls back to OpenAI, else none', () => {
    expect(chooseBackend({ command: 'whisper {file}', openaiKey: 'sk' })).toBe('command'); // local wins
    expect(chooseBackend({ openaiKey: 'sk' })).toBe('openai');
    expect(chooseBackend({})).toBeNull();
  });
});

describe('transcribe — buildCommand', () => {
  it('substitutes {file} and quotes the path', () => {
    expect(buildCommand('whisper-cli -f {file} -otxt', '/tmp/a.oga'))
      .toEqual(['sh', '-c', "whisper-cli -f '/tmp/a.oga' -otxt"]);
  });
  it('appends the file when there is no placeholder', () => {
    expect(buildCommand('my-stt', '/tmp/a.oga')).toEqual(['sh', '-c', "my-stt '/tmp/a.oga'"]);
  });
  it('is injection-safe for paths with spaces / quotes', () => {
    const [, , line] = buildCommand('stt {file}', "/tmp/it's here.oga");
    expect(line).toBe("stt '/tmp/it'\\''s here.oga'");
  });
});

describe('transcribe — no backend', () => {
  it('throws actionable guidance when nothing is configured', async () => {
    await expect(transcribeAudio('/tmp/x.oga', {})).rejects.toThrow(/QODEX_TRANSCRIBE_CMD.*OPENAI_API_KEY/);
  });
});
