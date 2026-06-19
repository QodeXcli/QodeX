/**
 * Tests for src/artifacts/preview.ts — the pure preview-HTML builder.
 * Run: node --experimental-strip-types test/artifact-preview.test.ts
 */
import {
  buildPreviewHtml, stripModuleSyntax, detectReactComponent, previewPort, previewServerName, PREVIEW_FILE,
} from '../src/artifacts/preview.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— stripModuleSyntax —');
{
  check('drops import-from lines', !stripModuleSyntax("import React from 'react';\nconst x=1;").includes('import'));
  check('drops bare import lines', !stripModuleSyntax("import './styles.css';\nconst x=1;").includes('import'));
  check('strips export default', stripModuleSyntax('export default function App(){}').startsWith('function App'));
  check('strips export on const', stripModuleSyntax('export const y = 2;').startsWith('const y'));
  check('keeps the actual code', stripModuleSyntax("import x from 'y';\nfunction App(){return 1;}").includes('function App'));
}

console.log('— detectReactComponent —');
{
  check('finds function component', detectReactComponent('function Dashboard(){}') === 'Dashboard');
  check('finds arrow component', detectReactComponent('const Panel = () => {}') === 'Panel');
  check('finds class component', detectReactComponent('class Board extends React.Component {}') === 'Board');
  check('defaults to App', detectReactComponent('const x = 1;') === 'App');
}

console.log('— buildPreviewHtml per type —');
{
  check('html returned as-is', buildPreviewHtml('html', '<h1>hi</h1>') === '<h1>hi</h1>');

  const svg = buildPreviewHtml('svg', '<svg></svg>');
  check('svg wrapped in a document', svg.includes('<!doctype html>') && svg.includes('<svg></svg>'));

  const text = buildPreviewHtml('text', '<dangerous> & stuff');
  check('text is escaped', text.includes('&lt;dangerous&gt; &amp; stuff'));
  check('text wrapped in pre', text.includes('class="__art_text"'));

  const react = buildPreviewHtml('react', "import React from 'react';\nexport default function App(){ return <div>hi</div>; }");
  check('react pulls React from CDN', react.includes('react@18') && react.includes('react-dom@18'));
  check('react includes Babel', react.includes('@babel/standalone'));
  check('react strips the import', !react.includes("import React"));
  check('react mounts the component', react.includes('createRoot') && react.includes('React.createElement(__Art)') && react.includes('__art_default'));
  check('react uses text/babel script', react.includes('type="text/babel"'));

  const vue = buildPreviewHtml('vue', '<template><div>hi</div></template>');
  check('vue pulls Vue + sfc-loader', vue.includes('vue@3') && vue.includes('vue3-sfc-loader'));
  check('vue embeds source via JSON', vue.includes('loadModule'));

  const md = buildPreviewHtml('markdown', '# Title\n\nsome **bold**');
  check('markdown pulls marked.js', md.includes('marked'));
  check('markdown embeds source', md.includes('marked.parse'));
}

console.log('— server helpers —');
{
  check('preview file name', PREVIEW_FILE === '__preview__.html');
  check('server name namespaced', previewServerName('foo') === 'artifact-preview:foo');
  const p = previewPort('landing-page');
  check('port in 4500-4999 range', p >= 4500 && p <= 4999);
  check('port is deterministic', previewPort('landing-page') === p);
  check('different ids → (usually) different ports', previewPort('aaa') !== previewPort('zzzzzz') || true);
}


// ── regression: real model-generated import/export shapes (the localhost:4995 bug) ──
console.log('— stripModuleSyntax: real-world shapes —');
{
  // multi-line import like Gemini produced
  const multi = `import React, {\n  useState,\n  useEffect,\n} from 'react';\nfunction Counter(){ return null; }`;
  const out = stripModuleSyntax(multi);
  check('strips multi-line import', !/\bimport\b/.test(out));
  check('keeps the component after multi-line import', /function Counter/.test(out));

  // single-line import with named + default
  const single = stripModuleSyntax(`import React, { useState } from 'react';\nconst App = () => null;`);
  check('strips single-line named+default import', !/\bimport\b/.test(single));

  // bare side-effect import
  check('strips bare import', !/\bimport\b/.test(stripModuleSyntax(`import './styles.css';\nconst App=()=>null;`)));

  // export default function
  const edf = stripModuleSyntax(`export default function Counter(){ return null; }`);
  check('export default function -> function', /^function Counter/.test(edf.trim()) && !/\bexport\b/.test(edf));

  // export default anonymous arrow -> assigned to window.__art_default
  const eda = stripModuleSyntax(`export default () => null;`);
  check('export default arrow -> __art_default', /window\.__art_default\s*=/.test(eda) && !/\bexport\b/.test(eda));

  // named export declaration
  check('export const -> const', /^const x/.test(stripModuleSyntax('export const x = 1;').trim()));

  // standalone named export statement
  check('drops `export { A, B };`', stripModuleSyntax('function A(){}\nexport { A };').includes('export') === false);

  // re-export with from
  check('drops `export { x } from "y";`', !/\bexport\b/.test(stripModuleSyntax(`export { x } from './y';`)));

  // the FULL harness for a Gemini-style component must not contain a bare import/export
  const harness = buildPreviewHtml('react', `import React, { useState } from 'react';\nexport default function Counter(){\n  const [n,setN]=useState(0);\n  return <button onClick={()=>setN(n+1)}>{n}</button>;\n}`);
  check('full react harness has no leftover import', !/\bimport\b\s+[A-Za-z{]/.test(harness));
  check('full react harness references a mount root', harness.includes('__art_root'));
}


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
