import { describe, it, expect } from 'vitest';
import { TodoWriteTool } from '../src/tools/builtin/todo.js';
import { BudgetTracker } from '../src/agent/budget.js';
import { outsideCwdHint } from '../src/utils/path-hint.js';

describe('todo_write argument tolerance (coerceArgs)', () => {
  const tool = new TodoWriteTool();

  it('parses todos passed as a JSON string and validates', () => {
    const raw = { todos: JSON.stringify([{ id: '1', content: 'do x', status: 'pending' }]) };
    const coerced = tool.coerceArgs(raw) as any;
    expect(Array.isArray(coerced.todos)).toBe(true);
    // and the strict schema now accepts it
    expect(() => tool.argsSchema.parse(coerced)).not.toThrow();
  });

  it('stringifies numeric ids', () => {
    const raw = { todos: [{ id: 2, content: 'y', status: 'in_progress' }] };
    const coerced = tool.coerceArgs(raw) as any;
    expect(coerced.todos[0].id).toBe('2');
    expect(() => tool.argsSchema.parse(coerced)).not.toThrow();
  });

  it('leaves a proper array untouched', () => {
    const raw = { todos: [{ id: '1', content: 'z', status: 'completed' }] };
    expect(tool.coerceArgs(raw)).toEqual(raw);
  });
});

describe('outsideCwdHint', () => {
  const cwd = '/Users/me/project';
  it('nudges when an absolute path is outside cwd', () => {
    expect(outsideCwdHint('/home/user/code/App.tsx', '/home/user/code/App.tsx', cwd)).toMatch(/working directory/);
  });
  it('stays silent for paths inside cwd', () => {
    expect(outsideCwdHint('/Users/me/project/src/a.ts', '/Users/me/project/src/a.ts', cwd)).toBe('');
  });
  it('stays silent for relative paths', () => {
    expect(outsideCwdHint('src/a.ts', '/Users/me/project/src/a.ts', cwd)).toBe('');
  });
});

describe('BudgetTracker iteration warning', () => {
  it('warns exactly once at ~80% of the cap', () => {
    const b = new BudgetTracker(0, 0, 0, 10); // only iteration cap = 10 → warn at 8
    let warned = 0;
    for (let i = 0; i < 9; i++) {
      b.incrementIteration();
      if (b.shouldWarnIterations()) warned++;
    }
    expect(warned).toBe(1);
    expect(b.getMaxIterations()).toBe(10);
  });

  it('never warns when there is no iteration cap (0)', () => {
    const b = new BudgetTracker(0, 0, 0, 0);
    for (let i = 0; i < 100; i++) { b.incrementIteration(); }
    expect(b.shouldWarnIterations()).toBe(false);
  });
});
