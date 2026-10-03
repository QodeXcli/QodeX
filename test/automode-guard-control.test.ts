/**
 * The control center shows WHY auto mode still asks: Sentinel puts the reason in the
 * approval's meta.autoMode (and in the prompt), the server passes meta through, and the
 * dashboard renders a "Auto mode still asks: …" line on the card.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import { renderDashboard, DASHBOARD_STRINGS } from '../src/control/dashboard.js';
import { publicApproval } from '../src/control/server.js';
import { ApprovalBroker, type PendingApproval } from '../src/control/approvals.js';
import { Sentinel } from '../src/sentinel/guard.js';
import { DEFAULT_SENTINEL_CONFIG } from '../src/config/agent-config.js';
import { PermissionEngine, setApprovalMode } from '../src/security/permissions.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { ToolContext } from '../src/tools/base.js';

afterEach(() => setApprovalMode('manual'));

describe('control center: the auto-mode reason on an approval', () => {
  it('the dashboard ships the label in both languages and renders meta.autoMode', () => {
    expect(DASHBOARD_STRINGS.en.autoAsks).toBe('Auto mode still asks');
    expect(DASHBOARD_STRINGS.fa.autoAsks).toBeTruthy();
    const html = renderDashboard();
    expect(html).toContain('a.meta.autoMode');
    expect(html).toContain("t('autoAsks')");
  });

  it('a remote delete asked in auto mode reaches the control channel with its reason', async () => {
    setApprovalMode('auto');
    const broker = new ApprovalBroker();
    const seen: PendingApproval[] = [];
    broker.registerChannel({ name: 'control', deliver: (p) => { seen.push(p); setTimeout(() => broker.resolve(p.id, 'no', 'control'), 0); } });
    const s = new Sentinel({
      config: () => ({ ...DEFAULT_SENTINEL_CONFIG, audit: false }), audit: null,
      broker: () => broker, interactive: () => false, browser: () => null, controlCenter: () => null,
    });
    const ctx = {
      cwd: os.tmpdir(), sessionId: 's', transaction: {} as any, permissions: new PermissionEngine(DEFAULT_CONFIG),
      askUser: async () => 'yes', emit: () => {},
    } as unknown as ToolContext;
    const r = await s.beforeTool('http_request', { method: 'DELETE', url: 'https://api.example.com/v1/projects/7' }, ctx);
    expect(r?.content).toMatch(/^\[SENTINEL_DENIED\]/);
    expect(seen).toHaveLength(1);
    const pub = publicApproval(seen[0]!) as { meta?: { autoMode?: string }; prompt: string };
    expect(pub.meta?.autoMode).toMatch(/HTTP DELETE to api\.example\.com/);
    expect(pub.prompt).toContain('Auto mode still asks');
  });
});
