import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { SCHEMA_SQL, TABLES } from './schema.js';

/** Minimal querier both PGlite and node-postgres satisfy. */
export interface Querier {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface Backend {
  raw: Querier;
  transaction<T>(fn: (q: Querier) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: 'pglite' | 'postgres';
}

const txStore = new AsyncLocalStorage<Querier>();
let backend: Backend | null = null;

/** `?` placeholders → `$1,$2,...` so repo code stays terse. */
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/** Postgres returns Date objects / bigint strings; normalise to the shapes the
 *  rest of the app (and the browser) expect: ISO strings and JS numbers. */
function normalizeRows<T>(rows: T[]): T[] {
  for (const row of rows as Record<string, unknown>[]) {
    for (const k in row) {
      const v = row[k];
      if (v instanceof Date) row[k] = v.toISOString();
      else if (typeof v === 'bigint') row[k] = Number(v);
    }
  }
  return rows;
}

async function makePglite(): Promise<Backend> {
  const { PGlite } = await import('@electric-sql/pglite');
  const loc = config.dbFile === ':memory:' ? undefined : `file://${config.dbFile}`;
  if (loc && config.dbFile !== ':memory:') mkdirSync(dirname(config.dbFile), { recursive: true });
  const pg = new PGlite(loc);
  await pg.waitReady;
  const wrap = (q: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Querier => ({
    query: async (sql, params) => {
      const res = await q.query(toPg(sql), params as unknown[] | undefined);
      return { rows: normalizeRows(res.rows as never[]) };
    },
  });
  return {
    kind: 'pglite',
    raw: wrap(pg),
    exec: (sql) => pg.exec(sql).then(() => undefined),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx as never))) as Promise<never>,
    close: () => pg.close(),
  };
}

async function makePostgres(url: string): Promise<Backend> {
  const pgMod = await import('pg');
  const PoolCtor = (pgMod.default ?? pgMod).Pool;
  const types = (pgMod.default ?? pgMod).types;
  types.setTypeParser(20, (v: string) => parseInt(v, 10)); // int8 → number
  types.setTypeParser(1114, (v: string) => v);             // timestamp → raw string
  types.setTypeParser(1184, (v: string) => v);             // timestamptz → raw string
  const needsSsl = !/sslmode=disable/.test(url) && (/supabase|sslmode=require|neon\.tech|render\.com/.test(url) || process.env.PGSSL === '1');
  const pool = new PoolCtor({
    connectionString: url,
    max: 8,
    idleTimeoutMillis: 30_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Querier => ({
    query: async (sql, params) => {
      const res = await c.query(toPg(sql), params as unknown[] | undefined);
      return { rows: normalizeRows(res.rows as never[]) };
    },
  });
  return {
    kind: 'postgres',
    raw: wrap(pool),
    exec: async (sql) => { await pool.query(sql); },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function initDb(): Promise<void> {
  if (backend) return;
  if (config.databaseUrl) {
    backend = await makePostgres(config.databaseUrl);
    try {
      await backend.raw.query('SELECT 1');
    } catch (err) {
      const host = config.databaseUrl.replace(/:[^:@/]+@/, ':***@');
      throw new Error(
        `Could not connect to DATABASE_URL (${host}).\n`
        + `  • Check the password is filled in and correct.\n`
        + `  • Use the Direct or Session-pooler connection (port 5432), not the transaction pooler (6543).\n`
        + `  • Original error: ${(err as Error).message}`,
      );
    }
  } else {
    backend = await makePglite();
  }
  await backend.exec(SCHEMA_SQL);
}

export function dbKind(): 'pglite' | 'postgres' {
  return backend?.kind ?? 'pglite';
}

/** Run a query on the ambient transaction if one is active, else the pool. */
export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!backend) throw new Error('initDb() not called');
  const querier = txStore.getStore() ?? backend.raw;
  const res = await querier.query<T>(sql, params);
  return res.rows;
}

export async function q1<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(sql, params))[0];
}

/** Execute `fn` atomically. Nested calls join the outer transaction. */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (!backend) throw new Error('initDb() not called');
  if (txStore.getStore()) return fn();
  return backend.transaction((querier) => txStore.run(querier, fn));
}

export async function resetDb(): Promise<void> {
  if (!backend) throw new Error('initDb() not called');
  await backend.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE;`);
}

export async function closeDb(): Promise<void> {
  await backend?.close();
  backend = null;
}
