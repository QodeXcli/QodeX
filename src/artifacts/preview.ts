/**
 * Artifact preview builder — Layer 2 of the Living Artifact system.
 *
 * Turns an artifact's source into a single, self-contained HTML page that a real browser
 * can render. This is the bridge between "an artifact exists on disk" (Layer 1) and "the
 * model can SEE what it rendered" (Layer 3): once an artifact is previewable in Chromium,
 * we can screenshot it and feed that back to vision.
 *
 * The clever bit: `react` and `vue` artifacts render with NO local bundler. We wrap the
 * source in an in-browser harness that pulls React/Vue + an in-browser transpiler from a
 * CDN, so a JSX component renders the moment the page loads. That means a freshly-created
 * React artifact is previewable without `npm install`, a vite config, or a build step.
 *
 * This module is PURE (string in, string out) so it unit-tests without a browser. The tool
 * that serves the page + drives the browser lives in the tools layer.
 *
 * Honest caveats:
 *  - The react/vue harnesses need network access IN THE BROWSER (CDN). For fully-offline
 *    rendering you'd vendor the libs; that's a later refinement.
 *  - The react harness handles the common shape (a top-level `App` component, ES imports of
 *    react stripped). Exotic multi-file React won't render from a single artifact file.
 */
import type { ArtifactType } from './store.js';

const CDN = {
  react: 'https://unpkg.com/react@18/umd/react.production.min.js',
  reactDom: 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  babel: 'https://unpkg.com/@babel/standalone/babel.min.js',
  vue: 'https://unpkg.com/vue@3/dist/vue.global.prod.js',
  vueSfc: 'https://unpkg.com/vue3-sfc-loader/dist/vue3-sfc-loader.js',
  marked: 'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
};

const BASE_STYLE =
  'body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}' +
  '#__art_root{min-height:100vh;}' +
  '.__art_center{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;box-sizing:border-box;}' +
  'pre.__art_text{margin:0;padding:24px;white-space:pre-wrap;word-break:break-word;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;}';

function htmlShell(body: string, head = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QodeX Artifact Preview</title>
<style>${BASE_STYLE}</style>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** Strip ES module noise so source can run inside an in-browser <script> harness. */
export function stripModuleSyntax(src: string): string {
  return src
    // drop `import ... from '...';` and bare `import '...';`
    .replace(/^\s*import\s+[^;]*?;\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '')
    // `export default function App` -> `function App`; `export default class` -> `class`
    .replace(/^\s*export\s+default\s+/gm, '')
    // drop remaining `export ` keywords on declarations
    .replace(/^\s*export\s+(?=(const|let|var|function|class)\b)/gm, '');
}

/** Best-effort: find the root React component name to mount (defaults to "App"). */
export function detectReactComponent(src: string): string {
  const m =
    src.match(/function\s+([A-Z][A-Za-z0-9_]*)\s*\(/) ||
    src.match(/(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*\(/) ||
    src.match(/class\s+([A-Z][A-Za-z0-9_]*)\s+extends/);
  return m ? m[1] : 'App';
}

function reactHarness(src: string): string {
  const code = stripModuleSyntax(src);
  const comp = detectReactComponent(code);
  const head =
    `<script crossorigin src="${CDN.react}"></script>` +
    `<script crossorigin src="${CDN.reactDom}"></script>` +
    `<script src="${CDN.babel}"></script>`;
  // The component source + a bootstrap, both transpiled by Babel-in-the-browser.
  const body =
    `<div id="__art_root"></div>` +
    `<script type="text/babel" data-presets="react">\n` +
    `const { useState, useEffect, useRef, useMemo, useCallback, useReducer } = React;\n` +
    `${code}\n` +
    `try {\n` +
    `  ReactDOM.createRoot(document.getElementById('__art_root')).render(React.createElement(${comp}));\n` +
    `} catch (e) {\n` +
    `  document.getElementById('__art_root').innerHTML = '<pre class=\\'__art_text\\'>Render error: ' + (e && e.message) + '</pre>';\n` +
    `}\n` +
    `</script>`;
  return htmlShell(body, head);
}

function vueHarness(src: string): string {
  // Use vue3-sfc-loader to render a .vue single-file component straight from source text.
  const head = `<script src="${CDN.vue}"></script><script src="${CDN.vueSfc}"></script>`;
  const body =
    `<div id="__art_root"></div>` +
    `<script>\n` +
    `const sfcSource = ${JSON.stringify(src)};\n` +
    `const options = {\n` +
    `  moduleCache: { vue: Vue },\n` +
    `  getFile: () => sfcSource,\n` +
    `  addStyle: (t) => { const s = document.createElement('style'); s.textContent = t; document.head.appendChild(s); },\n` +
    `};\n` +
    `const { loadModule } = window['vue3-sfc-loader'];\n` +
    `Vue.createApp(Vue.defineAsyncComponent(() => loadModule('artifact.vue', options))).mount('#__art_root');\n` +
    `</script>`;
  return htmlShell(body, head);
}

function markdownHarness(src: string): string {
  const head = `<script src="${CDN.marked}"></script>`;
  const body =
    `<div id="__art_root" style="max-width:760px;margin:0 auto;padding:40px 24px;"></div>` +
    `<script>\n` +
    `document.getElementById('__art_root').innerHTML = window.marked ? marked.parse(${JSON.stringify(src)}) : ${JSON.stringify(escapeHtml(src))};\n` +
    `</script>`;
  return htmlShell(body, head);
}

/**
 * Build a self-contained preview page for an artifact.
 * - html: returned as-is (already a full document, or a fragment the browser will render).
 * - svg: centered on a page.
 * - react: in-browser JSX harness (React + Babel from CDN).
 * - vue: in-browser SFC harness (Vue + vue3-sfc-loader from CDN).
 * - markdown: rendered with marked.js.
 * - text: shown in a <pre>.
 */
export function buildPreviewHtml(type: ArtifactType, content: string): string {
  switch (type) {
    case 'html':
      return content;
    case 'svg':
      return htmlShell(`<div class="__art_center">${content}</div>`);
    case 'react':
      return reactHarness(content);
    case 'vue':
      return vueHarness(content);
    case 'markdown':
      return markdownHarness(content);
    case 'text':
    default:
      return htmlShell(`<pre class="__art_text">${escapeHtml(content)}</pre>`);
  }
}

/** The filename the preview is written as, inside the artifact's version folder. */
export const PREVIEW_FILE = '__preview__.html';

/** A stable static-server process name for an artifact. */
export function previewServerName(id: string): string {
  return `artifact-preview:${id}`;
}

/** Derive a deterministic-ish port in the 4500–4999 range from the artifact id. */
export function previewPort(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 4500 + (h % 500);
}
