/**
 * Artifact tools — the model-facing surface of the Living Artifact system (Layer 1).
 *
 * These let the model produce a named, versioned, self-contained output instead of
 * dumping code into the chat: `artifact_create` makes v1, `artifact_update` adds a new
 * version (old ones are preserved), `artifact_list` / `artifact_get` browse them, and
 * `artifact_rollback` repoints "current" to an earlier version. Writes go through the
 * journaled transaction, so artifacts are undoable like any other edit.
 *
 * Layer 2 (auto browser preview) and Layer 3 (vision self-correction) will hook onto
 * `artifact_create` / `artifact_update` for web types — but artifacts work fully without
 * them.
 */
import { z } from 'zod';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from '../base.js';
import {
  createArtifact, updateArtifact, listArtifacts, getArtifact, rollbackArtifact,
  isArtifactType, type ArtifactType,
} from '../../artifacts/store.js';
import { buildPreviewHtml, PREVIEW_FILE, previewServerName, previewPort, livePort, liveServerName } from '../../artifacts/preview.js';
import { buildReviewPrompt, buildReviewReport, formatReviewReport } from '../../artifacts/review.js';
import { VisionAnalyzeTool } from '../vision/vision-analyze.js';
import * as processRegistry from '../browser/process-registry.js';
import { startLive, stopLive, stopAllLive, listLive } from '../../artifacts/live-registry.js';

const TYPE_VALUES = ['html', 'react', 'svg', 'markdown', 'vue', 'text'] as const;

/** Resolve the artifact id from either `id` or the `name` alias some models send. */
function resolveArtifactId(args: { id?: string; name?: string }): string {
  const id = (args.id ?? args.name ?? '').trim();
  if (!id) throw new Error('Missing artifact id. Pass id="<artifact-id>" (the id returned by artifact_create).');
  return id;
}


const CreateArgs = z.object({
  title: z.string().describe('Human title for the artifact, e.g. "Pricing page" — also seeds its id.'),
  type: z.enum(TYPE_VALUES).describe('Artifact kind: html, react (JSX), svg, markdown, vue, or text.'),
  content: z.string().describe('The full file content of this first version.'),
  note: z.string().optional().describe('Optional note describing this version.'),
});

export class ArtifactCreateTool extends Tool<z.infer<typeof CreateArgs>> {
  name = 'artifact_create';
  description = 'Create a new versioned artifact (a self-contained web page, React component, SVG, or doc the user will keep and iterate on). Returns the artifact id. Prefer this over dumping a large standalone file into chat.';
  argsSchema = CreateArgs;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: z.infer<typeof CreateArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (!isArtifactType(args.type)) {
      return { content: `Invalid artifact type "${args.type}". Use one of: ${TYPE_VALUES.join(', ')}.`, isError: true };
    }
    const { manifest, absFile } = await createArtifact(
      ctx.cwd,
      { title: args.title, type: args.type as ArtifactType, content: args.content, note: args.note },
      (p, c) => ctx.transaction.write(p, c),
    );
    ctx.emit({ type: 'progress', message: `Created artifact "${manifest.id}" (v1)` });
    return {
      content: `Created artifact "${manifest.id}" (${manifest.type}, v1) at ${absFile}. Use artifact_update with id="${manifest.id}" to revise it.`,
      metadata: { artifactId: manifest.id, version: 1, type: manifest.type, path: absFile },
    };
  }
}

const UpdateArgs = z.object({
  id: z.string().optional().describe('The artifact id returned by artifact_create.'),
  name: z.string().optional().describe('Alias for id — some models pass the artifact title here; id takes precedence.'),
  content: z.string().describe('The full file content of the NEW version (not a diff).'),
  note: z.string().optional().describe('What changed in this version.'),
});

