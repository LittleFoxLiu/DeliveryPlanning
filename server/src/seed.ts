import { getDb, resetDb } from './db.js';
import { hashPassword } from './auth.js';
import { users, merchants, stores, customers, drivers, orders, roads, traffic } from './repo.js';
import { buildRoadGrid } from './engine/routing.js';
import { minutesFromNow } from './util.js';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';

export function seed(opts: { reset?: boolean } = {}): void {
  const db = getDb();
  if (opts.reset) resetDb();

  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (existing.n > 0 && !opts.reset) return;

  // --- road grid ---
  const grid = buildRoadGrid();
  const insertRoad = db.prepare(`INSERT INTO road_segments (id, ax, ay, bx, by, status, delay_minutes) VALUES (?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  for (const s of grid) {
    const id = s.ay === s.by ? `H-${s.ax}-${s.ay}` : `V-${s.ax}-${s.ay}`;
    insertRoad.run(id, s.ax, s.ay, s.bx, s.by, 'clear', 0);
  }
  db.exec('COMMIT');

  // a little baseline congestion so routing has texture
  for (const id of ['H-9-10', 'H-10-10', 'H-11-10', 'V-13-6', 'V-13-7']) roads.setStatus(id, 'moderate', 4);
  for (const id of ['H-14-4', 'H-15-4']) roads.setStatus(id, 'heavy', 10);

  traffic.upsert({ id: 'traf_central', area: 'Central Avenue', status: 'moderate', delay: 4, source: 'City traffic API' });
  traffic.upsert({ id: 'traf_north', area: 'North Market Road', status: 'heavy', delay: 10, source: 'Dispatcher report' });
  traffic.upsert({ id: 'traf_harbor', area: 'Harbor Loop', status: 'clear', delay: 0, source: 'City traffic API' });

  // --- merchants + stores ---
  const harbor = merchants.create('Harbor Grocery Co.');
  const harborStore = stores.create({ merchantId: harbor.id, name: 'Harbor Grocery — Central', pickupLat: 10, pickupLng: 10 });
  const bakery = merchants.create('North Street Bakery');
  const bakeryStore = stores.create({ merchantId: bakery.id, name: 'North Street Bakery — Flagship', pickupLat: 15, pickupLng: 5 });

  // --- drivers ---
  const driverSpecs = [
    { name: 'Jordan Lee', vehicleType: 'van' as const, capacity: 4, maxPackageSize: 'large' as const, lat: 3, lng: 3, status: 'available' as const },
    { name: 'Priya Shah', vehicleType: 'car' as const, capacity: 3, maxPackageSize: 'medium' as const, lat: 16, lng: 15, status: 'available' as const },
    { name: 'Marco Silva', vehicleType: 'van' as const, capacity: 5, maxPackageSize: 'large' as const, lat: 10, lng: 18, status: 'available' as const },
    { name: 'Hana Ito', vehicleType: 'bike' as const, capacity: 2, maxPackageSize: 'small' as const, lat: 6, lng: 11, status: 'available' as const },
    { name: 'Diego Torres', vehicleType: 'truck' as const, capacity: 6, maxPackageSize: 'large' as const, lat: 18, lng: 8, status: 'break' as const },
  ];
  const driverIds = driverSpecs.map((spec, i) => {
    const d = drivers.create(spec);
    mkUser(`driver${i + 1}@demo.test`, 'driver', spec.name, d.id);
    return d.id;
  });
  void driverIds;

  // --- users ---
  mkUser('admin@demo.test', 'admin', 'Alex Morgan (Dispatch)', null);
  mkUser('harbor@demo.test', 'merchant', 'Harbor Grocery Ops', harbor.id);
  mkUser('bakery@demo.test', 'merchant', 'North Street Bakery Ops', bakery.id);
  const cust1 = customers.create('Maya Chen');
  const cust2 = customers.create('James Wu');
  mkUser('maya@demo.test', 'customer', 'Maya Chen', cust1.id);
  mkUser('james@demo.test', 'customer', 'James Wu', cust2.id);

  // --- sample orders (left in 'created' so the merchant can mark them ready on stage) ---
  orders.create({
    merchant_id: harbor.id, store_id: harborStore.id, customer_id: cust1.id,
    pickup_lat: 10, pickup_lng: 10, delivery_lat: 17, delivery_lng: 3,
    priority: 'express', deadline_ts: minutesFromNow(55), package_size: 'medium', volume: 2,
    note: 'Leave at the front desk', items: [{ name: 'Fresh produce box', qty: 1 }, { name: 'Dairy pack', qty: 2 }],
  });
  orders.create({
    merchant_id: harbor.id, store_id: harborStore.id, customer_id: cust2.id,
    pickup_lat: 10, pickup_lng: 10, delivery_lat: 4, delivery_lng: 16,
    priority: 'standard', deadline_ts: minutesFromNow(120), package_size: 'small', volume: 1,
    note: null, items: [{ name: 'Pantry staples', qty: 1 }],
  });
  orders.create({
    merchant_id: bakery.id, store_id: bakeryStore.id, customer_id: cust2.id,
    pickup_lat: 15, pickup_lng: 5, delivery_lat: 6, delivery_lng: 9,
    priority: 'standard', deadline_ts: minutesFromNow(90), package_size: 'small', volume: 1,
    note: 'Call on arrival', items: [{ name: 'Sourdough loaves', qty: 3 }],
  });

  if (process.env.NODE_ENV !== 'test') {
    console.log('[seed] demo data ready. Password for every demo account:', DEMO_PASSWORD);
  }
}

function mkUser(email: string, role: 'admin' | 'merchant' | 'driver' | 'customer', name: string, refId: string | null) {
  if (users.byEmail(email)) return;
  const { hash, salt } = hashPassword(DEMO_PASSWORD);
  users.create({ email, passwordHash: hash, passwordSalt: salt, role, name, refId });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  seed({ reset: process.argv.includes('--reset') });
  console.log('[seed] done');
}
