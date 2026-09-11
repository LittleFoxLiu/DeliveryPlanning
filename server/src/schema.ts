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
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  address text NOT NULL,
  CONSTRAINT stores_singapore_bounds CHECK (latitude BETWEEN 1.22 AND 1.48 AND longitude BETWEEN 103.60 AND 104.05),
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
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  address text,
  CONSTRAINT driver_locations_singapore_bounds CHECK (latitude BETWEEN 1.22 AND 1.48 AND longitude BETWEEN 103.60 AND 104.05),
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
  pickup_latitude double precision NOT NULL,
  pickup_longitude double precision NOT NULL,
  delivery_latitude double precision NOT NULL,
  delivery_longitude double precision NOT NULL,
  delivery_address text NOT NULL,
  CONSTRAINT orders_pickup_singapore_bounds CHECK (pickup_latitude BETWEEN 1.22 AND 1.48 AND pickup_longitude BETWEEN 103.60 AND 104.05),
  CONSTRAINT orders_delivery_singapore_bounds CHECK (delivery_latitude BETWEEN 1.22 AND 1.48 AND delivery_longitude BETWEEN 103.60 AND 104.05),
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

CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  name text NOT NULL,
  description text,
  price_cents integer NOT NULL DEFAULT 0,
  package_size text NOT NULL DEFAULT 'small' CHECK (package_size IN ('small','medium','large')),
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_merchant ON products(merchant_id, active);

CREATE TABLE IF NOT EXISTS order_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  product_id text REFERENCES products(id),
  name text NOT NULL,
  qty integer NOT NULL DEFAULT 1,
  unit_price_cents integer NOT NULL DEFAULT 0
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
  origin_latitude double precision NOT NULL,
  origin_longitude double precision NOT NULL,
  CONSTRAINT routes_singapore_bounds CHECK (origin_latitude BETWEEN 1.22 AND 1.48 AND origin_longitude BETWEEN 103.60 AND 104.05),
  legs_json jsonb NOT NULL,
  path_json jsonb NOT NULL,
  distance_km double precision NOT NULL,
  eta_minutes double precision NOT NULL,
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

CREATE TABLE IF NOT EXISTS agent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  cycle_id text,
  run_id text,
  agent text NOT NULL,
  event_type text NOT NULL,
  order_id text,
  delivery_id text,
  driver_id text,
  message text NOT NULL,
  data_json jsonb
);
-- Additive migration must run before indexes reference the new column. This is
-- important for existing PGlite/Supabase databases created by older versions.
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS run_id text;
CREATE INDEX IF NOT EXISTS idx_agent_events_order ON agent_events(order_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_id ON agent_events(id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id, id);

-- Autonomous planning runs: the append-only shared state for one reasoning loop
-- (dispatch or remediation). state_json holds proposals / critiques / revisions /
-- policy checks / decision / execution — everything a judge can inspect.
CREATE TABLE IF NOT EXISTS agent_runs (
  id text PRIMARY KEY,
  correlation_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dispatch','remediation','whatif','evaluation')),
  order_id text,
  delivery_id text,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','executed','escalated','aborted','no_action','simulated')),
  risk_level text CHECK (risk_level IN ('low','medium','high')),
  state_json jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_order ON agent_runs(order_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);

-- Human-in-the-loop escalations raised by the Coordinator for HIGH-risk actions.
CREATE TABLE IF NOT EXISTS agent_escalations (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES agent_runs(id),
  order_id text,
  delivery_id text,
  reason text NOT NULL,
  proposal_json jsonb NOT NULL,
  risk_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  resolved_by text,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agent_escalations_status ON agent_escalations(status, created_at DESC);

-- Additive migrations for the current schema (safe to re-run against a fresh
-- database; legacy-coordinate cleanup is handled by initDb before queries run).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_id text REFERENCES products(id);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_price_cents integer NOT NULL DEFAULT 0;
`;

/** Tables in dependency order (parents first) — used for TRUNCATE in tests. */
export const TABLES = [
  'join_requests', 'merchant_admins', 'admin_invites',
  'agent_escalations', 'agent_runs', 'agent_events',
  'assignments', 'routes', 'deliveries', 'order_items', 'orders', 'products',
  'driver_locations', 'driver_status', 'drivers', 'customers', 'stores', 'merchants',
  'users',
];
