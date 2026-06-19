import * as path from 'path';
import * as url from 'url';
import { access } from 'fs/promises';
import { logger } from '../../utils/logger.js';

let TreeSitter: any = null;        // Parser constructor (old: default export; new: named `Parser`)
let TSLanguage: any = null;        // Language namespace with .load() (new: named `Language`; old: TreeSitter.Language)
const parsersByLang = new Map<string, any>();
const languagesByLang = new Map<string, any>();

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.php': 'php',
  '.rb': 'ruby',
};

export function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

async function initTreeSitter(): Promise<void> {
  if (TreeSitter) return;
  try {
    const mod: any = await import('web-tree-sitter');
    // web-tree-sitter changed its public shape at v0.25:
    //   - old (<=0.24): default export is the Parser class; Parser.init();
    //     grammars load via Parser.Language.load(path).
    //   - new (>=0.25): named exports `Parser` and `Language`; Parser.init();
    //     grammars load via Language.load(path).
    // Support BOTH so a runtime bump to read ABI-15 grammars doesn't break us.
    const ParserCtor = mod.Parser ?? mod.default ?? mod;
    TreeSitter = ParserCtor;
    TSLanguage = mod.Language ?? ParserCtor?.Language ?? null;
    if (typeof ParserCtor.init === 'function') {
      await ParserCtor.init();
    }
  } catch (e: any) {
    throw new Error(`Failed to initialize Tree-sitter: ${e.message}. AST tools will be unavailable.`);
  }
}

export async function getParser(language: string): Promise<{ parser: any; language: any } | null> {
  try {
    await initTreeSitter();
  } catch (e: any) {
    logger.warn('Tree-sitter unavailable', { err: e.message });
    return null;
  }

  if (parsersByLang.has(language) && languagesByLang.has(language)) {
    return { parser: parsersByLang.get(language)!, language: languagesByLang.get(language)! };
  }

  // Try to load WASM grammar
  // First look in installed package dir, then in user qodex home
  const grammarFile = `tree-sitter-${language}.wasm`;
  const candidates: string[] = [];

  try {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    candidates.push(path.join(here, '..', '..', '..', 'grammars', grammarFile));
    candidates.push(path.join(here, '..', '..', '..', '..', 'grammars', grammarFile));
    candidates.push(path.join(process.cwd(), 'grammars', grammarFile));
  } catch {}

  let lang: any = null;
  for (const candidate of candidates) {
    // CRITICAL: only hand Language.load a path that exists. web-tree-sitter's
    // Emscripten loader, given a missing path, kicks off an async file read whose
    // ENOENT rejection floats OUTSIDE the promise we await here — so a try/catch
    // around load() does NOT catch it, and Node 24 crashes the whole process on
    // the unhandled rejection. Pre-checking existence means load() is only ever
    // called on a real file, so a missing grammar degrades to the regex fallback
    // instead of taking down the CLI.
    try {
      await access(candidate);
    } catch {
      continue; // not present — try the next candidate
    }
    try {
      lang = await TSLanguage.load(candidate);
      logger.debug(`Loaded grammar: ${candidate}`);
      break;
    } catch (e: any) {
      logger.warn(`Grammar present but failed to load: ${candidate}`, { err: e?.message });
    }
  }

  if (!lang) {
    logger.warn(`No grammar found for language: ${language}. Looked in: ${candidates.join(', ')}`);
    return null;
  }

  const parser = new TreeSitter();
  parser.setLanguage(lang);
  parsersByLang.set(language, parser);
  languagesByLang.set(language, lang);

  return { parser, language: lang };
}

/**
 * Diagnostic: attempt to load a grammar and RETURN the outcome — including the
 * actual failure reason — instead of swallowing it like getParser does. Used by
 * `qodex doctor` so a present-but-unloadable grammar (e.g. an ABI mismatch with
 * the installed web-tree-sitter) surfaces its real error rather than silently
 * degrading to the regex fallback.
 */
export async function diagnoseGrammar(
  language: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    await initTreeSitter();
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'tree-sitter init failed' };
  }
  const grammarFile = `tree-sitter-${language}.wasm`;
  const candidates: string[] = [];
  try {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    candidates.push(path.join(here, '..', '..', '..', 'grammars', grammarFile));
    candidates.push(path.join(here, '..', '..', '..', '..', 'grammars', grammarFile));
    candidates.push(path.join(process.cwd(), 'grammars', grammarFile));
  } catch {}

  let lastError: string | undefined;
  let foundButUnloadable = false;
  for (const candidate of candidates) {
    try {
      await access(candidate);
    } catch {
      continue; // file not present at this candidate
    }
    foundButUnloadable = true;
    try {
      await TSLanguage.load(candidate);
      return { ok: true, path: candidate };
    } catch (e: any) {
      lastError = e?.message ?? String(e);
    }
  }
  return {
    ok: false,
    error: foundButUnloadable
      ? (lastError ?? 'grammar present but load failed')
      : 'no grammar file found in any candidate path',
  };
}

export interface FoundSymbol {
  name: string;
  kind: string;
  startIndex: number;
  endIndex: number;
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export interface SyntaxError {
  line: number;
  column: number;
  text: string;
  missing: boolean;
}

export function findSyntaxErrors(rootNode: any, source: string): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const visit = (n: any) => {
    if (n.isError || n.isMissing) {
      errors.push({
        line: n.startPosition.row + 1,
        column: n.startPosition.column,
        text: n.text?.slice(0, 60) ?? '',
        missing: n.isMissing,
      });
    }
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) visit(child);
    }
  };
  visit(rootNode);
  return errors;
}
