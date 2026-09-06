-- Sync the Supabase schema with the current RoutePilot application.
-- Run schema.sql first, then run this migration.

alter table customer_orders
  add column if not exists grid_x integer,
  add column if not exists grid_y integer;

create table if not exists road_segments (
  id text primary key, start_x integer not null check (start_x between 0 and 50), start_y integer not null check (start_y between 0 and 50),
  end_x integer not null check (end_x between 0 and 50), end_y integer not null check (end_y between 0 and 50),
  status text not null default 'Clear' check (status in ('Clear','Moderate','Heavy','Closed')),
  delay_minutes integer not null default 0, source text, observed_at timestamptz not null default now(),
  check ((start_x=end_x and abs(end_y-start_y)=1) or (start_y=end_y and abs(end_x-start_x)=1))
);

insert into road_segments (id,start_x,start_y,end_x,end_y,status,delay_minutes,source)
select 'H-'||x||'-'||y, x, y, x+1, y, 'Clear', 0, 'Grid network'
from generate_series(0,49) x cross join generate_series(0,50) y
on conflict (id) do nothing;
insert into road_segments (id,start_x,start_y,end_x,end_y,status,delay_minutes,source)
select 'V-'||x||'-'||y, x, y, x, y+1, 'Clear', 0, 'Grid network'
from generate_series(0,50) x cross join generate_series(0,49) y
on conflict (id) do nothing;

update road_segments set status='Heavy', delay_minutes=18, source='City traffic API'
where id in ('H-42-35','H-43-35','V-43-34','V-43-35');
update road_segments set status='Moderate', delay_minutes=7, source='City traffic API'
where id in ('H-27-24','H-28-24','V-27-23','V-27-24');

create index if not exists road_segments_status_idx on road_segments(status);

alter table customer_orders
  drop constraint if exists customer_orders_grid_x_check;
alter table customer_orders
  add constraint customer_orders_grid_x_check check (grid_x between 0 and 50);

alter table customer_orders
  drop constraint if exists customer_orders_grid_y_check;
alter table customer_orders
  add constraint customer_orders_grid_y_check check (grid_y between 0 and 50);

-- Populate coordinates for existing rows using the same zone anchors used by src/map.ts.
-- The application may refine these positions when it renders a route.
update customer_orders
set
  grid_x = case zone
    when 'North' then 40
    when 'Central' then 27
    when 'Harbor' then 43
    when 'West' then 10
    when 'South' then 24
    else 25
  end,
  grid_y = case zone
    when 'North' then 8
    when 'Central' then 24
    when 'Harbor' then 35
    when 'West' then 27
    when 'South' then 43
    else 25
  end
where grid_x is null or grid_y is null;

create index if not exists customer_orders_zone_idx on customer_orders(zone);
create index if not exists customer_orders_delivery_window_idx on customer_orders(delivery_window);
create index if not exists planned_routes_created_at_idx on planned_routes(created_at desc);

-- Keep route graph snapshots queryable and consistent with the current model.
update planned_routes
set graph_snapshot = jsonb_build_object(
  'strategy', coalesce(graph_snapshot->>'strategy', 'capacity-aware'),
  'traffic_buffer', coalesce((graph_snapshot->>'traffic_buffer')::integer, 0),
  'stops', coalesce((graph_snapshot->>'stops')::integer, cardinality(order_ids)),
  'grid_size', 50,
  'coordinate_format', 'Rd. X<number> · Y<number>'
)
where graph_snapshot is null or graph_snapshot = '{}'::jsonb;

comment on column customer_orders.grid_x is 'Customer X coordinate on the 0-50 delivery grid.';
comment on column customer_orders.grid_y is 'Customer Y coordinate on the 0-50 delivery grid.';
