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

-- Development/demo policies. Tighten these with auth.uid() checks before production.
alter table traffic_conditions enable row level security;
alter table customer_orders enable row level security;
alter table driver_conditions enable row level security;
alter table planned_routes enable row level security;
create policy "demo read traffic" on traffic_conditions for select using (true);
create policy "demo write traffic" on traffic_conditions for insert with check (true);
create policy "demo update traffic" on traffic_conditions for update using (true);
create policy "demo read orders" on customer_orders for select using (true);
create policy "demo write orders" on customer_orders for insert with check (true);
create policy "demo update orders" on customer_orders for update using (true);
create policy "demo read drivers" on driver_conditions for select using (true);
create policy "demo write drivers" on driver_conditions for insert with check (true);
create policy "demo update drivers" on driver_conditions for update using (true);
create policy "demo read routes" on planned_routes for select using (true);
create policy "demo write routes" on planned_routes for insert with check (true);
