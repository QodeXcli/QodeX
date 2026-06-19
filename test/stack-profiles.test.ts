import { describe, it, expect } from 'vitest';
import {
  detectStacksFromText, detectStacksFromProject, detectStacks,
  buildStackAddendum, STACK_PROFILES,
  type StackId,
} from '../src/llm/prompts/stack-profiles.js';

describe('detectStacksFromText — English', () => {
  it('detects each stack from natural keywords', () => {
    expect(detectStacksFromText('add a Django REST serializer with select_related')).toContain('django');
    expect(detectStacksFromText('build a WooCommerce shortcode in WordPress')).toContain('wordpress');
    expect(detectStacksFromText('use a Next.js server action and revalidatePath')).toContain('nextjs');
    expect(detectStacksFromText('set up a React SPA with Vite and TanStack Query')).toContain('react-vite');
    expect(detectStacksFromText('animate a three.js scene with useFrame and shaders')).toContain('threejs');
    expect(detectStacksFromText('write an Express API with Prisma on Node.js')).toContain('node');
  });
  it('detects multiple stacks in one fullstack request', () => {
    const s = detectStacksFromText('a Next.js page with a three.js hero animation');
    expect(s).toContain('nextjs');
    expect(s).toContain('threejs');
  });
  it('returns empty for a generic request', () => {
    expect(detectStacksFromText('rename this variable everywhere')).toEqual([]);
  });
});

describe('detectStacksFromText — Persian', () => {
  it('matches Persian stack terms (no \\b around non-ASCII)', () => {
    expect(detectStacksFromText('یک سریالایزر جنگو بنویس')).toContain('django');
    expect(detectStacksFromText('یک افزونه وردپرس بساز')).toContain('wordpress');
    expect(detectStacksFromText('یک انیمیشن سه بعدی موشن قشنگ')).toContain('threejs');
  });
});

describe('detectStacksFromProject', () => {
  it('detects from package.json deps', () => {
    expect(detectStacksFromProject({ deps: ['next', 'react'] })).toContain('nextjs');
    expect(detectStacksFromProject({ deps: ['three', '@react-three/fiber'] })).toContain('threejs');
    expect(detectStacksFromProject({ deps: ['express', 'prisma'] })).toContain('node');
    expect(detectStacksFromProject({ deps: ['vite'] })).toContain('react-vite');
  });
  it('detects from marker files', () => {
    expect(detectStacksFromProject({ files: ['manage.py'] })).toContain('django');
    expect(detectStacksFromProject({ files: ['wp-config.php'] })).toContain('wordpress');
    expect(detectStacksFromProject({ files: ['next.config.mjs'] })).toContain('nextjs');
  });
  it('is case-insensitive on deps', () => {
    expect(detectStacksFromProject({ deps: ['Next'] })).toContain('nextjs');
  });
  it('returns empty with no signals', () => {
    expect(detectStacksFromProject({})).toEqual([]);
  });
});

describe('detectStacks — combination + cap', () => {
  it('text signals come before project signals', () => {
    const s = detectStacks('work on the three.js animation', { deps: ['next'] });
    expect(s[0]).toBe('threejs');
    expect(s).toContain('nextjs');
  });
  it('dedupes when text and project agree', () => {
    const s = detectStacks('a Next.js server component', { deps: ['next'] });
    expect(s.filter(x => x === 'nextjs')).toHaveLength(1);
  });
  it('caps the number of profiles (default 2)', () => {
    const s = detectStacks('Next.js with three.js and an Express Node API', { deps: ['vite'] });
    expect(s.length).toBeLessThanOrEqual(2);
  });
  it('respects a custom cap', () => {
    const s = detectStacks('Next.js three.js Express Django WordPress', {}, 3);
    expect(s.length).toBe(3);
  });
});

describe('buildStackAddendum', () => {
  it('returns empty string for no stacks', () => {
    expect(buildStackAddendum([])).toBe('');
  });
  it('includes the profile content for each stack', () => {
    const out = buildStackAddendum(['django', 'nextjs']);
    expect(out).toContain('Django specialist');
    expect(out).toContain('Next.js specialist');
    expect(out).toContain('select_related');
    expect(out).toContain('Server Component');
  });
  it('every profile is non-trivial and headed', () => {
    for (const id of Object.keys(STACK_PROFILES) as StackId[]) {
      const p = STACK_PROFILES[id];
      expect(p.startsWith('# ')).toBe(true);
      expect(p.length).toBeGreaterThan(300);
    }
  });
});
