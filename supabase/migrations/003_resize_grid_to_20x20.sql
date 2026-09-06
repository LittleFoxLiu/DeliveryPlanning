-- Resize the active network from 50x50 to 20x20.
-- Run after 002_add_grid_road_statuses.sql.

delete from road_segments
where start_x > 20 or start_y > 20 or end_x > 20 or end_y > 20;

alter table road_segments drop constraint if exists road_segments_start_x_check;
alter table road_segments drop constraint if exists road_segments_start_y_check;
alter table road_segments drop constraint if exists road_segments_end_x_check;
alter table road_segments drop constraint if exists road_segments_end_y_check;
alter table road_segments add constraint road_segments_start_x_check check (start_x between 0 and 20);
alter table road_segments add constraint road_segments_start_y_check check (start_y between 0 and 20);
alter table road_segments add constraint road_segments_end_x_check check (end_x between 0 and 20);
alter table road_segments add constraint road_segments_end_y_check check (end_y between 0 and 20);

insert into road_segments (id,start_x,start_y,end_x,end_y,status,delay_minutes,source)
select 'H-'||x||'-'||y,x,y,x+1,y,'Clear',0,'20x20 grid network'
from generate_series(0,19) x cross join generate_series(0,20) y
on conflict (id) do nothing;
insert into road_segments (id,start_x,start_y,end_x,end_y,status,delay_minutes,source)
select 'V-'||x||'-'||y,x,y,x,y+1,'Clear',0,'20x20 grid network'
from generate_series(0,20) x cross join generate_series(0,19) y
on conflict (id) do nothing;

update planned_routes set graph_snapshot=jsonb_set(coalesce(graph_snapshot,'{}'::jsonb),'{grid_size}','20'::jsonb,true);
