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

  /**
   * How the user signs in, when auth is 'oauth'.
   * 'browser' (default): mcp-remote opens a browser on connect.
   * 'device-code': the server prints a URL and a code (Hotmail / Outlook).
   */
  login?: 'browser' | 'device-code';

  /**
   * Write `${ENV}` into args and also pass the credential through env, so a
   * child that expands placeholders (mcp-remote --static-oauth-client-info)
   * never receives the secret on argv.
   */
  preserveArgEnvRefs?: boolean;
}

/**
 * Google's official Workspace MCP servers.
 * Checked against https://developers.google.com/workspace/guides/configure-mcp-servers
 * on 2026-11-06. One URL per product. No dynamic client registration — the user
 * brings an OAuth client marked for an AI agent. Ports are pinned so the
 * redirect URI in the note is the one mcp-remote will actually use
 * (http://localhost:<port>/oauth/callback).
 */
const GOOGLE_OAUTH_CLIENT: McpCredential[] = [
  {
    envVar: 'GOOGLE_OAUTH_CLIENT_ID',
    label: 'Google OAuth client id',
    hint: 'Google Auth Platform → Clients → Create. Type Web. Turn on "Use this client for an AI-powered agent". One client is reused by gmail, google-drive, google-calendar, google-docs, and google-sheets. Add each server\'s redirect URI (printed after add) to that client.',
  },
  {
    envVar: 'GOOGLE_OAUTH_CLIENT_SECRET',
    label: 'Google OAuth client secret',
    hint: 'Same client. QodeX does not include a client id or secret. Google rejects clients that are not in the Workspace Developer Preview Program.',
  },
];

function googleWorkspaceServer(opts: {
  id: string;
  title: string;
  description: string;
  url: string;
  port: number;
  scopes: string[];
  destructive?: boolean;
}): McpServerSpec {
  return {
    id: opts.id,
    title: opts.title,
    description: opts.description,
    transport: 'stdio',
    auth: 'oauth',
    command: 'npx',
    args: [
      '-y', 'mcp-remote@0.16.5', opts.url, String(opts.port),
      '--host', 'localhost', '--transport', 'http-only',
      '--static-oauth-client-info',
    ],
    tokenArgTemplate: [
      '{"client_id":"{GOOGLE_OAUTH_CLIENT_ID}","client_secret":"{GOOGLE_OAUTH_CLIENT_SECRET}"}',
      '--static-oauth-client-metadata',
      JSON.stringify({ scope: opts.scopes.join(' ') }),
    ],
    credentials: GOOGLE_OAUTH_CLIENT,
    preserveArgEnvRefs: true,
    destructive: opts.destructive,
    startupTimeoutSeconds: 90,
    note:
      `Official Google remote MCP (developer preview). Google does not allow dynamic client registration, and from 2026-11-11 it rejects OAuth clients that are not marked "Use this client for an AI-powered agent". Join the Workspace Developer Preview Program and enable the API. Export GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET — the same pair for every Google server. On that client add this redirect URI exactly: http://localhost:${opts.port}/oauth/callback. The secret stays in the environment; mcp-remote expands \${GOOGLE_OAUTH_CLIENT_SECRET} itself, so it is not put on the command line. If the preview rejects the client, the call fails. There is no second, silent login.`,
    docs: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
  };
}

