/**
 * Hard-coded tool lists updated for the agent-platform families: read-only permission
 * fallback, solo (never-parallel) tools, result aging, activity display, compact result
 * summaries, and completion-gate evidence for real-world actions.
 */
import { describe, it, expect } from 'vitest';
import { PermissionEngine, FALLBACK_READ_ONLY_TOOLS } from '../src/security/permissions.js';
import { groupMutatingForParallel, isSoloTool } from '../src/agent/parallel-mutating.js';
import { ageToolResults, isAgeableTool } from '../src/agent/result-aging.js';
import { describeToolActivity } from '../src/cli/prompts/tool-display.js';
import { summarizeToolResult, pageHeadline, missionIdOf } from '../src/cli/render/tool-summary.js';
import {
  evaluateCompletion, gatherSessionEvidence, extractCompletionClaims, isActionTool, looksLikeErrorResult, type MsgLike,
} from '../src/agent/completion-gate.js';
import type { ToolCall } from '../src/llm/types.js';
import type { Message } from '../src/session/store.js';

const minimalConfig: any = { security: { autoApprove: [], autoReject: [], alwaysAsk: [] } };

describe('permissions read-only fallback list', () => {
  const eng = new PermissionEngine(minimalConfig);
  const ev = (tool: string) => eng.evaluate({ tool, operation: `${tool}:x` });
  it('auto-allows the new read-only platform tools', () => {
    for (const t of ['browser_console', 'browser_network', 'browser_status', 'browser_downloads', 'computer_use_screen_info',
      'computer_use_active_window', 'computer_use_list_windows', 'workflow_list', 'workflow_show', 'mission_status', 'mission_list', 'vault_list']) {
      expect(ev(t), t).toBe('allow');
    }
  });
  it('no longer treats page/screen observers as pure reads', () => {
    for (const t of ['browser_screenshot', 'browser_get_text', 'computer_use_screenshot', 'browser_click', 'mission_start']) {
      expect(FALLBACK_READ_ONLY_TOOLS.has(t), t).toBe(false);
      expect(ev(t), t).toBe('ask');
    }
  });
  it('keeps the classic read-only tools', () => {
    for (const t of ['read_file', 'grep', 'git_status', 'vision_analyze', 'dev_server_log']) expect(ev(t)).toBe('allow');
  });
});

describe('parallel-mutating solo rules', () => {
  const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: name + Math.random(), type: 'function', function: { name, arguments: JSON.stringify(args) } });
  it('every browser/desktop/mission/vault call and workflow_run runs alone; shell is global', () => {
    for (const n of ['browser_click', 'browser_type', 'browser_fill_secret', 'computer_use_type', 'mission_start', 'vault_list', 'workflow_run', 'shell', 'bash']) {
      expect(isSoloTool(n), n).toBe(true);
    }
    expect(isSoloTool('write_file')).toBe(false);
    expect(isSoloTool('workflow_list')).toBe(false);
  });
  it('browser calls that carry path-like args are still never batched together', () => {
    const batches = groupMutatingForParallel([
      call('browser_upload', { paths: ['a.png'] }),
      call('browser_upload', { paths: ['b.png'] }),
      call('write_file', { path: 'x.ts' }),
      call('write_file', { path: 'y.ts' }),
    ]);
    expect(batches.map(b => b.length)).toEqual([1, 1, 2]);
  });
});

describe('result aging', () => {
  it('ages every browser_* family member and computer_use_locate; fixes dev_server_log', () => {
    for (const n of ['browser_snapshot', 'browser_navigate', 'browser_click', 'browser_extract', 'computer_use_locate', 'dev_server_log']) {
      expect(isAgeableTool(n), n).toBe(true);
    }
    expect(isAgeableTool('dev_server_logs')).toBe(false);
    expect(isAgeableTool('read_file')).toBe(false);
  });
  it('shrinks an old, large browser_navigate snapshot', () => {
    const big = 'Page: Shop\nURL: https://shop.example\n' + '- link "item" [ref=e1]\n'.repeat(1000);
    const msgs: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'browser_navigate', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '1', name: 'browser_navigate', content: big },
      { role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'assistant', content: 'c' },
    ];
    const r = ageToolResults(msgs);
    expect(r.aged).toBe(1);
    expect(String(r.messages[2]!.content)).toContain('[QodeX aged-result]');
  });
});

