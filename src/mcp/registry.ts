/**
 * Curated registry of well-known MCP servers.
 *
 * Each entry knows how to configure ONE popular server: its transport (stdio
 * command vs remote URL), which credentials it needs, and a one-line auth hint
 * so the user knows where to get the token. `qodex mcp add <id>` reads this,
 * prompts for any required secrets, writes the entry into config.yaml under
 * `mcp.servers`, and (for OAuth servers) points the user at the browser flow.
 *
 * Sources verified against each vendor's official docs (May 2026). Where a
 * vendor offers BOTH a hosted remote endpoint and a local package, we prefer
 * the remote one when it uses OAuth (no long-lived token on disk) and the local
 * package otherwise.
 *
 * Auth models:
 *   - 'oauth'   : remote URL; the MCP client performs an OAuth handshake in the
 *                 browser on first connect. No token stored by us.
 *   - 'token'   : needs an API token / PAT in an env var (or header for remote).
 *   - 'none'    : no credentials (e.g. sequential-thinking, fetch).
 *   - 'connstr' : needs a connection string (Postgres).
 */

export type McpAuthModel = 'oauth' | 'token' | 'none' | 'connstr';

export interface McpCredential {
  /** Env var name (stdio) or the value injected into a header (remote). */
  envVar: string;
  /** Human label shown when prompting. */
  label: string;
  /** Where to get it. */
  hint: string;
  /** If true, prompt is optional (server works without it, with reduced scope). */
  optional?: boolean;
}

export interface McpServerSpec {
  id: string;
  title: string;
  description: string;
  /** 'stdio' (local command) or 'remote' (HTTP/SSE URL). */
  transport: 'stdio' | 'remote';
  auth: McpAuthModel;

  // stdio
  command?: string;
  args?: string[];
  /** Args that should have a credential value spliced in (e.g. --access-token <VALUE>). */
  tokenArgTemplate?: string[]; // use {TOKEN} placeholder

  // remote
  url?: string;
  /** Use the modern Streamable-HTTP transport (MCP 2025-03-26) instead of the old
   *  SSE endpoint-event handshake. For token/header/no-auth servers that hang on the
   *  old protocol; OAuth servers still use the mcp-remote stdio bridge. */
  streamable?: boolean;
  /** For 'token' remote servers: header name to carry the token, e.g. Authorization. */
  authHeader?: string;
  /** Format string for the header value, {TOKEN} replaced. e.g. "Bearer {TOKEN}". */
  authHeaderFormat?: string;

  /** Credentials this server needs. Empty for auth:'none' and pure OAuth. */
  credentials: McpCredential[];

  /** Tools here can mutate external state → require confirmation. */
  destructive?: boolean;

  /** Override the default MCP startup timeout (seconds). Useful for stdio bridges
   *  like `npx mcp-remote` whose FIRST run must download the package + negotiate
   *  OAuth before the handshake completes — otherwise a short timeout SIGTERMs it. */
  startupTimeoutSeconds?: number;

  /** Extra setup note shown after install. */
  note?: string;

  /** Docs URL. */
  docs?: string;
}

