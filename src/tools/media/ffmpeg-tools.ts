import { z } from 'zod';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { runProcess, notInstalledMessage } from '../../utils/run-process.js';

/**
 * Media tools built on ffmpeg/ffprobe — useful for the Runway Gen-4 video pipeline
 * (cut, transcode, resize, pull frames/thumbnails, strip audio).
 *
 *   media_probe     — ffprobe → structured metadata (read-only)
 *   media_transform — ffmpeg  → convert / trim / extract_frame / resize / extract_audio (writes a file → destructive)
 *
 * ffmpeg is not bundled; if missing, a clear install hint is returned (no crash).
 */

const FFMPEG_HINT = 'Install with: brew install ffmpeg  (macOS). This also provides ffprobe.';

// ---- media_probe ----
const ProbeArgs = z.object({ file: z.string().describe('Path to a video/audio/image file.') });
export class MediaProbeTool extends Tool<z.infer<typeof ProbeArgs>> {
  name = 'media_probe';
  description = 'Inspect a media file with ffprobe: duration, container, and per-stream codec/resolution/fps/bitrate/sample-rate. Read-only. Use before media_transform to know what you are working with.';
  isReadOnly = true; isDestructive = false; argsSchema = ProbeArgs;

  async execute(a: z.infer<typeof ProbeArgs>): Promise<ToolResult> {
    const r = await runProcess('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', a.file], { timeoutMs: 30_000 });
    if (r.notFound) return { content: notInstalledMessage('ffprobe', FFMPEG_HINT), isError: true };
    if (!r.ok) return { content: (r.stderr || r.stdout).trim() || 'ffprobe failed', isError: true };
    try {
      const data = JSON.parse(r.stdout);
      const fmt = data.format ?? {};
      const lines: string[] = [];
      lines.push(`File: ${fmt.filename ?? a.file}`);
      lines.push(`Format: ${fmt.format_long_name ?? fmt.format_name}`);
      if (fmt.duration) lines.push(`Duration: ${Number(fmt.duration).toFixed(2)}s`);
      if (fmt.bit_rate) lines.push(`Bitrate: ${Math.round(Number(fmt.bit_rate) / 1000)} kbps`);
      if (fmt.size) lines.push(`Size: ${(Number(fmt.size) / 1048576).toFixed(2)} MB`);
      for (const s of data.streams ?? []) {
        if (s.codec_type === 'video') {
          const fps = s.r_frame_rate && s.r_frame_rate !== '0/0'
            ? (() => { const [n, d] = s.r_frame_rate.split('/').map(Number); return d ? (n / d).toFixed(2) : s.r_frame_rate; })()
            : '?';
          lines.push(`  video: ${s.codec_name} ${s.width}x${s.height} @ ${fps}fps${s.pix_fmt ? ` (${s.pix_fmt})` : ''}`);
        } else if (s.codec_type === 'audio') {
          lines.push(`  audio: ${s.codec_name} ${s.sample_rate ? s.sample_rate + 'Hz' : ''} ${s.channels ? s.channels + 'ch' : ''}`);
        } else {
          lines.push(`  ${s.codec_type}: ${s.codec_name}`);
        }
      }
      return { content: lines.join('\n') };
    } catch {
      return { content: r.stdout.slice(0, 4000) };
    }
  }
}

// ---- media_transform ----
const TransformArgs = z.object({
  input: z.string().optional().describe('Input media path (single-input ops). Not used by concat — use inputs.'),
  output: z.string().describe('Output path. Extension determines container/format.'),
  operation: z.enum(['convert', 'trim', 'extract_frame', 'resize', 'extract_audio', 'concat'])
    .describe('convert=transcode; trim=cut a segment; extract_frame=single still; resize=scale video; extract_audio=strip audio track; concat=join multiple clips in order into one final video.'),
  inputs: z.array(z.string()).optional().describe('For concat: ordered list of clip paths to join into the final video.'),
  reencode: z.boolean().optional().describe('For concat: re-encode (H.264/yuv420p) instead of stream-copy. Use when clips have different codecs/resolutions; slower but tolerant of mismatched sources.'),
  start: z.string().optional().describe("For trim/extract_frame: start time, e.g. '00:00:05' or '5'."),
  end: z.string().optional().describe("For trim: end time, e.g. '00:00:10'."),
  width: z.number().int().optional().describe('For resize: target width (height auto if omitted, keeps aspect with -1).'),
  height: z.number().int().optional().describe('For resize: target height.'),
  overwrite: z.boolean().optional().describe('Pass -y to overwrite an existing output. Default false (ffmpeg will refuse if output exists).'),
  timeout_seconds: z.number().int().min(5).max(1800).optional().describe('Default 600. For long encodes prefer background_job_start.'),
});
export class MediaTransformTool extends Tool<z.infer<typeof TransformArgs>> {
  name = 'media_transform';
  description = 'Transform media with ffmpeg: convert (transcode), trim (cut a segment), extract_frame (single still), resize (scale), extract_audio, and concat (join multiple clips in order into one final video). Writes the output file → destructive, permission-gated. For long encodes, consider background_job_start with a shell ffmpeg command so it does not block.';
  isReadOnly = false; isDestructive = true; argsSchema = TransformArgs;

