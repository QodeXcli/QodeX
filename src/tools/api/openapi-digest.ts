import { z } from 'zod';
import { promises as fs } from 'fs';
import yaml from 'js-yaml';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { proxyFetch } from '../../utils/proxy-fetch.js';

/**
 * `openapi_digest` — read an OpenAPI/Swagger spec (local file or URL, JSON or
 * YAML) and return a *condensed, structured* endpoint inventory: method, path,
 * summary, parameters (name/in/required/type), request body schema name, success
 * response schema name, and the security scheme each endpoint requires.
 *
 * Why: a raw spec is often 10k–100k lines — too big to drop into context and the
 * model ends up guessing parameter names. This digest gives the model the exact
 * surface (every path, every required param, the auth model) so it can generate a
 * frontend client (React hooks, fetch wrappers, typed DTOs) that matches the API
 * 100% instead of approximately. Read-only.
 */

const Args = z.object({
  source: z.string().describe('Path to a local openapi.json/.yaml, or an https URL to the spec.'),
  filter: z.string().optional().describe('Optional substring to filter paths, e.g. "/users" to only show user endpoints.'),
  include_schemas: z.boolean().optional().describe('Also list component schema names + their property names. Default false (paths only).'),
});

interface ParamInfo { name: string; in: string; required: boolean; type: string; }
interface EndpointInfo { method: string; path: string; summary?: string; params: ParamInfo[]; body?: string; success?: string; security?: string[]; }

function refName(ref: unknown): string | undefined {
  if (typeof ref === 'string') return ref.split('/').pop();
  return undefined;
}

function schemaLabel(schema: any): string {
  if (!schema) return 'any';
  if (schema.$ref) return refName(schema.$ref) ?? 'object';
  if (schema.type === 'array') return `${schemaLabel(schema.items)}[]`;
  return schema.type ?? (schema.properties ? 'object' : 'any');
}

export class OpenApiDigestTool extends Tool<z.infer<typeof Args>> {
  name = 'openapi_digest';
  description = 'Parse an OpenAPI/Swagger spec (local file or URL, JSON or YAML) into a condensed endpoint inventory: method, path, parameters (name/in/required/type), request + response schema names, and required auth. Use this BEFORE generating a frontend API client so endpoint and parameter names are exact, not guessed. Read-only.';
  isReadOnly = true; isDestructive = false; argsSchema = Args;

  async execute(a: z.infer<typeof Args>, _ctx: ToolContext): Promise<ToolResult> {
    let raw: string;
    try {
      if (/^https?:\/\//i.test(a.source)) {
        const res = await proxyFetch(a.source, { redirect: 'follow' });
        if (!res.ok) return { content: `Failed to fetch spec: HTTP ${res.status}`, isError: true };
        raw = await res.text();
      } else {
        raw = await fs.readFile(a.source, 'utf8');
      }
    } catch (e: any) {
      return { content: `Could not read spec source: ${e.message}`, isError: true };
    }

    let spec: any;
    try {
      spec = a.source.trim().endsWith('.json') || raw.trimStart().startsWith('{')
        ? JSON.parse(raw)
        : yaml.load(raw);
    } catch (e: any) {
      return { content: `Spec is not valid JSON/YAML: ${e.message}`, isError: true };
    }

    if (!spec || (!spec.paths && !spec.swagger && !spec.openapi)) {
      return { content: 'This does not look like an OpenAPI/Swagger document (no paths/openapi/swagger fields).', isError: true };
    }

    const version = spec.openapi ?? spec.swagger ?? 'unknown';
    const title = spec.info?.title ?? '(untitled)';
    const servers: string[] = (spec.servers ?? []).map((s: any) => s.url).filter(Boolean);
    const securitySchemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};

    const endpoints: EndpointInfo[] = [];
    const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
    for (const [p, item] of Object.entries<any>(spec.paths ?? {})) {
      if (a.filter && !p.includes(a.filter)) continue;
      for (const m of methods) {
        const op = item?.[m];
        if (!op) continue;
        const params: ParamInfo[] = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((pr: any) => ({
          name: pr.name, in: pr.in, required: !!pr.required,
          type: schemaLabel(pr.schema ?? pr),
        }));
        let body: string | undefined;
        if (op.requestBody) {
          const content = op.requestBody.content ?? {};
          const first = content['application/json'] ?? Object.values(content)[0];
          body = schemaLabel((first as any)?.schema);
        } else if (m === 'post' || m === 'put' || m === 'patch') {
          // Swagger 2.0 carries body in parameters with in:'body'.
          const b = params.find(pr => pr.in === 'body');
          if (b) body = b.type;
        }
        const responses = op.responses ?? {};
        const okKey = Object.keys(responses).find(k => k.startsWith('2')) ?? 'default';
        const okResp = responses[okKey];
        const okContent = okResp?.content?.['application/json'] ?? (okResp?.content ? Object.values(okResp.content)[0] : undefined);
        const success = schemaLabel((okContent as any)?.schema ?? okResp?.schema);
        const security: string[] | undefined = (op.security ?? spec.security)?.flatMap((s: any) => Object.keys(s));
        endpoints.push({ method: m.toUpperCase(), path: p, summary: op.summary, params, body, success, security });
      }
    }

    const lines: string[] = [];
    lines.push(`# ${title}  (OpenAPI ${version})`);
    if (servers.length) lines.push(`Servers: ${servers.join(', ')}`);
    if (Object.keys(securitySchemes).length) {
      const schemes = Object.entries<any>(securitySchemes).map(([k, v]) => `${k} (${v.type}${v.scheme ? '/' + v.scheme : ''})`);
      lines.push(`Auth schemes: ${schemes.join(', ')}`);
    }
    lines.push(`Endpoints: ${endpoints.length}${a.filter ? ` (filtered by "${a.filter}")` : ''}`);
    lines.push('');

    for (const e of endpoints) {
      lines.push(`${e.method} ${e.path}${e.summary ? `  — ${e.summary}` : ''}`);
      if (e.params.length) {
        for (const pr of e.params.filter(x => x.in !== 'body')) {
          lines.push(`    ${pr.required ? '*' : ' '} ${pr.name} (${pr.in}: ${pr.type})`);
        }
      }
      if (e.body) lines.push(`    → body: ${e.body}`);
      if (e.success) lines.push(`    ← 2xx: ${e.success}`);
      if (e.security?.length) lines.push(`    🔒 ${e.security.join(', ')}`);
      lines.push('');
    }

    if (a.include_schemas) {
      const schemas = spec.components?.schemas ?? spec.definitions ?? {};
      const names = Object.keys(schemas);
      if (names.length) {
        lines.push(`## Schemas (${names.length})`);
        for (const n of names) {
          const props = schemas[n]?.properties ? Object.keys(schemas[n].properties) : [];
          lines.push(`  ${n}: { ${props.join(', ')} }`);
        }
      }
    }

    return { content: lines.join('\n') };
  }
}
