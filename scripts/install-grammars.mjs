#!/usr/bin/env node
/**
 * Download Tree-sitter WASM grammars into the grammars/ directory.
 * Run this manually after `npm install` if you want edit_symbol to work.
 *
 * Usage:
 *   node scripts/install-grammars.mjs           # all default languages
 *   node scripts/install-grammars.mjs typescript python
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as url from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const GRAMMARS_DIR = path.join(__dirname, '..', 'grammars');

const PACKAGES = {
  typescript: { pkg: 'tree-sitter-typescript', wasmIn: 'tree-sitter-typescript.wasm' },
  tsx: { pkg: 'tree-sitter-typescript', wasmIn: 'tree-sitter-tsx.wasm' },
  javascript: { pkg: 'tree-sitter-javascript', wasmIn: 'tree-sitter-javascript.wasm' },
  python: { pkg: 'tree-sitter-python', wasmIn: 'tree-sitter-python.wasm' },
  rust: { pkg: 'tree-sitter-rust', wasmIn: 'tree-sitter-rust.wasm' },
  go: { pkg: 'tree-sitter-go', wasmIn: 'tree-sitter-go.wasm' },
  php: { pkg: 'tree-sitter-php', wasmIn: 'tree-sitter-php.wasm' },
};

async function main() {
  const requested = process.argv.slice(2);
  const targets = requested.length > 0 ? requested : Object.keys(PACKAGES);

  await fs.mkdir(GRAMMARS_DIR, { recursive: true });

  console.log(`Installing Tree-sitter grammars for: ${targets.join(', ')}`);
  console.log(`(This requires 'tree-sitter-cli' to be globally available or installed locally.)`);
  console.log('');
  console.log('If this fails, you can manually download pre-built WASM files from:');
  console.log('  https://github.com/tree-sitter/<lang>/releases');
  console.log('  https://github.com/emscripten-core/tree-sitter');
  console.log('');
  console.log('Or skip this step — QodeX still works without edit_symbol (falls back to edit_text).');
  console.log('');

  for (const lang of targets) {
    const spec = PACKAGES[lang];
    if (!spec) {
      console.warn(`Unknown language: ${lang}, skipping.`);
      continue;
    }
    const outPath = path.join(GRAMMARS_DIR, `tree-sitter-${lang}.wasm`);
    try {
      await fs.access(outPath);
      console.log(`✓ ${lang} already installed`);
      continue;
    } catch {}

    try {
      console.log(`→ Installing ${lang}...`);
      execSync(`npm install --no-save ${spec.pkg}`, { stdio: 'inherit' });
      const candidates = [
        path.join('node_modules', spec.pkg, spec.wasmIn),
        path.join('node_modules', spec.pkg, 'src', spec.wasmIn),
      ];
      let found = null;
      for (const c of candidates) {
        try {
          await fs.access(c);
          found = c;
          break;
        } catch {}
      }
      if (!found) {
        console.warn(`✗ Could not find ${spec.wasmIn} in ${spec.pkg}. You may need to build it with tree-sitter-cli.`);
        continue;
      }
      await fs.copyFile(found, outPath);
      console.log(`✓ ${lang} → ${outPath}`);
    } catch (e) {
      console.warn(`✗ Failed to install ${lang}: ${e.message}`);
    }
  }

  console.log('\nDone. Restart QodeX to use AST-aware editing.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
