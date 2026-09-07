import type { DatabaseSync } from 'node:sqlite';
import { getDb, qRun } from './db.js';
import { id, nowIso } from './util.js';
import { assertOrderTransition, assertDeliveryTransition, type OrderStatus, type DeliveryStatus } from './engine/stateMachine.js';
import type { Segment } from './engine/routing.js';

const db = (): DatabaseSync => getDb();

/* ------------------------------------------------------------------ users */
export interface UserRow { id: string; email: string; role: 'admin' | 'merchant' | 'driver' | 'customer'; name: string; ref_id: string | null }

export const users = {
  create(input: { email: string; passwordHash: string; passwordSalt: string; role: UserRow['role']; name: string; refId: string | null }): UserRow {
    const uid = id('usr');
    db().prepare(`INSERT INTO users (id, email, password_hash, password_salt, role, name, ref_id) VALUES (?,?,?,?,?,?,?)`)
      .run(uid, input.email.toLowerCase(), input.passwordHash, input.passwordSalt, input.role, input.name, input.refId);
    return { id: uid, email: input.email.toLowerCase(), role: input.role, name: input.name, ref_id: input.refId };
  },
  byEmail(email: string): (UserRow & { password_hash: string; password_salt: string }) | undefined {
    return db().prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase()) as never;
  },
  byId(uid: string): UserRow | undefined {
    return db().prepare(`SELECT id, email, role, name, ref_id FROM users WHERE id = ?`).get(uid) as never;
  },
};

/* -------------------------------------------------------------- merchants */
export const merchants = {
  create(name: string): { id: string; name: string } {
    const mid = id('mch');
    db().prepare(`INSERT INTO merchants (id, name) VALUES (?, ?)`).run(mid, name);
    return { id: mid, name };
  },
  byId(mid: string) { return db().prepare(`SELECT * FROM merchants WHERE id = ?`).get(mid) as { id: string; name: string } | undefined; },
  list() { return db().prepare(`SELECT * FROM merchants ORDER BY name`).all() as { id: string; name: string }[]; },
};

export const stores = {
  create(input: { merchantId: string; name: string; pickupLat: number; pickupLng: number }) {
    const sid = id('sto');
    db().prepare(`INSERT INTO stores (id, merchant_id, name, pickup_lat, pickup_lng) VALUES (?,?,?,?,?)`)
      .run(sid, input.merchantId, input.name, input.pickupLat, input.pickupLng);
    return { id: sid, ...input };
  },
  byId(sid: string) { return db().prepare(`SELECT * FROM stores WHERE id = ?`).get(sid) as unknown as StoreRow | undefined; },
  byMerchant(mid: string) { return db().prepare(`SELECT * FROM stores WHERE merchant_id = ? ORDER BY name`).all(mid) as unknown as StoreRow[]; },
};
export interface StoreRow { id: string; merchant_id: string; name: string; pickup_lat: number; pickup_lng: number }

export const customers = {
  create(name: string) { const cid = id('cus'); db().prepare(`INSERT INTO customers (id, name) VALUES (?, ?)`).run(cid, name); return { id: cid, name }; },
  byId(cid: string) { return db().prepare(`SELECT * FROM customers WHERE id = ?`).get(cid) as { id: string; name: string } | undefined; },
};

/* ---------------------------------------------------------------- drivers */
export interface DriverRow { id: string; name: string; vehicle_type: 'bike' | 'car' | 'van' | 'truck'; capacity: number; max_package_size: 'small' | 'medium' | 'large' }
export interface DriverFull extends DriverRow {
  status: DeliveryStatusForDriver; current_order_count: number; lat: number | null; lng: number | null; location_at: string | null;
}
type DeliveryStatusForDriver = 'available' | 'on_route' | 'break' | 'offline';