  async execute(a: z.infer<typeof TransformArgs>): Promise<ToolResult> {
    // ---- concat: join an ordered list of clips into one final video ----
    // Uses the concat demuxer. Default -c copy is lossless + fast and works when
    // all clips share codec/resolution (the typical same-preset AI-generated case);
    // reencode:true normalizes mismatched sources.
    if (a.operation === 'concat') {
      const inputs = a.inputs ?? [];
      if (inputs.length < 2) {
        return { content: 'concat requires "inputs" with at least 2 clip paths, in play order.', isError: true };
      }
      const listLines = inputs.map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`);
      const listPath = path.join(os.tmpdir(), `qodex-concat-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      try {
        await fs.writeFile(listPath, listLines.join('\n') + '\n', 'utf8');
        const cargs: string[] = [];
        if (a.overwrite) cargs.push('-y');
        cargs.push('-f', 'concat', '-safe', '0', '-i', listPath);
        if (a.reencode) cargs.push('-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
        else cargs.push('-c', 'copy');
        cargs.push(a.output);
        const r = await runProcess('ffmpeg', cargs, { timeoutMs: (a.timeout_seconds ?? 600) * 1000 });
        if (r.notFound) return { content: notInstalledMessage('ffmpeg', FFMPEG_HINT), isError: true };
        if (r.timedOut) return { content: 'ffmpeg concat timed out. For many/long clips use background_job_start.', isError: true };
        if (!r.ok) {
          const hint = a.reencode ? '' : '\nIf clips differ in codec/resolution, retry with reencode:true (or normalize them first with resize/convert).';
          return { content: `ffmpeg concat failed:\n${r.stderr.trim().slice(-1500)}${hint}`, isError: true };
        }
        return { content: `✓ concat ${inputs.length} clips → ${a.output}` };
      } finally {
        try { await fs.unlink(listPath); } catch { /* ignore temp cleanup */ }
      }
    }

    if (!a.input) return { content: `Operation "${a.operation}" requires "input".`, isError: true };
    const input: string = a.input;
    const args: string[] = [];
    if (a.overwrite) args.push('-y');

    switch (a.operation) {
      case 'convert':
        args.push('-i', input, a.output);
        break;
      case 'trim':
        if (!a.start) return { content: 'trim requires "start".', isError: true };
        args.push('-i', input, '-ss', a.start);
        if (a.end) args.push('-to', a.end);
        args.push('-c', 'copy', a.output);
        break;
      case 'extract_frame':
        args.push('-ss', a.start ?? '0', '-i', input, '-frames:v', '1', a.output);
        break;
      case 'resize': {
        if (!a.width && !a.height) return { content: 'resize requires width and/or height.', isError: true };
        const w = a.width ?? -1, h = a.height ?? -1;
        args.push('-i', input, '-vf', `scale=${w}:${h}`, a.output);
        break;
      }
      case 'extract_audio':
        args.push('-i', input, '-vn', '-acodec', 'copy', a.output);
        break;
    }

    const r = await runProcess('ffmpeg', args, { timeoutMs: (a.timeout_seconds ?? 600) * 1000 });
    if (r.notFound) return { content: notInstalledMessage('ffmpeg', FFMPEG_HINT), isError: true };
    if (r.timedOut) return { content: `ffmpeg timed out. For long encodes use background_job_start with a shell ffmpeg command.`, isError: true };
    if (!r.ok) return { content: `ffmpeg failed:\n${r.stderr.trim().slice(-1500)}`, isError: true };
    return { content: `✓ ${a.operation} → ${a.output}` };
  }
}
