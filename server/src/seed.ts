import { resetDb } from './db.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';
import { users, merchants, stores, customers, drivers, orders, roads, traffic } from './repo.js';
import { buildRoadGrid } from './engine/routing.js';
import { minutesFromNow } from './util.js';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';

export async function seed(opts: { reset?: boolean } = {}): Promise<void> {
  if (opts.reset) await resetDb();
  if (await users.byEmail('admin@demo.test')) return;

  // `supabase/seed.sql` uses stable IDs and intentionally omits password
  // hashes. If that SQL seed was applied directly, attach the demo accounts
  // to its existing records instead of creating a second copy of the domain
  // data.
  const sqlSeedReady = (await Promise.all([
    merchants.byId('mch_harbor_grocery'), stores.byId('sto_harbor_central'),
    merchants.byId('mch_north_bakery'), stores.byId('sto_bakery_flagship'),
    customers.byId('cus_maya_chen'), customers.byId('cus_james_wu'),
    drivers.byId('drv_jordan_lee'), drivers.byId('drv_priya_shah'),
    drivers.byId('drv_marco_silva'), drivers.byId('drv_hana_ito'),
    drivers.byId('drv_diego_torres'),
  ])).every(Boolean);
  if (sqlSeedReady) {
    await mkUser('admin@demo.test', 'admin', 'Alex Morgan (Dispatch)', null);
    await mkUser('harbor@demo.test', 'merchant', 'Harbor Grocery Ops', 'mch_harbor_grocery');
    await mkUser('bakery@demo.test', 'merchant', 'North Street Bakery Ops', 'mch_north_bakery');
    const sqlDrivers = [
      ['driver1@demo.test', 'Jordan Lee', 'drv_jordan_lee'],
      ['driver2@demo.test', 'Priya Shah', 'drv_priya_shah'],
      ['driver3@demo.test', 'Marco Silva', 'drv_marco_silva'],
      ['driver4@demo.test', 'Hana Ito', 'drv_hana_ito'],
      ['driver5@demo.test', 'Diego Torres', 'drv_diego_torres'],
    ] as const;
    for (const [email, name, driverId] of sqlDrivers) await mkUser(email, 'driver', name, driverId);
    await mkUser('maya@demo.test', 'customer', 'Maya Chen', 'cus_maya_chen');
    await mkUser('james@demo.test', 'customer', 'James Wu', 'cus_james_wu');
    if (process.env.NODE_ENV !== 'test') console.log('[seed] Attached demo users to existing Supabase SQL seed.');
    return;
  }

  const roadRows = buildRoadGrid().map((s) => {
    const roadId = s.ay === s.by ? `H-${s.ax}-${s.ay}` : `V-${s.ax}-${s.ay}`;
    return { id: roadId, ax: s.ax, ay: s.ay, bx: s.bx, by: s.by };
  });
  await roads.upsertMany(roadRows);
  for (const roadId of ['H-9-10', 'H-10-10', 'H-11-10', 'V-13-6', 'V-13-7']) await roads.setStatus(roadId, 'moderate', 4);
  for (const roadId of ['H-14-4', 'H-15-4']) await roads.setStatus(roadId, 'heavy', 10);

  await traffic.upsert({ id: 'traf_central', area: 'Central Avenue', status: 'moderate', delay: 4, source: 'City traffic API' });
  await traffic.upsert({ id: 'traf_north', area: 'North Market Road', status: 'heavy', delay: 10, source: 'Dispatcher report' });
  await traffic.upsert({ id: 'traf_harbor', area: 'Harbor Loop', status: 'clear', delay: 0, source: 'City traffic API' });

  const harbor = await merchants.create('Harbor Grocery Co.');
  const harborStore = await stores.create({ merchantId: harbor.id, name: 'Harbor Grocery — Central', pickupLat: 10, pickupLng: 10 });
  const bakery = await merchants.create('North Street Bakery');
  const bakeryStore = await stores.create({ merchantId: bakery.id, name: 'North Street Bakery — Flagship', pickupLat: 15, pickupLng: 5 });

  const driverSpecs = [
    { name: 'Jordan Lee', vehicleType: 'van' as const, capacity: 4, maxPackageSize: 'large' as const, lat: 3, lng: 3, status: 'available' as const },
    { name: 'Priya Shah', vehicleType: 'car' as const, capacity: 3, maxPackageSize: 'medium' as const, lat: 16, lng: 15, status: 'available' as const },
    { name: 'Marco Silva', vehicleType: 'van' as const, capacity: 5, maxPackageSize: 'large' as const, lat: 10, lng: 18, status: 'available' as const },
    { name: 'Hana Ito', vehicleType: 'bike' as const, capacity: 2, maxPackageSize: 'small' as const, lat: 6, lng: 11, status: 'available' as const },
    { name: 'Diego Torres', vehicleType: 'truck' as const, capacity: 6, maxPackageSize: 'large' as const, lat: 18, lng: 8, status: 'break' as const },
  ];
  for (const [i, spec] of driverSpecs.entries()) {
    const d = await drivers.create(spec);
    await mkUser(`driver${i + 1}@demo.test`, 'driver', spec.name, d.id);
  }

  await mkUser('admin@demo.test', 'admin', 'Alex Morgan (Dispatch)', null);
  await mkUser('harbor@demo.test', 'merchant', 'Harbor Grocery Ops', harbor.id);
  await mkUser('bakery@demo.test', 'merchant', 'North Street Bakery Ops', bakery.id);
  const cust1 = await customers.create('Maya Chen');
  const cust2 = await customers.create('James Wu');
  await mkUser('maya@demo.test', 'customer', 'Maya Chen', cust1.id);
  await mkUser('james@demo.test', 'customer', 'James Wu', cust2.id);

  await orders.create({ merchant_id: harbor.id, store_id: harborStore.id, customer_id: cust1.id, pickup_lat: 10, pickup_lng: 10, delivery_lat: 17, delivery_lng: 3, priority: 'express', deadline_ts: minutesFromNow(55), package_size: 'medium', volume: 2, note: 'Leave at the front desk', items: [{ name: 'Fresh produce box', qty: 1 }, { name: 'Dairy pack', qty: 2 }] });
  await orders.create({ merchant_id: harbor.id, store_id: harborStore.id, customer_id: cust2.id, pickup_lat: 10, pickup_lng: 10, delivery_lat: 4, delivery_lng: 16, priority: 'standard', deadline_ts: minutesFromNow(120), package_size: 'small', volume: 1, note: null, items: [{ name: 'Pantry staples', qty: 1 }] });
  await orders.create({ merchant_id: bakery.id, store_id: bakeryStore.id, customer_id: cust2.id, pickup_lat: 15, pickup_lng: 5, delivery_lat: 6, delivery_lng: 9, priority: 'standard', deadline_ts: minutesFromNow(90), package_size: 'small', volume: 1, note: 'Call on arrival', items: [{ name: 'Sourdough loaves', qty: 3 }] });

  if (process.env.NODE_ENV !== 'test') console.log('[seed] Supabase demo data ready. Password for every demo account:', DEMO_PASSWORD);
}

async function mkUser(email: string, role: 'admin' | 'merchant' | 'driver' | 'customer', name: string, refId: string | null): Promise<void> {
  if (await users.byEmail(email)) return;
  const { hash, salt } = hashPassword(DEMO_PASSWORD);
  await users.create({ email, passwordHash: hash, passwordSalt: salt, role, name, refId });
}

const entryPath = process.argv[1];
const isMain = !!entryPath && fileURLToPath(import.meta.url) === resolve(entryPath);
if (isMain) { await seed({ reset: process.argv.includes('--reset') }); console.log('[seed] done'); }
