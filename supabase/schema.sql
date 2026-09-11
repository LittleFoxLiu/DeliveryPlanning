-- Delivery Planner schema for Supabase/PostgreSQL.
-- Location data is stored as Nominatim latitude/longitude plus the selected
-- address. OSRM supplies route geometry and driving durations at runtime.

create table if not exists public.users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  password_salt text not null,
  role text not null check (role in ('admin', 'merchant', 'driver', 'customer')),
  name text not null,
  ref_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.merchants (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.stores (
  id text primary key,
  merchant_id text not null references public.merchants(id),
  name text not null,
  latitude double precision not null,
  longitude double precision not null,
  address text not null,
  constraint stores_singapore_bounds check (latitude between 1.22 and 1.48 and longitude between 103.60 and 104.05),
  created_at timestamptz not null default now()
);

create table if not exists public.customers (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.drivers (
  id text primary key,
  name text not null,
  vehicle_type text not null check (vehicle_type in ('bike', 'car', 'van', 'truck')),
  capacity integer not null,
  max_package_size text not null check (max_package_size in ('small', 'medium', 'large')),
  created_at timestamptz not null default now()
);

create table if not exists public.driver_status (
  driver_id text primary key references public.drivers(id),
  status text not null check (status in ('available', 'on_route', 'break', 'offline')),
  current_order_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.driver_locations (
  id bigint generated always as identity primary key,
  driver_id text not null references public.drivers(id),
  latitude double precision not null,
  longitude double precision not null,
  address text,
  constraint driver_locations_singapore_bounds check (latitude between 1.22 and 1.48 and longitude between 103.60 and 104.05),
  recorded_at timestamptz not null default now()
);
create index if not exists idx_driver_locations_driver on public.driver_locations(driver_id, id desc);

create table if not exists public.admin_invites (
  admin_id text primary key references public.users(id) on delete cascade,
  invite_code text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists public.merchant_admins (
  merchant_id text primary key references public.merchants(id) on delete cascade,
  admin_id text not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.join_requests (
  id text primary key,
  requester_user_id text not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('merchant_admin', 'driver_store')),
  target_admin_id text references public.users(id) on delete cascade,
  target_store_id text references public.stores(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists idx_join_requests_target on public.join_requests(target_admin_id, target_store_id, status);

create table if not exists public.products (
  id text primary key,
  merchant_id text not null references public.merchants(id),
  name text not null,
  description text,
  price_cents integer not null default 0,
  package_size text not null default 'small' check (package_size in ('small', 'medium', 'large')),
  active integer not null default 1 check (active in (0, 1)),
  created_at timestamptz not null default now()
);
create index if not exists idx_products_merchant on public.products(merchant_id, active);

create table if not exists public.orders (
  id text primary key,
  merchant_id text not null references public.merchants(id),
  store_id text not null references public.stores(id),
  customer_id text not null references public.customers(id),
  pickup_latitude double precision not null,
  pickup_longitude double precision not null,
  delivery_latitude double precision not null,
  delivery_longitude double precision not null,
  delivery_address text not null,
  constraint orders_pickup_singapore_bounds check (pickup_latitude between 1.22 and 1.48 and pickup_longitude between 103.60 and 104.05),
  constraint orders_delivery_singapore_bounds check (delivery_latitude between 1.22 and 1.48 and delivery_longitude between 103.60 and 104.05),
  status text not null default 'created' check (status in ('created', 'ready', 'validated', 'dispatching', 'assigned', 'picked_up', 'delivering', 'delivered', 'cancelled', 'failed')),
  priority text not null default 'standard' check (priority in ('standard', 'express')),
  deadline_ts timestamptz not null,
  package_size text not null check (package_size in ('small', 'medium', 'large')),
  volume integer not null default 1,
  note text,
  created_at timestamptz not null default now(),
  ready_at timestamptz
);
create index if not exists idx_orders_merchant on public.orders(merchant_id);
create index if not exists idx_orders_customer on public.orders(customer_id);

create table if not exists public.order_items (
  id bigint generated always as identity primary key,
  order_id text not null references public.orders(id),
  product_id text references public.products(id),
  name text not null,
  qty integer not null default 1,
  unit_price_cents integer not null default 0
);
create index if not exists idx_order_items_order on public.order_items(order_id);

create table if not exists public.deliveries (
  id text primary key,
  order_id text not null unique references public.orders(id),
  driver_id text references public.drivers(id),
  status text not null default 'pending' check (status in ('pending', 'assigned', 'en_route_pickup', 'picked_up', 'en_route_drop', 'delivered', 'cancelled', 'failed')),
  assigned_at timestamptz,
  pickup_at timestamptz,
  delivered_at timestamptz,
  estimated_delivery_minutes double precision,
  actual_delivery_minutes double precision,
  eta_ts timestamptz,
  route_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.routes (
  id text primary key,
  delivery_id text not null references public.deliveries(id),
  driver_id text not null references public.drivers(id),
  origin_latitude double precision not null,
  origin_longitude double precision not null,
  constraint routes_singapore_bounds check (origin_latitude between 1.22 and 1.48 and origin_longitude between 103.60 and 104.05),
  legs_json jsonb not null,
  path_json jsonb not null,
  distance_km double precision not null,
  eta_minutes double precision not null,
  active integer not null default 1 check (active in (0, 1)),
  created_at timestamptz not null default now()
);
create index if not exists idx_routes_delivery on public.routes(delivery_id, active);

create table if not exists public.assignments (
  id text primary key,
  order_id text not null references public.orders(id),
  driver_id text not null references public.drivers(id),
  status text not null check (status in ('proposed', 'active', 'cancelled', 'superseded', 'rejected')),
  score double precision not null,
  reasoning_json jsonb not null,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists idx_assignments_order on public.assignments(order_id, status);
create unique index if not exists uq_assignments_live_order on public.assignments(order_id) where status in ('proposed', 'active');

create table if not exists public.agent_events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  cycle_id text,
  run_id text,
  agent text not null,
  event_type text not null,
  order_id text,
  delivery_id text,
  driver_id text,
  message text not null,
  data_json jsonb
);
create index if not exists idx_agent_events_order on public.agent_events(order_id, id desc);
create index if not exists idx_agent_events_id on public.agent_events(id desc);
create index if not exists idx_agent_events_run on public.agent_events(run_id, id);

create table if not exists public.agent_runs (
  id text primary key,
  correlation_id text not null,
  kind text not null check (kind in ('dispatch', 'remediation', 'whatif', 'evaluation')),
  order_id text,
  delivery_id text,
  status text not null default 'running' check (status in ('running', 'executed', 'escalated', 'aborted', 'no_action', 'simulated')),
  risk_level text check (risk_level in ('low', 'medium', 'high')),
  state_json jsonb not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists idx_agent_runs_order on public.agent_runs(order_id, started_at desc);
create index if not exists idx_agent_runs_started on public.agent_runs(started_at desc);

create table if not exists public.agent_escalations (
  id text primary key,
  run_id text not null references public.agent_runs(id),
  order_id text,
  delivery_id text,
  reason text not null,
  proposal_json jsonb not null,
  risk_json jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  resolved_by text,
  resolution_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_agent_escalations_status on public.agent_escalations(status, created_at desc);

-- Remove tables and columns from databases created by the retired coordinate
-- model. Existing rows with no Nominatim coordinates are intentionally not
-- converted; rerun `npm run seed` to create valid Singapore sample data.
drop table if exists public.traffic_conditions;
drop table if exists public.road_segments;
alter table if exists public.stores add column if not exists latitude double precision;
alter table if exists public.stores add column if not exists longitude double precision;
alter table if exists public.stores add column if not exists address text;
alter table if exists public.driver_locations add column if not exists latitude double precision;
alter table if exists public.driver_locations add column if not exists longitude double precision;
alter table if exists public.driver_locations add column if not exists address text;
alter table if exists public.orders add column if not exists pickup_latitude double precision;
alter table if exists public.orders add column if not exists pickup_longitude double precision;
alter table if exists public.orders add column if not exists delivery_latitude double precision;
alter table if exists public.orders add column if not exists delivery_longitude double precision;
alter table if exists public.orders add column if not exists delivery_address text;
alter table if exists public.routes add column if not exists origin_latitude double precision;
alter table if exists public.routes add column if not exists origin_longitude double precision;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stores' and column_name = 'geo_lat')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stores' and column_name = 'geo_lng') then
    update public.stores set latitude = geo_lat, longitude = geo_lng where geo_lat is not null and geo_lng is not null;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'driver_locations' and column_name = 'geo_lat')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'driver_locations' and column_name = 'geo_lng') then
    update public.driver_locations set latitude = geo_lat, longitude = geo_lng where geo_lat is not null and geo_lng is not null;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'delivery_geo_lat')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'delivery_geo_lng') then
    update public.orders set delivery_latitude = delivery_geo_lat, delivery_longitude = delivery_geo_lng
      where delivery_geo_lat is not null and delivery_geo_lng is not null;
  end if;
end $$;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'routes' and column_name = 'origin_lat')
     or exists (select 1 from public.routes where path_json::text like '%"x"%') then
    update public.deliveries set route_id = null where route_id is not null;
    delete from public.routes;
  end if;
end $$;
alter table if exists public.stores drop column if exists pickup_lat;
alter table if exists public.stores drop column if exists pickup_lng;
alter table if exists public.stores drop column if exists geo_lat;
alter table if exists public.stores drop column if exists geo_lng;
alter table if exists public.driver_locations drop column if exists lat;
alter table if exists public.driver_locations drop column if exists lng;
alter table if exists public.driver_locations drop column if exists geo_lat;
alter table if exists public.driver_locations drop column if exists geo_lng;
alter table if exists public.orders drop column if exists pickup_lat;
alter table if exists public.orders drop column if exists pickup_lng;
alter table if exists public.orders drop column if exists delivery_lat;
alter table if exists public.orders drop column if exists delivery_lng;
alter table if exists public.orders drop column if exists delivery_geo_lat;
alter table if exists public.orders drop column if exists delivery_geo_lng;
alter table if exists public.routes drop column if exists origin_lat;
alter table if exists public.routes drop column if exists origin_lng;
alter table if exists public.routes drop column if exists traffic_penalty_minutes;
delete from public.routes where origin_latitude is null or origin_longitude is null
  or origin_latitude not between 1.22 and 1.48 or origin_longitude not between 103.60 and 104.05;

drop table if exists pg_temp._invalid_geo_orders;
create temporary table _invalid_geo_orders on commit drop as
select o.id from public.orders o left join public.stores s on s.id = o.store_id
where o.pickup_latitude is null or o.pickup_longitude is null
  or o.pickup_latitude not between 1.22 and 1.48 or o.pickup_longitude not between 103.60 and 104.05
  or o.delivery_latitude is null or o.delivery_longitude is null or o.delivery_address is null
  or o.delivery_latitude not between 1.22 and 1.48 or o.delivery_longitude not between 103.60 and 104.05
  or s.id is null or s.latitude is null or s.longitude is null or s.address is null
  or s.latitude not between 1.22 and 1.48 or s.longitude not between 103.60 and 104.05;
delete from public.agent_escalations where order_id in (select id from _invalid_geo_orders);
delete from public.agent_events where order_id in (select id from _invalid_geo_orders);
delete from public.agent_runs where order_id in (select id from _invalid_geo_orders);
delete from public.assignments where order_id in (select id from _invalid_geo_orders);
delete from public.order_items where order_id in (select id from _invalid_geo_orders);
delete from public.routes where delivery_id in
  (select d.id from public.deliveries d where d.order_id in (select id from _invalid_geo_orders));
delete from public.deliveries where order_id in (select id from _invalid_geo_orders);
delete from public.orders where id in (select id from _invalid_geo_orders);
drop table if exists pg_temp._invalid_geo_orders;
delete from public.join_requests where target_store_id in
  (select id from public.stores where latitude is null or longitude is null or address is null
   or latitude not between 1.22 and 1.48 or longitude not between 103.60 and 104.05);
delete from public.stores where latitude is null or longitude is null or address is null
  or latitude not between 1.22 and 1.48 or longitude not between 103.60 and 104.05;
delete from public.driver_locations where latitude is null or longitude is null
  or latitude not between 1.22 and 1.48 or longitude not between 103.60 and 104.05;
alter table if exists public.stores alter column latitude set not null;
alter table if exists public.stores alter column longitude set not null;
alter table if exists public.stores alter column address set not null;
alter table if exists public.driver_locations alter column latitude set not null;
alter table if exists public.driver_locations alter column longitude set not null;
alter table if exists public.orders alter column pickup_latitude set not null;
alter table if exists public.orders alter column pickup_longitude set not null;
alter table if exists public.orders alter column delivery_latitude set not null;
alter table if exists public.orders alter column delivery_longitude set not null;
alter table if exists public.orders alter column delivery_address set not null;
alter table if exists public.routes alter column origin_latitude set not null;
alter table if exists public.routes alter column origin_longitude set not null;
do $$ begin
  if not exists (select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace where n.nspname = 'public' and r.relname = 'stores' and c.conname = 'stores_singapore_bounds') then
    alter table public.stores add constraint stores_singapore_bounds check (latitude between 1.22 and 1.48 and longitude between 103.60 and 104.05);
  end if;
  if not exists (select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace where n.nspname = 'public' and r.relname = 'driver_locations' and c.conname = 'driver_locations_singapore_bounds') then
    alter table public.driver_locations add constraint driver_locations_singapore_bounds check (latitude between 1.22 and 1.48 and longitude between 103.60 and 104.05);
  end if;
  if not exists (select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace where n.nspname = 'public' and r.relname = 'orders' and c.conname = 'orders_pickup_singapore_bounds') then
    alter table public.orders add constraint orders_pickup_singapore_bounds check (pickup_latitude between 1.22 and 1.48 and pickup_longitude between 103.60 and 104.05);
  end if;
  if not exists (select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace where n.nspname = 'public' and r.relname = 'orders' and c.conname = 'orders_delivery_singapore_bounds') then
    alter table public.orders add constraint orders_delivery_singapore_bounds check (delivery_latitude between 1.22 and 1.48 and delivery_longitude between 103.60 and 104.05);
  end if;
  if not exists (select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace where n.nspname = 'public' and r.relname = 'routes' and c.conname = 'routes_singapore_bounds') then
    alter table public.routes add constraint routes_singapore_bounds check (origin_latitude between 1.22 and 1.48 and origin_longitude between 103.60 and 104.05);
  end if;
end $$;

-- The server uses its service-role connection for all application queries.
do $$ declare t text; begin
  foreach t in array array['users','merchants','stores','customers','drivers','driver_status','driver_locations','admin_invites','merchant_admins','join_requests','products','orders','order_items','deliveries','routes','assignments','agent_events','agent_runs','agent_escalations'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