export const drivers = {
  create(input: { name: string; vehicleType: DriverRow['vehicle_type']; capacity: number; maxPackageSize: DriverRow['max_package_size']; lat: number; lng: number; status?: DeliveryStatusForDriver }) {
    const did = id('drv');
    db().prepare(`INSERT INTO drivers (id, name, vehicle_type, capacity, max_package_size) VALUES (?,?,?,?,?)`)
      .run(did, input.name, input.vehicleType, input.capacity, input.maxPackageSize);
    db().prepare(`INSERT INTO driver_status (driver_id, status, current_order_count) VALUES (?, ?, 0)`).run(did, input.status ?? 'available');
    db().prepare(`INSERT INTO driver_locations (driver_id, lat, lng) VALUES (?, ?, ?)`).run(did, input.lat, input.lng);
    return { id: did };
  },
  byId(did: string): DriverFull | undefined {
    return db().prepare(`
      SELECT d.*, s.status, s.current_order_count,
             (SELECT lat FROM driver_locations WHERE driver_id = d.id ORDER BY id DESC LIMIT 1) AS lat,
             (SELECT lng FROM driver_locations WHERE driver_id = d.id ORDER BY id DESC LIMIT 1) AS lng,
             (SELECT recorded_at FROM driver_locations WHERE driver_id = d.id ORDER BY id DESC LIMIT 1) AS location_at
      FROM drivers d JOIN driver_status s ON s.driver_id = d.id WHERE d.id = ?
    `).get(did) as never;
  },
  all(): DriverFull[] {
    return db().prepare(`
      SELECT d.*, s.status, s.current_order_count,
             (SELECT lat FROM driver_locations WHERE driver_id = d.id ORDER BY id DESC LIMIT 1) AS lat,
             (SELECT lng FROM driver_locations WHERE driver_id = d.id ORDER BY id DESC LIMIT 1) AS lng,
             (SELECT recorded_at FROM driver_locations WHERE driver_id = d.id ORDER BY id DESC LIMIT 1) AS location_at
      FROM drivers d JOIN driver_status s ON s.driver_id = d.id ORDER BY d.name
    `).all() as never;
  },
  setStatus(did: string, status: DeliveryStatusForDriver) {
    db().prepare(`UPDATE driver_status SET status = ?, updated_at = ? WHERE driver_id = ?`).run(status, nowIso(), did);
  },
  adjustOrderCount(did: string, delta: number) {
    db().prepare(`UPDATE driver_status SET current_order_count = MAX(0, current_order_count + ?), updated_at = ? WHERE driver_id = ?`)
      .run(delta, nowIso(), did);
  },
  recordLocation(did: string, lat: number, lng: number) {
    db().prepare(`INSERT INTO driver_locations (driver_id, lat, lng) VALUES (?, ?, ?)`).run(did, lat, lng);
  },
};

/* ----------------------------------------------------------------- orders */
export interface OrderRow {
  id: string; merchant_id: string; store_id: string; customer_id: string;
  pickup_lat: number; pickup_lng: number; delivery_lat: number; delivery_lng: number;
  status: OrderStatus; priority: 'standard' | 'express'; deadline_ts: string;
  package_size: 'small' | 'medium' | 'large'; volume: number; note: string | null;
  created_at: string; ready_at: string | null;
}

export const orders = {
  create(input: Omit<OrderRow, 'id' | 'status' | 'created_at' | 'ready_at'> & { items?: { name: string; qty: number }[] }): OrderRow {
    const oid = id('ord');
    db().prepare(`
      INSERT INTO orders (id, merchant_id, store_id, customer_id, pickup_lat, pickup_lng, delivery_lat, delivery_lng, status, priority, deadline_ts, package_size, volume, note)
      VALUES (?,?,?,?,?,?,?,?, 'created', ?,?,?,?,?)
    `).run(oid, input.merchant_id, input.store_id, input.customer_id, input.pickup_lat, input.pickup_lng,
      input.delivery_lat, input.delivery_lng, input.priority, input.deadline_ts, input.package_size, input.volume, input.note ?? null);
    for (const item of input.items ?? []) {
      db().prepare(`INSERT INTO order_items (order_id, name, qty) VALUES (?, ?, ?)`).run(oid, item.name, item.qty);
    }
    return orders.byId(oid)!;
  },
  byId(oid: string): OrderRow | undefined { return db().prepare(`SELECT * FROM orders WHERE id = ?`).get(oid) as never; },
  items(oid: string) { return db().prepare(`SELECT name, qty FROM order_items WHERE order_id = ?`).all(oid) as { name: string; qty: number }[]; },
  byMerchant(mid: string) { return db().prepare(`SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at DESC`).all(mid) as unknown as OrderRow[]; },
  byCustomer(cid: string) { return db().prepare(`SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC`).all(cid) as unknown as OrderRow[]; },
  all() { return db().prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all() as unknown as OrderRow[]; },
  active() {
    return db().prepare(`SELECT * FROM orders WHERE status NOT IN ('delivered','cancelled','failed') ORDER BY created_at DESC`).all() as unknown as OrderRow[];
  },
  /** Guarded state transition. Pass expectedFrom to make it a compare-and-set. */
  setStatus(oid: string, to: OrderStatus, expectedFrom?: OrderStatus | OrderStatus[]): OrderRow {
    const current = orders.byId(oid);
    if (!current) throw new Error('order not found');
    if (expectedFrom) {
      const allowed = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom];
      if (!allowed.includes(current.status)) {
        throw new Error(`order ${oid} expected ${allowed.join('/')} but was ${current.status}`);
      }
    }
    assertOrderTransition(current.status, to);
    const readyAt = to === 'ready' && !current.ready_at ? nowIso() : current.ready_at;
    db().prepare(`UPDATE orders SET status = ?, ready_at = ? WHERE id = ?`).run(to, readyAt, oid);
    return orders.byId(oid)!;
  },
};

