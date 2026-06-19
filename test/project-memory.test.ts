import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from '../src/session/store.js';
import { ProjectLogTool, ProjectRecallTool } from '../src/tools/project/project-tools.js';

// Project memory rides on SessionStore (cwd = project). These tests exercise the
// new projects + worklog layer against a throwaway DB so nothing touches the real
// ~/.qodex/sessions.db.

describe('SessionStore — project memory', () => {
  let dbPath: string;
  let store: SessionStore;
  const CWD = '/work/sevengum-amazon';

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `qodex-projmem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new SessionStore(dbPath);
  });
  afterEach(async () => {
    try { await fs.unlink(dbPath); } catch { /* ignore */ }
  });

  it('defines and reads back a project (upsert)', () => {
    store.defineProject(CWD, 'Seven Gum Amazon Launch', '64,800 units, 19 SKUs');
    const p = store.getProject(CWD)!;
    expect(p.name).toBe('Seven Gum Amazon Launch');
    expect(p.description).toContain('19 SKUs');
    // upsert: redefining updates the name, keeps a row (no duplicate PK error)
    store.defineProject(CWD, 'SG Amazon');
    expect(store.getProject(CWD)!.name).toBe('SG Amazon');
  });

  it('returns null for an unknown project', () => {
    expect(store.getProject('/nope')).toBeNull();
  });

  it('appends worklog entries newest-first', () => {
    store.addWorklogEntry(CWD, 's1', 'Set up SP-API credentials', 'work');
    store.addWorklogEntry(CWD, 's1', 'Decided on 20/40/40 inventory split', 'decision');
    const log = store.getWorklog(CWD);
    expect(log).toHaveLength(2);
    expect(log[0]!.entry).toBe('Decided on 20/40/40 inventory split'); // most recent first
    expect(log[0]!.kind).toBe('decision');
  });

  it('worklog is scoped per cwd (project isolation)', () => {
    store.addWorklogEntry(CWD, 's1', 'A', 'work');
    store.addWorklogEntry('/other/project', 's2', 'B', 'work');
    expect(store.getWorklog(CWD)).toHaveLength(1);
    expect(store.getWorklog('/other/project')).toHaveLength(1);
    expect(store.getWorklog(CWD)[0]!.entry).toBe('A');
  });

  it('briefing is null when empty, populated after work', () => {
    expect(store.getProjectBriefingFact('/fresh')).toBeNull();

    store.defineProject(CWD, 'SG Launch');
    store.addWorklogEntry(CWD, 's1', 'Built price monitor', 'work');
    const brief = store.getProjectBriefingFact(CWD)!;
    expect(brief).toContain('PROJECT MEMORY');
    expect(brief).toContain('SG Launch');
    expect(brief).toContain('Built price monitor');
    // It should instruct continuation, not restart.
    expect(brief.toLowerCase()).toContain('do not redo');
  });

  it('briefing works with worklog but no defined project', () => {
    store.addWorklogEntry('/anon', null, 'Did a thing', 'work');
    const brief = store.getProjectBriefingFact('/anon')!;
    expect(brief).toContain('PROJECT MEMORY');
    expect(brief).toContain('Did a thing');
  });
});

describe('project tools — metadata', () => {
  it('project_log is a write tool with the right shape', () => {
    const t = new ProjectLogTool();
    expect(t.name).toBe('project_log');
    expect(t.isReadOnly).toBe(false);
    expect(t.isDestructive).toBe(false);
    // schema accepts an entry + optional kind
    expect(() => t.argsSchema.parse({ entry: 'did X' })).not.toThrow();
    expect(() => t.argsSchema.parse({ entry: 'd', kind: 'decision' })).not.toThrow();
    expect(() => t.argsSchema.parse({ entry: 'd', kind: 'bogus' })).toThrow();
    expect(() => t.argsSchema.parse({})).toThrow(); // entry required
  });

  it('project_recall is read-only', () => {
    const t = new ProjectRecallTool();
    expect(t.name).toBe('project_recall');
    expect(t.isReadOnly).toBe(true);
    expect(() => t.argsSchema.parse({})).not.toThrow(); // limit optional
  });
});