export class ArtifactUpdateTool extends Tool<z.infer<typeof UpdateArgs>> {
  name = 'artifact_update';
  description = 'Save a new version of an existing artifact. Previous versions are preserved (use artifact_rollback to go back). Pass the FULL new content, not a diff.';
  argsSchema = UpdateArgs;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: z.infer<typeof UpdateArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const { manifest, absFile, version } = await updateArtifact(
        ctx.cwd,
        { id: resolveArtifactId(args), content: args.content, note: args.note },
        (p, c) => ctx.transaction.write(p, c),
      );
      ctx.emit({ type: 'progress', message: `Updated artifact "${manifest.id}" → v${version}` });
      return {
        content: `Saved "${manifest.id}" v${version} at ${absFile}. It now has ${manifest.versions.length} version(s).`,
        metadata: { artifactId: manifest.id, version, type: manifest.type, path: absFile },
      };
    } catch (e: any) {
      return { content: e?.message ?? String(e), isError: true };
    }
  }
}

const ListArgs = z.object({});

export class ArtifactListTool extends Tool<z.infer<typeof ListArgs>> {
  name = 'artifact_list';
  description = 'List all artifacts in this project with their current version and type.';
  argsSchema = ListArgs;
  isReadOnly = true;
  isDestructive = false;

  async execute(_args: z.infer<typeof ListArgs>, ctx: ToolContext): Promise<ToolResult> {
    const items = await listArtifacts(ctx.cwd);
    if (items.length === 0) return { content: 'No artifacts yet. Create one with artifact_create.' };
    const lines = items.map(a => `- ${a.id} (${a.type}) — "${a.title}", v${a.current} of ${a.versionCount}`);
    return { content: `Artifacts (${items.length}):\n${lines.join('\n')}`, metadata: { count: items.length } };
  }
}

const GetArgs = z.object({
  id: z.string().optional().describe('The artifact id.'),
  name: z.string().optional().describe('Alias for id — some models pass the artifact title here; id takes precedence.'),
  version: z.number().int().positive().optional().describe('Version to read (defaults to current).'),
});

export class ArtifactGetTool extends Tool<z.infer<typeof GetArgs>> {
  name = 'artifact_get';
  description = 'Read the content of an artifact version (defaults to the current version).';
  argsSchema = GetArgs;
  isReadOnly = true;
  isDestructive = false;

  async execute(args: z.infer<typeof GetArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const { manifest, version, content } = await getArtifact(ctx.cwd, resolveArtifactId(args), args.version);
      return {
        content: `Artifact "${manifest.id}" v${version} (${manifest.type}):\n\n${content}`,
        metadata: { artifactId: manifest.id, version, type: manifest.type },
      };
    } catch (e: any) {
      return { content: e?.message ?? String(e), isError: true };
    }
  }
}

const RollbackArgs = z.object({
  id: z.string().optional().describe('The artifact id.'),
  name: z.string().optional().describe('Alias for id — some models pass the artifact title here; id takes precedence.'),
  version: z.number().int().positive().describe('The earlier version number to make current.'),
});

export class ArtifactRollbackTool extends Tool<z.infer<typeof RollbackArgs>> {
  name = 'artifact_rollback';
  description = 'Repoint an artifact\u2019s "current" version to an earlier one. No content is lost; later versions remain in history.';
  argsSchema = RollbackArgs;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: z.infer<typeof RollbackArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const manifest = await rollbackArtifact(ctx.cwd, resolveArtifactId(args), args.version, (p, c) => ctx.transaction.write(p, c));
      ctx.emit({ type: 'progress', message: `Rolled "${manifest.id}" back to v${args.version}` });
      return { content: `"${manifest.id}" current version is now v${args.version}.`, metadata: { artifactId: manifest.id, current: args.version } };
    } catch (e: any) {
      return { content: e?.message ?? String(e), isError: true };
    }
  }
}

const PreviewArgs = z.object({
  id: z.string().optional().describe('The artifact id to preview.'),
  name: z.string().optional().describe('Alias for id — some models pass the artifact title here; id takes precedence.'),
  version: z.number().int().positive().optional().describe('Version to preview (defaults to current).'),
});

