import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServerEntry } from '../src/mcp/config-writer.js';
import { findMcpSpec, listMcpSpecs } from '../src/mcp/registry.js';
import { expandEnvRefs } from '../src/mcp/manager.js';
import { cloudBrowserAsk } from '../src/mcp/tool-wrapper.js';
import { classifyAsk } from '../src/desk/sentinel.js';

describe('MCP registry', () => {
  it('has all the well-known servers', () => {
    const ids = listMcpSpecs().map(s => s.id);
    for (const id of [
      'github', 'supabase', 'postgres', 'playwright', 'figma', 'sentry', 'linear', 'slack',
      'sequential-thinking', 'brave-search', 'fetch', 'higgsfield', 'tavily', 'canva',
      'gmail', 'google-drive', 'google-calendar', 'google-docs', 'google-sheets',
      'hotmail', 'outlook-work', 'notion', 'atlassian', 'browserbase',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('findMcpSpec is case-insensitive and matches title', () => {
    expect(findMcpSpec('GitHub')?.id).toBe('github');
    expect(findMcpSpec('sentry')?.id).toBe('sentry');
    expect(findMcpSpec('nonexistent')).toBeUndefined();
  });

  it('offers all three Figma access methods', () => {
    const ids = listMcpSpecs().map(s => s.id);
    for (const id of ['figma', 'figma-devmode', 'figma-remote']) expect(ids).toContain(id);
    // token, no-auth-local, oauth-remote respectively
    expect(findMcpSpec('figma')!.auth).toBe('token');
    const dev = findMcpSpec('figma-devmode')!;
    expect(dev.transport).toBe('remote');
    expect(dev.auth).toBe('none');
    expect(dev.url).toBe('http://127.0.0.1:3845/mcp'); // local desktop, uses the logged-in session
    expect(dev.streamable).toBe(true);
    const remote = findMcpSpec('figma-remote')!;
    expect(remote.auth).toBe('oauth');
    expect((remote.args ?? []).join(' ')).toContain('mcp-remote https://mcp.figma.com/mcp');
    // Dev Mode builds a local streamable-HTTP entry with no headers (uses the desktop session).
    const devEntry = buildServerEntry(dev);
    expect(devEntry.url).toBe('http://127.0.0.1:3845/mcp');
    expect(devEntry.streamable).toBe(true);
    expect(devEntry.headers).toBeUndefined();
  });

  it('Canva is an OAuth login server via the mcp-remote bridge', () => {
    const spec = findMcpSpec('canva')!;
    expect(spec.transport).toBe('stdio');
    expect(spec.auth).toBe('oauth');
    expect(spec.credentials).toEqual([]); // OAuth → no token on disk
    const entry = buildServerEntry(spec);
    const argsJoined = (entry.args ?? []).join(' ');
    expect(argsJoined).toContain('mcp-remote');
    expect(argsJoined).toContain('https://mcp.canva.com/mcp');
    expect(entry.destructive).toBe(true); // can create/edit/export designs
  });

  it('Browserbase is the hosted cloud browser and the key stays off argv', () => {
    const spec = findMcpSpec('browserbase')!;
    expect(spec.transport).toBe('stdio');
    expect(spec.auth).toBe('token');
    expect(spec.preserveArgEnvRefs).toBe(true);
    expect(spec.destructive).toBe(true);
    const joined = (spec.args ?? []).join(' ');
    expect(joined).toContain('mcp-remote@0.16.5');
    expect(joined).toContain('https://mcp.browserbase.com/mcp');
    expect(joined).toContain('--header');
    expect(joined).not.toContain('browserbaseApiKey=');

    const entry = buildServerEntry(spec, {
      secrets: { BROWSERBASE_API_KEY: 'bb_live_secret_value' },
      inlineToken: true,
    });
    const argsJoined = (entry.args ?? []).join(' ');
    expect(argsJoined).toContain('Authorization: Bearer ${BROWSERBASE_API_KEY}');
    expect(argsJoined).not.toContain('bb_live_secret_value');
    expect(entry.env?.BROWSERBASE_API_KEY).toBe('bb_live_secret_value');
    expect(entry.preserveArgEnvRefs).toBe(true);

    const spawned = expandEnvRefs({
      command: entry.command,
      args: entry.args,
      env: { BROWSERBASE_API_KEY: '${BROWSERBASE_API_KEY}' },
      preserveArgEnvRefs: true,
    }, 'browserbase');
    expect((spawned.args ?? []).join(' ')).toContain('${BROWSERBASE_API_KEY}');
    expect((spawned.args ?? []).join(' ')).not.toContain('bb_live_secret_value');

    const start = cloudBrowserAsk('mcp:browserbase:start');
    const act = cloudBrowserAsk('mcp:browserbase:act');
    expect(start).toBeTruthy();
    expect(act).toBeTruthy();
    expect(cloudBrowserAsk('mcp:browserbase:extract')).toBeNull();
    expect(cloudBrowserAsk('mcp:playwright:navigate')).toBeNull();
    expect(classifyAsk(start!).kind).toBe('spend');
    expect(classifyAsk(act!).kind).toBe('spend');
  });

  it('Gmail uses Google\'s official URL and never puts the client secret on argv', () => {
    const spec = findMcpSpec('gmail')!;
    expect(spec.auth).toBe('oauth');
    expect(spec.preserveArgEnvRefs).toBe(true);
    const joined = (spec.args ?? []).join(' ');
    expect(joined).toContain('mcp-remote@0.16.5');
    expect(joined).toContain('https://gmailmcp.googleapis.com/mcp/v1');
    expect(joined).toContain('4311');
    expect(joined).toContain('--transport http-only');
    expect(spec.note).toContain('http://localhost:4311/oauth/callback');
    expect(spec.description.toLowerCase()).toContain('does not send');

    const entry = buildServerEntry(spec, {
      secrets: {
        GOOGLE_OAUTH_CLIENT_ID: 'id.apps.googleusercontent.com',
        GOOGLE_OAUTH_CLIENT_SECRET: 'super-secret-value',
      },
      inlineToken: true,
    });
    const argsJoined = (entry.args ?? []).join(' ');
    expect(argsJoined).toContain('https://gmailmcp.googleapis.com/mcp/v1');
    expect(argsJoined).toContain('${GOOGLE_OAUTH_CLIENT_ID}');
    expect(argsJoined).toContain('${GOOGLE_OAUTH_CLIENT_SECRET}');
    expect(argsJoined).not.toContain('super-secret-value');
    expect(argsJoined).not.toContain('id.apps.googleusercontent.com');
    expect(entry.env?.GOOGLE_OAUTH_CLIENT_SECRET).toBe('super-secret-value');
    expect(entry.env?.GOOGLE_OAUTH_CLIENT_ID).toBe('id.apps.googleusercontent.com');
    expect(entry.preserveArgEnvRefs).toBe(true);
    // Without --inline the env stays a reference, still not a literal.
    const referenced = buildServerEntry(spec);
    expect(referenced.env?.GOOGLE_OAUTH_CLIENT_SECRET).toBe('${GOOGLE_OAUTH_CLIENT_SECRET}');
    expect(JSON.stringify(referenced.args)).not.toContain('super-secret-value');
  });

  it('Google product URLs are the official Workspace endpoints, each with its own port', () => {
    const expectUrl = (id: string, url: string, port: string) => {
      const spec = findMcpSpec(id)!;
      expect((spec.args ?? []).join(' ')).toContain(url);
      expect((spec.args ?? []).join(' ')).toContain(port);
      expect(spec.docs).toBe('https://developers.google.com/workspace/guides/configure-mcp-servers');
    };
    expectUrl('google-drive', 'https://drivemcp.googleapis.com/mcp/v1', '4312');
    expectUrl('google-calendar', 'https://calendarmcp.googleapis.com/mcp/v1', '4313');
    expectUrl('google-docs', 'https://docsmcp.googleapis.com/mcp/v1', '4314');
    expectUrl('google-sheets', 'https://sheetsmcp.googleapis.com/mcp/v1', '4315');
    expect(findMcpSpec('google-calendar')!.destructive).toBeUndefined();
  });

  it('Hotmail is the personal Graph server; work mode is a separate id', () => {
    const personal = findMcpSpec('hotmail')!;
    expect(personal.login).toBe('device-code');
    expect(personal.credentials).toEqual([]);
    const args = (personal.args ?? []).join(' ');
    expect(args).toContain('@softeria/ms-365-mcp-server');
    expect(args).toContain('--enable-auth-tools');
    expect(args).not.toContain('--org-mode');
    expect(personal.note).toContain('not Microsoft Copilot');
    const work = findMcpSpec('outlook-work')!;
    expect((work.args ?? []).join(' ')).toContain('--org-mode');
    expect(work.login).toBe('device-code');
  });

  it('Notion and Atlassian point at the vendors\' hosted MCP URLs', () => {
    expect((findMcpSpec('notion')!.args ?? []).join(' ')).toContain('https://mcp.notion.com/mcp');
    expect(findMcpSpec('notion')!.credentials).toEqual([]);
    expect((findMcpSpec('atlassian')!.args ?? []).join(' ')).toContain('https://mcp.atlassian.com/v2/mcp');
    expect((findMcpSpec('atlassian')!.args ?? []).join(' ')).not.toContain('/sse');
  });

  it('tavily uses the mcp-remote stdio bridge with the key in the URL via env ref', () => {
    const spec = findMcpSpec('tavily')!;
    expect(spec.transport).toBe('stdio');
    expect(spec.command).toBe('npx');
    const entry = buildServerEntry(spec, { secrets: { TAVILY_API_KEY: 'tvly-secret' } });
    // The hosted Tavily URL is reached through mcp-remote, with the key as an
    // env ref (NOT the literal secret) spliced into the query string.
    const argsJoined = (entry.args ?? []).join(' ');
    expect(argsJoined).toContain('mcp-remote');
    expect(argsJoined).toContain('https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}');
    expect(JSON.stringify(entry)).not.toContain('tvly-secret');
  });
});

describe('buildServerEntry', () => {
  it('remote+token writes an Authorization header with an env ref by default', () => {
    const spec = findMcpSpec('github')!;
    const entry = buildServerEntry(spec, { secrets: { GITHUB_PAT: 'ghp_secret' } });
    expect(entry.url).toBe('https://api.githubcopilot.com/mcp');
    expect(entry.headers?.Authorization).toBe('Bearer ${GITHUB_PAT}');
    // The literal secret must NOT appear in the config by default.
    expect(JSON.stringify(entry)).not.toContain('ghp_secret');
  });

  it('--inline writes the literal token instead of a ref', () => {
    const spec = findMcpSpec('github')!;
    const entry = buildServerEntry(spec, { secrets: { GITHUB_PAT: 'ghp_secret' }, inlineToken: true });
    expect(entry.headers?.Authorization).toBe('Bearer ghp_secret');
  });

  it('stdio+token exposes the credential as an env var ref', () => {
    const spec = findMcpSpec('supabase')!;
    const entry = buildServerEntry(spec);
    expect(entry.command).toBe('npx');
    expect(entry.args).toContain('@supabase/mcp-server-supabase@latest');
    expect(entry.env?.SUPABASE_ACCESS_TOKEN).toBe('${SUPABASE_ACCESS_TOKEN}');
  });

  it('stdio+connstr appends the connection string as an arg', () => {
    const spec = findMcpSpec('postgres')!;
    const entry = buildServerEntry(spec);
    expect(entry.args?.some(a => a.includes('${POSTGRES_CONNECTION_STRING}'))).toBe(true);
  });

  it('remote+oauth writes only the url, no headers', () => {
    const spec = findMcpSpec('sentry')!;
    const entry = buildServerEntry(spec);
    expect(entry.url).toBe('https://mcp.sentry.dev/mcp');
    expect(entry.headers).toBeUndefined();
  });

  it('no-auth stdio server has command/args and no env', () => {
    const spec = findMcpSpec('fetch')!;
    const entry = buildServerEntry(spec);
    expect(entry.command).toBe('npx');
    expect(entry.env).toBeUndefined();
  });

  it('destructive servers carry the destructive flag', () => {
    expect(buildServerEntry(findMcpSpec('github')!).destructive).toBe(true);
    expect(buildServerEntry(findMcpSpec('linear')!).destructive).toBe(true);
  });
});

describe('expandEnvRefs', () => {
  const SAVED = process.env.TEST_MCP_TOKEN;
  beforeEach(() => { process.env.TEST_MCP_TOKEN = 'resolved-value'; });
  afterEach(() => { if (SAVED === undefined) delete process.env.TEST_MCP_TOKEN; else process.env.TEST_MCP_TOKEN = SAVED; });

  it('resolves ${VAR} in env values', () => {
    const out = expandEnvRefs({ command: 'x', env: { TOKEN: '${TEST_MCP_TOKEN}' } } as any, 'test');
    expect(out.env?.TOKEN).toBe('resolved-value');
  });

  it('resolves ${VAR} inside header values and url', () => {
    const out = expandEnvRefs({
      url: 'https://api/${TEST_MCP_TOKEN}',
      headers: { Authorization: 'Bearer ${TEST_MCP_TOKEN}' },
    } as any, 'test');
    expect(out.url).toBe('https://api/resolved-value');
    expect(out.headers?.Authorization).toBe('Bearer resolved-value');
  });

  it('resolves ${VAR} in args', () => {
    const out = expandEnvRefs({ command: 'x', args: ['--token', '${TEST_MCP_TOKEN}'] } as any, 'test');
    expect(out.args).toEqual(['--token', 'resolved-value']);
  });

  it('missing var expands to empty string (not literal)', () => {
    const out = expandEnvRefs({ command: 'x', env: { K: '${DEFINITELY_UNSET_VAR_XYZ}' } } as any, 'test');
    expect(out.env?.K).toBe('');
  });

  it('does not mutate the input config', () => {
    const input = { command: 'x', env: { TOKEN: '${TEST_MCP_TOKEN}' } } as any;
    expandEnvRefs(input, 'test');
    expect(input.env.TOKEN).toBe('${TEST_MCP_TOKEN}'); // original untouched
  });

  it('preserveArgEnvRefs leaves ${VAR} in args and still expands env', () => {
    const out = expandEnvRefs({
      command: 'npx',
      args: ['--static-oauth-client-info', '{"client_secret":"${TEST_MCP_TOKEN}"}'],
      env: { TEST_MCP_TOKEN: '${TEST_MCP_TOKEN}' },
      preserveArgEnvRefs: true,
    } as any, 'gmail');
    expect(out.args?.[1]).toBe('{"client_secret":"${TEST_MCP_TOKEN}"}');
    expect(out.env?.TEST_MCP_TOKEN).toBe('resolved-value');
  });
});
