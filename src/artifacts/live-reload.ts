/**
 * Live-reload client injection — the browser half of the Living Artifact "live" mode.
 *
 * The live server (src/artifacts/live-server.ts) serves the artifact's CURRENT version
 * rebuilt on the fly, and keeps an SSE channel open. We inject a tiny client snippet into
 * every served page: it opens an `EventSource` on the channel and calls `location.reload()`
 * when the server pushes a `reload` event. `EventSource` reconnects on its own, so the tab
 * survives a server restart.
 *
 * This module is PURE (string in, string out) so it unit-tests without a browser, exactly
 * like preview.ts.
 */

/** Path the live server exposes the SSE channel on. */
export const LIVE_CHANNEL_PATH = '/__live__';

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/**
 * The injected client `<script>`. Opens an SSE connection and reloads on a `reload` event.
 * Wrapped in try/catch so a context without EventSource degrades to a plain static page
 * instead of throwing.
 */
export function liveReloadClientScript(channelPath: string = LIVE_CHANNEL_PATH): string {
  const ch = JSON.stringify(channelPath);
  return (
    `<script>(function(){try{` +
    `var es=new EventSource(${ch});` +
    `es.addEventListener('reload',function(){location.reload();});` +
    `es.onerror=function(){/* EventSource auto-reconnects via the server's retry hint */};` +
    `}catch(e){/* no EventSource → static page, no live reload */}})();</script>`
  );
}

/**
 * Inject the live-reload client into a built preview page. Insert just before `</body>`
 * when present (so it runs after the artifact mounts); otherwise append (some `html`
 * artifacts are fragments without a body tag).
 */
export function injectLiveReload(html: string, channelPath: string = LIVE_CHANNEL_PATH): string {
  const snippet = liveReloadClientScript(channelPath);
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + snippet;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

/**
 * A full HTML page shown when the current version can't be rendered (artifact deleted,
 * corrupt manifest, read error). It carries the SAME live-reload client, so the page
 * recovers automatically the moment a valid version lands again.
 */
export function renderErrorOverlay(message: string, channelPath: string = LIVE_CHANNEL_PATH): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QodeX Live Artifact — unavailable</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#1e1e1e;color:#e6e6e6;}
.wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;}
.card{max-width:640px;width:100%;background:#2a2a2a;border:1px solid #4a3636;border-radius:10px;padding:24px 28px;}
h1{margin:0 0 8px;font-size:16px;color:#ff8a8a;}
p{margin:0 0 4px;color:#bdbdbd;font-size:13px;}
pre{margin:12px 0 0;padding:12px;background:#111;border-radius:6px;white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e6e6e6;}
.hint{margin-top:14px;font-size:12px;color:#8a8a8a;}
</style>
</head>
<body>
<div class="wrap"><div class="card">
<h1>Artifact preview unavailable</h1>
<p>The live server couldn't render the current version.</p>
<pre>${escapeHtml(message)}</pre>
<p class="hint">This page reloads automatically as soon as the artifact is valid again.</p>
</div></div>
${liveReloadClientScript(channelPath)}
</body>
</html>`;
}
