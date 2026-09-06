-- Fix for 003_resize_grid_to_20x20.sql.
-- Existing customer rows must be converted before the 0-20 constraints are added.

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

alter table customer_orders drop constraint if exists customer_orders_grid_x_check;
alter table customer_orders drop constraint if exists customer_orders_grid_y_check;

update customer_orders
set
  grid_x=case zone
    when 'North' then 16
    when 'Central' then 11
    when 'Harbor' then 17
    when 'West' then 4
    when 'South' then 12
    else least(greatest(coalesce(grid_x,10),0),20)
  end,
  grid_y=case zone
    when 'North' then 3
    when 'Central' then 10
    when 'Harbor' then 14
    when 'West' then 11
    when 'South' then 18
    else least(greatest(coalesce(grid_y,10),0),20)
  end;

alter table customer_orders
  add constraint customer_orders_grid_x_check check (grid_x between 0 and 20);
alter table customer_orders
  add constraint customer_orders_grid_y_check check (grid_y between 0 and 20);

update planned_routes
set graph_snapshot=jsonb_set(
  coalesce(graph_snapshot,'{}'::jsonb),
  '{grid_size}',
  '20'::jsonb,
  true
);
