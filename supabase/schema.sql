-- RoutePilot cloud schema. Run in Supabase Dashboard → SQL Editor.
create extension if not exists pgcrypto;

create table if not exists traffic_conditions (
  id uuid primary key default gen_random_uuid(),
  area text not null,
  status text not null check (status in ('Clear', 'Moderate', 'Heavy')),
  delay_minutes integer not null default 0,
  source text,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists customer_orders (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  location text not null,
  zone text,
  items text not null,
  delivery_window text not null,
  priority text not null default 'Standard',
  volume_units integer not null default 1,
  status text not null default 'Ready',
  grid_x integer check (grid_x between 0 and 20),
  grid_y integer check (grid_y between 0 and 20),
  created_at timestamptz not null default now()
);

create table if not exists driver_conditions (
  id uuid primary key default gen_random_uuid(),
  driver_name text not null,
  availability text not null check (availability in ('Available', 'On route', 'Break')),
  current_load integer not null default 0,
  current_position text not null,
  maximum_load integer not null,
  vehicle text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists planned_routes (
  id uuid primary key default gen_random_uuid(),
  route_code text not null,
  driver_id uuid references driver_conditions(id) on delete set null,
  order_ids uuid[] not null default '{}',
  distance_km numeric,
  eta_minutes integer,
  capacity_percent integer,
  graph_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists road_segments (
  id text primary key,
  start_x integer not null check (start_x between 0 and 20),
  start_y integer not null check (start_y between 0 and 20),
  end_x integer not null check (end_x between 0 and 20),
  end_y integer not null check (end_y between 0 and 20),
  status text not null default 'Clear' check (status in ('Clear','Moderate','Heavy','Closed')),
  delay_minutes integer not null default 0,
  orientation text not null default 'horizontal' check (orientation in ('horizontal','vertical')),
  road_group text not null default 'H-ROW-0',
  source text,
  observed_at timestamptz not null default now(),
  check ((start_x = end_x and abs(end_y - start_y) = 1) or (start_y = end_y and abs(end_x - start_x) = 1))
);

-- Development/demo policies. Tighten these with auth.uid() checks before production.
alter table traffic_conditions enable row level security;
alter table customer_orders enable row level security;
alter table driver_conditions enable row level security;
alter table planned_routes enable row level security;
alter table road_segments enable row level security;
drop policy if exists "demo read traffic" on traffic_conditions;
drop policy if exists "demo write traffic" on traffic_conditions;
drop policy if exists "demo update traffic" on traffic_conditions;
create policy "demo read traffic" on traffic_conditions for select using (true);
create policy "demo write traffic" on traffic_conditions for insert with check (true);
create policy "demo update traffic" on traffic_conditions for update using (true);
drop policy if exists "demo read orders" on customer_orders;
drop policy if exists "demo write orders" on customer_orders;
drop policy if exists "demo update orders" on customer_orders;
create policy "demo read orders" on customer_orders for select using (true);
create policy "demo write orders" on customer_orders for insert with check (true);
create policy "demo update orders" on customer_orders for update using (true);
drop policy if exists "demo read drivers" on driver_conditions;
drop policy if exists "demo write drivers" on driver_conditions;
drop policy if exists "demo update drivers" on driver_conditions;
create policy "demo read drivers" on driver_conditions for select using (true);
create policy "demo write drivers" on driver_conditions for insert with check (true);
create policy "demo update drivers" on driver_conditions for update using (true);
drop policy if exists "demo read routes" on planned_routes;
drop policy if exists "demo write routes" on planned_routes;
create policy "demo read routes" on planned_routes for select using (true);
create policy "demo write routes" on planned_routes for insert with check (true);
drop policy if exists "demo read road segments" on road_segments;
drop policy if exists "demo write road segments" on road_segments;
drop policy if exists "demo update road segments" on road_segments;
create policy "demo read road segments" on road_segments for select using (true);
create policy "demo write road segments" on road_segments for insert with check (true);
create policy "demo update road segments" on road_segments for update using (true) with check (true);
