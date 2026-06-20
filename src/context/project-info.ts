import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';

export interface ProjectInfo {
  framework?: string;
  languages: string[];
  packageManager?: string;
  testRunner?: string;
  linter?: string;
  typeChecker?: string;
  hasGit: boolean;
}

const LANGUAGE_FILES: Record<string, string[]> = {
  TypeScript: ['tsconfig.json'],
  JavaScript: ['package.json'],
  Python: ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'],
  Rust: ['Cargo.toml'],
  Go: ['go.mod'],
  Java: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  Ruby: ['Gemfile'],
  PHP: ['composer.json'],
  Elixir: ['mix.exs'],
  Swift: ['Package.swift'],
};

const FRAMEWORK_DETECTION: Array<[string, (deps: Record<string, string>) => boolean]> = [
  ['Next.js', deps => 'next' in deps],
  ['Nuxt', deps => 'nuxt' in deps],
  ['Remix', deps => '@remix-run/react' in deps],
  ['Astro', deps => 'astro' in deps],
  ['SvelteKit', deps => '@sveltejs/kit' in deps],
  ['Vite + React', deps => 'vite' in deps && ('react' in deps || 'react-dom' in deps)],
  ['Vite', deps => 'vite' in deps],
  ['React Native', deps => 'react-native' in deps],
  ['Expo', deps => 'expo' in deps],
  ['Express', deps => 'express' in deps],
  ['Fastify', deps => 'fastify' in deps],
  ['NestJS', deps => '@nestjs/core' in deps],
  ['Hono', deps => 'hono' in deps],
  ['React', deps => 'react' in deps],
  ['Vue', deps => 'vue' in deps],
  ['Svelte', deps => 'svelte' in deps],
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function detectProjectInfo(cwd: string): Promise<ProjectInfo> {
  const info: ProjectInfo = {
    languages: [],
    hasGit: await fileExists(path.join(cwd, '.git')),
  };

  // Detect languages
  for (const [lang, files] of Object.entries(LANGUAGE_FILES)) {
    for (const f of files) {
      if (await fileExists(path.join(cwd, f))) {
        info.languages.push(lang);
        break;
      }
    }
  }

  // Node-specific deeper detection
  const pkgPath = path.join(cwd, 'package.json');
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Framework
      for (const [fw, predicate] of FRAMEWORK_DETECTION) {
        if (predicate(allDeps)) {
          info.framework = fw;
          break;
        }
      }

      // Package manager
      if (await fileExists(path.join(cwd, 'pnpm-lock.yaml'))) info.packageManager = 'pnpm';
      else if (await fileExists(path.join(cwd, 'yarn.lock'))) info.packageManager = 'yarn';
      else if (await fileExists(path.join(cwd, 'bun.lockb'))) info.packageManager = 'bun';
      else if (await fileExists(path.join(cwd, 'package-lock.json'))) info.packageManager = 'npm';
      else info.packageManager = 'npm';

      // Test runner
      if ('vitest' in allDeps) info.testRunner = 'vitest';
      else if ('jest' in allDeps) info.testRunner = 'jest';
      else if ('mocha' in allDeps) info.testRunner = 'mocha';
      else if (pkg.scripts?.test) info.testRunner = 'npm test';

      // Linter
      if ('eslint' in allDeps) info.linter = 'eslint';
      else if ('biome' in allDeps || '@biomejs/biome' in allDeps) info.linter = 'biome';

      // Type checker
      if ('typescript' in allDeps) info.typeChecker = 'tsc';
    } catch (err: any) {
      // ENOENT (package.json vanished between the exists-check and read) is
      // benign — just skip deeper detection. A parse error means the file is
      // present but malformed; log it so the degraded detection is traceable.
      if (err?.code !== 'ENOENT') {
        logger.debug(`Failed to parse ${pkgPath}: ${err?.message ?? err}`);
      }
    }
  }

  // Python-specific
  if (info.languages.includes('Python')) {
    if (await fileExists(path.join(cwd, 'pyproject.toml'))) info.packageManager = 'pip/poetry';
    else if (await fileExists(path.join(cwd, 'Pipfile'))) info.packageManager = 'pipenv';
    else info.packageManager = info.packageManager ?? 'pip';

    if (await fileExists(path.join(cwd, 'pytest.ini')) ||
        await fileExists(path.join(cwd, 'pyproject.toml'))) {
      info.testRunner = info.testRunner ?? 'pytest';
    }
    if (await fileExists(path.join(cwd, '.ruff.toml')) ||
        await fileExists(path.join(cwd, 'ruff.toml'))) {
      info.linter = 'ruff';
    }
    if (await fileExists(path.join(cwd, 'mypy.ini'))) info.typeChecker = 'mypy';
  }

  // Rust
  if (info.languages.includes('Rust')) {
    info.packageManager = 'cargo';
    info.testRunner = info.testRunner ?? 'cargo test';
    info.linter = info.linter ?? 'cargo clippy';
  }

  // Go
  if (info.languages.includes('Go')) {
    info.packageManager = 'go mod';
    info.testRunner = info.testRunner ?? 'go test';
  }

  return info;
}
