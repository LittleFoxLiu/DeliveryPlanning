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

  // PGlite is a single embedded engine — concurrent .query() calls race and can
  // corrupt its page cache. Serialise every DB operation through one promise
  // chain. (Real Postgres uses a connection pool and needs none of this.)
  let gate: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = gate.then(fn, fn);
    gate = run.then(() => undefined, () => undefined);
    return run;
  };

  const wrap = (q: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }, direct = false): Querier => ({
    query: async (sql, params) => {
      const exec = async () => {
        const res = await q.query(toPg(sql), params as unknown[] | undefined);
        return { rows: normalizeRows(res.rows as never[]) };
      };
      // inside a transaction the queries are already ordered by the caller
      return direct ? exec() : serialize(exec);
    },
  });
  return {
    kind: 'pglite',
    raw: wrap(pg),
    exec: (sql) => serialize(() => pg.exec(sql)).then(() => undefined),
    transaction: (fn) => serialize(() => pg.transaction((tx) => fn(wrap(tx as never, true)))) as Promise<never>,
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
  await migrateLegacyLocationSchema();
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  if (!backend) return false;
  const rows = await backend.raw.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ? AND column_name = ?
     ) AS present`, [table, column]);
  return rows.rows[0]?.present === true;
}

async function hasConstraint(table: string, constraint: string): Promise<boolean> {
  if (!backend) return false;
  const rows = await backend.raw.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = 'public' AND r.relname = ? AND c.conname = ?
     ) AS present`, [table, constraint]);
  return rows.rows[0]?.present === true;
}

