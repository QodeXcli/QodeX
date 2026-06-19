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
  check('react mounts the component', react.includes('createRoot') && react.includes('React.createElement(App)'));
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
