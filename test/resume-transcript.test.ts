import { describe, it, expect } from 'vitest';
import { messagesToHistory } from '../src/cli/resume-transcript.js';
import type { Message } from '../src/session/store.js';

describe('messagesToHistory (resume repaint)', () => {
  it('keeps only user + assistant text turns, in order, with resume ids', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'You are QodeX...' },
      { role: 'user', content: 'add breadcrumbs to chinpost' },
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'project_overview', arguments: '{}' } }] },
      { role: 'tool', content: 'project_overview output', tool_call_id: '1', name: 'project_overview' },
      { role: 'assistant', content: 'I added breadcrumb JSON-LD to functions.php.' },
      { role: 'user', content: '   ' },
      { role: 'user', content: 'now add hreflang' },
      { role: 'assistant', content: 'Done — hreflang tags added.' },
    ];
    const h = messagesToHistory(msgs);
    expect(h).toEqual([
      { type: 'user', text: 'add breadcrumbs to chinpost', id: 'resume-0' },
      { type: 'assistant', text: 'I added breadcrumb JSON-LD to functions.php.', id: 'resume-1' },
      { type: 'user', text: 'now add hreflang', id: 'resume-2' },
      { type: 'assistant', text: 'Done — hreflang tags added.', id: 'resume-3' },
    ]);
  });

  it('returns empty for a session with no readable turns', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', content: 'result', tool_call_id: 'x', name: 't' },
    ];
    expect(messagesToHistory(msgs)).toEqual([]);
  });

  it('preserves full text (no truncation) so the user sees the whole conversation', () => {
    const long = 'x'.repeat(5000);
    const h = messagesToHistory([{ role: 'user', content: long }]);
    expect(h).toHaveLength(1);
    expect(h[0]!.text).toHaveLength(5000);
  });
});