async function hasLegacyRoutePath(): Promise<boolean> {
  if (!backend || !(await hasColumn('routes', 'path_json'))) return false;
  const rows = await backend.raw.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM routes WHERE path_json::text LIKE ?) AS present`, ['%"x"%']);
  return rows.rows[0]?.present === true;
}

/** Move the pre-geocoding database forward without retaining synthetic
 * coordinates. Legacy rows without Nominatim coordinates intentionally become
 * unusable locations and are replaced by `npm run seed`; their old values are
 * never copied into the geographic columns. */
async function migrateLegacyLocationSchema(): Promise<void> {
  if (!backend) return;
  const run = async (sql: string, params: unknown[] = []) => backend!.raw.query(sql, params);

  const oldStore = await hasColumn('stores', 'pickup_lat');
  const oldDriverLocation = await hasColumn('driver_locations', 'lat');
  const oldOrder = await hasColumn('orders', 'delivery_lat');
  const oldRoute = await hasColumn('routes', 'origin_lat');
  const oldRoutePath = await hasLegacyRoutePath();

  if (oldStore) {
    await run('ALTER TABLE stores ADD COLUMN IF NOT EXISTS latitude double precision');
    await run('ALTER TABLE stores ADD COLUMN IF NOT EXISTS longitude double precision');
    await run('ALTER TABLE stores ADD COLUMN IF NOT EXISTS address text');
    if (await hasColumn('stores', 'geo_lat') && await hasColumn('stores', 'geo_lng')) {
      await run('UPDATE stores SET latitude = geo_lat, longitude = geo_lng WHERE geo_lat IS NOT NULL AND geo_lng IS NOT NULL');
    }
    await run('ALTER TABLE stores DROP COLUMN IF EXISTS pickup_lat');
    await run('ALTER TABLE stores DROP COLUMN IF EXISTS pickup_lng');
    await run('ALTER TABLE stores DROP COLUMN IF EXISTS geo_lat');
    await run('ALTER TABLE stores DROP COLUMN IF EXISTS geo_lng');
  }

  if (oldDriverLocation) {
    await run('ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS latitude double precision');
    await run('ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS longitude double precision');
    await run('ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS address text');
    if (await hasColumn('driver_locations', 'geo_lat') && await hasColumn('driver_locations', 'geo_lng')) {
      await run('UPDATE driver_locations SET latitude = geo_lat, longitude = geo_lng WHERE geo_lat IS NOT NULL AND geo_lng IS NOT NULL');
    }
    await run('ALTER TABLE driver_locations DROP COLUMN IF EXISTS lat');
    await run('ALTER TABLE driver_locations DROP COLUMN IF EXISTS lng');
    await run('ALTER TABLE driver_locations DROP COLUMN IF EXISTS geo_lat');
    await run('ALTER TABLE driver_locations DROP COLUMN IF EXISTS geo_lng');
  }

  if (oldOrder) {
    await run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_latitude double precision');
    await run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_longitude double precision');
    await run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_latitude double precision');
    await run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_longitude double precision');
    await run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address text');
    if (await hasColumn('orders', 'delivery_geo_lat') && await hasColumn('orders', 'delivery_geo_lng')) {
      await run('UPDATE orders SET delivery_latitude = delivery_geo_lat, delivery_longitude = delivery_geo_lng WHERE delivery_geo_lat IS NOT NULL AND delivery_geo_lng IS NOT NULL');
    }
    if (await hasColumn('stores', 'latitude') && await hasColumn('stores', 'longitude')) {
      await run(`UPDATE orders o SET pickup_latitude = s.latitude, pickup_longitude = s.longitude
                 FROM stores s WHERE s.id = o.store_id AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL`);
    }
    await run('ALTER TABLE orders DROP COLUMN IF EXISTS pickup_lat');
    await run('ALTER TABLE orders DROP COLUMN IF EXISTS pickup_lng');
    await run('ALTER TABLE orders DROP COLUMN IF EXISTS delivery_lat');
    await run('ALTER TABLE orders DROP COLUMN IF EXISTS delivery_lng');
    await run('ALTER TABLE orders DROP COLUMN IF EXISTS delivery_geo_lat');
    await run('ALTER TABLE orders DROP COLUMN IF EXISTS delivery_geo_lng');
  }

  if (oldRoute || oldRoutePath) {
    // The old path_json is synthetic geometry. It cannot be converted faithfully
    // to OSRM road geometry, so discard it while preserving delivery/order rows.
    await run('UPDATE deliveries SET route_id = NULL WHERE route_id IS NOT NULL');
    await run('DELETE FROM routes');
    await run('ALTER TABLE routes ADD COLUMN IF NOT EXISTS origin_latitude double precision');
    await run('ALTER TABLE routes ADD COLUMN IF NOT EXISTS origin_longitude double precision');
    await run('ALTER TABLE routes DROP COLUMN IF EXISTS origin_lat');
    await run('ALTER TABLE routes DROP COLUMN IF EXISTS origin_lng');
  }

  // Rows that never had a Nominatim result cannot be made geographic by
  // renaming their former values. Remove those stale demo rows instead.
  // This cleanup is deliberately repeated for partially migrated databases,
  // not just databases where a legacy column was detected.
  if (await hasColumn('orders', 'pickup_latitude') && await hasColumn('orders', 'delivery_latitude')
    && await hasColumn('stores', 'latitude')) {
    const invalidOrders = `(SELECT o.id FROM orders o
                            LEFT JOIN stores s ON s.id = o.store_id
                            WHERE o.pickup_latitude IS NULL OR o.pickup_longitude IS NULL
                              OR o.pickup_latitude NOT BETWEEN 1.22 AND 1.48 OR o.pickup_longitude NOT BETWEEN 103.60 AND 104.05
                              OR o.delivery_latitude IS NULL OR o.delivery_longitude IS NULL
                              OR o.delivery_latitude NOT BETWEEN 1.22 AND 1.48 OR o.delivery_longitude NOT BETWEEN 103.60 AND 104.05
                              OR o.delivery_address IS NULL
                              OR s.id IS NULL OR s.latitude IS NULL OR s.longitude IS NULL
                              OR s.latitude NOT BETWEEN 1.22 AND 1.48 OR s.longitude NOT BETWEEN 103.60 AND 104.05
                              OR s.address IS NULL)`;
    await run(`DELETE FROM agent_escalations WHERE order_id IN ${invalidOrders}`);
    await run(`DELETE FROM agent_events WHERE order_id IN ${invalidOrders}`);
    await run(`DELETE FROM agent_runs WHERE order_id IN ${invalidOrders}`);
    await run(`DELETE FROM assignments WHERE order_id IN ${invalidOrders}`);
    await run(`DELETE FROM order_items WHERE order_id IN ${invalidOrders}`);
    await run(`DELETE FROM routes WHERE delivery_id IN (SELECT id FROM deliveries WHERE order_id IN ${invalidOrders})`);
    await run(`DELETE FROM deliveries WHERE order_id IN ${invalidOrders}`);
    await run(`DELETE FROM orders WHERE id IN ${invalidOrders}`);
  }
  if (await hasColumn('stores', 'latitude')) {
    await run(`DELETE FROM join_requests WHERE target_store_id IN
               (SELECT id FROM stores WHERE latitude IS NULL OR longitude IS NULL OR address IS NULL
                OR latitude NOT BETWEEN 1.22 AND 1.48 OR longitude NOT BETWEEN 103.60 AND 104.05)`);
    await run(`DELETE FROM stores WHERE latitude IS NULL OR longitude IS NULL OR address IS NULL
               OR latitude NOT BETWEEN 1.22 AND 1.48 OR longitude NOT BETWEEN 103.60 AND 104.05`);
  }
  if (await hasColumn('driver_locations', 'latitude')) {
    await run(`DELETE FROM driver_locations WHERE latitude IS NULL OR longitude IS NULL
               OR latitude NOT BETWEEN 1.22 AND 1.48 OR longitude NOT BETWEEN 103.60 AND 104.05`);
  }
  if (await hasColumn('routes', 'origin_latitude')) {
    await run(`DELETE FROM routes WHERE origin_latitude IS NULL OR origin_longitude IS NULL
               OR origin_latitude NOT BETWEEN 1.22 AND 1.48 OR origin_longitude NOT BETWEEN 103.60 AND 104.05`);
  }
  if (await hasColumn('routes', 'traffic_penalty_minutes')) {
    await run('ALTER TABLE routes DROP COLUMN traffic_penalty_minutes');
  }
  if (await hasColumn('stores', 'latitude')) {
    await run('ALTER TABLE stores ALTER COLUMN latitude SET NOT NULL');
    await run('ALTER TABLE stores ALTER COLUMN longitude SET NOT NULL');
    await run('ALTER TABLE stores ALTER COLUMN address SET NOT NULL');
  }
  if (await hasColumn('driver_locations', 'latitude')) {
    await run('ALTER TABLE driver_locations ALTER COLUMN latitude SET NOT NULL');
    await run('ALTER TABLE driver_locations ALTER COLUMN longitude SET NOT NULL');
  }
  if (await hasColumn('orders', 'pickup_latitude')) {
    await run('ALTER TABLE orders ALTER COLUMN pickup_latitude SET NOT NULL');
    await run('ALTER TABLE orders ALTER COLUMN pickup_longitude SET NOT NULL');
    await run('ALTER TABLE orders ALTER COLUMN delivery_latitude SET NOT NULL');
    await run('ALTER TABLE orders ALTER COLUMN delivery_longitude SET NOT NULL');
    await run('ALTER TABLE orders ALTER COLUMN delivery_address SET NOT NULL');
  }
  if (await hasColumn('routes', 'origin_latitude')) {
    await run('ALTER TABLE routes ALTER COLUMN origin_latitude SET NOT NULL');
    await run('ALTER TABLE routes ALTER COLUMN origin_longitude SET NOT NULL');
  }

  const addSingaporeCheck = async (table: string, name: string, expression: string) => {
    if (!(await hasConstraint(table, name))) {
      await run(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expression})`);
    }
  };
  if (await hasColumn('stores', 'latitude')) {
    await addSingaporeCheck('stores', 'stores_singapore_bounds', 'latitude BETWEEN 1.22 AND 1.48 AND longitude BETWEEN 103.60 AND 104.05');
  }
  if (await hasColumn('driver_locations', 'latitude')) {
    await addSingaporeCheck('driver_locations', 'driver_locations_singapore_bounds', 'latitude BETWEEN 1.22 AND 1.48 AND longitude BETWEEN 103.60 AND 104.05');
  }
  if (await hasColumn('orders', 'pickup_latitude')) {
    await addSingaporeCheck('orders', 'orders_pickup_singapore_bounds', 'pickup_latitude BETWEEN 1.22 AND 1.48 AND pickup_longitude BETWEEN 103.60 AND 104.05');
    await addSingaporeCheck('orders', 'orders_delivery_singapore_bounds', 'delivery_latitude BETWEEN 1.22 AND 1.48 AND delivery_longitude BETWEEN 103.60 AND 104.05');
  }
  if (await hasColumn('routes', 'origin_latitude')) {
    await addSingaporeCheck('routes', 'routes_singapore_bounds', 'origin_latitude BETWEEN 1.22 AND 1.48 AND origin_longitude BETWEEN 103.60 AND 104.05');
  }

  // The road graph and area traffic rows only described the removed synthetic
  // network. OSRM now owns route geometry and travel duration.
  await run('DROP TABLE IF EXISTS traffic_conditions');
  await run('DROP TABLE IF EXISTS road_segments');
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
