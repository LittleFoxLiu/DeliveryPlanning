import { q, q1, initDb, resetDb, closeDb } from './db.js';
import { hashPassword } from './auth.js';
import { users, merchants, stores, customers, drivers, orders, roads, traffic, products } from './repo.js';
import { buildRoadGrid } from './engine/routing.js';
import { minutesFromNow } from './util.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';

export async function seed(opts: { reset?: boolean } = {}): Promise<void> {
  await initDb();
  if (opts.reset) await resetDb();

  const existing = await q1<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');
  if ((existing?.n ?? 0) > 0 && !opts.reset) {
    // Data already seeded. Keep the demo usable across days by refreshing the
    // deadline of any not-yet-dispatched order whose deadline has passed
    // (persistent local DB only — this never rewrites in-flight deliveries).
    const bumped = await q<{ id: string }>(
      `UPDATE orders SET deadline_ts = now() + interval '90 minutes'
       WHERE status IN ('created','ready','validated') AND deadline_ts < now()
       RETURNING id`);
    if (bumped.length && process.env.NODE_ENV !== 'test') {
      console.log(`[seed] refreshed ${bumped.length} stale order deadline(s)`);
    }
    return;
  }

  // --- road grid ---
  for (const s of buildRoadGrid()) {
    const rid = s.ay === s.by ? `H-${s.ax}-${s.ay}` : `V-${s.ax}-${s.ay}`;
    await q(`INSERT INTO road_segments (id, ax, ay, bx, by, status, delay_minutes) VALUES (?,?,?,?,?, 'clear', 0)
             ON CONFLICT (id) DO NOTHING`, [rid, s.ax, s.ay, s.bx, s.by]);
  }

  for (const rid of ['H-9-10', 'H-10-10', 'H-11-10', 'V-13-6', 'V-13-7']) await roads.setStatus(rid, 'moderate', 4);
  for (const rid of ['H-14-4', 'H-15-4']) await roads.setStatus(rid, 'heavy', 10);

  await traffic.upsert({ id: 'traf_central', area: 'Central Avenue', status: 'moderate', delay: 4, source: 'City traffic API' });
  await traffic.upsert({ id: 'traf_north', area: 'North Market Road', status: 'heavy', delay: 10, source: 'Dispatcher report' });
  await traffic.upsert({ id: 'traf_harbor', area: 'Harbor Loop', status: 'clear', delay: 0, source: 'City traffic API' });

  const harbor = await merchants.create('Harbor Grocery Co.');
  const harborStore = await stores.create({ merchantId: harbor.id, name: 'Harbor Grocery — Central', pickupLat: 10, pickupLng: 10 });
  const bakery = await merchants.create('North Street Bakery');
  const bakeryStore = await stores.create({ merchantId: bakery.id, name: 'North Street Bakery — Flagship', pickupLat: 15, pickupLng: 5 });

  const mkProduct = (merchantId: string, name: string, priceCents: number, packageSize: 'small' | 'medium' | 'large', description: string) =>
    products.create({ merchantId, name, priceCents, packageSize, description });

  const harborProducts = await Promise.all([
    mkProduct(harbor.id, 'Fresh produce box', 2400, 'medium', 'Seasonal fruit & veg, ~4kg'),
    mkProduct(harbor.id, 'Dairy pack', 900, 'small', 'Milk, butter, yoghurt'),
    mkProduct(harbor.id, 'Pantry staples bundle', 1800, 'medium', 'Rice, pasta, canned goods'),
    mkProduct(harbor.id, 'Sparkling water (12-pack)', 1100, 'large', 'Glass bottles, 12 × 330ml'),
    mkProduct(harbor.id, 'Bag of coffee beans', 1500, 'small', 'Single-origin, 250g'),
  ]);
  const bakeryProducts = await Promise.all([
    mkProduct(bakery.id, 'Sourdough loaf', 700, 'small', 'Naturally leavened, sliced on request'),
    mkProduct(bakery.id, 'Almond croissant', 450, 'small', 'Filled with frangipane'),
    mkProduct(bakery.id, 'Celebration cake', 3800, 'large', 'Serves 12, 24h notice ideal'),
    mkProduct(bakery.id, 'Cinnamon roll (6-pack)', 1500, 'medium', 'Cream-cheese glaze'),
  ]);

  const driverSpecs = [
    { name: 'Jordan Lee', vehicleType: 'van' as const, capacity: 4, maxPackageSize: 'large' as const, lat: 3, lng: 3, status: 'available' as const },
    { name: 'Priya Shah', vehicleType: 'car' as const, capacity: 3, maxPackageSize: 'medium' as const, lat: 16, lng: 15, status: 'available' as const },
    { name: 'Marco Silva', vehicleType: 'van' as const, capacity: 5, maxPackageSize: 'large' as const, lat: 10, lng: 18, status: 'available' as const },
    { name: 'Hana Ito', vehicleType: 'bike' as const, capacity: 2, maxPackageSize: 'small' as const, lat: 6, lng: 11, status: 'available' as const },
    { name: 'Diego Torres', vehicleType: 'truck' as const, capacity: 6, maxPackageSize: 'large' as const, lat: 18, lng: 8, status: 'break' as const },
  ];
  for (let i = 0; i < driverSpecs.length; i++) {
    const d = await drivers.create(driverSpecs[i]);
    await mkUser(`driver${i + 1}@demo.test`, 'driver', driverSpecs[i].name, d.id);
  }

  await mkUser('admin@demo.test', 'admin', 'Alex Morgan (Dispatch)', null);
  await mkUser('harbor@demo.test', 'merchant', 'Harbor Grocery Ops', harbor.id);
  await mkUser('bakery@demo.test', 'merchant', 'North Street Bakery Ops', bakery.id);
  const cust1 = await customers.create('Maya Chen');
  const cust2 = await customers.create('James Wu');
  await mkUser('maya@demo.test', 'customer', 'Maya Chen', cust1.id);
  await mkUser('james@demo.test', 'customer', 'James Wu', cust2.id);

  const line = (p: { id: string; name: string; price_cents: number }, qty: number) =>
    ({ productId: p.id, name: p.name, qty, unitPriceCents: p.price_cents });

  await orders.create({
    merchant_id: harbor.id, store_id: harborStore.id, customer_id: cust1.id,
    pickup_lat: 10, pickup_lng: 10, delivery_lat: 17, delivery_lng: 3,
    priority: 'express', deadline_ts: minutesFromNow(55), package_size: 'medium', volume: 3,
    note: 'Leave at the front desk', items: [line(harborProducts[0], 1), line(harborProducts[1], 2)],
  });
  await orders.create({
    merchant_id: harbor.id, store_id: harborStore.id, customer_id: cust2.id,
    pickup_lat: 10, pickup_lng: 10, delivery_lat: 4, delivery_lng: 16,
    priority: 'standard', deadline_ts: minutesFromNow(120), package_size: 'medium', volume: 1,
    note: null, items: [line(harborProducts[2], 1)],
  });
  await orders.create({
    merchant_id: bakery.id, store_id: bakeryStore.id, customer_id: cust2.id,
    pickup_lat: 15, pickup_lng: 5, delivery_lat: 6, delivery_lng: 9,
    priority: 'standard', deadline_ts: minutesFromNow(90), package_size: 'small', volume: 3,
    note: 'Call on arrival', items: [line(bakeryProducts[0], 3)],
  });

  if (process.env.NODE_ENV !== 'test') {
    console.log('[seed] demo data ready. Password for every demo account:', DEMO_PASSWORD);
  }
}

async function mkUser(email: string, role: 'admin' | 'merchant' | 'driver' | 'customer', name: string, refId: string | null) {
  if (await users.byEmail(email)) return;
  const { hash, salt } = hashPassword(DEMO_PASSWORD);
  await users.create({ email, passwordHash: hash, passwordSalt: salt, role, name, refId });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  seed({ reset: process.argv.includes('--reset') })
    .then(() => { console.log('[seed] done'); return closeDb(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
