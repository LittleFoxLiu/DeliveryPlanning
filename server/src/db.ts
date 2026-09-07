import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','merchant','driver','customer')),
  name TEXT NOT NULL,
  ref_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  name TEXT NOT NULL,
  pickup_lat REAL NOT NULL,
  pickup_lng REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('bike','car','van','truck')),
  capacity INTEGER NOT NULL,
  max_package_size TEXT NOT NULL CHECK (max_package_size IN ('small','medium','large')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_status (
  driver_id TEXT PRIMARY KEY REFERENCES drivers(id),
  status TEXT NOT NULL CHECK (status IN ('available','on_route','break','offline')),
  current_order_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_driver_locations_driver ON driver_locations(driver_id, id DESC);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  pickup_lat REAL NOT NULL,
  pickup_lng REAL NOT NULL,
  delivery_lat REAL NOT NULL,
  delivery_lng REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','ready','validated','dispatching','assigned','picked_up','delivering','delivered','cancelled','failed')),
  priority TEXT NOT NULL DEFAULT 'standard' CHECK (priority IN ('standard','express')),
  deadline_ts TEXT NOT NULL,
  package_size TEXT NOT NULL CHECK (package_size IN ('small','medium','large')),
  volume INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ready_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  driver_id TEXT REFERENCES drivers(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','assigned','en_route_pickup','picked_up','en_route_drop','delivered','cancelled','failed')),
  assigned_at TEXT,
  pickup_at TEXT,
  delivered_at TEXT,
  estimated_delivery_minutes REAL,
  actual_delivery_minutes REAL,
  eta_ts TEXT,
  route_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  origin_lat REAL NOT NULL,
  origin_lng REAL NOT NULL,
  legs_json TEXT NOT NULL,
  path_json TEXT NOT NULL,
  distance_km REAL NOT NULL,
  eta_minutes REAL NOT NULL,
  traffic_penalty_minutes REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_routes_delivery ON routes(delivery_id, active);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  status TEXT NOT NULL CHECK (status IN ('proposed','active','cancelled','superseded','rejected')),
  score REAL NOT NULL,
  reasoning_json TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assignments_order ON assignments(order_id, status);

CREATE TABLE IF NOT EXISTS road_segments (
  id TEXT PRIMARY KEY,
  ax INTEGER NOT NULL, ay INTEGER NOT NULL,
  bx INTEGER NOT NULL, by INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'clear' CHECK (status IN ('clear','moderate','heavy','closed')),
  delay_minutes REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS traffic_conditions (
  id TEXT PRIMARY KEY,
  area TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('clear','moderate','heavy')),
  delay_minutes REAL NOT NULL DEFAULT 0,
  source TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now','subsec')),
  cycle_id TEXT,
  agent TEXT NOT NULL,
  event_type TEXT NOT NULL,
  order_id TEXT,
  delivery_id TEXT,
  driver_id TEXT,
  message TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_events_order ON agent_events(order_id, id DESC);
`;

let instance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (instance) return instance;
  const file = config.dbFile === ':memory:' ? ':memory:' : config.dbFile;
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 4000;');
  db.exec(SCHEMA);
  instance = db;
  return db;
}

/* Thin typed query helpers. node:sqlite returns `Record<string, SQLOutputValue>`;
 * our schema guarantees the shape, so we assert it in one place. */
type Param = string | number | bigint | null | Uint8Array;
const coerce = (params: unknown[]): Param[] =>
  params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as Param[];

export function qAll<T>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...coerce(params)) as unknown as T[];
}
export function qGet<T>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().prepare(sql).get(...coerce(params)) as unknown as T | undefined;
}
export function qRun(sql: string, ...params: unknown[]) {
  return getDb().prepare(sql).run(...coerce(params));
}

/** Run fn inside an IMMEDIATE transaction. Node is single-threaded, so this
 *  block executes atomically with respect to other request handlers. */
export function tx<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export function resetDb(): void {
  const db = getDb();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const { name } of tables) db.exec(`DELETE FROM ${name}`);
  db.exec(`DELETE FROM sqlite_sequence`);
  db.exec('PRAGMA foreign_keys = ON;');
}
