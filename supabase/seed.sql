-- Delivery Planner sample data for Supabase/PostgreSQL.
-- Run schema.sql first. This script contains only current geographic sample
-- data; login accounts are created by `npm run seed` because passwords use
-- server-side scrypt hashes.

begin;

insert into public.merchants (id, name) values
  ('mch_harbor_grocery', 'Harbor Grocery Co.'),
  ('mch_north_bakery', 'North Street Bakery')
on conflict (id) do update set name = excluded.name;

insert into public.stores (id, merchant_id, name, latitude, longitude, address) values
  ('sto_harbor_central', 'mch_harbor_grocery', 'Harbor Grocery — Central', 1.2644, 103.8222, '1 HarbourFront Walk, Singapore 098585'),
  ('sto_bakery_flagship', 'mch_north_bakery', 'North Street Bakery — Bishan', 1.3508, 103.8485, '9 Bishan Place, Singapore 579837')
on conflict (id) do update set
  merchant_id = excluded.merchant_id, name = excluded.name,
  latitude = excluded.latitude, longitude = excluded.longitude, address = excluded.address;

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

insert into public.driver_locations (driver_id, latitude, longitude, address) values
  ('drv_jordan_lee', 1.2997, 103.8553, '200 Victoria Street, Singapore 188024'),
  ('drv_priya_shah', 1.3526, 103.9442, '4 Tampines Central 5, Singapore 529510'),
  ('drv_marco_silva', 1.2936, 103.7838, '5 Lower Kent Ridge Road, Singapore 119074'),
  ('drv_hana_ito', 1.3020, 103.8746, '1 Stadium Drive, Singapore 397629'),
  ('drv_diego_torres', 1.3854, 103.7443, '21 Choa Chu Kang Avenue 4, Singapore 689812');

insert into public.products (id, merchant_id, name, description, price_cents, package_size, active) values
  ('prd_harbor_produce', 'mch_harbor_grocery', 'Fresh produce box', 'Seasonal fruit and vegetables', 2400, 'medium', 1),
  ('prd_harbor_dairy', 'mch_harbor_grocery', 'Dairy pack', 'Milk, butter, and yoghurt', 900, 'small', 1),
  ('prd_bakery_sourdough', 'mch_north_bakery', 'Sourdough loaf', 'Naturally leavened', 700, 'small', 1)
on conflict (id) do update set
  merchant_id = excluded.merchant_id, name = excluded.name,
  description = excluded.description, price_cents = excluded.price_cents,
  package_size = excluded.package_size, active = excluded.active;

insert into public.orders
  (id, merchant_id, store_id, customer_id, pickup_latitude, pickup_longitude,
   delivery_latitude, delivery_longitude, delivery_address, status, priority,
   deadline_ts, package_size, volume, note)
values
  ('ord_demo_001', 'mch_harbor_grocery', 'sto_harbor_central', 'cus_maya_chen',
   1.2644, 103.8222, 1.3040, 103.8318, '437 Orchard Road, Singapore 238879',
   'created', 'express', now() + interval '55 minutes', 'medium', 2, 'Leave at the front desk'),
  ('ord_demo_002', 'mch_harbor_grocery', 'sto_harbor_central', 'cus_james_wu',
   1.2644, 103.8222, 1.3658, 103.9293, '21 Tampines North Drive 2, Singapore 528765',
   'created', 'standard', now() + interval '120 minutes', 'small', 1, null),
  ('ord_demo_003', 'mch_north_bakery', 'sto_bakery_flagship', 'cus_james_wu',
   1.3508, 103.8485, 1.3331, 103.7423, '50 Jurong Gateway Road, Singapore 608549',
   'created', 'standard', now() + interval '90 minutes', 'small', 3, 'Call on arrival')
on conflict (id) do update set
  merchant_id = excluded.merchant_id, store_id = excluded.store_id,
  customer_id = excluded.customer_id, pickup_latitude = excluded.pickup_latitude,
  pickup_longitude = excluded.pickup_longitude, delivery_latitude = excluded.delivery_latitude,
  delivery_longitude = excluded.delivery_longitude, delivery_address = excluded.delivery_address,
  status = excluded.status, priority = excluded.priority, deadline_ts = excluded.deadline_ts,
  package_size = excluded.package_size, volume = excluded.volume, note = excluded.note;

delete from public.order_items where order_id in ('ord_demo_001', 'ord_demo_002', 'ord_demo_003');
insert into public.order_items (order_id, product_id, name, qty, unit_price_cents) values
  ('ord_demo_001', 'prd_harbor_produce', 'Fresh produce box', 1, 2400),
  ('ord_demo_001', 'prd_harbor_dairy', 'Dairy pack', 2, 900),
  ('ord_demo_002', 'prd_harbor_dairy', 'Dairy pack', 1, 900),
  ('ord_demo_003', 'prd_bakery_sourdough', 'Sourdough loaf', 3, 700);

commit;
