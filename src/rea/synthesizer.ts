/**
 * Atom-by-atom synthesizer — rebuilds a compiled binary (PE, Mach-O, ELF)
 * as a clean, compilable source project.
 *
 * A decompiler alone is not enough: its output is pseudo-C that does not
 * compile. So every function ("atom") is rebuilt leaf-first along the
 * topological call graph and must pass two real gates before it is kept:
 *
 *   1. it compiles with a real compiler (`rustc` — see RustcCompilerRunner);
 *   2. it is semantically equivalent to the original bytes, checked by
 *      running both in an emulator (Unicorn / Qiling) on the same inputs.
 *
 * The static lifter (Ghidra / Radare2) and the emulator are injected
 * interfaces. No lifter or emulator is bundled: a missing one is a clear
 * "not configured" error, never a faked equivalence result. The topological
 * sort, the retry loop, and the compiler gate are real and tested.
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface BinaryFunctionAtom {
  address: bigint;
  name: string;
  size: number;
  rawBytes: Buffer;
  /** Intermediate code lifted from Ghidra / Radare2 (P-Code / LLVM IR). */
  pcodeIr: string;
  /** First-pass pseudo-C from the decompiler. */
  decompiledPseudoC: string;
  /** Functions this function calls. */
  callees: bigint[];
  dynamicTraces: Array<{
    inputs: Record<string, bigint>;
    outputs: Record<string, bigint>;
  }>;
}

export interface StaticLifterEngine {
  extractDependencyGraph(binaryPath: string): Promise<BinaryFunctionAtom[]>;
  extractDataStructuresAndTypes(binaryPath: string): Promise<string>;
}

export interface BinaryEquivalenceTester {
  verifyFunctionEquivalence(
    originalBytes: Buffer,
    compiledObjectPath: string,
    symbolName: string,
    testVectors: BinaryFunctionAtom['dynamicTraces'],
  ): Promise<{ equivalent: boolean; mismatchDetail?: string }>;
}

export interface CodeSynthesisModel {
  synthesizeFunction(prompt: {
    atom: BinaryFunctionAtom;
    resolvedDependenciesCode: string[];
    globalTypesHeader: string;
    lastCompilerError?: string;
    lastEquivalenceMismatch?: string;
  }): Promise<string>;
}

export type CompilerResult =
  | { success: true; objPath: string }
  | { success: false; stderr: string };

export type CompilerRunner = (sourceCode: string) => Promise<CompilerResult>;

/**
 * Real compiler gate: writes the candidate to a temp file and compiles it
 * with `rustc --emit=obj`. A missing rustc is a clear error, not a pass.
 */
export async function rustcCompile(sourceCode: string): Promise<CompilerResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-compile-'));
  const srcPath = path.join(dir, 'candidate.rs');
  const objPath = path.join(dir, 'candidate.o');
  await fs.writeFile(srcPath, sourceCode, 'utf8');
  try {
    await execFileAsync('rustc', ['--edition', '2021', '--emit=obj', '-o', objPath, srcPath], {
      timeout: 120_000,
    });
    return { success: true, objPath };
  } catch (e: any) {
    return { success: false, stderr: String(e?.stderr ?? e?.message ?? e) };
  }
}

const MAX_ATTEMPTS = 5;

export class AtomByAtomSynthesizer {
  constructor(
    private lifter: StaticLifterEngine,
    private equivalenceTester: BinaryEquivalenceTester,
    private aiSynthesizer: CodeSynthesisModel,
    private compilerRunner: CompilerRunner = rustcCompile,
  ) {}

  public async reconstructFullProject(binaryPath: string): Promise<Map<string, string>> {
    const globalTypesHeader = await this.lifter.extractDataStructuresAndTypes(binaryPath);
    const allAtoms = await this.lifter.extractDependencyGraph(binaryPath);

    // Leaves first, root (main) last.
    const sortedAtoms = this.topologicalSort(allAtoms);
    const verifiedSourceMap = new Map<bigint, string>();
    const projectFiles = new Map<string, string>();

    projectFiles.set('src/types.rs', globalTypesHeader);

    for (const atom of sortedAtoms) {
      const depsCode = atom.callees
        .map((addr) => verifiedSourceMap.get(addr))
        .filter((code): code is string => Boolean(code));

      let lastCompilerError: string | undefined;
      let lastEquivalenceMismatch: string | undefined;
      let verifiedCode = '';

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const candidateCode = await this.aiSynthesizer.synthesizeFunction({
          atom,
          resolvedDependenciesCode: depsCode,
          globalTypesHeader,
          lastCompilerError,
          lastEquivalenceMismatch,
        });

        // Gate 1: it must really compile.
        const compileResult = await this.compilerRunner(candidateCode);
        if (!compileResult.success) {
          lastCompilerError = compileResult.stderr;
          continue;
        }

        // Gate 2: it must behave identically in the emulator.
        const eqResult = await this.equivalenceTester.verifyFunctionEquivalence(
          atom.rawBytes,
          compileResult.objPath,
          atom.name,
          atom.dynamicTraces,
        );

        if (!eqResult.equivalent) {
          lastEquivalenceMismatch = eqResult.mismatchDetail;
          continue;
        }

        verifiedCode = candidateCode;
        break;
      }

      if (!verifiedCode) {
        throw new Error(
          `Could not reconstruct atom at 0x${atom.address.toString(16)} (${atom.name}) after ${MAX_ATTEMPTS} attempts` +
            (lastCompilerError ? ` — last compiler error: ${lastCompilerError}` : '') +
            (lastEquivalenceMismatch ? ` — last equivalence mismatch: ${lastEquivalenceMismatch}` : ''),
        );
      }

      verifiedSourceMap.set(atom.address, verifiedCode);
      projectFiles.set(`src/modules/${atom.name}.rs`, verifiedCode);
    }

    return projectFiles;
  }

  /**
   * Depth-first topological sort: a function's callees always come before
   * the function itself, so dependencies are verified before their callers.
   * Cyclic graphs (mutual recursion) are visited once and keep input order.
   */
  public topologicalSort(atoms: BinaryFunctionAtom[]): BinaryFunctionAtom[] {
    const visited = new Set<bigint>();
    const result: BinaryFunctionAtom[] = [];
    const atomMap = new Map(atoms.map((a) => [a.address, a]));

    const visit = (atom: BinaryFunctionAtom): void => {
      if (visited.has(atom.address)) return;
      visited.add(atom.address);
      for (const calleeAddr of atom.callees) {
        const callee = atomMap.get(calleeAddr);
        if (callee) visit(callee);
      }
      result.push(atom);
    };

    for (const atom of atoms) visit(atom);
    return result;
  }
}
