import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { parseWhatsAppWebhook, verifyWhatsAppSignature } from '../src/bot/adapters/whatsapp.js';
import { parseSignalReceive, formatSignalButtons } from '../src/bot/adapters/signal.js';
import { isAuthorized } from '../src/bot/auth.js';

describe('WhatsApp Cloud API webhook parse', () => {
  it('extracts a text message', () => {
    const body = {
      entry: [{ changes: [{ value: { messages: [{ from: '15551230000', type: 'text', text: { body: '/status' } }] } }] }],
    };
    expect(parseWhatsAppWebhook(body)).toEqual([{ from: '15551230000', text: '/status' }]);
  });

  it('extracts an interactive button as callback id', () => {
    const body = {
      entry: [{ changes: [{ value: { messages: [{
        from: '15551230000',
        type: 'interactive',
        interactive: { button_reply: { id: 'ask:yes', title: 'yes' } },
      }] } }] }],
    };
    const [hit] = parseWhatsAppWebhook(body);
    expect(hit?.from).toBe('15551230000');
    expect(hit?.buttonId).toBe('ask:yes');
  });

  it('ignores statuses and empty bodies', () => {
    expect(parseWhatsAppWebhook({})).toEqual([]);
    expect(parseWhatsAppWebhook({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] })).toEqual([]);
  });

  it('accepts a matching X-Hub-Signature-256 over the raw bytes', () => {
    const secret = 'app-secret';
    const raw = Buffer.from('{"ok":true}', 'utf8');
    const hex = createHmac('sha256', secret).update(raw).digest('hex');
    expect(verifyWhatsAppSignature(raw, `sha256=${hex}`, secret)).toBe(true);
  });

  it('rejects a missing header, a bad prefix, a wrong secret, and a forged body', () => {
    const secret = 'app-secret';
    const raw = Buffer.from('{"from":"15551230000","text":{"body":"rm -rf /"}}', 'utf8');
    const hex = createHmac('sha256', secret).update(raw).digest('hex');
    expect(verifyWhatsAppSignature(raw, undefined, secret)).toBe(false);
    expect(verifyWhatsAppSignature(raw, hex, secret)).toBe(false);
    expect(verifyWhatsAppSignature(raw, `sha256=${hex}`, 'other-secret')).toBe(false);
    expect(verifyWhatsAppSignature(Buffer.from('{"from":"15551230000"}'), `sha256=${hex}`, secret)).toBe(false);
    expect(verifyWhatsAppSignature(raw, 'sha256=deadbeef', secret)).toBe(false);
  });
});

describe('signal-cli receive parse', () => {
  it('reads sourceNumber + dataMessage.message', () => {
    expect(parseSignalReceive({
      envelope: { sourceNumber: '+15550001111', dataMessage: { message: 'ship it' } },
    })).toEqual({ from: '+15550001111', text: 'ship it' });
  });

  it('accepts the jsonrpc receive wrapper', () => {
    const hit = parseSignalReceive({
      jsonrpc: '2.0',
      method: 'receive',
      params: { envelope: { source: '+1', dataMessage: { message: 'hi' } } },
    });
    expect(hit).toEqual({ from: '+1', text: 'hi' });
  });

  it('drops empty envelopes', () => {
    expect(parseSignalReceive({ envelope: { sourceNumber: '+1' } })).toBeNull();
    expect(parseSignalReceive({})).toBeNull();
  });

  it('prints numbered options because Signal has no inline buttons', () => {
    const s = formatSignalButtons('Run npm test?', [
      [{ label: 'yes', data: 'ask:yes' }, { label: 'no', data: 'ask:no' }],
    ]);
    expect(s).toMatch(/1\. yes/);
    expect(s).toMatch(/2\. no/);
    expect(s).toMatch(/Reply with a number/);
  });
});

describe('allowlists stay isolated', () => {
  it('whatsapp / signal ids do not leak across platforms', () => {
    const allow = {
      whatsapp: { allowedUsers: ['1555'] },
      signal: { allowedUsers: ['+1555'] },
    };
    expect(isAuthorized('whatsapp', '1555', allow)).toBe(true);
    expect(isAuthorized('signal', '+1555', allow)).toBe(true);
    expect(isAuthorized('telegram', '1555', allow)).toBe(false);
    expect(isAuthorized('whatsapp', '+1555', allow)).toBe(false);
  });
});
