import { describe, it, expect } from 'vitest';
import {
  AtomByAtomSynthesizer,
  type BinaryFunctionAtom,
  type BinaryEquivalenceTester,
  type CodeSynthesisModel,
  type CompilerResult,
  type StaticLifterEngine,
} from '../src/rea/synthesizer.js';

function atom(address: bigint, name: string, callees: bigint[]): BinaryFunctionAtom {
  return {
    address,
    name,
    size: 16,
    rawBytes: Buffer.from([0x90, 0x90]),
    pcodeIr: '',
    decompiledPseudoC: '',
    callees,
    dynamicTraces: [],
  };
}

const A = 0x1000n;
const B = 0x2000n;
const C = 0x3000n;
const D = 0x4000n;

describe('AtomByAtomSynthesizer.topologicalSort', () => {
  it('orders callees before callers (leaves first, root last)', () => {
    const s = new AtomByAtomSynthesizer(null as any, null as any, null as any);
    const sorted = s.topologicalSort([
      atom(A, 'main', [B, C]),
      atom(B, 'helper_b', [D]),
      atom(C, 'helper_c', [D]),
      atom(D, 'leaf', []),
    ]);
    const idx = new Map(sorted.map((a, i) => [a.address, i]));
    expect(idx.get(D)!).toBeLessThan(idx.get(B)!);
    expect(idx.get(D)!).toBeLessThan(idx.get(C)!);
    expect(idx.get(B)!).toBeLessThan(idx.get(A)!);
    expect(idx.get(C)!).toBeLessThan(idx.get(A)!);
    expect(sorted[sorted.length - 1]!.address).toBe(A);
  });

  it('skips callees that are not in the graph and tolerates cycles', () => {
    const s = new AtomByAtomSynthesizer(null as any, null as any, null as any);
    const sorted = s.topologicalSort([
      atom(A, 'a', [B, 0x9999n]),
      atom(B, 'b', [A]), // mutual recursion
    ]);
    expect(sorted).toHaveLength(2);
    expect(new Set(sorted.map((a) => a.address))).toEqual(new Set([A, B]));
  });
});

describe('AtomByAtomSynthesizer.reconstructFullProject', () => {
  const atoms = [
    atom(A, 'main', [B]),
    atom(B, 'helper', []),
  ];

  function makeSynthesizer(opts: {
    compile: (code: string) => Promise<CompilerResult>;
    equivalent: boolean;
    mismatch?: string;
  }): AtomByAtomSynthesizer {
    const lifter: StaticLifterEngine = {
      extractDependencyGraph: async () => atoms,
      extractDataStructuresAndTypes: async () => 'pub struct Ctx; // types',
    };
    const tester: BinaryEquivalenceTester = {
      verifyFunctionEquivalence: async () => ({
        equivalent: opts.equivalent,
        mismatchDetail: opts.mismatch,
      }),
    };
    const model: CodeSynthesisModel = {
      synthesizeFunction: async ({ atom: a }) => `pub fn ${a.name}() {}`,
    };
    return new AtomByAtomSynthesizer(lifter, tester, model, opts.compile);
  }

  it('verifies every atom and writes one file per atom plus types', async () => {
    const s = makeSynthesizer({
      compile: async () => ({ success: true, objPath: '/tmp/fake.o' }),
      equivalent: true,
    });
    const files = await s.reconstructFullProject('/tmp/fake.bin');
    expect(files.get('src/types.rs')).toContain('pub struct Ctx');
    expect(files.get('src/modules/helper.rs')).toContain('pub fn helper');
    expect(files.get('src/modules/main.rs')).toContain('pub fn main');
  });

  it('retries on compiler failure and throws after 5 attempts', async () => {
    let calls = 0;
    const s = makeSynthesizer({
      compile: async () => {
        calls += 1;
        return { success: false, stderr: 'boom' };
      },
      equivalent: true,
    });
    await expect(s.reconstructFullProject('/tmp/fake.bin')).rejects.toThrow(/helper/);
    // Leaf atom first: 5 attempts before giving up.
    expect(calls).toBe(5);
  });

  it('retries on equivalence mismatch and throws after 5 attempts', async () => {
    const s = makeSynthesizer({
      compile: async () => ({ success: true, objPath: '/tmp/fake.o' }),
      equivalent: false,
      mismatch: 'rax differs',
    });
    await expect(s.reconstructFullProject('/tmp/fake.bin')).rejects.toThrow(/rax differs/);
  });
});
