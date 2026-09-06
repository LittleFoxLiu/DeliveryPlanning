-- Small 20x20 sample dataset. Run after 003_resize_grid_to_20x20.sql.
insert into traffic_conditions (area,status,delay_minutes,source) values
('North avenue','Moderate',6,'Sample traffic feed'),('Harbor crossing','Heavy',14,'Sample traffic feed');

insert into customer_orders (customer_name,location,zone,items,delivery_window,priority,volume_units,status,grid_x,grid_y) values
('Ava Lin','12 North Avenue','North','Groceries · 2 bags','09:00 - 10:00','Express',2,'Ready',16,3),
('Ben Carter','8 Harbor Road','Harbor','Household · 1 box','10:00 - 11:00','Standard',1,'Ready',17,14),
('Chloe Wu','31 Central Street','Central','Pantry · 3 boxes','11:00 - 12:00','Standard',3,'Ready',11,10);

insert into driver_conditions (driver_name,availability,current_load,current_position,maximum_load,vehicle) values
('Sam Rivera','Available',1,'Central depot',10,'Van · SAMPLE-01'),
('Ella Martin','On route',4,'North avenue',12,'Van · SAMPLE-02');

update road_segments set status='Heavy',delay_minutes=14,source='Sample traffic feed'
where id in ('H-17-14','H-16-14','V-17-13','V-17-14');
update road_segments set status='Moderate',delay_minutes=6,source='Sample traffic feed'
where id in ('H-11-10','H-10-10','V-11-9','V-11-10');
