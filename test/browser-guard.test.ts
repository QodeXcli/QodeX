import { describe, it, expect } from 'vitest';
import { confirmPageChange, BrowserClickTool, BrowserFillTool } from '../src/tools/browser/tools.js';
import { classifyAsk } from '../src/desk/sentinel.js';

const ctx = (answer: string, seen: string[] = []) => ({
  askUser: async (prompt: string) => { seen.push(prompt); return answer; },
  emit: () => {},
}) as any;

describe('page changes ask every time', () => {
  it('rejects no and a standing always-yes', async () => {
    expect((await confirmPageChange(ctx('no'), 'browser_click', '#buy'))?.isError).toBe(true);
    expect((await confirmPageChange(ctx('always yes'), 'browser_fill', '#card'))?.isError).toBe(true);
  });

  it('accepts one yes', async () => {
    expect(await confirmPageChange(ctx('yes'), 'browser_evaluate', 'return 1')).toBeNull();
  });

  it('does not launch the browser when the click is refused', async () => {
    const tool = new BrowserClickTool();
    const result = await tool.execute({ selector: '#buy' }, ctx('no'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('USER_REJECTED');
    expect(result.content).not.toContain('Clicked:');
  });

  it('asks about a fill without putting the typed text in the question', async () => {
    const seen: string[] = [];
    const tool = new BrowserFillTool();
    const result = await tool.execute({ selector: '#field', value: 'correct-horse' }, ctx('no', seen));
    expect(result.isError).toBe(true);
    expect(seen[0]).toContain('#field');
    expect(seen[0]).toContain('13 chars');
    expect(seen[0]).not.toContain('correct-horse');
    expect(classifyAsk(seen[0]).kind).toBe('page');
  });

  it('labels a page change, and a purchase stays a spend', () => {
    expect(classifyAsk('browser_click will change the page: text=Save').kind).toBe('page');
    expect(classifyAsk('browser_click will change the page: text=Buy now').kind).toBe('spend');
  });
});
