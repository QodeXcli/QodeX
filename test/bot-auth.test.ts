import { describe, it, expect } from 'vitest';
import { isAuthorized } from '../src/bot/auth.ts';

describe('isAuthorized (closed by default)', () => {
  it('denies when no allowlist is configured', () => {
    expect(isAuthorized('telegram', 'u1', {})).toBe(false);
    expect(isAuthorized('telegram', 'u1', { telegram: { allowedUsers: [] } })).toBe(false);
  });
  it('allows only explicitly listed ids', () => {
    const allow = { telegram: { allowedUsers: ['123', '456'] } };
    expect(isAuthorized('telegram', '123', allow)).toBe(true);
    expect(isAuthorized('telegram', '999', allow)).toBe(false);
  });
  it('treats ids as strings (numeric platform ids)', () => {
    expect(isAuthorized('discord', 789 as unknown as string, { discord: { allowedUsers: ['789'] } })).toBe(true);
  });
  it('"*" opts a platform into public access (the documented foot-gun)', () => {
    expect(isAuthorized('telegram', 'anyone', { telegram: { allowedUsers: ['*'] } })).toBe(true);
  });
  it('platforms are isolated', () => {
    const allow = { telegram: { allowedUsers: ['u1'] } };
    expect(isAuthorized('discord', 'u1', allow)).toBe(false);
  });
});
