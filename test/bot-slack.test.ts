import { describe, it, expect } from 'vitest';
import { createSlackTransport } from '../src/bot/adapters/slack.ts';
import { isAuthorized } from '../src/bot/auth.ts';
import { parseDeliveryTarget, clampForPlatform } from '../src/schedule/delivery.ts';
import { DEFAULT_CONFIG } from '../src/config/defaults.ts';

describe('slack adapter', () => {
  it('throws an actionable error when the Slack SDKs are not installed', async () => {
    // The SDKs are optional deps; without them the adapter must fail with install guidance,
    // exactly like the Discord adapter — never a cryptic module-not-found.
    await expect(createSlackTransport('xapp-test', 'xoxb-test')).rejects.toThrow(/npm i @slack\/socket-mode @slack\/web-api/);
  });
});

describe('slack — auth, delivery, config wiring', () => {
  it('is deny-by-default and respects the allowlist + "*" like every platform', () => {
    expect(isAuthorized('slack', 'U123', {})).toBe(false);
    expect(isAuthorized('slack', 'U123', { slack: { allowedUsers: [] } })).toBe(false);
    expect(isAuthorized('slack', 'U123', { slack: { allowedUsers: ['U123'] } })).toBe(true);
    expect(isAuthorized('slack', 'anyone', { slack: { allowedUsers: ['*'] } })).toBe(true);
    // isolated from other platforms
    expect(isAuthorized('slack', 'U1', { telegram: { allowedUsers: ['U1'] } })).toBe(false);
  });

  it('schedule delivery understands slack targets', () => {
    expect(parseDeliveryTarget('slack:C0123ABC')).toEqual({ platform: 'slack', chatId: 'C0123ABC' });
    expect(clampForPlatform('x'.repeat(5000), 'slack').length).toBe(3000);
  });

  it('ships disabled-by-default in config (no surprise public bot)', () => {
    expect((DEFAULT_CONFIG as any).bot.slack).toEqual({ enabled: false, allowedUsers: [] });
  });
});
