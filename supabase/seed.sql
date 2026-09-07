-- Delivery Planner sample data for Supabase/PostgreSQL.
-- Run schema.sql first.
-- This script is rerunnable and seeds the non-auth domain data.
--
-- Important: application login uses server-side scrypt password hashes, so
-- this SQL file intentionally does not create users. Run `npm run seed` from
-- the project directory after applying schema.sql to create the demo users.

begin;

-- The application uses a 20 x 20 grid (0..20), with horizontal and vertical
-- segments between every adjacent pair of points.
insert into public.road_segments (id, ax, ay, bx, by, status, delay_minutes)
select case when x < 20 then 'H-' || x || '-' || y else 'V-' || x || '-' || y end,
       x, y,
       case when x < 20 then x + 1 else x end,
       case when x < 20 then y else y + 1 end,
       'clear', 0
from generate_series(0, 20) as x
cross join generate_series(0, 20) as y
where x < 20 or y < 20
on conflict (id) do update set
  ax = excluded.ax, ay = excluded.ay, bx = excluded.bx, by = excluded.by,
  status = excluded.status, delay_minutes = excluded.delay_minutes,
  updated_at = now();

update public.road_segments set status = 'moderate', delay_minutes = 4, updated_at = now()
where id in ('H-9-10', 'H-10-10', 'H-11-10', 'V-13-6', 'V-13-7');

update public.road_segments set status = 'heavy', delay_minutes = 10, updated_at = now()
where id in ('H-14-4', 'H-15-4');

insert into public.traffic_conditions (id, area, status, delay_minutes, source)
values
  ('traf_central', 'Central Avenue', 'moderate', 4, 'City traffic API'),
  ('traf_north', 'North Market Road', 'heavy', 10, 'Dispatcher report'),
  ('traf_harbor', 'Harbor Loop', 'clear', 0, 'City traffic API')
on conflict (id) do update set
  area = excluded.area, status = excluded.status,
  delay_minutes = excluded.delay_minutes, source = excluded.source,
  updated_at = now();

insert into public.merchants (id, name) values
  ('mch_harbor_grocery', 'Harbor Grocery Co.'),
  ('mch_north_bakery', 'North Street Bakery')
on conflict (id) do update set name = excluded.name;

insert into public.stores (id, merchant_id, name, pickup_lat, pickup_lng) values
  ('sto_harbor_central', 'mch_harbor_grocery', 'Harbor Grocery — Central', 10, 10),
  ('sto_bakery_flagship', 'mch_north_bakery', 'North Street Bakery — Flagship', 15, 5)
on conflict (id) do update set
  merchant_id = excluded.merchant_id, name = excluded.name,
  pickup_lat = excluded.pickup_lat, pickup_lng = excluded.pickup_lng;

insert into public.customers (id, name) values
  ('cus_maya_chen', 'Maya Chen'),
  ('cus_james_wu', 'James Wu')
on conflict (id) do update set name = excluded.name;

insert into public.drivers (id, name, vehicle_type, capacity, max_package_size) values
  ('drv_jordan_lee', 'Jordan Lee', 'van', 4, 'large'),
  ('drv_priya_shah', 'Priya Shah', 'car', 3, 'medium'),
  ('drv_marco_silva', 'Marco Silva', 'van', 5, 'large'),
  ('drv_hana_ito', 'Hana Ito', 'bike', 2, 'small'),
  ('drv_diego_torres', 'Diego Torres', 'truck', 6, 'large')
on conflict (id) do update set
  name = excluded.name, vehicle_type = excluded.vehicle_type,
  capacity = excluded.capacity, max_package_size = excluded.max_package_size;

insert into public.driver_status (driver_id, status, current_order_count) values
  ('drv_jordan_lee', 'available', 0),
  ('drv_priya_shah', 'available', 0),
  ('drv_marco_silva', 'available', 0),
  ('drv_hana_ito', 'available', 0),
  ('drv_diego_torres', 'break', 0)
on conflict (driver_id) do update set
  status = excluded.status, current_order_count = excluded.current_order_count,
  updated_at = now();

insert into public.driver_locations (driver_id, lat, lng)
select v.driver_id, v.lat, v.lng
from (values
  ('drv_jordan_lee', 3::double precision, 3::double precision),
  ('drv_priya_shah', 16::double precision, 15::double precision),
  ('drv_marco_silva', 10::double precision, 18::double precision),
  ('drv_hana_ito', 6::double precision, 11::double precision),
  ('drv_diego_torres', 18::double precision, 8::double precision)
) as v(driver_id, lat, lng)
where not exists (
  select 1 from public.driver_locations existing
  where existing.driver_id = v.driver_id
    and existing.lat = v.lat
    and existing.lng = v.lng
);

insert into public.orders
  (id, merchant_id, store_id, customer_id, pickup_lat, pickup_lng,
   delivery_lat, delivery_lng, status, priority, deadline_ts,
   package_size, volume, note)
values
  ('ord_demo_001', 'mch_harbor_grocery', 'sto_harbor_central', 'cus_maya_chen',
   10, 10, 17, 3, 'created', 'express', now() + interval '55 minutes',
   'medium', 2, 'Leave at the front desk'),
  ('ord_demo_002', 'mch_harbor_grocery', 'sto_harbor_central', 'cus_james_wu',
   10, 10, 4, 16, 'created', 'standard', now() + interval '120 minutes',
   'small', 1, null),
  ('ord_demo_003', 'mch_north_bakery', 'sto_bakery_flagship', 'cus_james_wu',
   15, 5, 6, 9, 'created', 'standard', now() + interval '90 minutes',
   'small', 1, 'Call on arrival')
on conflict (id) do update set
  merchant_id = excluded.merchant_id, store_id = excluded.store_id,
  customer_id = excluded.customer_id, pickup_lat = excluded.pickup_lat,
  pickup_lng = excluded.pickup_lng, delivery_lat = excluded.delivery_lat,
  delivery_lng = excluded.delivery_lng, status = excluded.status,
  priority = excluded.priority, deadline_ts = excluded.deadline_ts,
  package_size = excluded.package_size, volume = excluded.volume,
  note = excluded.note;

insert into public.order_items (order_id, name, qty)
select 'ord_demo_001', 'Fresh produce box', 1
where not exists (select 1 from public.order_items where order_id = 'ord_demo_001');
insert into public.order_items (order_id, name, qty)
select 'ord_demo_001', 'Dairy pack', 2
where not exists (select 1 from public.order_items where order_id = 'ord_demo_001' and name = 'Dairy pack');
insert into public.order_items (order_id, name, qty)
select 'ord_demo_002', 'Pantry staples', 1
where not exists (select 1 from public.order_items where order_id = 'ord_demo_002');
insert into public.order_items (order_id, name, qty)
select 'ord_demo_003', 'Sourdough loaves', 3
where not exists (select 1 from public.order_items where order_id = 'ord_demo_003');

commit;
