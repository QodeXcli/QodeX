/**
 * H2 hand-off surfaces — terminal: a hand-off prompt shows "solve it in the browser
 * window / control center — QodeX continues automatically", the local control-center
 * URL and d / c / Esc; d and c are unique shortcuts for done / cancel.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { Confirmation, DEFAULT_CONFIRMATION_HINT, pickByShortcut } from '../src/cli/prompts/confirmation.js';
import { getApprovalBroker } from '../src/control/approvals.js';
import { handoffForPrompt, handoffTerminalHint, localHandoffUrl } from '../src/control/handoff.js';
import { startControlCenter, stopControlCenter } from '../src/control/server.js';

function fakeTty(): { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream; frames: string[] } {
  const frames: string[] = [];
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & { columns: number; rows: number };
  stdout.columns = 120;
  stdout.rows = 40;
  (stdout as any).isTTY = true;
  stdout.on('data', (c: Buffer) => frames.push(c.toString('utf8')));
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = () => stdin;
  (stdin as any).ref = () => stdin;
  (stdin as any).unref = () => stdin;
  return { stdout, stdin, frames };
}

const strip = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

afterEach(async () => {
  await stopControlCenter();
  getApprovalBroker().reset();
});

describe('terminal hand-off prompt', () => {
  it('done / cancel have unique shortcuts', () => {
    expect(pickByShortcut(['done', 'cancel'], 'd')).toBe('done');
    expect(pickByShortcut(['done', 'cancel'], 'c')).toBe('cancel');
    expect(pickByShortcut(['done', 'cancel'], 'y')).toBeNull();
  });

  it('renders the hand-off hint instead of the default keys', async () => {
    const { stdout, stdin, frames } = fakeTty();
    const hint = handoffTerminalHint({ id: 'ho_1' }, 'en', 'http://127.0.0.1:7420/?k=abc&handoff=ho_1');
    const app = render(React.createElement(Confirmation, { prompt: 'A bot check on shop.example needs you.', options: ['done', 'cancel'], onAnswer: () => {}, hint }), { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false });
    await new Promise(r => setTimeout(r, 30));
    app.unmount();
    const out = strip(frames.join(''));
    expect(out).toContain('Solve it in the browser window or the control center — QodeX continues automatically.');
    expect(out).toContain('Control center: http://127.0.0.1:7420/?k=abc&handoff=ho_1');
    expect(out).toContain('d done');
    expect(out).toContain('Esc stops the task');
    expect(out).not.toContain(DEFAULT_CONFIRMATION_HINT);
  });

  it('keeps the default hint for other prompts', async () => {
    const { stdout, stdin, frames } = fakeTty();
    const app = render(React.createElement(Confirmation, { prompt: 'Run npm test?', options: ['yes', 'no'], onAnswer: () => {} }), { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false });
    await new Promise(r => setTimeout(r, 30));
    app.unmount();
    expect(strip(frames.join(''))).toContain(DEFAULT_CONFIRMATION_HINT);
  });

  it('finds the hand-off behind a terminal prompt (also with a lane tag) and shows the local URL', async () => {
    const info = await startControlCenter({ port: 0, token: 'tui-handoff-token-0123456789' });
    const broker = getApprovalBroker();
    const pr = broker.request({
      prompt: 'A bot check (hCaptcha) on shop.example needs you.', options: ['done', 'cancel'], source: 'browser', category: 'challenge', timeoutMs: 30_000,
      meta: { handoff: { id: 'ho_tui', host: 'shop.example', vendor: 'hcaptcha' } },
    });
    expect(handoffForPrompt('A bot check (hCaptcha) on shop.example needs you.', ['done', 'cancel'])?.handoff.id).toBe('ho_tui');
    expect(handoffForPrompt('[bg1] A bot check (hCaptcha) on shop.example needs you.', ['done', 'cancel'])?.handoff.id).toBe('ho_tui');
    expect(handoffForPrompt('Something else', ['done', 'cancel'])).toBeNull();
    expect(handoffForPrompt('A bot check (hCaptcha) on shop.example needs you.', ['yes', 'no'])).toBeNull();
    expect(localHandoffUrl('ho_tui')).toBe(`${info.url}&handoff=ho_tui`);
    const lines = handoffTerminalHint({ id: 'ho_tui' }, 'fa');
    expect(lines[0]).toContain('QodeX خودش ادامه می‌دهد');
    expect(lines[1]).toContain(`handoff=ho_tui`);
    broker.cancel(broker.pending()[0]!.id);
    await pr;
  });
});
