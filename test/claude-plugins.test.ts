import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  relevantPluginPaths,
  claudeCodeCommandDirs,
  claudeCodeSkillDirs,
  loadClaudeCodeAgents,
  mergeClaudeCodeAgentRoles,
  mergeClaudeCodePluginMcp,
  mergeClaudeCodePluginHooks,
} from '../src/integrations/claude-plugins.js';

describe('Claude Code plugin/asset discovery', () => {
  let tmpHome: string;
  let projectDir: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-cc-home-'));
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-cc-proj-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome; // os.homedir() reads $HOME on posix
    delete process.env.QODEX_DISABLE_CLAUDE_PLUGINS;

    // A user-scope plugin (applies everywhere) and a project-scope plugin (only its project).
    const userPluginPath = path.join(tmpHome, '.claude', 'plugins', 'cache', 'mp', 'userplug');
    const projPluginPath = path.join(tmpHome, '.claude', 'plugins', 'cache', 'mp', 'projplug');
    await fs.mkdir(path.join(userPluginPath, 'commands'), { recursive: true });
    await fs.mkdir(path.join(projPluginPath, 'commands'), { recursive: true });
    await fs.mkdir(path.join(tmpHome, '.claude', 'plugins'), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'userplug@mp': [{ scope: 'user', installPath: userPluginPath }],
          'projplug@mp': [{ scope: 'project', installPath: projPluginPath, projectPath: projectDir }],
        },
      }),
    );
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('user-scope plugins apply to any cwd; project-scope only to their project', async () => {
    const inProject = await relevantPluginPaths(projectDir);
    expect(inProject.map(p => p.name).sort()).toEqual(['projplug', 'userplug']);

    const elsewhere = await relevantPluginPaths('/some/unrelated/dir');
    expect(elsewhere.map(p => p.name)).toEqual(['userplug']); // project plugin excluded
  });

  it('command dirs include plugin commands + standalone .claude/commands', async () => {
    const dirs = await claudeCodeCommandDirs(projectDir);
    const paths = dirs.map(d => d.dir);
    // both plugins' command dirs present for the matching project
    expect(paths.some(p => p.includes(path.join('userplug', 'commands')))).toBe(true);
    expect(paths.some(p => p.includes(path.join('projplug', 'commands')))).toBe(true);
    // standalone roots
    expect(paths).toContain(path.join(tmpHome, '.claude', 'commands'));
    expect(paths).toContain(path.join(projectDir, '.claude', 'commands'));
    // plugin dirs are listed before standalone (lowest precedence first)
    expect(dirs[0]!.origin).toBe('plugin');
  });

  it('skill dirs mirror the same sources', async () => {
    const dirs = await claudeCodeSkillDirs(projectDir);
    const paths = dirs.map(d => d.dir);
    expect(paths.some(p => p.includes(path.join('userplug', 'skills')))).toBe(true);
    expect(paths).toContain(path.join(projectDir, '.claude', 'skills'));
  });

  it('QODEX_DISABLE_CLAUDE_PLUGINS=1 disables discovery', async () => {
    process.env.QODEX_DISABLE_CLAUDE_PLUGINS = '1';
    expect(await claudeCodeCommandDirs(projectDir)).toEqual([]);
    expect(await claudeCodeSkillDirs(projectDir)).toEqual([]);
    delete process.env.QODEX_DISABLE_CLAUDE_PLUGINS;
  });

  it('imports plugin agents as roles (body=systemPrompt, model inherited, tools mapped)', async () => {
    // Put an agent in the user-scope plugin
    const agentsDir = path.join(tmpHome, '.claude', 'plugins', 'cache', 'mp', 'userplug', 'agents');
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(path.join(agentsDir, 'code-reviewer.md'),
      '---\nname: code-reviewer\ndescription: Reviews code\nmodel: opus\ntools: Read, Grep, Bash\n---\nYou are an expert code reviewer.');

    const agents = await loadClaudeCodeAgents(projectDir);
    expect(Object.keys(agents)).toContain('code-reviewer');
    const r = agents['code-reviewer']!;
    expect(r.systemPrompt).toContain('expert code reviewer');
    expect(r.origin).toBe('plugin');
    expect(r.model).toBeUndefined();          // inherits (opus alias ignored)
    // Read/Grep/Bash → read_file/grep/shell+code_run
    expect(r.allowedTools).toEqual(expect.arrayContaining(['read_file', 'grep', 'shell']));
  });

  it('merge adds agent roles but never overwrites user-defined config roles', async () => {
    const agentsDir = path.join(tmpHome, '.claude', 'plugins', 'cache', 'mp', 'userplug', 'agents');
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(path.join(agentsDir, 'code-reviewer.md'),
      '---\nname: code-reviewer\n---\nPlugin reviewer prompt.');

    const config: any = { roles: { 'code-reviewer': { provider: 'ollama', model: 'mine', systemPrompt: 'USER OWN' } } };
    const added = await mergeClaudeCodeAgentRoles(config, projectDir);
    // user already had code-reviewer → not counted as added, and NOT overwritten
    expect(added).toBe(0);
    expect(config.roles['code-reviewer'].systemPrompt).toBe('USER OWN');
  });

  it('imports plugin MCP servers with ${CLAUDE_PLUGIN_ROOT} substituted', async () => {
    const root = path.join(tmpHome, '.claude', 'plugins', 'cache', 'mp', 'userplug');
    await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'userplug',
      mcpServers: {
        db: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], env: { TOKEN: '$DB_TOKEN' } },
      },
    }));

    const config: any = { mcp: { servers: {} } };
    const added = await mergeClaudeCodePluginMcp(config, projectDir);
    expect(added).toBe(1);
    const srv = config.mcp.servers['userplug:db'];
    expect(srv).toBeDefined();
    expect(srv.args[0]).toBe(path.join(root, 'server.js')); // placeholder substituted
    expect(srv.env.TOKEN).toBe('$DB_TOKEN'); // $VAR left for qodex's own expansion
  });

  it('imports + flattens nested plugin hooks into QodeX flat format', async () => {
    const root = path.join(tmpHome, '.claude', 'plugins', 'cache', 'mp', 'userplug');
    await fs.mkdir(path.join(root, 'hooks'), { recursive: true });
    await fs.writeFile(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({
      PreToolUse: [
        { matcher: 'Write|Edit', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/guard.sh', timeout: 10 }] },
      ],
      // Unsupported events are ignored
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'x' }] }],
    }));

    const config: any = { hooks: {} };
    const added = await mergeClaudeCodePluginHooks(config, projectDir);
    expect(added).toBe(1);
    const h = config.hooks.PreToolUse[0];
    expect(h.matcher).toBe('Write|Edit');
    expect(h.command).toBe(path.join(root, 'guard.sh'));
    expect(h.timeout).toBe(10);
    expect(h.blocking).toBe(false); // imported hooks never silently veto
    expect(config.hooks.UserPromptSubmit).toBeUndefined();
  });
});