/* ------------------------------------------------------------- deliveries */
export interface DeliveryRow {
  id: string; order_id: string; driver_id: string | null; status: DeliveryStatus;
  assigned_at: string | null; pickup_at: string | null; delivered_at: string | null;
  estimated_delivery_minutes: number | null; actual_delivery_minutes: number | null;
  eta_ts: string | null; route_id: string | null; created_at: string;
}

export const deliveries = {
  byOrderId(oid: string): DeliveryRow | undefined { return db().prepare(`SELECT * FROM deliveries WHERE order_id = ?`).get(oid) as never; },
  byId(dsid: string): DeliveryRow | undefined { return db().prepare(`SELECT * FROM deliveries WHERE id = ?`).get(dsid) as never; },
  byDriver(did: string) { return db().prepare(`SELECT * FROM deliveries WHERE driver_id = ? ORDER BY created_at DESC`).all(did) as unknown as DeliveryRow[]; },
  active() {
    return db().prepare(`SELECT * FROM deliveries WHERE status NOT IN ('delivered','cancelled','failed')`).all() as unknown as DeliveryRow[];
  },
  all() { return db().prepare(`SELECT * FROM deliveries ORDER BY created_at DESC`).all() as unknown as DeliveryRow[]; },
  ensure(oid: string): DeliveryRow {
    const existing = deliveries.byOrderId(oid);
    if (existing) return existing;
    const dsid = id('dlv');
    db().prepare(`INSERT INTO deliveries (id, order_id, status) VALUES (?, ?, 'pending')`).run(dsid, oid);
    return deliveries.byId(dsid)!;
  },
  update(dsid: string, patch: Partial<Pick<DeliveryRow, 'driver_id' | 'assigned_at' | 'pickup_at' | 'delivered_at' | 'estimated_delivery_minutes' | 'actual_delivery_minutes' | 'eta_ts' | 'route_id'>>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = ?`).join(', ');
    qRun(`UPDATE deliveries SET ${set} WHERE id = ?`, ...keys.map((k) => (patch as Record<string, unknown>)[k]), dsid);
  },
  setStatus(dsid: string, to: DeliveryStatus, expectedFrom?: DeliveryStatus | DeliveryStatus[]): DeliveryRow {
    const current = deliveries.byId(dsid);
    if (!current) throw new Error('delivery not found');
    if (expectedFrom) {
      const allowed = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom];
      if (!allowed.includes(current.status)) throw new Error(`delivery ${dsid} expected ${allowed.join('/')} but was ${current.status}`);
    }
    assertDeliveryTransition(current.status, to);
    db().prepare(`UPDATE deliveries SET status = ? WHERE id = ?`).run(to, dsid);
    return deliveries.byId(dsid)!;
  },
};

/* ------------------------------------------------------------------ routes */
export interface RouteRow {
  id: string; delivery_id: string; driver_id: string; origin_lat: number; origin_lng: number;
  legs_json: string; path_json: string; distance_km: number; eta_minutes: number;
  traffic_penalty_minutes: number; active: number; created_at: string;
}

export const routes = {
  activeForDelivery(dsid: string): RouteRow | undefined {
    return db().prepare(`SELECT * FROM routes WHERE delivery_id = ? AND active = 1 ORDER BY id DESC LIMIT 1`).get(dsid) as never;
  },
  create(input: { deliveryId: string; driverId: string; originLat: number; originLng: number; legs: unknown; path: unknown; distanceKm: number; etaMinutes: number; trafficPenalty: number }): RouteRow {
    db().prepare(`UPDATE routes SET active = 0 WHERE delivery_id = ?`).run(input.deliveryId);
    const rid = id('rte');
    db().prepare(`
      INSERT INTO routes (id, delivery_id, driver_id, origin_lat, origin_lng, legs_json, path_json, distance_km, eta_minutes, traffic_penalty_minutes, active)
      VALUES (?,?,?,?,?,?,?,?,?,?, 1)
    `).run(rid, input.deliveryId, input.driverId, input.originLat, input.originLng,
      JSON.stringify(input.legs), JSON.stringify(input.path), input.distanceKm, input.etaMinutes, input.trafficPenalty);
    return db().prepare(`SELECT * FROM routes WHERE id = ?`).get(rid) as never;
  },
};

/* ------------------------------------------------------------- assignments */
export interface AssignmentRow {
  id: string; order_id: string; driver_id: string; status: 'proposed' | 'active' | 'cancelled' | 'superseded' | 'rejected';
  score: number; reasoning_json: string; idempotency_key: string | null; created_at: string;
}

export const assignments = {
  activeForOrder(oid: string): AssignmentRow | undefined {
    return db().prepare(`SELECT * FROM assignments WHERE order_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`).get(oid) as never;
  },
  forOrder(oid: string) { return db().prepare(`SELECT * FROM assignments WHERE order_id = ? ORDER BY id DESC`).all(oid) as unknown as AssignmentRow[]; },
  byIdempotencyKey(key: string): AssignmentRow | undefined {
    return db().prepare(`SELECT * FROM assignments WHERE idempotency_key = ?`).get(key) as never;
  },
  create(input: { orderId: string; driverId: string; score: number; reasoning: unknown; idempotencyKey?: string | null; status?: AssignmentRow['status'] }): AssignmentRow {
    db().prepare(`UPDATE assignments SET status = 'superseded' WHERE order_id = ? AND status IN ('proposed','active')`).run(input.orderId);
    const aid = id('asg');
    db().prepare(`
      INSERT INTO assignments (id, order_id, driver_id, status, score, reasoning_json, idempotency_key)
      VALUES (?,?,?,?,?,?,?)
    `).run(aid, input.orderId, input.driverId, input.status ?? 'active', input.score, JSON.stringify(input.reasoning), input.idempotencyKey ?? null);
    return db().prepare(`SELECT * FROM assignments WHERE id = ?`).get(aid) as never;
  },
  cancel(oid: string) {
    db().prepare(`UPDATE assignments SET status = 'cancelled' WHERE order_id = ? AND status IN ('proposed','active')`).run(oid);
  },
};

/* -------------------------------------------------------------- road / traffic */
export interface RoadRow { id: string; ax: number; ay: number; bx: number; by: number; status: 'clear' | 'moderate' | 'heavy' | 'closed'; delay_minutes: number; updated_at: string }

export const roads = {
  all(): RoadRow[] { return db().prepare(`SELECT * FROM road_segments ORDER BY id`).all() as never; },
  segments(): Segment[] {
    return roads.all().map((r) => ({ id: r.id, ax: r.ax, ay: r.ay, bx: r.bx, by: r.by, status: r.status, delay_minutes: r.delay_minutes }));
  },
  byId(rid: string) { return db().prepare(`SELECT * FROM road_segments WHERE id = ?`).get(rid) as unknown as RoadRow | undefined; },
  upsert(r: { id: string; ax: number; ay: number; bx: number; by: number; status?: RoadRow['status']; delay?: number }) {
    db().prepare(`
      INSERT INTO road_segments (id, ax, ay, bx, by, status, delay_minutes) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, delay_minutes = excluded.delay_minutes, updated_at = datetime('now')
    `).run(r.id, r.ax, r.ay, r.bx, r.by, r.status ?? 'clear', r.delay ?? 0);
  },
  setStatus(rid: string, status: RoadRow['status'], delay: number) {
    db().prepare(`UPDATE road_segments SET status = ?, delay_minutes = ?, updated_at = datetime('now') WHERE id = ?`).run(status, delay, rid);
  },
};

export const traffic = {
  all() { return db().prepare(`SELECT * FROM traffic_conditions ORDER BY area`).all() as { id: string; area: string; status: string; delay_minutes: number; source: string; updated_at: string }[]; },
  upsert(t: { id: string; area: string; status: 'clear' | 'moderate' | 'heavy'; delay: number; source: string }) {
    db().prepare(`
      INSERT INTO traffic_conditions (id, area, status, delay_minutes, source) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, delay_minutes = excluded.delay_minutes, source = excluded.source, updated_at = datetime('now')
    `).run(t.id, t.area, t.status, t.delay, t.source);
  },
};
