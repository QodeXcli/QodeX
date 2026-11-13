import { describe, it, expect } from 'vitest';
import {
  assertQuery,
  parseUiTree,
  pickControl,
  findSame,
  verifyInvoke,
  macosInvokeScript,
  macosTreeScript,
  windowsInvokeScript,
  linuxAtspiScript,
  parseInvokeLine,
  assertTypeText,
  verifyTyped,
  parseTypeLine,
  macosTypeScript,
  windowsTypeScript,
  type UiNode,
} from '../src/tools/computer/access.js';
import { describeDesktop } from '../src/desk/policy.js';
import { classifyAsk } from '../src/desk/sentinel.js';

const allow: UiNode = { app: 'Settings', role: 'AXButton', name: 'Allow', x: 10, y: 20, w: 80, h: 24, enabled: true, value: '' };
const deny: UiNode = { app: 'Settings', role: 'AXButton', name: 'Don\'t Allow', x: 100, y: 20, w: 90, h: 24, enabled: true, value: '' };

describe('accessibility tree', () => {
  it('parses rows and ignores junk', () => {
    const raw = [
      'noise',
      'EL\tSettings\tAXButton\tAllow\t10\t20\t80\t24\t1\t',
      'EL\tbad',
      'CAP\t1',
    ].join('\n');
    const tree = parseUiTree(raw);
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]).toMatchObject({ name: 'Allow', app: 'Settings', enabled: true });
    expect(tree.capped).toBe(true);
  });

  it('refuses a short name, a miss, and two hits', () => {
    expect(assertQuery('A')).toMatch(/2/);
    expect(pickControl([allow, deny], { name: 'Nope' }).ok).toBe(false);
    const many = pickControl([allow, deny], { name: 'Allow' });
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.matches.length).toBe(2);
    const one = pickControl([allow, deny], { name: 'Don\'t Allow' });
    expect(one.ok).toBe(true);
  });

  it('verifies gone, changed, and same', () => {
    expect(verifyInvoke(allow, null)).toBe('gone');
    expect(verifyInvoke(allow, { ...allow, value: '1' })).toBe('changed');
    expect(verifyInvoke(allow, { ...allow })).toBe('same');
    expect(findSame([deny], allow)).toBeNull();
    expect(findSame([{ ...allow, x: 11 }], allow)?.x).toBe(11);
  });

  it('invoke scripts press one element and do not take a model coordinate', () => {
    const mac = macosInvokeScript('Settings', 'Allow', 'AXButton');
    expect(mac).toContain('count of hits) is not 1');
    expect(mac).toContain('Allow');
    expect(mac).not.toContain('cliclick');
    expect(macosTreeScript('Finder')).toContain('wantApp to "Finder"');
    const win = windowsInvokeScript('Allow', 'Button', 'Settings');
    expect(win).toContain('InvokePattern');
    expect(win).toContain('OK`taction');
    expect(win).toContain('OK`tcenter');
    const linux = linuxAtspiScript();
    expect(linux).toContain('gi.require_version("Atspi"');
    expect(linux).toContain('QODEX_MATCH');
    expect(linux).toContain('do_action');
  });

  it('reads the invoke receipt', () => {
    expect(parseInvokeLine('noise\nOK\taction')).toEqual({ ok: true, method: 'action' });
    expect(parseInvokeLine('ERR\tQODEX_MATCH 2').ok).toBe(false);
    expect(parseInvokeLine('OK\tcenter\nwarning').ok).toBe(true);
  });

  it('sets a field value without putting the text in the script', () => {
    expect(assertTypeText('')).toBeTruthy();
    expect(assertTypeText('hello\nthere')).toBeTruthy();
    expect(assertTypeText('x'.repeat(501))).toBeTruthy();
    expect(assertTypeText('café')).toBeNull();
    const secret = '"; do shell script "id';
    expect(macosTypeScript('Notes', 'Body')).not.toContain(secret);
    expect(macosTypeScript('Notes', 'Body')).toContain('QODEX_UI_TEXT');
    expect(windowsTypeScript('Body')).toContain('$env:QODEX_UI_TEXT');
    expect(windowsTypeScript('Body')).not.toContain(secret);
    const linux = linuxAtspiScript();
    const typeAt = linux.indexOf('set_text_contents');
    const clickAt = linux.indexOf('do_action');
    expect(typeAt).toBeGreaterThan(0);
    expect(typeAt).toBeLessThan(clickAt);
    expect(parseTypeLine('OK\tvalue').ok).toBe(true);
    expect(parseTypeLine('ERR\tno editable text').ok).toBe(false);
    const field = { ...allow, role: 'AXTextField', name: 'Body', value: '' };
    expect(verifyTyped(field, { ...field, value: 'café' }, 'café')).toBe('verified');
    expect(verifyTyped(field, field, 'café')).toBe('same');
    expect(verifyTyped(field, null, 'café')).toBe('gone');
  });
});

describe('desktop access backend', () => {
  it('names the accessibility backend without inventing one', () => {
    expect(describeDesktop('darwin').access).toBe('ax');
    expect(describeDesktop('win32').access).toBe('uia');
    expect(describeDesktop('linux').access).toBe('none');
    expect(describeDesktop('linux', { atspi: true }).access).toBe('atspi');
    expect(describeDesktop('linux').gui).toBe('none');
  });

  it('parks an invoke on the sentinel as a screen change', () => {
    expect(classifyAsk('computer_use_invoke will change what is on screen: invoke "Allow"').kind).toBe('screen');
  });
});
