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
import * as os from 'os';
import { promises as fs } from 'fs';
import { Tool, ToolContext, ToolResult } from '../base.js';
import {
  createArtifact, updateArtifact, listArtifacts, getArtifact, rollbackArtifact,
  isArtifactType, type ArtifactType,
} from '../../artifacts/store.js';
import { buildPreviewHtml, PREVIEW_FILE, previewServerName, previewPort, livePort, liveServerName } from '../../artifacts/preview.js';
import { buildReviewPrompt, buildReviewReport, formatReviewReport } from '../../artifacts/review.js';
import { captureArtifact, type CaptureDeps } from '../../artifacts/review-capture.js';
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
  screenshot_path: z.string().optional().describe('OPTIONAL. Path to an existing screenshot (from browser_screenshot). If omitted, artifact_review builds the preview, opens it in the browser, and screenshots it ITSELF — you do not need to run artifact_preview / browser_* first.'),
  intent: z.string().optional().describe('What the artifact is supposed to look like / do, so the review can judge against it.'),
  console_errors: z.array(z.string()).optional().describe('Console error strings from browser_console, if any. Auto-captured when artifact_review takes its own screenshot.'),
  page_errors: z.array(z.string()).optional().describe('Uncaught page error strings from browser_console, if any. Auto-captured when artifact_review takes its own screenshot.'),
  version: z.number().int().positive().optional().describe('Artifact version under review (defaults to current).'),
});

/** Build the real (browser + static-server backed) capture dependencies. Kept as a factory
 *  so tests can inject a fake capturer and exercise the tool without Playwright/python3. */
