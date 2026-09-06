-- Add shared line/group metadata and a non-zero travel delay to every road segment.
-- Run after 003_resize_grid_to_20x20.sql (and after existing road seed data).
alter table road_segments add column if not exists orientation text;
alter table road_segments add column if not exists road_group text;
alter table road_segments drop constraint if exists road_segments_orientation_check;
alter table road_segments add constraint road_segments_orientation_check check (orientation in ('horizontal','vertical'));
update road_segments set orientation=case when start_y=end_y then 'horizontal' else 'vertical' end, road_group=case when start_y=end_y then 'H-ROW-'||start_y::text else 'V-COL-'||start_x::text end;
alter table road_segments alter column orientation set not null;
alter table road_segments alter column road_group set not null;
update road_segments set delay_minutes=case status when 'Moderate' then 5 when 'Heavy' then 12 when 'Closed' then 60 else 1 end where delay_minutes is null or delay_minutes=0;
create index if not exists road_segments_group_idx on road_segments(road_group);
create index if not exists road_segments_orientation_idx on road_segments(orientation);
comment on column road_segments.road_group is 'Connected grid line: H-ROW-Y or V-COL-X.';
comment on column road_segments.delay_minutes is 'Travel delay in minutes for this road edge.';