function googleWorkspaceServers(): McpServerSpec[] {
  return [
    googleWorkspaceServer({
      id: 'gmail',
      title: 'Gmail',
      description: 'Search Gmail, read threads, and create drafts on the official server. That server does not send mail.',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      port: 4311,
      destructive: true,
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
      ],
    }),
    googleWorkspaceServer({
      id: 'google-drive',
      title: 'Google Drive',
      description: 'List and open Drive files, and create files the app is allowed to touch (drive.file).',
      url: 'https://drivemcp.googleapis.com/mcp/v1',
      port: 4312,
      destructive: true,
      scopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
      ],
    }),
    googleWorkspaceServer({
      id: 'google-calendar',
      title: 'Google Calendar',
      description: 'Read Google Calendar events. The scopes requested here are the read scopes on Google\'s configure page.',
      url: 'https://calendarmcp.googleapis.com/mcp/v1',
      port: 4313,
      scopes: [
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
        'https://www.googleapis.com/auth/calendar.events.freebusy',
        'https://www.googleapis.com/auth/calendar.events.readonly',
      ],
    }),
    googleWorkspaceServer({
      id: 'google-docs',
      title: 'Google Docs',
      description: 'Read and edit Google Docs through the official Docs MCP server.',
      url: 'https://docsmcp.googleapis.com/mcp/v1',
      port: 4314,
      destructive: true,
      scopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/documents',
      ],
    }),
    googleWorkspaceServer({
      id: 'google-sheets',
      title: 'Google Sheets',
      description: 'Read and edit Google Sheets through the official Sheets MCP server.',
      url: 'https://sheetsmcp.googleapis.com/mcp/v1',
      port: 4315,
      destructive: true,
      scopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/spreadsheets',
      ],
    }),
  ];
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
    note: 'Microsoft\'s official Playwright MCP. QodeX also has built-in browser_* tools; use this when you want the model to drive Playwright directly via MCP. This browser is local. A cloud browser is `browserbase`, and it needs your own API key.',
    docs: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'browserbase',
    title: 'Browserbase',
    description: 'A cloud browser on Browserbase\'s machines. Your API key. start and act still wait for a yes, because a session is billed and a click can submit.',
    transport: 'stdio',
    auth: 'token',
    command: 'npx',
    args: [
      '-y', 'mcp-remote@0.16.5',
      'https://mcp.browserbase.com/mcp',
      '--header',
      'Authorization: Bearer ${BROWSERBASE_API_KEY}',
    ],
    credentials: [{
      envVar: 'BROWSERBASE_API_KEY',
      label: 'Browserbase API key',
      hint: 'From https://www.browserbase.com/overview (dashboard). QodeX does not ship a key. A session is billed to that account. The hosted server runs Stagehand\'s default model, so a separate Gemini key is not required.',
    }],
    preserveArgEnvRefs: true,
    destructive: true,
    startupTimeoutSeconds: 90,
    note: 'Official hosted Browserbase MCP (https://mcp.browserbase.com/mcp) via mcp-remote, because QodeX does not speak streamable HTTP. The key stays in the environment; mcp-remote expands ${BROWSERBASE_API_KEY} inside the Authorization header, so the secret is not written onto the command line. Tools: start, end, navigate, act, observe, extract. start and act ask every time — always-yes does not cover them. If the key is missing or rejected, the call fails. There is no second browser and no rented VM of our own.',
    docs: 'https://docs.browserbase.com/integrations/mcp/setup',
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
    note: 'Token-based (third-party figma-developer-mcp): paste a Figma frame link, get matching code. Simplest path, no paid seat. For NO-token access use `figma-devmode` (your logged-in desktop app) or `figma-remote` (official hosted OAuth login).',
    docs: 'https://github.com/GLips/Figma-Context-MCP',
  },
  {
    id: 'figma-devmode',
    title: 'Figma (Dev Mode — local desktop)',
    description: 'Use your LOGGED-IN Figma desktop app directly — no token. Select a frame, the model reads it and generates matching code/variables.',
    transport: 'remote',
    auth: 'none',
    url: 'http://127.0.0.1:3845/mcp',
    streamable: true,
    credentials: [],
    note: 'Requires the Figma DESKTOP app running with the Dev Mode MCP server enabled (Figma menu → Preferences → "Enable Dev Mode MCP server") and a Dev or Full seat. No token: it uses your active desktop SESSION, so whatever you have open/selected is what the model sees — this IS "log in with your own Figma and authorize". Endpoint is local-only (127.0.0.1:3845); nothing leaves your machine.',
    docs: 'https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server',
  },
  {
    id: 'figma-remote',
    title: 'Figma (remote — OAuth login)',
    description: 'Official hosted Figma MCP. Log in to Figma in the browser and authorize — no desktop app, no token on disk.',
    transport: 'stdio',
    auth: 'oauth',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.figma.com/mcp'],
    credentials: [],
    startupTimeoutSeconds: 60,
    note: 'Connects to Figma\'s official hosted server via the mcp-remote stdio bridge, which runs the OAuth (mcp:connect) browser handshake and caches the token under ~/.mcp-auth. IMPORTANT: as of 2026 Figma restricts its remote MCP to clients on its approved MCP Catalog (waitlist) — if QodeX is not yet approved the handshake may be rejected; until then use `figma-devmode` (desktop) or `figma` (token). On a restricted network, route npx + the OAuth browser through a proxy.',
    docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
  },
  {
    id: 'canva',
    title: 'Canva',
    description: 'Create and edit Canva designs, autofill brand templates, export — driven by the model. Log in once and authorize.',
    transport: 'stdio',
    auth: 'oauth',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.canva.com/mcp'],
    credentials: [],
    destructive: true,
    startupTimeoutSeconds: 60,
    note: 'Official Canva remote MCP via the mcp-remote stdio bridge. On first connect a browser opens for Canva OAuth — Dynamic Client Registration, so each connection is a separately auditable/revocable client; the token caches under ~/.mcp-auth, later runs are silent. Same surface as the Canva Connect API (design create/edit, autofill brand templates, export). On a restricted network, route npx + the OAuth browser through a proxy or Warp.',
    docs: 'https://www.canva.dev/docs/connect/mcp-server/',
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
  ...googleWorkspaceServers(),
  {
    id: 'hotmail',
    title: 'Hotmail / Outlook',
    description: 'Hotmail, Outlook.com, and Live mail, plus the personal calendar and OneDrive. Device-code login. Does not send a password to QodeX.',
    transport: 'stdio',
    auth: 'oauth',
    login: 'device-code',
    command: 'npx',
    args: ['-y', '@softeria/ms-365-mcp-server', '--enable-auth-tools'],
    credentials: [],
    destructive: true,
    startupTimeoutSeconds: 60,
    note: 'Personal Microsoft accounts only, via @softeria/ms-365-mcp-server (Graph, device code). This is not Microsoft Copilot Work IQ and it does not need a Copilot license. On first use the model calls the server\'s login tool; you open the URL and enter the code. That server caches the token (OS keychain). QodeX does not store it. A work or school tenant is a different entry: qodex mcp add outlook-work.',
    docs: 'https://github.com/Softeria/ms-365-mcp-server',
  },
  {
    id: 'outlook-work',
    title: 'Outlook (work / school)',
    description: 'Microsoft 365 work or school: mail, calendar, Teams, SharePoint. Same package as hotmail, with --org-mode.',
    transport: 'stdio',
    auth: 'oauth',
    login: 'device-code',
    command: 'npx',
    args: ['-y', '@softeria/ms-365-mcp-server', '--enable-auth-tools', '--org-mode'],
    credentials: [],
    destructive: true,
    startupTimeoutSeconds: 60,
    note: 'Work or school tenant (--org-mode). An admin may have to consent to the Graph permissions. Personal Hotmail / Outlook.com stays on `hotmail`, which does not pass --org-mode. Login is still the device-code tool, not a password in the config.',
    docs: 'https://github.com/Softeria/ms-365-mcp-server',
  },
  {
    id: 'notion',
    title: 'Notion',
    description: 'Search and edit the Notion pages your user can already open. Browser login, no integration token.',
    transport: 'stdio',
    auth: 'oauth',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp'],
    credentials: [],
    destructive: true,
    startupTimeoutSeconds: 60,
    note: 'Official hosted Notion MCP (https://mcp.notion.com/mcp) via the mcp-remote stdio bridge. First connect opens a browser; the token caches under ~/.mcp-auth. The model sees what that Notion user can see, including edits. This is not the unmaintained open-source server that asked for an ntn_ integration secret.',
    docs: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
  },
  {
    id: 'atlassian',
    title: 'Jira / Confluence',
    description: 'Jira and Confluence through Atlassian\'s official remote MCP. Browser login.',
    transport: 'stdio',
    auth: 'oauth',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v2/mcp'],
    credentials: [],
    destructive: true,
    startupTimeoutSeconds: 60,
    note: 'Official Atlassian Rovo MCP at https://mcp.atlassian.com/v2/mcp (Jira, Confluence, Jira Service Management). OAuth runs in the browser through mcp-remote. The retired SSE endpoint is not used.',
    docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
  },
];

export function findMcpSpec(id: string): McpServerSpec | undefined {
  const key = id.trim().toLowerCase();
  return MCP_REGISTRY.find(s => s.id === key || s.title.toLowerCase() === key);
}

export function listMcpSpecs(): McpServerSpec[] {
  return MCP_REGISTRY.slice();
}