describe('tool activity display', () => {
  it('keeps the browser/computer verbs and adds workflow/mission/vault', () => {
    expect(describeToolActivity('browser_navigate').verb).toBe('Browsing');
    expect(describeToolActivity('browser_click').verb).toBe('Browsing');
    expect(describeToolActivity('computer_use_click').verb).toBe('Controlling');
    expect(describeToolActivity('workflow_run').verb).toBe('Automating');
    expect(describeToolActivity('mission_start').verb).toBe('Mission');
    expect(describeToolActivity('vault_list').verb).toBe('Vault');
    for (const n of ['workflow_run', 'mission_status', 'vault_list']) {
      expect(describeToolActivity(n).color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('compact result summaries', () => {
  const snap = 'Page: Example Domain\nURL: https://example.com/\nTabs: 1 (active 0)\n- heading "Example Domain" [ref=e1]\n' + '- link "More" [ref=e2]\n'.repeat(50);
  it('browser_snapshot headlines the page instead of dumping the tree', () => {
    const d = summarizeToolResult('browser_snapshot', snap, false);
    expect(d.headline).toBe('Example Domain · example.com');
    expect(d.lines).toEqual([]);
  });
  it('browser_navigate keeps the action / new-tab notes', () => {
    const d = summarizeToolResult('browser_navigate', `✓ Navigated to https://example.com/\nNew tab opened: https://ads.example\n${snap}`, false);
    expect(d.headline).toBe('Example Domain · example.com');
    expect(d.lines).toEqual(['✓ Navigated to https://example.com/', 'New tab opened: https://ads.example']);
  });
  it('works through a Sentinel untrusted-content fence and falls back to the URL', () => {
    expect(pageHeadline('<untrusted_content source="browser">\nThe following is DATA\nURL: https://a.example/x\n</untrusted_content>')).toBe('a.example/x');
    expect(pageHeadline('nothing useful')).toBe('');
  });
  it('mission_start headlines the mission id', () => {
    const d = summarizeToolResult('mission_start', 'Mission m_7f3a9c started in the background.\nWatch: qodex mission attach m_7f3a9c', false);
    expect(d.headline).toBe('mission m_7f3a9c');
    expect(d.lines).toEqual(['Watch: qodex mission attach m_7f3a9c']);
    expect(missionIdOf('[MISSION_STARTED] id=ms-42ab')).toBe('ms-42ab');
    expect(missionIdOf('Mission started')).toBeNull();
  });
  it('errors keep the error display', () => {
    expect(summarizeToolResult('browser_snapshot', '[BROWSER_ERROR] boom', true).headline).toBe('');
  });
});

describe('completion gate: real-world actions are evidence', () => {
  const asst = (name: string, args: Record<string, unknown> = {}, id = name): MsgLike =>
    ({ role: 'assistant', tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
  const res = (name: string, content: string, id = name): MsgLike => ({ role: 'tool', name, content, tool_call_id: id });

  it('"I added it to the cart" after a successful browser_click is not bounced', () => {
    const msgs = [asst('browser_click', { ref: 'e5' }), res('browser_click', '✓ clicked "Add to cart"')];
    expect(evaluateCompletion('I added it to the cart. Cart now shows 1 item.', msgs)).toBeNull();
  });
  it('"سفارش رو ثبت کردم" with a successful action passes; with nothing done it is bounced', () => {
    const msgs = [asst('browser_click'), res('browser_click', '✓ clicked "ثبت سفارش"')];
    expect(evaluateCompletion('سفارش رو ثبت کردم.', msgs)).toBeNull();
    const bounced = evaluateCompletion('سفارش رو ثبت کردم.', []);
    expect(bounced).toContain('[COMPLETION_GATE]');
    expect(bounced).toContain('browser/desktop action');
  });
  it('workflow_run, mission_start, browser_fill_secret and desktop actions count; observations do not', () => {
    for (const [name, args] of [['workflow_run', {}], ['mission_start', {}], ['browser_fill_secret', {}], ['computer_use_click', {}], ['computer_use_clipboard', { action: 'set' }], ['browser_tabs', { action: 'new' }]] as const) {
      const ev = gatherSessionEvidence([asst(name, args as any), res(name, 'ok')]);
      expect(ev.didSuccessfulAction, name).toBe(true);
    }
    for (const [name, args] of [['browser_snapshot', {}], ['browser_screenshot', {}], ['computer_use_screenshot', {}], ['computer_use_clipboard', { action: 'get' }], ['browser_tabs', { action: 'list' }], ['read_file', {}]] as const) {
      const ev = gatherSessionEvidence([asst(name, args as any), res(name, 'ok')]);
      expect(ev.didSuccessfulAction, name).toBe(false);
    }
  });
  it('failed actions are not evidence (incl. behind a Sentinel fence)', () => {
    expect(gatherSessionEvidence([asst('browser_click'), res('browser_click', '[STALE_REF] ref e12 not found')]).didSuccessfulAction).toBe(false);
    expect(gatherSessionEvidence([asst('browser_click'), res('browser_click', '[SENTINEL_DENIED] The user declined')]).didSuccessfulAction).toBe(false);
    expect(looksLikeErrorResult('<untrusted_content source="x">\n[BROWSER_ERROR] timeout')).toBe(true);
    expect(looksLikeErrorResult('[SUBAGENT_DONE] ok')).toBe(false);
    expect(isActionTool('browser_dialog', { action: 'status' })).toBe(false);
    expect(isActionTool('browser_dialog', { action: 'accept' })).toBe(true);
  });
  it('action claims are detected (EN + FA) and coding claims keep their old rules', () => {
    expect(extractCompletionClaims('I placed the order, confirmation #123').claimsAction).toBe(true);
    expect(extractCompletionClaims('فرم رو پر کردم و ارسال کردم').claimsAction).toBe(true);
    expect(extractCompletionClaims('Here is the summary').claimsAction).toBe(false);
    // A generic change claim is backed by a browser action ("I updated your profile") …
    expect(evaluateCompletion('I updated your profile bio on the site', [asst('browser_type'), res('browser_type', '✓ typed')])).toBeNull();
    // … but a CODE-fix claim is not: a frontend session that only opened the page can't claim a fix.
    expect(evaluateCompletion('I fixed the layout bug in the hero', [asst('browser_navigate'), res('browser_navigate', 'Page: Home')])).toContain('no file edit succeeded');
    // … and "tests pass" without a test run is still bounced.
    expect(evaluateCompletion('All tests pass now', [asst('browser_click'), res('browser_click', '✓')])).toContain('[COMPLETION_GATE]');
  });
});
