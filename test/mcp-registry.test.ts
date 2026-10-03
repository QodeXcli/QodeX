import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServerEntry } from '../src/mcp/config-writer.js';
import { findMcpSpec, listMcpSpecs } from '../src/mcp/registry.js';
import { expandEnvRefs } from '../src/mcp/manager.js';

describe('MCP registry', () => {
  it('has all the well-known servers', () => {
    const ids = listMcpSpecs().map(s => s.id);
    for (const id of ['github', 'supabase', 'postgres', 'playwright', 'figma', 'sentry', 'linear', 'slack', 'sequential-thinking', 'brave-search', 'fetch', 'higgsfield', 'tavily']) {
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
});
