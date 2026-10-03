import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendAudit, setAuditLogPath, auditLogPath } from '../src/security/audit-log.js';
import { OperatorHub } from '../src/operator/hub.js';

describe('audit log', () => {
  const files: string[] = [];
  afterEach(() => {
    setAuditLogPath(null);
    for (const f of files) {
      try { fs.unlinkSync(f); } catch { /* */ }
    }
    files.length = 0;
  });

  function tmpLog(): string {
    const f = path.join(os.tmpdir(), `qodex-audit-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
    files.push(f);
    setAuditLogPath(f);
    return f;
  }

  it('appends one JSON line per event and clips long operations', () => {
    const f = tmpLog();
    appendAudit({ type: 'permission', tool: 'bash', operation: 'x'.repeat(400), decision: 'allow', via: 'allow-rule' });
    appendAudit({ type: 'tool', tool: 'edit_text', ok: true, durationMs: 12, sessionId: 's1' });
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]!);
    const b = JSON.parse(lines[1]!);
    expect(a.type).toBe('permission');
    expect(a.via).toBe('allow-rule');
    expect(a.operation.endsWith('…')).toBe(true);
    expect(a.operation.length).toBeLessThanOrEqual(240);
    expect(b).toMatchObject({ type: 'tool', tool: 'edit_text', ok: true, durationMs: 12 });
    expect(typeof a.ts).toBe('string');
  });

  it('auditLogPath honors the override', () => {
    const f = tmpLog();
    expect(auditLogPath()).toBe(f);
  });

  it('records hub answers with origin', async () => {
    const f = tmpLog();
    const hub = new OperatorHub();
    let id = '';
    hub.subscribe(ev => { if (ev.kind === 'approval') id = ev.id; });
    const p = hub.requestApproval('main', 'run npm test?', ['yes', 'no'], { origin: 'telegram:9', lane: 'bot:telegram:9' });
    expect(id).toMatch(/^ap/);
    expect(hub.answer(id, 'yes')).toBe(true);
    await p;
    const rec = JSON.parse(fs.readFileSync(f, 'utf8').trim());
    expect(rec).toMatchObject({
      type: 'approval',
      answer: 'yes',
      origin: 'telegram:9',
      source: 'main',
    });
  });
});
