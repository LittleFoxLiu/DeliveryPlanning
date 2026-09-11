import { q, q1, initDb, resetDb, closeDb } from './db.js';
import { hashPassword } from './auth.js';
import { users, merchants, stores, customers, drivers, orders, products, roads, traffic } from './repo.js';
import { buildRoadGrid } from './engine/routing.js';
import { minutesFromNow } from './util.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';

type SeedLocation = { address: string; lat: number; lon: number };

// Curated public places on Singapore's developed road network. Random points
// are never generated directly from the country's bounding box, which could
// place a driver or delivery in the sea, a reservoir, or an undeveloped area.
const VALID_SINGAPORE_LOCATIONS: SeedLocation[] = [
  { address: '1 HarbourFront Walk, Singapore 098585', lat: 1.2644, lon: 103.8222 },
  { address: '9 Bishan Place, Singapore 579837', lat: 1.3508, lon: 103.8485 },
  { address: '10 Bayfront Avenue, Singapore 018956', lat: 1.2834, lon: 103.8607 },
  { address: '437 Orchard Road, Singapore 238879', lat: 1.3040, lon: 103.8318 },
  { address: '10 Paya Lebar Road, Singapore 409057', lat: 1.3179, lon: 103.8926 },
  { address: '200 Victoria Street, Singapore 188024', lat: 1.2997, lon: 103.8553 },
  { address: '4 Tampines Central 5, Singapore 529510', lat: 1.3526, lon: 103.9442 },
  { address: '5 Lower Kent Ridge Road, Singapore 119074', lat: 1.2936, lon: 103.7838 },
  { address: '1 Stadium Drive, Singapore 397629', lat: 1.3020, lon: 103.8746 },
  { address: '1 Woodlands Square, Singapore 738099', lat: 1.4368, lon: 103.7865 },
  { address: '1 Jurong West Central 2, Singapore 648886', lat: 1.3395, lon: 103.7066 },
  { address: '21 Choa Chu Kang Avenue 4, Singapore 689812', lat: 1.3854, lon: 103.7443 },
  { address: '50 Jurong Gateway Road, Singapore 608549', lat: 1.3331, lon: 103.7423 },
  { address: '21 Tampines North Drive 2, Singapore 528765', lat: 1.3658, lon: 103.9293 },
  { address: '1 Sengkang Square, Singapore 545078', lat: 1.3916, lon: 103.8957 },
];

function randomLocations(count: number): SeedLocation[] {
  return [...VALID_SINGAPORE_LOCATIONS]
    .sort(() => Math.random() - 0.5)
    .slice(0, count);
}

export async function seed(opts: { reset?: boolean } = {}): Promise<void> {
  await initDb();
  if (opts.reset) await resetDb();

  // The abstract road grid backs deterministic routing, the traffic simulator
  // and the offline routing fallback. Idempotent — recreated on every boot so
  // an older database that predates it still gets one.
  const roadCount = await q1<{ n: number }>('SELECT COUNT(*)::int AS n FROM road_segments');
  if ((roadCount?.n ?? 0) === 0) {
    for (const s of buildRoadGrid()) {
      const rid = s.ay === s.by ? `H-${s.ax}-${s.ay}` : `V-${s.ax}-${s.ay}`;
      await q(`INSERT INTO road_segments (id, ax, ay, bx, by, status, delay_minutes) VALUES (?,?,?,?,?, 'clear', 0)
               ON CONFLICT (id) DO NOTHING`, [rid, s.ax, s.ay, s.bx, s.by]);
    }
  }

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

  // These are Singapore addresses and coordinates returned by Nominatim. They
  // are stored directly; the seed never creates synthetic positions.
  const locations = randomLocations(10);
  const [harborLocation, bakeryLocation, ...driverLocations] = locations;

  const harbor = await merchants.create('Harbor Grocery Co.');
  const harborStore = await stores.create({ merchantId: harbor.id, name: 'Harbor Grocery', latitude: harborLocation.lat, longitude: harborLocation.lon, address: harborLocation.address });
  const bakery = await merchants.create('North Street Bakery');
  const bakeryStore = await stores.create({ merchantId: bakery.id, name: 'North Street Bakery', latitude: bakeryLocation.lat, longitude: bakeryLocation.lon, address: bakeryLocation.address });

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
    ...driverLocations.slice(0, 5).map((location, i) => ({
      name: ['Jordan Lee', 'Priya Shah', 'Marco Silva', 'Hana Ito', 'Diego Torres'][i],
      vehicleType: ['van', 'car', 'van', 'bike', 'truck'][i] as 'van' | 'car' | 'bike' | 'truck',
      capacity: [4, 3, 5, 2, 6][i], maxPackageSize: ['large', 'medium', 'large', 'small', 'large'][i] as 'small' | 'medium' | 'large',
      latitude: location.lat, longitude: location.lon, status: (i === 4 ? 'break' : 'available') as 'available' | 'break', address: location.address,
    })),
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
    pickup_latitude: harborLocation.lat, pickup_longitude: harborLocation.lon, delivery_latitude: locations[7].lat, delivery_longitude: locations[7].lon, delivery_address: locations[7].address,
    priority: 'express', deadline_ts: minutesFromNow(55), package_size: 'medium', volume: 3,
    note: 'Leave at the front desk', items: [line(harborProducts[0], 1), line(harborProducts[1], 2)],
  });
  await orders.create({
    merchant_id: harbor.id, store_id: harborStore.id, customer_id: cust2.id,
    pickup_latitude: harborLocation.lat, pickup_longitude: harborLocation.lon, delivery_latitude: locations[8].lat, delivery_longitude: locations[8].lon, delivery_address: locations[8].address,
    priority: 'standard', deadline_ts: minutesFromNow(120), package_size: 'medium', volume: 1,
    note: null, items: [line(harborProducts[2], 1)],
  });
  await orders.create({
    merchant_id: bakery.id, store_id: bakeryStore.id, customer_id: cust2.id,
    pickup_latitude: bakeryLocation.lat, pickup_longitude: bakeryLocation.lon, delivery_latitude: locations[9].lat, delivery_longitude: locations[9].lon, delivery_address: locations[9].address,
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

const isMain = process.argv[1] && typeof import.meta.url === 'string' && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  seed({ reset: process.argv.includes('--reset') })
    .then(() => { console.log('[seed] done'); return closeDb(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
