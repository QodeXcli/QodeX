/**
 * Add / remove MCP servers in the user-level config.yaml, preserving everything
 * else in the file. Unlike saveUserConfig (which rewrites the whole document
 * from an in-memory object and would drop comments / unknown keys), this reads
 * the RAW user YAML, mutates only `mcp.servers.<id>`, and writes it back.
 *
 * Building the entry from a registry spec:
 *   - stdio + token  → command/args, token injected via env or a templated arg
 *   - stdio + connstr→ connection string appended as a positional arg
 *   - remote + oauth → just the url (client does the browser handshake)
 *   - remote + token → url + headers: { <authHeader>: "<format with token>" }
 *
 * Secrets: by default we DON'T hardcode tokens into config.yaml. We write
 * `${ENV_VAR}` and tell the user to export it (so the token never sits in a
 * file that might get committed). Passing `inlineToken` writes the literal
 * value instead — convenient but less safe; we warn.
 */

import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import { QODEX_CONFIG_FILE } from '../config/defaults.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import type { McpServerSpec } from './registry.js';

export interface BuiltServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  streamable?: boolean;
  enabled: boolean;
  destructive?: boolean;
  startupTimeoutSeconds?: number;
  /** See MCPServerConfig.preserveArgEnvRefs. */
  preserveArgEnvRefs?: boolean;
}

export interface AddServerOptions {
  /** Map of credential envVar → literal value the user provided. */
  secrets?: Record<string, string>;
  /** Write literal secret values into config.yaml instead of ${ENV} refs. */
  inlineToken?: boolean;
  /** Override the id used as the config key. */
  asId?: string;
}

/** Build a config entry object from a registry spec + provided secrets. */
export function buildServerEntry(spec: McpServerSpec, opts: AddServerOptions = {}): BuiltServerEntry {
  const secrets = opts.secrets ?? {};
  const ref = (envVar: string): string =>
    opts.inlineToken && secrets[envVar] ? secrets[envVar]! : `\${${envVar}}`;

  const entry: BuiltServerEntry = { enabled: true };
  if (spec.destructive) entry.destructive = true;
  if (spec.startupTimeoutSeconds) entry.startupTimeoutSeconds = spec.startupTimeoutSeconds;

  if (spec.transport === 'stdio') {
    entry.command = spec.command;
    entry.args = [...(spec.args ?? [])];

    // connstr / templated-arg servers: append the credential as an argument.
    // `{TOKEN}` is credentials[0]. `{ENV_VAR}` is that credential's envVar name,
    // so one arg can carry two secrets (Google client id + secret).
    // preserveArgEnvRefs keeps `${ENV}` in the arg even with --inline: the
    // literal goes to env, and the child (mcp-remote) expands the arg itself
    // so the secret is not on the command line.
    if (spec.tokenArgTemplate && spec.credentials.length > 0) {
      const primary = spec.credentials[0]!;
      const argToken = (envVar: string): string =>
        spec.preserveArgEnvRefs ? `\${${envVar}}` : ref(envVar);
      for (const t of spec.tokenArgTemplate) {
        // `{ENV_VAR}` first. Doing it after `{TOKEN}` → `${ENV}` would see
        // the braces inside `${ENV}` and double the dollar.
        let arg = t;
        for (const cred of spec.credentials) {
          arg = arg.split(`{${cred.envVar}}`).join(argToken(cred.envVar));
        }
        arg = arg.split('{TOKEN}').join(argToken(primary.envVar));
        entry.args.push(arg);
      }
    }

    // token servers (stdio): expose every credential as an env var.
    // A templated arg normally consumes the secret, so it is not also copied
    // into env — unless the arg deliberately leaves `${ENV}` for the child.
    const env: Record<string, string> = {};
    for (const cred of spec.credentials) {
      if (spec.tokenArgTemplate && !spec.preserveArgEnvRefs) continue;
      env[cred.envVar] = ref(cred.envVar);
    }
    if (Object.keys(env).length > 0) entry.env = env;
    if (spec.preserveArgEnvRefs) entry.preserveArgEnvRefs = true;
  } else {
    // remote
    entry.url = spec.url;
    if (spec.streamable) entry.streamable = true;
    if (spec.auth === 'token' && spec.authHeader && spec.credentials[0]) {
      const cred = spec.credentials[0];
      const fmt = spec.authHeaderFormat ?? '{TOKEN}';
      entry.headers = { [spec.authHeader]: fmt.replace('{TOKEN}', ref(cred.envVar)) };
    }
    // oauth remote: no headers — the MCP client negotiates in the browser.
  }
  return entry;
}

async function readRawUserConfig(): Promise<any> {
  try {
    const raw = await fs.readFile(QODEX_CONFIG_FILE, 'utf-8');
    return (yaml.load(raw) as any) ?? {};
  } catch (e: any) {
    if (e?.code === 'ENOENT') return {};
    throw e;
  }
}

async function writeRawUserConfig(obj: any): Promise<void> {
  const text = yaml.dump(obj, { indent: 2, lineWidth: 100 });
  await writeFileAtomic(QODEX_CONFIG_FILE, text);
}

/** Add (or overwrite) a server entry under mcp.servers.<id> in user config. */
export async function addServerToConfig(
  spec: McpServerSpec,
  opts: AddServerOptions = {},
): Promise<{ id: string; entry: BuiltServerEntry }> {
  const id = opts.asId ?? spec.id;
  const cfg = await readRawUserConfig();
  cfg.mcp = cfg.mcp ?? {};
  cfg.mcp.servers = cfg.mcp.servers ?? {};
  const entry = buildServerEntry(spec, opts);
  cfg.mcp.servers[id] = entry;
  await writeRawUserConfig(cfg);
  return { id, entry };
}

/** Remove a server entry. Returns true if it existed. */
export async function removeServerFromConfig(id: string): Promise<boolean> {
  const cfg = await readRawUserConfig();
  if (!cfg.mcp?.servers?.[id]) return false;
  delete cfg.mcp.servers[id];
  await writeRawUserConfig(cfg);
  return true;
}

/** List configured server ids from user config. */
export async function listConfiguredServers(): Promise<string[]> {
  const cfg = await readRawUserConfig();
  return Object.keys(cfg.mcp?.servers ?? {});
}
