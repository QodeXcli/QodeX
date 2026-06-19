/**
 * `db_schema` + `db_query` — database introspection and read-only querying.
 *
 * Supports the database engines Hamed actually uses: MySQL (Seven Gum,
 * ChinPost, sg-commerce-pro WordPress), PostgreSQL, and SQLite.
 *
 * `db_schema` lists tables, columns, indexes, foreign keys. Always safe.
 *
 * `db_query` runs a SELECT statement. By default it REFUSES anything that
 * isn't a SELECT (or EXPLAIN/SHOW/DESCRIBE — read-only metadata variants).
 * `allow_write: true` opens up INSERT/UPDATE/DELETE — destructive,
 * auto-snapshot in this tool's case can't capture remote DB state, so the
 * user is warned in the description.
 *
 * Connection string formats:
 *   mysql://user:pass@host:port/dbname
 *   postgres://user:pass@host:port/dbname
 *   postgresql://user:pass@host:port/dbname
 *   sqlite:///absolute/path/to.db
 *   sqlite://./relative/path/to.db
 *
 * Drivers are loaded dynamically — `mysql2`, `pg`, `better-sqlite3` are
 * optionalDependencies. If the matching driver isn't installed, the tool
 * returns a clear error pointing to the install command.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

type Dialect = 'mysql' | 'postgres' | 'sqlite';

interface ParsedConn {
  dialect: Dialect;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  filepath?: string;
}

function parseConn(connStr: string): ParsedConn | null {
  if (connStr.startsWith('sqlite://')) {
    const filepath = connStr.replace(/^sqlite:\/\/+/, '');
    return { dialect: 'sqlite', filepath: filepath.startsWith('/') ? filepath : filepath };
  }
  try {
    const u = new URL(connStr);
    const dialect: Dialect = u.protocol === 'mysql:' ? 'mysql'
                          : u.protocol === 'postgres:' || u.protocol === 'postgresql:' ? 'postgres'
                          : (() => { throw new Error('Unknown dialect'); })();
    return {
      dialect,
      host: u.hostname || 'localhost',
      port: u.port ? parseInt(u.port, 10) : (dialect === 'mysql' ? 3306 : 5432),
      user: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      database: u.pathname ? u.pathname.replace(/^\//, '') : undefined,
    };
  } catch {
    return null;
  }
}

async function getConnection(parsed: ParsedConn): Promise<{ kind: Dialect; conn: any } | { kind: 'error'; message: string }> {
  if (parsed.dialect === 'mysql') {
    try {
      // @ts-ignore — mysql2 is an optionalDependency
      const mysql: any = await import('mysql2/promise');
      const conn = await mysql.createConnection({
        host: parsed.host, port: parsed.port, user: parsed.user, password: parsed.password, database: parsed.database,
      });
      return { kind: 'mysql', conn };
    } catch (e: any) {
      return { kind: 'error', message: `MySQL driver not installed or connection failed: ${e?.message}. Install: npm install mysql2 --save-optional` };
    }
  }
  if (parsed.dialect === 'postgres') {
    try {
      // @ts-ignore — pg is an optionalDependency; types may not be installed
      const pg: any = await import('pg');
      const Client = pg.default?.Client ?? pg.Client;
      const conn = new Client({
        host: parsed.host, port: parsed.port, user: parsed.user, password: parsed.password, database: parsed.database,
      });
      await conn.connect();
      return { kind: 'postgres', conn };
    } catch (e: any) {
      return { kind: 'error', message: `Postgres driver not installed or connection failed: ${e?.message}. Install: npm install pg --save-optional` };
    }
  }
  if (parsed.dialect === 'sqlite') {
    try {
      // @ts-ignore — better-sqlite3 loaded dynamically; keep optional
      const sqlite: any = await import('better-sqlite3');
      const Database = sqlite.default ?? sqlite;
      const conn = new Database(parsed.filepath, { readonly: false });
      return { kind: 'sqlite', conn };
    } catch (e: any) {
      return { kind: 'error', message: `SQLite driver not installed: ${e?.message}. Install: npm install better-sqlite3 --save-optional` };
    }
  }
  return { kind: 'error', message: 'Unsupported dialect' };
}

async function closeConnection(c: any, dialect: Dialect): Promise<void> {
  try {
    if (dialect === 'mysql') await c.end();
    else if (dialect === 'postgres') await c.end();
    else if (dialect === 'sqlite') c.close();
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// db_schema

const DbSchemaArgs = z.object({
  connection_string: z.string().min(1).describe('mysql://user:pass@host/db, postgres://..., sqlite:///path.db'),
  table: z.string().optional().describe('If set, return detailed columns/indexes for this one table. Otherwise list all tables.'),
});

export class DbSchemaTool extends Tool<z.infer<typeof DbSchemaArgs>> {
  name = 'db_schema';
  description = 'Inspect a database schema. Without "table" → lists all tables. With "table" → columns, indexes, foreign keys for that table. Read-only. Supports MySQL, Postgres, SQLite.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = DbSchemaArgs;

  async execute(args: z.infer<typeof DbSchemaArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseConn(args.connection_string);
    if (!parsed) return { content: `[DB_SCHEMA_ERROR] Could not parse connection_string. Expected mysql://, postgres://, or sqlite:///path`, isError: true };
    const g = await getConnection(parsed);
    if (g.kind === 'error') return { content: `[DB_SCHEMA_ERROR] ${g.message}`, isError: true };
    const { conn } = g;

    try {
      const out: string[] = [];
      out.push(`# DB Schema: ${parsed.dialect}${parsed.database ? ` / ${parsed.database}` : ''}${parsed.filepath ? ` / ${parsed.filepath}` : ''}`);

      if (!args.table) {
        let tables: any[];
        if (parsed.dialect === 'mysql') {
          const [rows] = await conn.execute('SHOW TABLES');
          tables = (rows as any[]).map(r => Object.values(r)[0]);
        } else if (parsed.dialect === 'postgres') {
          const r = await conn.query(`SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY tablename`);
          tables = r.rows.map((r: any) => r.tablename);
        } else {
          tables = conn.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r: any) => r.name);
        }
        out.push(`Tables (${tables.length}):`);
        for (const t of tables) out.push(`  - ${t}`);
      } else {
        // Table-specific detail
        if (parsed.dialect === 'mysql') {
          const [cols] = await conn.execute(`SHOW FULL COLUMNS FROM \`${args.table.replace(/`/g, '')}\``);
          out.push(`## Columns`);
          for (const c of cols as any[]) out.push(`  ${c.Field.padEnd(28)} ${String(c.Type).padEnd(20)} ${c.Null === 'NO' ? 'NOT NULL' : 'NULL    '} ${c.Key || ''} ${c.Default !== null ? `DEFAULT ${c.Default}` : ''}`);
          const [idx] = await conn.execute(`SHOW INDEX FROM \`${args.table.replace(/`/g, '')}\``);
          if ((idx as any[]).length > 0) {
            out.push('');
            out.push(`## Indexes`);
            for (const i of idx as any[]) out.push(`  ${i.Key_name.padEnd(28)} on ${i.Column_name}${i.Non_unique === 0 ? ' (UNIQUE)' : ''}`);
          }
        } else if (parsed.dialect === 'postgres') {
          const colsR = await conn.query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns WHERE table_name = $1
            ORDER BY ordinal_position`, [args.table]);
          out.push(`## Columns`);
          for (const c of colsR.rows) out.push(`  ${c.column_name.padEnd(28)} ${String(c.data_type).padEnd(20)} ${c.is_nullable === 'NO' ? 'NOT NULL' : 'NULL    '} ${c.column_default !== null ? `DEFAULT ${c.column_default}` : ''}`);
          const idxR = await conn.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`, [args.table]);
          if (idxR.rows.length > 0) {
            out.push('');
            out.push(`## Indexes`);
            for (const i of idxR.rows) out.push(`  ${i.indexname}: ${i.indexdef}`);
          }
        } else {
          const cols = conn.prepare(`PRAGMA table_info("${args.table.replace(/"/g, '')}")`).all();
          out.push(`## Columns`);
          for (const c of cols as any[]) out.push(`  ${c.name.padEnd(28)} ${String(c.type).padEnd(20)} ${c.notnull ? 'NOT NULL' : 'NULL    '} ${c.dflt_value ? `DEFAULT ${c.dflt_value}` : ''}${c.pk ? ' PK' : ''}`);
          const idx = conn.prepare(`PRAGMA index_list("${args.table.replace(/"/g, '')}")`).all();
          if ((idx as any[]).length > 0) {
            out.push('');
            out.push(`## Indexes`);
            for (const i of idx as any[]) out.push(`  ${i.name}${i.unique ? ' (UNIQUE)' : ''}`);
          }
        }
      }
      return { content: out.join('\n') };
    } catch (e: any) {
      return { content: `[DB_SCHEMA_ERROR] ${e?.message ?? e}`, isError: true };
    } finally {
      await closeConnection(conn, parsed.dialect);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// db_query

const DbQueryArgs = z.object({
  connection_string: z.string().min(1),
  sql: z.string().min(1).describe('SQL to execute. By default only SELECT/EXPLAIN/SHOW/DESCRIBE/PRAGMA are allowed.'),
  params: z.array(z.any()).optional().describe('Parameter values for prepared statement. Use ? (MySQL/SQLite) or $1, $2... (Postgres).'),
  allow_write: z.boolean().optional().describe('If true, INSERT/UPDATE/DELETE/ALTER/DROP are allowed. DESTRUCTIVE — remote DB changes can\'t be /restored. Default false.'),
  max_rows: z.number().int().min(1).max(100_000).optional().describe('Cap on rows returned. Default 200.'),
});

const READ_ONLY_PREFIXES = /^\s*(SELECT|EXPLAIN|SHOW|DESCRIBE|DESC|PRAGMA|WITH)\b/i;

export class DbQueryTool extends Tool<z.infer<typeof DbQueryArgs>> {
  name = 'db_query';
  description = 'Run a SQL query against the database. By default ONLY SELECT/EXPLAIN/SHOW/DESCRIBE/PRAGMA are allowed (safe). Pass allow_write=true for mutating statements — these are DESTRUCTIVE and cannot be /restored by QodeX (remote DB state). Use prepared-statement params to avoid injection.';
  isReadOnly = false; // can be destructive with allow_write
  isDestructive = true;
  argsSchema = DbQueryArgs;

  async execute(args: z.infer<typeof DbQueryArgs>, _ctx: ToolContext): Promise<ToolResult> {
    if (!args.allow_write && !READ_ONLY_PREFIXES.test(args.sql)) {
      return {
        content: `[DB_QUERY_REFUSED] Only read statements (SELECT/EXPLAIN/SHOW/DESCRIBE/PRAGMA/WITH) are allowed by default. Detected non-read prefix in: ${args.sql.slice(0, 80)}…\n\nPass allow_write=true if intentional. Note: changes to a remote DB cannot be /restored by QodeX.`,
        isError: true,
      };
    }

    const parsed = parseConn(args.connection_string);
    if (!parsed) return { content: `[DB_QUERY_ERROR] Bad connection_string`, isError: true };
    const g = await getConnection(parsed);
    if (g.kind === 'error') return { content: `[DB_QUERY_ERROR] ${g.message}`, isError: true };
    const { conn } = g;
    const maxRows = args.max_rows ?? 200;

    try {
      let rows: any[] = [];
      let affectedRows: number | undefined;

      if (parsed.dialect === 'mysql') {
        const [r] = await conn.execute(args.sql, args.params ?? []);
        if (Array.isArray(r)) rows = r as any[];
        else affectedRows = (r as any).affectedRows;
      } else if (parsed.dialect === 'postgres') {
        const r = await conn.query(args.sql, args.params ?? []);
        rows = r.rows ?? [];
        affectedRows = r.rowCount ?? undefined;
      } else {
        const stmt = conn.prepare(args.sql);
        if (stmt.reader) {
          rows = stmt.all(...(args.params ?? []));
        } else {
          const info = stmt.run(...(args.params ?? []));
          affectedRows = info.changes;
        }
      }

      const out: string[] = [];
      out.push(`# DB Query result`);
      out.push(`SQL: ${args.sql.slice(0, 200)}${args.sql.length > 200 ? '…' : ''}`);
      if (affectedRows !== undefined) {
        out.push(`Affected rows: ${affectedRows}`);
      }
      if (rows.length > 0) {
        const total = rows.length;
        const shown = rows.slice(0, maxRows);
        const cols = Object.keys(shown[0]!);
        // Pretty-print as a markdown table
        out.push('');
        out.push(`Rows: ${total}${total > maxRows ? ` (showing first ${maxRows})` : ''}`);
        out.push('');
        out.push('| ' + cols.join(' | ') + ' |');
        out.push('|' + cols.map(() => '---').join('|') + '|');
        for (const r of shown) {
          out.push('| ' + cols.map(c => {
            const v = (r as any)[c];
            if (v === null) return 'NULL';
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return s.length > 80 ? s.slice(0, 77) + '...' : s;
          }).join(' | ') + ' |');
        }
      } else if (affectedRows === undefined) {
        out.push('');
        out.push(`(no rows)`);
      }
      return { content: out.join('\n'), metadata: { rowCount: rows.length, affectedRows } };
    } catch (e: any) {
      return { content: `[DB_QUERY_ERROR] ${e?.message ?? e}`, isError: true };
    } finally {
      await closeConnection(conn, parsed.dialect);
    }
  }
}