export class ArtifactPreviewTool extends Tool<z.infer<typeof PreviewArgs>> {
  name = 'artifact_preview';
  description = 'Render an artifact in a real browser: builds a self-contained preview page (React/Vue render via an in-browser harness, no build step) and starts a local static server. Returns a URL — follow with browser_navigate then browser_screenshot to SEE the result. Needs python3 for the static server.';
  argsSchema = PreviewArgs;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: z.infer<typeof PreviewArgs>, ctx: ToolContext): Promise<ToolResult> {
    let manifest, version, content, absFile;
    try {
      ({ manifest, version, content, absFile } = await getArtifact(ctx.cwd, resolveArtifactId(args), args.version));
    } catch (e: any) {
      return { content: e?.message ?? String(e), isError: true };
    }

    // Build + write the preview page next to the artifact's version file.
    const html = buildPreviewHtml(manifest.type, content);
    const versionDir = path.dirname(absFile);
    const previewPath = path.join(versionDir, PREVIEW_FILE);
    await ctx.transaction.write(previewPath, html);

    const port = previewPort(manifest.id);
    const name = previewServerName(manifest.id);
    const url = `http://localhost:${port}/${PREVIEW_FILE}`;

    // Serve the version dir statically. python3 is near-universal on macOS/Linux and needs
    // no project deps. If it isn't available, hand back the page path + a manual fallback.
    try {
      await processRegistry.start({
        name,
        command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory ${JSON.stringify(versionDir)}`,
        cwd: versionDir,
        replace: true,
      });
    } catch (e: any) {
      return {
        content:
          `Preview page written to ${previewPath}, but the static server could not start ` +
          `(${e?.message ?? e}). Serve it yourself, e.g.:\n` +
          `  dev_server_start name="${name}" command="python3 -m http.server ${port}" cwd="${versionDir}"\n` +
          `then browser_navigate ${url} and browser_screenshot.`,
        metadata: { artifactId: manifest.id, version, previewPath, url, served: false },
      };
    }

    ctx.emit({ type: 'progress', message: `Serving artifact "${manifest.id}" v${version} at ${url}` });
    return {
      content:
        `Preview of "${manifest.id}" v${version} (${manifest.type}) is live at ${url}\n` +
        `Next: browser_navigate to that URL, then browser_screenshot to see how it rendered. ` +
        `Stop the server later with dev_server_stop name="${name}".`,
      metadata: { artifactId: manifest.id, version, type: manifest.type, url, server: name, served: true },
    };
  }
}

const ReviewArgs = z.object({
  id: z.string().optional().describe('The artifact id to review.'),
  name: z.string().optional().describe('Alias for id — some models pass the artifact title here; id takes precedence.'),
  screenshot_path: z.string().min(1).describe('Path to a screenshot of the rendered preview (from browser_screenshot). Required — the review judges what actually rendered.'),
  intent: z.string().optional().describe('What the artifact is supposed to look like / do, so the review can judge against it.'),
  console_errors: z.array(z.string()).optional().describe('Console error strings from browser_console, if any.'),
  page_errors: z.array(z.string()).optional().describe('Uncaught page error strings from browser_console, if any.'),
  version: z.number().int().positive().optional().describe('Artifact version under review (defaults to current).'),
});

export class ArtifactReviewTool extends Tool<z.infer<typeof ReviewArgs>> {
  name = 'artifact_review';
  description = 'Visually review a rendered artifact (Layer 3 of the artifact loop): sends a screenshot of the live preview to a vision model, folds in any page/console errors, and returns a structured verdict (LOOKS_GOOD / NEEDS_WORK / BROKEN) with concrete issues. Use after artifact_preview + browser_navigate + browser_screenshot. If the verdict is not LOOKS_GOOD, fix with artifact_update and review again. Degrades gracefully when no vision backend is configured (falls back to runtime errors only).';
  argsSchema = ReviewArgs;
  isReadOnly = true;
  isDestructive = false;

  async execute(args: z.infer<typeof ReviewArgs>, ctx: ToolContext): Promise<ToolResult> {
    // Resolve the artifact (also validates the id + version and gives us type/title for the prompt).
    let manifest, version;
    try {
      ({ manifest, version } = await getArtifact(ctx.cwd, resolveArtifactId(args), args.version));
    } catch (e: any) {
      return { content: e?.message ?? String(e), isError: true };
    }

    // Ask a vision model to critique the screenshot. We reuse the vision_analyze tool so all
    // the backend-selection + graceful "[VISION_NOT_CONFIGURED]" handling lives in one place.
    const prompt = buildReviewPrompt({ type: manifest.type, title: manifest.title, intent: args.intent });
    let visionAnswer = '';
    let sawScreenshot = false;
    try {
      const vision = new VisionAnalyzeTool();
      const res = await vision.execute({ image_path: args.screenshot_path, prompt } as any, ctx);
      const text = typeof res.content === 'string' ? res.content : '';
      if (res.isError || text.startsWith('[VISION_NOT_CONFIGURED]')) {
        // Vision unavailable — we can still report runtime errors, just not a visual verdict.
        visionAnswer = '';
        sawScreenshot = false;
      } else {
        visionAnswer = text;
        sawScreenshot = true;
      }
    } catch {
      visionAnswer = '';
      sawScreenshot = false;
    }

    const report = buildReviewReport({
      visionAnswer,
      consoleErrors: args.console_errors ?? [],
      pageErrors: args.page_errors ?? [],
      sawScreenshot,
    });

    const out = formatReviewReport(manifest.id, version, report);
    const extra = !sawScreenshot && (args.console_errors?.length || args.page_errors?.length || 0) === 0
      ? '\n(No vision backend configured and no runtime errors captured — set QODEX_OLLAMA_VISION_MODEL / ANTHROPIC_API_KEY / OPENAI_API_KEY for a visual verdict.)'
      : '';

    return {
      content: out + extra,
      metadata: { artifactId: manifest.id, version, verdict: report.verdict, issueCount: report.issues.length, sawScreenshot },
    };
  }
}

const LiveArgs = z.object({
  id: z.string().optional().describe('The artifact id to serve live.'),
  name: z.string().optional().describe('Alias for id — some models pass the artifact title here; id takes precedence.'),
  share: z.enum(['local', 'network', 'tunnel']).optional().describe(
    'Reach: "local" (default, localhost only) · "network" (same WiFi/LAN — teammates open ' +
    'http://<your-ip>:port) · "tunnel" (a public https link via cloudflared/ngrok, plus LAN). ' +
    'network/tunnel links carry a private access token, so only someone with the full URL gets in.'),
  open: z.boolean().optional().describe(
    'Auto-open the live page in the user’s default browser so they WATCH it hot-reload as you ' +
    'iterate (default true). Set false for headless/automated runs. Always best-effort — never fails the tool.'),
  // No `version`: live mode ALWAYS tracks the current version (incl. rollbacks).
});

export class ArtifactLiveTool extends Tool<z.infer<typeof LiveArgs>> {
  name = 'artifact_live';
  description =
    'Serve an artifact in a real browser with LIVE hot-reload: a persistent server that always ' +
    'renders the artifact’s CURRENT version (React/Vue via an in-browser harness, no build step) ' +
    'and auto-refreshes the instant you artifact_update or artifact_rollback it. It AUTO-OPENS the ' +
    'page in the user’s browser so they watch your changes land in real time (pass open=false to skip). ' +
    'Set share="network" to share over your LAN, or ' +
    'share="tunnel" for a public private link (PR walkthrough / living dashboard for your team). ' +
    'Stop it with artifact_live_stop. Use artifact_preview for a one-shot snapshot to screenshot.';
  argsSchema = LiveArgs;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: z.infer<typeof LiveArgs>, ctx: ToolContext): Promise<ToolResult> {
    let id: string;
    let manifest;
    try {
      id = resolveArtifactId(args);
      // Validate the artifact exists up-front so the model gets a clean error, not a 500 page.
      ({ manifest } = await getArtifact(ctx.cwd, id));
    } catch (e: any) {
      return { content: e?.message ?? String(e), isError: true };
    }

    const share = args.share ?? 'local';
    const shared = share !== 'local';
    const { makeAccessToken } = await import('../../artifacts/live-share.js');

    let info;
    try {
      info = await startLive({
        cwd: ctx.cwd,
        id,
        port: livePort(id),
        host: shared ? '0.0.0.0' : '127.0.0.1',           // expose on the network when sharing
        token: shared ? makeAccessToken() : undefined,    // private-link token for shared modes
        lan: shared,
        tunnel: share === 'tunnel',
      });
    } catch (e: any) {
      return { content: `Could not start live server for "${id}": ${e?.message ?? e}`, isError: true };
    }

    ctx.emit({ type: 'progress', message: `Live artifact "${id}" (${manifest.type}) at ${info.url}` });

    // Pop the page open on the user's machine so they actually SEE the artifact and
    // watch it hot-reload as the model iterates — the live URL on its own usually
    // goes unclicked. Best-effort: skipped on headless/CI, never fails the tool.
    let opened = false;
    if (args.open !== false) {
      const { openUrl } = await import('../../artifacts/open-browser.js');
      opened = await openUrl(info.url);
      if (opened) ctx.emit({ type: 'progress', message: `Opened ${info.url} in your browser — watch it update live.` });
    }

    const lines = [`Live preview of "${id}" (${manifest.type}) — hot-reloads on every artifact_update / artifact_rollback.`];
    lines.push(`  You (this machine):  ${info.url}${opened ? '  (opened in your browser)' : ''}`);
    if (shared) {
      const lan = info.urls.filter(u => u !== info.url && u !== info.tunnelUrl);
      for (const u of lan) lines.push(`  Same network (LAN):  ${u}`);
      if (info.tunnelUrl) lines.push(`  Public link:         ${info.tunnelUrl}`);
      else if (info.tunnelError) lines.push(`  Public link:         (unavailable — ${info.tunnelError})`);
      lines.push(`  🔒 These links include a private access token — share the FULL url.`);
    }
    lines.push(`Stop with artifact_live_stop id="${id}".`);

    return {
      content: lines.join('\n'),
      metadata: {
        artifactId: id, type: manifest.type, url: info.url, urls: info.urls,
        tunnelUrl: info.tunnelUrl, port: info.port, share, server: liveServerName(id), live: true, opened,
      },
    };
  }
}

const LiveStopArgs = z.object({
  id: z.string().optional().describe('The artifact id whose live server to stop. Omit to stop ALL live artifact servers.'),
  name: z.string().optional().describe('Alias for id.'),
});

export class ArtifactLiveStopTool extends Tool<z.infer<typeof LiveStopArgs>> {
  name = 'artifact_live_stop';
  description = 'Stop a live artifact server started with artifact_live (or all of them if no id is given).';
  argsSchema = LiveStopArgs;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: z.infer<typeof LiveStopArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const id = (args.id ?? args.name ?? '').trim();
    if (!id) {
      const running = listLive().length;
      await stopAllLive();
      return { content: running ? `Stopped ${running} live artifact server(s).` : 'No live artifact servers were running.' };
    }
    const stopped = await stopLive(id);
    return { content: stopped ? `Stopped live server for "${id}".` : `No live server was running for "${id}".` };
  }
}

export const ARTIFACT_TOOLS = [
  ArtifactCreateTool, ArtifactUpdateTool, ArtifactListTool, ArtifactGetTool, ArtifactRollbackTool, ArtifactPreviewTool,
  ArtifactReviewTool, ArtifactLiveTool, ArtifactLiveStopTool,
];
