-- RoutePilot migration 002
-- Adds a stored road segment for every edge of the 50 x 50 grid.
-- Run this file after 001_sync_current_status.sql.

create table if not exists road_segments (
  id text primary key,
  start_x integer not null check (start_x between 0 and 50),
  start_y integer not null check (start_y between 0 and 50),
  end_x integer not null check (end_x between 0 and 50),
  end_y integer not null check (end_y between 0 and 50),
  status text not null default 'Clear' check (status in ('Clear', 'Moderate', 'Heavy', 'Closed')),
  delay_minutes integer not null default 0,
  source text,
  observed_at timestamptz not null default now(),
  constraint road_segments_must_be_adjacent check (
    (start_x = end_x and abs(end_y - start_y) = 1)
    or (start_y = end_y and abs(end_x - start_x) = 1)
  )
);

-- 2,550 horizontal edges: x 0..49, y 0..50.
insert into road_segments (id, start_x, start_y, end_x, end_y, status, delay_minutes, source)
select 'H-' || x || '-' || y, x, y, x + 1, y, 'Clear', 0, 'Grid network'
from generate_series(0, 49) as x
cross join generate_series(0, 50) as y
on conflict (id) do nothing;

-- 2,550 vertical edges: x 0..50, y 0..49.
insert into road_segments (id, start_x, start_y, end_x, end_y, status, delay_minutes, source)
select 'V-' || x || '-' || y, x, y, x, y + 1, 'Clear', 0, 'Grid network'
from generate_series(0, 50) as x
cross join generate_series(0, 49) as y
on conflict (id) do nothing;

-- Example current conditions. Replace these with live traffic imports later.
update road_segments
set status = 'Heavy', delay_minutes = 18, source = 'City traffic API', observed_at = now()
where id in ('H-42-35', 'H-43-35', 'V-43-34', 'V-43-35');

update road_segments
set status = 'Moderate', delay_minutes = 7, source = 'City traffic API', observed_at = now()
where id in ('H-27-24', 'H-28-24', 'V-27-23', 'V-27-24');

create index if not exists road_segments_status_idx on road_segments(status);
create index if not exists road_segments_coordinates_idx
  on road_segments(start_x, start_y, end_x, end_y);

alter table road_segments enable row level security;

drop policy if exists "demo read road segments" on road_segments;
create policy "demo read road segments"
  on road_segments for select using (true);

drop policy if exists "demo insert road segments" on road_segments;
create policy "demo insert road segments"
  on road_segments for insert with check (true);

drop policy if exists "demo update road segments" on road_segments;
create policy "demo update road segments"
  on road_segments for update using (true) with check (true);
