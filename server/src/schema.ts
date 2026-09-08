/** Postgres DDL. Idempotent — safe to run on every boot against a fresh PGlite
 *  database or an existing Supabase project (CREATE ... IF NOT EXISTS). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','merchant','driver','customer')),
  name text NOT NULL,
  ref_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS merchants (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stores (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  name text NOT NULL,
  pickup_lat double precision NOT NULL,
  pickup_lng double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drivers (
  id text PRIMARY KEY,
  name text NOT NULL,
  vehicle_type text NOT NULL CHECK (vehicle_type IN ('bike','car','van','truck')),
  capacity integer NOT NULL,
  max_package_size text NOT NULL CHECK (max_package_size IN ('small','medium','large')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver_status (
  driver_id text PRIMARY KEY REFERENCES drivers(id),
  status text NOT NULL CHECK (status IN ('available','on_route','break','offline')),
  current_order_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver_locations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_id text NOT NULL REFERENCES drivers(id),
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_driver_locations_driver ON driver_locations(driver_id, id DESC);

CREATE TABLE IF NOT EXISTS admin_invites (
  admin_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  invite_code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS merchant_admins (
  merchant_id text PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  admin_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS driver_stores (
  driver_id text NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  store_id text NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (driver_id, store_id)
);
CREATE TABLE IF NOT EXISTS join_requests (
  id text PRIMARY KEY,
  requester_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('merchant_admin','driver_store')),
  target_admin_id text REFERENCES users(id) ON DELETE CASCADE,
  target_store_id text REFERENCES stores(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_join_requests_target ON join_requests(target_admin_id, target_store_id, status);

CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  store_id text NOT NULL REFERENCES stores(id),
  customer_id text NOT NULL REFERENCES customers(id),
  pickup_lat double precision NOT NULL,
  pickup_lng double precision NOT NULL,
  delivery_lat double precision NOT NULL,
  delivery_lng double precision NOT NULL,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','ready','validated','dispatching','assigned','picked_up','delivering','delivered','cancelled','failed')),
  priority text NOT NULL DEFAULT 'standard' CHECK (priority IN ('standard','express')),
  deadline_ts timestamptz NOT NULL,
  package_size text NOT NULL CHECK (package_size IN ('small','medium','large')),
  volume integer NOT NULL DEFAULT 1,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS order_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  name text NOT NULL,
  qty integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS deliveries (
  id text PRIMARY KEY,
  order_id text NOT NULL UNIQUE REFERENCES orders(id),
  driver_id text REFERENCES drivers(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','assigned','en_route_pickup','picked_up','en_route_drop','delivered','cancelled','failed')),
  assigned_at timestamptz,
  pickup_at timestamptz,
  delivered_at timestamptz,
  estimated_delivery_minutes double precision,
  actual_delivery_minutes double precision,
  eta_ts timestamptz,
  route_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routes (
  id text PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES deliveries(id),
  driver_id text NOT NULL REFERENCES drivers(id),
  origin_lat double precision NOT NULL,
  origin_lng double precision NOT NULL,
  legs_json jsonb NOT NULL,
  path_json jsonb NOT NULL,
  distance_km double precision NOT NULL,
  eta_minutes double precision NOT NULL,
  traffic_penalty_minutes double precision NOT NULL DEFAULT 0,
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_routes_delivery ON routes(delivery_id, active);

CREATE TABLE IF NOT EXISTS assignments (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  driver_id text NOT NULL REFERENCES drivers(id),
  status text NOT NULL CHECK (status IN ('proposed','active','cancelled','superseded','rejected')),
  score double precision NOT NULL,
  reasoning_json jsonb NOT NULL,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assignments_order ON assignments(order_id, status);

CREATE TABLE IF NOT EXISTS road_segments (
  id text PRIMARY KEY,
  ax integer NOT NULL, ay integer NOT NULL,
  bx integer NOT NULL, by integer NOT NULL,
  status text NOT NULL DEFAULT 'clear' CHECK (status IN ('clear','moderate','heavy','closed')),
  delay_minutes double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traffic_conditions (
  id text PRIMARY KEY,
  area text NOT NULL,
  status text NOT NULL CHECK (status IN ('clear','moderate','heavy')),
  delay_minutes double precision NOT NULL DEFAULT 0,
  source text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  cycle_id text,
  agent text NOT NULL,
  event_type text NOT NULL,
  order_id text,
  delivery_id text,
  driver_id text,
  message text NOT NULL,
  data_json jsonb
);
CREATE INDEX IF NOT EXISTS idx_agent_events_order ON agent_events(order_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_id ON agent_events(id DESC);
`;

/** Tables in dependency order (parents first) — used for TRUNCATE in tests. */
export const TABLES = [
  'join_requests', 'driver_stores', 'merchant_admins', 'admin_invites',
  'agent_events', 'assignments', 'routes', 'deliveries', 'order_items', 'orders',
  'driver_locations', 'driver_status', 'drivers', 'customers', 'stores', 'merchants',
  'road_segments', 'traffic_conditions', 'users',
];