function realCaptureDeps(ctx: ToolContext): CaptureDeps {
  return {
    writeFile: (p, c) => ctx.transaction.write(p, c),
    screenshotDir: path.join(os.tmpdir(), 'qodex-screenshots'),
    serve: async ({ name, port, dir }) => {
      await processRegistry.start({
        name,
        command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory ${JSON.stringify(dir)}`,
        cwd: dir,
        replace: true,
      });
      // Give the static server a beat to bind before we navigate to it.
      await new Promise(r => setTimeout(r, 400));
    },
    navigateAndShoot: async ({ url, screenshotPath }) => {
      // Lazily pull in the browser session — its import chain touches Playwright, which is an
      // OPTIONAL dep, so importing it up-front would penalise every non-review run.
      const { getSession, clearBuffers } = await import('../browser/session.js');
      const s = await getSession();
      clearBuffers(s);
      try {
        await s.page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 });
      } catch {
        // A slow CDN (react/vue harness) can trip networkidle; fall back to domcontentloaded so
        // we still screenshot whatever rendered rather than failing the whole review.
        try { await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }); } catch { /* screenshot best-effort below */ }
      }
      // Let CDN-driven harnesses (React/Babel, Vue SFC) mount before we shoot.
      await new Promise(r => setTimeout(r, 800));
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await s.page.screenshot({ path: screenshotPath, fullPage: false });
      const consoleErrors = s.consoleBuffer.filter((m: any) => m.type === 'error').map((m: any) => m.text);
      const pageErrors = s.errorBuffer.map((e: any) => e.message);
      return { consoleErrors, pageErrors };
    },
  };
}

export class ArtifactReviewTool extends Tool<z.infer<typeof ReviewArgs>> {
  name = 'artifact_review';
  description = 'Visually review a rendered artifact (Layer 3 of the artifact loop): screenshots the live preview, sends it to a vision model, folds in any page/console errors, and returns a structured verdict (LOOKS_GOOD / NEEDS_WORK / BROKEN) with concrete issues. SELF-SUFFICIENT: call it with just the artifact id and it builds the preview, opens it in a headless browser, and screenshots it for you — no need to run artifact_preview / browser_navigate / browser_screenshot first (pass screenshot_path only if you already have one). If the verdict is not LOOKS_GOOD, fix with artifact_update and review again. Degrades gracefully with a clear next step when Playwright or a vision backend is missing (falls back to runtime errors only).';
  argsSchema = ReviewArgs;
  isReadOnly = true;
  isDestructive = false;

  /** Injectable capturer — the real one drives the browser; tests supply a fake. */
  captureFn: typeof captureArtifact = captureArtifact;
  /** Injectable deps factory (browser/server) — overridden in tests. */
  captureDeps: (ctx: ToolContext) => CaptureDeps = realCaptureDeps;
  /** Injectable vision call — default reuses vision_analyze (all backend selection + the
   *  graceful "[VISION_NOT_CONFIGURED]" handling live there). Tests supply a fake so the
   *  orchestration is exercised without a real vision backend. */
  visionFn: (opts: { imagePath: string; prompt: string; ctx: ToolContext }) => Promise<ToolResult> =
    ({ imagePath, prompt, ctx }) => new VisionAnalyzeTool().execute({ image_path: imagePath, prompt } as any, ctx);

  async execute(args: z.infer<typeof ReviewArgs>, ctx: ToolContext): Promise<ToolResult> {
    // Resolve the artifact (also validates the id + version and gives us type/title/content).
    let manifest, version, content, absFile;
    try {
      ({ manifest, version, content, absFile } = await getArtifact(ctx.cwd, resolveArtifactId(args), args.version));
    } catch (e: any) {
      return { content: e?.message ?? String(e), isError: true };
    }

    // Decide how we get a screenshot: use the one the caller handed us, or capture our own.
    let screenshotPath = args.screenshot_path;
    let consoleErrors = args.console_errors ?? [];
    let pageErrors = args.page_errors ?? [];
    let captureNote = '';
    if (!screenshotPath) {
      ctx.emit({ type: 'progress', message: `Rendering "${manifest.id}" v${version} to review it…` });
      const cap = await this.captureFn(
        { id: manifest.id, type: manifest.type, content, versionDir: path.dirname(absFile) },
        this.captureDeps(ctx),
      );
      screenshotPath = cap.screenshotPath;
      // Merge caller-supplied errors with what the page actually reported.
      consoleErrors = [...consoleErrors, ...cap.consoleErrors];
      pageErrors = [...pageErrors, ...cap.pageErrors];
      captureNote = cap.note;
    }

    // Ask a vision model to critique the screenshot. We reuse the vision_analyze tool so all
    // the backend-selection + graceful "[VISION_NOT_CONFIGURED]" handling lives in one place.
    const prompt = buildReviewPrompt({ type: manifest.type, title: manifest.title, intent: args.intent });
    let visionAnswer = '';
    let sawScreenshot = false;
    if (screenshotPath) {
      try {
        const res = await this.visionFn({ imagePath: screenshotPath, prompt, ctx });
        const text = typeof res.content === 'string' ? res.content : '';
        if (res.isError || text.startsWith('[VISION_NOT_CONFIGURED]')) {
          // Vision unavailable — we can still report runtime errors, just not a visual verdict.
          visionAnswer = '';
          sawScreenshot = false;
        } else {
          // vision_analyze prefixes every answer with `[via <backend>, <n>KB]\n\n`. That pushes the
          // verdict token (LOOKS_GOOD/…) off the first line, so classifyVisionAnswer — which keys off
          // the LEADING token — would misread a clean render as `unverified` and the loop would never
          // confirm success. Strip the banner so the model's actual verdict is what gets classified.
          visionAnswer = text.replace(/^\[via [^\]]*\]\s*/, '');
          sawScreenshot = true;
        }
      } catch {
        visionAnswer = '';
        sawScreenshot = false;
      }
    }

    const report = buildReviewReport({ visionAnswer, consoleErrors, pageErrors, sawScreenshot });

    const out = formatReviewReport(manifest.id, version, report);
    const notes: string[] = [];
    if (captureNote) notes.push(captureNote);
    if (!sawScreenshot && consoleErrors.length === 0 && pageErrors.length === 0 && screenshotPath) {
      notes.push(
        'No vision backend configured — captured the render but could not get a visual verdict. ' +
        'Set QODEX_OLLAMA_VISION_MODEL / ANTHROPIC_API_KEY / OPENAI_API_KEY for one.',
      );
    }
    const extra = notes.length ? '\n' + notes.map(n => `(${n})`).join('\n') : '';

    return {
      content: out + extra,
      // `issues` + `screenshotPath` are echoed so a front-end (the bot card) can render the verdict,
      // the concrete problems, and the rendered screenshot from this single tool result.
      metadata: { artifactId: manifest.id, version, verdict: report.verdict, issues: report.issues, issueCount: report.issues.length, sawScreenshot, screenshotPath, title: manifest.title, type: manifest.type },
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
