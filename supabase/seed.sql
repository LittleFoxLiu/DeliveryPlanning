-- RoutePilot demo data. Run schema.sql first, then run this file in Supabase SQL Editor.
insert into traffic_conditions (id, area, status, delay_minutes, source, observed_at) values
('10000000-0000-0000-0000-000000000101','Harbor tunnel','Heavy',18,'City traffic API',now()-interval '3 minutes'),
('10000000-0000-0000-0000-000000000102','Central avenue','Moderate',7,'Dispatcher report',now()-interval '8 minutes'),
('10000000-0000-0000-0000-000000000103','North interchange','Clear',0,'City traffic API',now()-interval '11 minutes'),
('10000000-0000-0000-0000-000000000104','West market road','Moderate',5,'Driver report',now()-interval '15 minutes'),
('10000000-0000-0000-0000-000000000105','Airport connector','Clear',0,'City traffic API',now()-interval '19 minutes'),
('10000000-0000-0000-0000-000000000106','South ring road','Heavy',24,'City traffic API',now()-interval '22 minutes'),
('10000000-0000-0000-0000-000000000107','Riverside drive','Moderate',9,'Driver report',now()-interval '28 minutes'),
('10000000-0000-0000-0000-000000000108','Old town crossing','Clear',0,'Dispatcher report',now()-interval '31 minutes')
on conflict (id) do update set status=excluded.status,delay_minutes=excluded.delay_minutes,observed_at=excluded.observed_at;

insert into customer_orders (id,customer_name,location,zone,items,delivery_window,priority,volume_units,status) values
('20000000-0000-0000-0000-000000000201','Maya Chen','18 Willow Lane','North','Fresh produce · 3 bags','09:00 – 10:00','Standard',3,'Ready'),
('20000000-0000-0000-0000-000000000202','James Wu','42 Harbor View','Harbor','Household · 2 boxes','09:30 – 10:30','Express',2,'Ready'),
('20000000-0000-0000-0000-000000000203','Sofia Lin','7 Market Street','Central','Pantry · 1 box','10:00 – 11:30','Standard',1,'Ready'),
('20000000-0000-0000-0000-000000000204','Noah Patel','91 Cedar Park','North','Pet supplies · 4 bags','10:30 – 12:00','Standard',4,'Ready'),
('20000000-0000-0000-0000-000000000205','Evelyn Hart','3 Foundry Road','West','Personal care · 2 boxes','11:00 – 12:00','Standard',2,'Ready'),
('20000000-0000-0000-0000-000000000206','Leo Martin','66 Palm Avenue','South','Cold goods · 5 bags','11:30 – 13:00','Express',5,'Ready'),
('20000000-0000-0000-0000-000000000207','Amelia Kao','12 Grove Crescent','West','Bakery · 1 bag','12:00 – 13:30','Standard',1,'Ready'),
('20000000-0000-0000-0000-000000000208','Oliver Reed','25 Station Walk','Central','Pantry · 3 boxes','12:30 – 14:00','Standard',3,'Ready'),
('20000000-0000-0000-0000-000000000209','Grace Park','8 Seaview Road','Harbor','Frozen food · 4 bags','13:00 – 14:00','Express',4,'Ready'),
('20000000-0000-0000-0000-000000000210','Ethan Cole','54 Pine Terrace','North','Cleaning supplies · 2 boxes','13:30 – 15:00','Standard',2,'Ready'),
('20000000-0000-0000-0000-000000000211','Iris Wong','29 Garden Row','South','Drinks · 6 cases','14:00 – 15:30','Standard',6,'Ready'),
('20000000-0000-0000-0000-000000000212','Daniel Ross','103 Hill Street','Central','Baby care · 2 boxes','14:30 – 16:00','Standard',2,'Ready')
on conflict (id) do update set status=excluded.status,priority=excluded.priority,volume_units=excluded.volume_units;

update customer_orders
set grid_x=case zone when 'North' then 40 when 'Central' then 27 when 'Harbor' then 43 when 'West' then 10 when 'South' then 24 else 25 end,
    grid_y=case zone when 'North' then 8 when 'Central' then 24 when 'Harbor' then 35 when 'West' then 27 when 'South' then 43 else 25 end
where grid_x is null or grid_y is null;

insert into driver_conditions (id,driver_name,availability,current_load,current_position,maximum_load,vehicle) values
('30000000-0000-0000-0000-000000000301','Jordan Lee','Available',4,'North depot',12,'Van · RP-18'),
('30000000-0000-0000-0000-000000000302','Priya Shah','On route',8,'Central avenue',12,'Van · RP-21'),
('30000000-0000-0000-0000-000000000303','Marco Silva','Available',2,'South depot',10,'Van · RP-24'),
('30000000-0000-0000-0000-000000000304','Hana Ito','Break',0,'West depot',8,'Bike · RP-27'),
('30000000-0000-0000-0000-000000000305','Camila Torres','Available',1,'Harbor depot',14,'Van · RP-31'),
('30000000-0000-0000-0000-000000000306','Theo Grant','On route',6,'Riverside drive',10,'Van · RP-34'),
('30000000-0000-0000-0000-000000000307','Nina Brooks','Available',0,'Central depot',8,'Bike · RP-36'),
('30000000-0000-0000-0000-000000000308','Andre Kim','Available',3,'West depot',12,'Van · RP-40')
on conflict (id) do update set availability=excluded.availability,current_load=excluded.current_load,current_position=excluded.current_position;

insert into planned_routes (id,route_code,driver_id,order_ids,distance_km,eta_minutes,capacity_percent,graph_snapshot) values
('40000000-0000-0000-0000-000000000401','RT-01','30000000-0000-0000-0000-000000000301',array['20000000-0000-0000-0000-000000000201'::uuid,'20000000-0000-0000-0000-000000000204'::uuid],8.4,42,75,'{"strategy":"capacity-aware","traffic_buffer":0,"stops":2}'::jsonb),
('40000000-0000-0000-0000-000000000402','RT-02','30000000-0000-0000-0000-000000000302',array['20000000-0000-0000-0000-000000000202'::uuid,'20000000-0000-0000-0000-000000000209'::uuid],11.8,67,100,'{"strategy":"capacity-aware","traffic_buffer":18,"stops":2}'::jsonb),
('40000000-0000-0000-0000-000000000403','RT-03','30000000-0000-0000-0000-000000000303',array['20000000-0000-0000-0000-000000000203'::uuid,'20000000-0000-0000-0000-000000000205'::uuid,'20000000-0000-0000-0000-000000000207'::uuid],15.8,64,60,'{"strategy":"capacity-aware","traffic_buffer":7,"stops":3}'::jsonb),
('40000000-0000-0000-0000-000000000404','RT-04','30000000-0000-0000-0000-000000000305',array['20000000-0000-0000-0000-000000000206'::uuid,'20000000-0000-0000-0000-000000000211'::uuid],18.2,90,86,'{"strategy":"capacity-aware","traffic_buffer":24,"stops":2}'::jsonb)
on conflict (id) do update set capacity_percent=excluded.capacity_percent,graph_snapshot=excluded.graph_snapshot;
