/**
 * The mail tools reach the model only for mail tasks (tool-relevance family), so the
 * ungated tool budget is untouched and a coding task never sees mail_send.
 */
import { describe, it, expect } from 'vitest';
import { selectRelevantToolNames, filterSchemasByRelevance } from '../src/agent/tool-relevance.js';
import { ToolRegistry } from '../src/tools/registry.js';

const registry = new ToolRegistry();
const all = registry.list().map(t => t.name);
const MAIL = all.filter(n => n.startsWith('mail_'));

const mailSelected = (text: string) => {
  const sel = selectRelevantToolNames(all, text).selected;
  return MAIL.filter(n => sel.has(n));
};

describe('mail tool-relevance family', () => {
  it('registers the seven mail tools', () => {
    expect(MAIL.sort()).toEqual(['mail_download_attachment', 'mail_draft', 'mail_list', 'mail_mark', 'mail_move', 'mail_read', 'mail_send']);
  });

  for (const text of [
    'check my inbox for anything from Ali',
    'Reply to the invoice email from Sara',
    'any unread e-mail today?',
    'save the attachment from the last message',
    'write a draft for the client',
    'ایمیل‌های جدیدم را بخوان',
    'به ای میل علی جواب بده',
    'جیمیلم را چک کن',
    'صندوق ورودی را مرتب کن',
    'پیوست نامهٔ آخر را ذخیره کن',
    'اینباکس رو ببین',
  ]) {
    it(`surfaces every mail tool for: ${text}`, () => {
      expect(mailSelected(text).sort()).toEqual([...MAIL].sort());
    });
  }

  for (const text of [
    'fix the failing test in parser.ts',
    'برنامه را تکمیل کن و تست‌ها را اجرا کن',
    'refactor the payment module',
    'open digikala.com and add the phone to the cart',
  ]) {
    it(`keeps mail tools out of: ${text}`, () => {
      expect(mailSelected(text)).toEqual([]);
    });
  }

  it('gating removes the mail schemas from a non-mail turn', () => {
    const schemas = registry.list().map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: {} } }));
    const r = filterSchemasByRelevance(schemas as any, 'implement the new CLI flag and run the tests');
    expect(r.schemas.some(s => s.function.name.startsWith('mail_'))).toBe(false);
    const m = filterSchemasByRelevance(schemas as any, 'read my latest email and draft a reply');
    expect(m.schemas.filter(s => s.function.name.startsWith('mail_'))).toHaveLength(7);
  });
});
