import { config } from './config.js';

export type SupabaseRow = Record<string, unknown>;

function endpoint(table: string, query = ''): string {
  const baseUrl = config.supabase.url.replace(/\/+$/, '');
  return `${baseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`;
}

async function request<T>(table: string, init: RequestInit = {}, queryString = ''): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('apikey', config.supabase.serviceRoleKey);
  headers.set('authorization', `Bearer ${config.supabase.serviceRoleKey}`);
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json');
  const response = await fetch(endpoint(table, queryString), { ...init, headers });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null ? JSON.stringify(body) : String(body ?? '');
    throw new Error(`Supabase ${init.method ?? 'GET'} ${table} failed (${response.status}): ${detail}`);
  }
  return body as T;
}

function query(filters: Record<string, string>, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ ...filters, ...extra }).toString();
}

export async function select<T extends object>(table: string, filters: Record<string, string> = {}, extra: Record<string, string> = {}): Promise<T[]> {
  return request<T[]>(table, {}, query(filters, { select: '*', ...extra }));
}

export async function first<T extends object>(table: string, filters: Record<string, string> = {}, extra: Record<string, string> = {}): Promise<T | undefined> {
  const rows = await select<T>(table, filters, { ...extra, limit: '1' });
  return rows[0];
}

export async function insert<T extends object>(table: string, row: SupabaseRow): Promise<T> {
  const rows = await request<T[]>(table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!rows[0]) throw new Error(`Supabase insert into ${table} returned no row`);
  return rows[0];
}

export async function insertMany<T extends object>(table: string, rows: SupabaseRow[]): Promise<T[]> {
  if (!rows.length) return [];
  return request<T[]>(table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  });
}

export async function upsert<T extends object>(table: string, row: SupabaseRow, conflict = 'id'): Promise<T> {
  const rows = await request<T[]>(table, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  }, query({}, { on_conflict: conflict }));
  if (!rows[0]) throw new Error(`Supabase upsert into ${table} returned no row`);
  return rows[0];
}

export async function upsertMany<T extends object>(table: string, rows: SupabaseRow[], conflict = 'id'): Promise<T[]> {
  if (!rows.length) return [];
  return request<T[]>(table, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows),
  }, query({}, { on_conflict: conflict }));
}

export async function update(table: string, filters: Record<string, string>, patch: SupabaseRow): Promise<void> {
  await request(table, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  }, query(filters));
}

export async function remove(table: string, filters: Record<string, string>): Promise<void> {
  if (Object.keys(filters).length === 0) {
    throw new Error(`Supabase DELETE ${table} requires a filter`);
  }
  await request(table, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }, query(filters));
}

/** Verify that the configured Supabase project is reachable. */
export async function getDb(): Promise<void> {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for the database connection');
  }
  let parsed: URL;
  try { parsed = new URL(config.supabase.url); } catch { throw new Error('SUPABASE_URL must be a valid https:// URL'); }
  if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new Error('SUPABASE_URL must use https:// in production');
  }
  try {
    await select('users', {}, { select: 'id', limit: '1' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/failed \(401\).*Invalid API key/i.test(message)) {
      throw new Error('Supabase rejected SUPABASE_SERVICE_ROLE_KEY. Copy a fresh service_role/secret key from the same Supabase project into .env.');
    }
    throw error;
  }
}

/** PostgREST requests are individually atomic. Multi-row critical workflows
 * should use Supabase RPC functions when strict transactionality is required. */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

export async function resetDb(): Promise<void> {
  // PostgREST deliberately rejects an unrestricted DELETE. Every table uses
  // a non-null primary key, so this remains a full reset while still sending
  // an explicit WHERE clause. driver_status uses driver_id as its key.
  const tables: [string, string][] = [
    ['agent_events', 'id'], ['assignments', 'id'], ['routes', 'id'],
    ['deliveries', 'id'], ['order_items', 'id'], ['orders', 'id'],
    ['driver_locations', 'id'], ['driver_status', 'driver_id'],
    ['drivers', 'id'], ['stores', 'id'], ['customers', 'id'],
    ['merchants', 'id'], ['traffic_conditions', 'id'],
    ['road_segments', 'id'], ['users', 'id'],
  ];
  for (const [table, primaryKey] of tables) {
    await remove(table, { [primaryKey]: 'not.is.null' });
  }
}
