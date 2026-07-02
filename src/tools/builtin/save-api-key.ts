/**
 * `save_api_key` — when the user pastes an API key in chat ("here, set it for me"), store it in
 * ~/.qodex/.env (chmod 600, atomic, the same place `qodex provider add` uses) AND load it into the
 * running process, so the interrupted task can resume in the SAME session without a restart.
 *
 * Security posture: the value is never echoed back, never logged, and never written to config.yaml
 * (secrets live in env, not config). Only the env-var NAME appears in the confirmation.
 */
import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../base.js';

const Args = z.object({
  env_var: z.string().describe('The environment variable name, e.g. FIRECRAWL_API_KEY or TAVILY_API_KEY.'),
  value: z.string().describe('The key value the user provided. Stored in ~/.qodex/.env (0600); never echoed back.'),
});

export class SaveApiKeyTool extends Tool<z.infer<typeof Args>> {
  name = 'save_api_key';
  description = 'Store an API key the USER just provided in chat (e.g. FIRECRAWL_API_KEY / TAVILY_API_KEY / BRAVE_SEARCH_API_KEY) into ~/.qodex/.env (chmod 600) and load it into this session, so a blocked task (web search, page extraction, a cloud provider) can continue immediately. Use ONLY with a key the user explicitly pasted — never invent or reuse values. The value is never echoed back or logged.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, _ctx: ToolContext): Promise<ToolResult> {
    const envVar = args.env_var.trim().toUpperCase();
    const value = args.value.trim();
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(envVar)) {
      return { content: `[SAVE_KEY_ERROR] "${envVar}" is not a valid environment variable name (A-Z, 0-9, _).`, isError: true };
    }
    if (!value || value.length < 8) {
      return { content: '[SAVE_KEY_ERROR] That does not look like a key (too short). Ask the user to re-paste it.', isError: true };
    }
    if (/\s/.test(value)) {
      return { content: '[SAVE_KEY_ERROR] The value contains whitespace — probably a paste accident. Ask the user to re-paste just the key.', isError: true };
    }

    const { setEnvKey } = await import('../../setup/env-writer.js');
    const file = await setEnvKey(envVar, value);
    process.env[envVar] = value;   // live for THIS session — the blocked task can retry right away

    const { findServiceKey } = await import('../../setup/key-guidance.js');
    const svc = findServiceKey(envVar);
    const unlocked = svc ? ` ${svc.service} is now available — ${svc.unlocks}.` : '';
    return {
      content: `✓ ${envVar} saved to ${file} (chmod 600) and loaded into this session.${unlocked} Retry the blocked step now.`,
      metadata: { envVar, service: svc?.service },
    };
  }
}
