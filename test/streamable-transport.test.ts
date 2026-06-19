import { describe, it, expect } from 'vitest';
import { extractSseData } from '../src/mcp/transport.js';

// The Streamable-HTTP transport's correctness hinges on this pure line parser:
// it must reassemble JSON-RPC payloads from SSE chunks that arrive split at
// arbitrary boundaries, keep the trailing partial line for the next chunk, and
// ignore non-data lines. (Multibyte safety is handled upstream by TextDecoderStream.)

describe('extractSseData', () => {
  it('extracts a single data line and keeps no remainder when newline-terminated', () => {
    const { data, rest } = extractSseData('data: {"jsonrpc":"2.0","id":1}\n');
    expect(data).toEqual(['{"jsonrpc":"2.0","id":1}']);
    expect(rest).toBe('');
  });

  it('keeps an incomplete trailing line in rest for the next chunk', () => {
    const { data, rest } = extractSseData('data: {"a":1}\ndata: {"b":2');
    expect(data).toEqual(['{"a":1}']);
    expect(rest).toBe('data: {"b":2'); // incomplete — carried forward
  });

  it('reassembles a payload split across two chunks', () => {
    let buffer = '';
    const out: string[] = [];
    for (const chunk of ['data: {"jsonr', 'pc":"2.0","id":', '7}\n']) {
      buffer += chunk;
      const { data, rest } = extractSseData(buffer);
      buffer = rest;
      out.push(...data);
    }
    expect(out).toEqual(['{"jsonrpc":"2.0","id":7}']);
  });

  it('ignores event:, id:, comments, and blank lines', () => {
    const input = ': keep-alive\nevent: message\nid: 42\n\ndata: {"x":1}\n';
    const { data } = extractSseData(input);
    expect(data).toEqual(['{"x":1}']);
  });

  it('handles CRLF line endings', () => {
    const { data } = extractSseData('data: {"y":2}\r\n');
    expect(data).toEqual(['{"y":2}']);
  });

  it('skips the [DONE] sentinel and empty data', () => {
    const { data } = extractSseData('data: [DONE]\ndata:\ndata: {"z":3}\n');
    expect(data).toEqual(['{"z":3}']);
  });

  it('handles multiple data lines in one chunk', () => {
    const { data } = extractSseData('data: {"a":1}\ndata: {"b":2}\ndata: {"c":3}\n');
    expect(data).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('tolerates data lines with or without the leading space', () => {
    const { data } = extractSseData('data:{"nospace":1}\ndata: {"space":1}\n');
    expect(data).toEqual(['{"nospace":1}', '{"space":1}']);
  });
});
