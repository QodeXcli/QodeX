import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolContext } from '../src/tools/base.js';
import { runProcess, notInstalledMessage } from '../src/utils/run-process.js';
import { OpenApiDigestTool } from '../src/tools/api/openapi-digest.js';
import { BackendRoutemapTool } from '../src/tools/backend/route-map.js';
import { ToolRegistry } from '../src/tools/registry.js';

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: 'test',
    transaction: {} as any,
    permissions: { evaluate: () => 'allow' } as any,
    askUser: async () => 'allow',
    signal: new AbortController().signal,
    emit: () => {},
  } as ToolContext;
}

describe('runProcess helper', () => {
  it('runs a present binary and captures stdout', async () => {
    // node is guaranteed present (the tests run under it).
    const r = await runProcess('node', ['--version']);
    expect(r.ok).toBe(true);
    expect(r.notFound).toBe(false);
    expect(r.stdout).toContain('v');
  }, 20_000); // spawns a real process; generous timeout so a loaded machine can't flake it

  it('reports notFound for a missing binary instead of throwing', async () => {
    const r = await runProcess('qodex_definitely_missing_bin_xyz', []);
    expect(r.notFound).toBe(true);
    expect(r.ok).toBe(false);
  }, 20_000); // also spawns; same reason

  it('notInstalledMessage names the binary and the hint', () => {
    const msg = notInstalledMessage('docker', 'install it');
    expect(msg).toContain('docker');
    expect(msg).toContain('install it');
  });
});

describe('openapi_digest', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oapi-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('parses an OpenAPI 3 spec into an endpoint inventory', async () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Pet API' },
      servers: [{ url: 'https://api.example.com' }],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        schemas: { Pet: { properties: { id: {}, name: {} } } },
      },
      paths: {
        '/pets': {
          get: {
            summary: 'List pets',
            parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
            responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
          },
          post: {
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
            security: [{ bearerAuth: [] }],
            responses: { '201': {} },
          },
        },
      },
    };
    const file = path.join(dir, 'openapi.json');
    await fs.writeFile(file, JSON.stringify(spec));
    const res = await new OpenApiDigestTool().execute({ source: file, include_schemas: true } as any, makeCtx(dir));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('Pet API');
    expect(res.content).toContain('GET /pets');
    expect(res.content).toContain('POST /pets');
    expect(res.content).toContain('limit (query: integer)');
    expect(res.content).toContain('body: Pet');
    expect(res.content).toContain('bearerAuth');     // security scheme surfaced
    expect(res.content).toContain('Pet: { id, name }'); // schema listing
  });

  it('rejects a non-OpenAPI document cleanly', async () => {
    const file = path.join(dir, 'not-a-spec.json');
    await fs.writeFile(file, JSON.stringify({ hello: 'world' }));
    const res = await new OpenApiDigestTool().execute({ source: file } as any, makeCtx(dir));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('does not look like');
  });
});

describe('backend_routemap', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routemap-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('extracts FastAPI routes and their handlers', async () => {
    const py = [
      'from fastapi import APIRouter',
      'router = APIRouter(prefix="/api")',
      '',
      '@router.get("/users")',
      'def list_users():',
      '    return []',
      '',
      '@router.post("/users")',
      'def create_user():',
      '    return {}',
    ].join('\n');
    await fs.writeFile(path.join(dir, 'routes.py'), py);
    const res = await new BackendRoutemapTool().execute({ dir } as any, makeCtx(dir));
    expect(res.content).toContain('fastapi');
    expect(res.content).toContain('GET');
    expect(res.content).toContain('/api/users');
    expect(res.content).toContain('list_users');
    expect(res.content).toContain('create_user');
  });

  it('extracts Django models and their fields', async () => {
    const py = [
      'from django.db import models',
      '',
      'class Product(models.Model):',
      '    name = models.CharField(max_length=200)',
      '    price = models.DecimalField(max_digits=10, decimal_places=2)',
      '    created = models.DateTimeField(auto_now_add=True)',
    ].join('\n');
    await fs.writeFile(path.join(dir, 'models.py'), py);
    const res = await new BackendRoutemapTool().execute({ dir } as any, makeCtx(dir));
    expect(res.content).toContain('Product');
    expect(res.content).toContain('name: CharField');
    expect(res.content).toContain('price: DecimalField');
  });
});

describe('infrastructure tools registered', () => {
  it('registers all 13 new infra tools', () => {
    const reg = new ToolRegistry();
    const names = reg.list().map((t: any) => t.name);
    for (const n of [
      'network_optimize',
      'docker_ps', 'docker_logs', 'docker_inspect', 'docker_exec', 'docker_build', 'docker_compose',
      'openapi_digest', 'backend_routemap',
      'media_probe', 'media_transform',
      's3_sync', 'ci_status',
    ]) {
      expect(names).toContain(n);
    }
  });
});