export const MCP_REGISTRY: McpServerSpec[] = [
  {
    id: 'github',
    title: 'GitHub',
    description: 'Read issues, review PRs, automate repo workflows without leaving the terminal.',
    transport: 'remote',
    auth: 'token',
    url: 'https://api.githubcopilot.com/mcp',
    authHeader: 'Authorization',
    authHeaderFormat: 'Bearer {TOKEN}',
    credentials: [{
      envVar: 'GITHUB_PAT',
      label: 'GitHub Personal Access Token',
      hint: 'Create at https://github.com/settings/personal-access-tokens (fine-grained; grant repo + issues + PR scopes).',
    }],
    destructive: true,
    note: 'Official GitHub remote MCP server. The legacy npm package @modelcontextprotocol/server-github is deprecated. A local Docker option (ghcr.io/github/github-mcp-server) also exists if you prefer not to use the hosted endpoint.',
    docs: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'supabase',
    title: 'Supabase',
    description: 'Full database + auth + storage access in one server.',
    transport: 'stdio',
    auth: 'token',
    command: 'npx',
    args: ['-y', '@supabase/mcp-server-supabase@latest'],
    credentials: [{
      envVar: 'SUPABASE_ACCESS_TOKEN',
      label: 'Supabase Access Token',
      hint: 'Generate at https://supabase.com/dashboard/account/tokens (account-level access token).',
    }],
    destructive: true,
    note: 'Official Supabase server. Pass --read-only in args if you want to forbid writes. Scope to one project with --project-ref=<ref>.',
    docs: 'https://supabase.com/docs/guides/getting-started/mcp',
  },
  {
    id: 'postgres',
    title: 'PostgreSQL',
    description: 'Query schemas and run SQL directly.',
    transport: 'stdio',
    auth: 'connstr',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    tokenArgTemplate: ['{TOKEN}'], // connection string appended as a positional arg
    credentials: [{
      envVar: 'POSTGRES_CONNECTION_STRING',
      label: 'PostgreSQL connection string',
      hint: 'Format: postgresql://user:pass@host:5432/dbname  — use a read-only role if you only need queries.',
    }],
    destructive: true,
    note: 'Connection string is passed as an argument. For QodeX-native DB access without MCP, the built-in db_query / db_schema tools also work.',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
  {
    id: 'playwright',
    title: 'Playwright',
    description: 'Browser automation for E2E testing or UI verification.',
    transport: 'stdio',
    auth: 'none',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    credentials: [],
    note: 'Microsoft\'s official Playwright MCP. QodeX also has built-in browser_* tools; use this when you want the model to drive Playwright directly via MCP.',
    docs: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'figma',
    title: 'Figma',
    description: 'Paste a frame link, get code that matches the actual design (tokens, layout, variants).',
    transport: 'stdio',
    auth: 'token',
    command: 'npx',
    args: ['-y', 'figma-developer-mcp', '--stdio'],
    credentials: [{
      envVar: 'FIGMA_API_KEY',
      label: 'Figma API access token',
      hint: 'Create at https://www.figma.com/developers/api#access-tokens (personal access token).',
    }],
    note: 'Figma also ships a Dev Mode MCP server (local, requires the desktop app + a paid Dev seat) at http://127.0.0.1:3845/sse — add that as a custom remote server if you have Dev Mode.',
    docs: 'https://github.com/GLips/Figma-Context-MCP',
  },
  {
    id: 'sentry',
    title: 'Sentry',
    description: 'Pull stack traces and error context without copy-pasting logs.',
    transport: 'remote',
    auth: 'oauth',
    url: 'https://mcp.sentry.dev/mcp',
    credentials: [],
    note: 'Official Sentry remote server with OAuth 2.0 — no token stored on disk. On first connect, your browser opens for authorization. Includes Seer AI root-cause analysis.',
    docs: 'https://github.com/getsentry/sentry-mcp',
  },
  {
    id: 'linear',
    title: 'Linear',
    description: 'Close the loop between your code and your issue tracker.',
    transport: 'remote',
    auth: 'oauth',
    url: 'https://mcp.linear.app/mcp',
    credentials: [],
    destructive: true,
    note: 'Official Linear remote server with OAuth. Browser opens on first connect to authorize your workspace.',
    docs: 'https://linear.app/docs/mcp',
  },
  {
    id: 'slack',
    title: 'Slack',
    description: 'Official server shipped in 2026; community forks are dead now.',
    transport: 'remote',
    auth: 'oauth',
    url: 'https://mcp.slack.com/mcp',
    credentials: [],
    destructive: true,
    note: 'Official Slack remote server with OAuth. Authorizes against your workspace in the browser. (The old community @modelcontextprotocol/server-slack with a bot token is deprecated.)',
    docs: 'https://api.slack.com/',
  },
  {
    id: 'sequential-thinking',
    title: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning — a real difference on hard debugging sessions.',
    transport: 'stdio',
    auth: 'none',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    credentials: [],
    note: 'No credentials. Gives the model an explicit scratchpad tool for multi-step problem decomposition.',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    id: 'brave-search',
    title: 'Brave Search',
    description: 'Let the model verify docs and package versions before writing code against them.',
    transport: 'stdio',
    auth: 'token',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    credentials: [{
      envVar: 'BRAVE_API_KEY',
      label: 'Brave Search API key',
      hint: 'Get a free key at https://brave.com/search/api/ (free tier: 2,000 queries/month).',
    }],
    note: 'QodeX also has built-in web_search; use this when you want Brave specifically via MCP.',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  {
    id: 'tavily',
    title: 'Tavily',
    description: 'LLM-optimized web search + full-page extract + site crawl/map — built for agents, returns clean markdown not raw HTML.',
    transport: 'stdio',
    auth: 'token',
    command: 'npx',
    args: ['-y', 'mcp-remote'],
    tokenArgTemplate: ['https://mcp.tavily.com/mcp/?tavilyApiKey={TOKEN}'],
    startupTimeoutSeconds: 60,
    credentials: [{
      envVar: 'TAVILY_API_KEY',
      label: 'Tavily API key',
      hint: 'Get a free key at https://app.tavily.com/home (free tier included). Format starts with tvly-.',
    }],
    note: 'Connects to Tavily\'s hosted MCP server via the mcp-remote stdio bridge (the method Tavily documents for generic clients — more robust than a direct streamable-HTTP connection, and friendlier on restricted networks). Gives the model tavily-search, tavily-extract, tavily-crawl and tavily-map. QodeX also supports Tavily as a built-in web_search backend just by exporting TAVILY_API_KEY — use that for plain search; use this MCP server when you also want full-page extract and site mapping (e.g. competitor SEO/GEO analysis). On a restricted network, route npx/mcp-remote through a proxy or Warp if the first connection times out.',
    docs: 'https://docs.tavily.com/documentation/mcp',
  },
  {
    id: 'fetch',
    title: 'Fetch',
    description: 'Fetch and convert web pages to markdown for the model to read.',
    transport: 'stdio',
    auth: 'none',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    credentials: [],
    note: 'No credentials. Pairs with Brave Search: search → fetch the result page.',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'higgsfield',
    title: 'Higgsfield',
    description: 'Image/video generation, Soul characters, Marketing Studio ad creatives.',
    transport: 'stdio',
    auth: 'oauth',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.higgsfield.ai/mcp'],
    credentials: [],
    note: 'Connects to Higgsfield\'s hosted MCP server via the mcp-remote stdio bridge — more robust than a direct connection (QodeX\'s HTTP+SSE transport speaks the OLDER SSE protocol and would hang on Higgsfield\'s streamable-HTTP endpoint). On first connect, mcp-remote opens a browser for the OAuth handshake and caches the token under ~/.mcp-auth, so later runs are silent. Exposes generate_image / generate_video, Soul character training, and Marketing Studio ad-creative tools as mcp:higgsfield:* tools. On a restricted network, route npx + the OAuth browser through a proxy or Warp.',
    docs: 'https://higgsfield.ai',
  },
];

export function findMcpSpec(id: string): McpServerSpec | undefined {
  const key = id.trim().toLowerCase();
  return MCP_REGISTRY.find(s => s.id === key || s.title.toLowerCase() === key);
}

export function listMcpSpecs(): McpServerSpec[] {
  return MCP_REGISTRY.slice();
}
