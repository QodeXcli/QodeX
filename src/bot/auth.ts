/**
 * Allowlist — closed by default (PURE).
 *
 * This bot drives a coding agent that runs shell commands and edits files on the host. An open
 * bot is a remote-code-execution hole. So authorization is DENY-by-default: a platform with no
 * configured allowlist accepts NO ONE. A user is allowed only if their id is explicitly listed.
 * The literal `'*'` opts a platform into fully public access — a deliberate, documented foot-gun
 * for trusted private servers, never the default.
 */
import type { Platform } from './types.js';

export interface AllowConfig {
  telegram?: { allowedUsers?: string[] };
  discord?: { allowedUsers?: string[] };
  slack?: { allowedUsers?: string[] };
}

export function isAuthorized(platform: Platform, userId: string, allow: AllowConfig): boolean {
  const list = allow[platform]?.allowedUsers;
  if (!list || list.length === 0) return false;          // no allowlist ⇒ nobody
  const id = String(userId);
  return list.includes('*') || list.includes(id);
}
