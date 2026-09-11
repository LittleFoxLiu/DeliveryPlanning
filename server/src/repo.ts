import { q, q1, tx } from './db.js';
import { id, nowIso } from './util.js';
import { assertOrderTransition, assertDeliveryTransition, type OrderStatus, type DeliveryStatus } from './engine/stateMachine.js';
import type { GeoPoint } from './geo.js';

const inList = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/* ------------------------------------------------------------------ users */
export interface UserRow { id: string; email: string; role: 'admin' | 'merchant' | 'driver' | 'customer'; name: string; ref_id: string | null }

export const users = {
  async create(input: { email: string; passwordHash: string; passwordSalt: string; role: UserRow['role']; name: string; refId: string | null }): Promise<UserRow> {
    const uid = id('usr');
    await q(`INSERT INTO users (id, email, password_hash, password_salt, role, name, ref_id) VALUES (?,?,?,?,?,?,?)`,
      [uid, input.email.toLowerCase(), input.passwordHash, input.passwordSalt, input.role, input.name, input.refId]);
    return { id: uid, email: input.email.toLowerCase(), role: input.role, name: input.name, ref_id: input.refId };
  },
  byEmail(email: string) {
    return q1<UserRow & { password_hash: string; password_salt: string }>(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase()]);
  },
  byId(uid: string) {
    return q1<UserRow>(`SELECT id, email, role, name, ref_id FROM users WHERE id = ?`, [uid]);
  },
  async setRole(uid: string, role: UserRow['role'], refId: string | null) {
    return q1<UserRow>(`UPDATE users SET role = ?, ref_id = ? WHERE id = ? RETURNING id, email, role, name, ref_id`, [role, refId, uid]);
  },
};

export const memberships = {
  async inviteForAdmin(adminId: string) {
    const existing = await q1<{ invite_code: string }>('SELECT invite_code FROM admin_invites WHERE admin_id = ?', [adminId]);
    if (existing) return existing.invite_code;
    const code = `ADMIN-${id('code').replace(/^code_/, '').slice(0, 8).toUpperCase()}`;
    await q('INSERT INTO admin_invites (admin_id, invite_code) VALUES (?, ?)', [adminId, code]);
    return code;
  },
  async requestMerchantAdmin(userId: string, code: string) {
    const invite = await q1<{ admin_id: string }>('SELECT admin_id FROM admin_invites WHERE invite_code = ?', [code.toUpperCase()]);
    if (!invite) throw new Error('Invalid admin invite code');
    const existing = await q1<{ id: string }>(`SELECT id FROM join_requests WHERE requester_user_id = ? AND kind = 'merchant_admin' AND target_admin_id = ? AND status = 'pending'`, [userId, invite.admin_id]);
    if (existing) return existing.id;
    const rid = id('req');
    await q('INSERT INTO join_requests (id, requester_user_id, kind, target_admin_id) VALUES (?, ?, \'merchant_admin\', ?)', [rid, userId, invite.admin_id]);
    return rid;
  },
  adminRequests(adminId: string) {
    return q(`SELECT r.id, r.status, r.created_at, u.id AS requester_id, u.email, u.name FROM join_requests r JOIN users u ON u.id = r.requester_user_id WHERE r.kind = 'merchant_admin' AND r.target_admin_id = ? ORDER BY r.created_at DESC`, [adminId]);
  },
  async decideAdminRequest(adminId: string, requestId: string, accept: boolean) {
    const r = await q1<{ id: string; requester_user_id: string; target_admin_id: string | null }>(`SELECT id, requester_user_id, target_admin_id FROM join_requests WHERE id = ? AND kind = 'merchant_admin' AND status = 'pending'`, [requestId]);
    if (!r || r.target_admin_id !== adminId) throw new Error('Join request not found');
    await tx(async () => {
      await q(`UPDATE join_requests SET status = ?, decided_at = ? WHERE id = ?`, [accept ? 'accepted' : 'rejected', nowIso(), requestId]);
      if (accept) {
        const merchant = await q1<{ ref_id: string | null }>(`SELECT ref_id FROM users WHERE id = ? AND role = 'merchant'`, [r.requester_user_id]);
        if (merchant?.ref_id) await q(`INSERT INTO merchant_admins (merchant_id, admin_id) VALUES (?, ?) ON CONFLICT (merchant_id) DO UPDATE SET admin_id = excluded.admin_id`, [merchant.ref_id, adminId]);
      }
    });
  },
};

/* -------------------------------------------------------------- merchants */
export const merchants = {
  async create(name: string) {
    const mid = id('mch');
    await q(`INSERT INTO merchants (id, name) VALUES (?, ?)`, [mid, name]);
    return { id: mid, name };
  },
  byId(mid: string) { return q1<{ id: string; name: string }>(`SELECT * FROM merchants WHERE id = ?`, [mid]); },
  list() { return q<{ id: string; name: string }>(`SELECT * FROM merchants ORDER BY name`); },
};

export interface StoreRow { id: string; merchant_id: string; name: string; latitude: number; longitude: number; address: string }
export const stores = {
  async create(input: { merchantId: string; name: string; latitude: number; longitude: number; address: string }) {
    const sid = id('sto');
    await q(`INSERT INTO stores (id, merchant_id, name, latitude, longitude, address) VALUES (?,?,?,?,?,?)`,
      [sid, input.merchantId, input.name, input.latitude, input.longitude, input.address]);
    return { id: sid, ...input };
  },
  byId(sid: string) { return q1<StoreRow>(`SELECT * FROM stores WHERE id = ?`, [sid]); },
  byMerchant(mid: string) { return q<StoreRow>(`SELECT * FROM stores WHERE merchant_id = ? ORDER BY name`, [mid]); },
};

export const customers = {
  async create(name: string) { const cid = id('cus'); await q(`INSERT INTO customers (id, name) VALUES (?, ?)`, [cid, name]); return { id: cid, name }; },
  byId(cid: string) { return q1<{ id: string; name: string }>(`SELECT * FROM customers WHERE id = ?`, [cid]); },
};

/* --------------------------------------------------------------- products */
export interface ProductRow {
  id: string; merchant_id: string; name: string; description: string | null;
  price_cents: number; package_size: 'small' | 'medium' | 'large'; active: number;
}
export const products = {
  async create(input: { merchantId: string; name: string; description?: string | null; priceCents: number; packageSize: ProductRow['package_size'] }) {
    const pid = id('prd');
    await q(`INSERT INTO products (id, merchant_id, name, description, price_cents, package_size) VALUES (?,?,?,?,?,?)`,
      [pid, input.merchantId, input.name, input.description ?? null, input.priceCents, input.packageSize]);
    return (await products.byId(pid))!;
  },
  byId(pid: string) { return q1<ProductRow>(`SELECT * FROM products WHERE id = ?`, [pid]); },
  byMerchant(mid: string, opts: { activeOnly?: boolean } = {}) {
    return q<ProductRow>(
      `SELECT * FROM products WHERE merchant_id = ?${opts.activeOnly ? ' AND active = 1' : ''} ORDER BY created_at DESC`, [mid]);
  },
  async update(pid: string, patch: Partial<Pick<ProductRow, 'name' | 'description' | 'price_cents' | 'package_size' | 'active'>>) {
    const keys = Object.keys(patch);
    if (!keys.length) return products.byId(pid);
    const set = keys.map((k) => `${k} = ?`).join(', ');
    await q(`UPDATE products SET ${set} WHERE id = ?`, [...keys.map((k) => (patch as Record<string, unknown>)[k]), pid]);
    return products.byId(pid);
  },
};

/* ---------------------------------------------------------------- drivers */
export interface DriverRow { id: string; name: string; vehicle_type: 'bike' | 'car' | 'van' | 'truck'; capacity: number; max_package_size: 'small' | 'medium' | 'large' }
type DriverAvailability = 'available' | 'on_route' | 'break' | 'offline';
export interface DriverFull extends DriverRow {
  status: DriverAvailability; current_order_count: number; latitude: number | null; longitude: number | null; location_at: string | null; location_address: string | null;
}

const DRIVER_SELECT = `
  SELECT d.*, s.status, s.current_order_count,
         loc.latitude, loc.longitude, loc.recorded_at AS location_at,
         loc.address AS location_address
  FROM drivers d
  JOIN driver_status s ON s.driver_id = d.id
  LEFT JOIN LATERAL (
    SELECT latitude, longitude, recorded_at, address FROM driver_locations WHERE driver_id = d.id ORDER BY id DESC LIMIT 1
  ) loc ON true`;

export const drivers = {
  async create(input: { name: string; vehicleType: DriverRow['vehicle_type']; capacity: number; maxPackageSize: DriverRow['max_package_size']; latitude: number; longitude: number; status?: DriverAvailability; address?: string | null }) {
    const did = id('drv');
    await tx(async () => {
      await q(`INSERT INTO drivers (id, name, vehicle_type, capacity, max_package_size) VALUES (?,?,?,?,?)`,
        [did, input.name, input.vehicleType, input.capacity, input.maxPackageSize]);
      await q(`INSERT INTO driver_status (driver_id, status, current_order_count) VALUES (?, ?, 0)`, [did, input.status ?? 'available']);
      await q(`INSERT INTO driver_locations (driver_id, latitude, longitude, address) VALUES (?, ?, ?, ?)`, [did, input.latitude, input.longitude, input.address ?? null]);
    });
    return { id: did };
  },
  byId(did: string) { return q1<DriverFull>(`${DRIVER_SELECT} WHERE d.id = ?`, [did]); },
  all() { return q<DriverFull>(`${DRIVER_SELECT} ORDER BY d.name`); },
  async setStatus(did: string, status: DriverAvailability) {
    await q(`UPDATE driver_status SET status = ?, updated_at = ? WHERE driver_id = ?`, [status, nowIso(), did]);
  },
  async adjustOrderCount(did: string, delta: number) {
    await q(`UPDATE driver_status SET current_order_count = GREATEST(0, current_order_count + ?), updated_at = ? WHERE driver_id = ?`,
      [delta, nowIso(), did]);
  },
  async recordLocation(did: string, latitude: number, longitude: number, address?: string | null) {
    await q(`INSERT INTO driver_locations (driver_id, latitude, longitude, address) VALUES (?, ?, ?, ?)`, [did, latitude, longitude, address ?? null]);
  },
};

/* ----------------------------------------------------------------- orders */
export interface OrderRow {
  id: string; merchant_id: string; store_id: string; customer_id: string;
  pickup_latitude: number; pickup_longitude: number; delivery_latitude: number; delivery_longitude: number;
  delivery_address: string;
  status: OrderStatus; priority: 'standard' | 'express'; deadline_ts: string;
  package_size: 'small' | 'medium' | 'large'; volume: number; note: string | null;
  created_at: string; ready_at: string | null;
}

export interface OrderItemInput { name: string; qty: number; productId?: string | null; unitPriceCents?: number }

export const orders = {
  async create(input: Omit<OrderRow, 'id' | 'status' | 'created_at' | 'ready_at'> & { items?: OrderItemInput[] }): Promise<OrderRow> {
    const oid = id('ord');
    await tx(async () => {
      await q(`
        INSERT INTO orders (id, merchant_id, store_id, customer_id, pickup_latitude, pickup_longitude, delivery_latitude, delivery_longitude, delivery_address, status, priority, deadline_ts, package_size, volume, note)
        VALUES (?,?,?,?,?,?,?,?,?, 'created', ?,?,?,?,?)`,
        [oid, input.merchant_id, input.store_id, input.customer_id, input.pickup_latitude, input.pickup_longitude,
          input.delivery_latitude, input.delivery_longitude, input.delivery_address,
          input.priority, input.deadline_ts, input.package_size, input.volume, input.note ?? null]);
      for (const item of input.items ?? []) {
        await q(`INSERT INTO order_items (order_id, product_id, name, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?)`,
          [oid, item.productId ?? null, item.name, item.qty, item.unitPriceCents ?? 0]);
      }
    });
    return (await orders.byId(oid))!;
  },
  byId(oid: string) { return q1<OrderRow>(`SELECT * FROM orders WHERE id = ?`, [oid]); },
  async items(oid: string) {
    const rows = await q<{ name: string; qty: number; product_id: string | null; unit_price_cents: number }>(
      `SELECT name, qty, product_id, unit_price_cents FROM order_items WHERE order_id = ? ORDER BY id`, [oid]);
    return rows.map((r) => ({ name: r.name, qty: r.qty, productId: r.product_id, unitPriceCents: r.unit_price_cents }));
  },
  byMerchant(mid: string) { return q<OrderRow>(`SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at DESC`, [mid]); },
  byCustomer(cid: string) { return q<OrderRow>(`SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC`, [cid]); },
  all() { return q<OrderRow>(`SELECT * FROM orders ORDER BY created_at DESC`); },
  active() { return q<OrderRow>(`SELECT * FROM orders WHERE status NOT IN ('delivered','cancelled','failed') ORDER BY created_at DESC`); },

  /** Guarded transition. With `expectedFrom` it is an atomic compare-and-set:
   *  the UPDATE only fires while the row still holds one of those statuses. */
  async setStatus(oid: string, to: OrderStatus, expectedFrom?: OrderStatus | OrderStatus[]): Promise<OrderRow> {
    const current = await orders.byId(oid);
    if (!current) throw new Error('order not found');
    const allowed = expectedFrom ? (Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom]) : null;
    if (allowed && !allowed.includes(current.status)) {
      throw new Error(`order ${oid} expected ${allowed.join('/')} but was ${current.status}`);
    }
    assertOrderTransition(current.status, to);
    const guard = allowed ?? [current.status];
    const readyAt = to === 'ready' && !current.ready_at ? nowIso() : current.ready_at;
    const rows = await q<OrderRow>(
      `UPDATE orders SET status = ?, ready_at = ? WHERE id = ? AND status IN (${inList(guard.length)}) RETURNING *`,
      [to, readyAt, oid, ...guard]);
    if (!rows.length) throw new Error(`order ${oid} changed concurrently (no longer ${guard.join('/')})`);
    return rows[0];
  },
};

/* ------------------------------------------------------------- deliveries */
export interface DeliveryRow {
  id: string; order_id: string; driver_id: string | null; status: DeliveryStatus;
  assigned_at: string | null; pickup_at: string | null; delivered_at: string | null;
  estimated_delivery_minutes: number | null; actual_delivery_minutes: number | null;
  eta_ts: string | null; route_id: string | null; created_at: string;
}
type DeliveryPatch = Partial<Pick<DeliveryRow, 'driver_id' | 'assigned_at' | 'pickup_at' | 'delivered_at' | 'estimated_delivery_minutes' | 'actual_delivery_minutes' | 'eta_ts' | 'route_id'>>;

export const deliveries = {
  byOrderId(oid: string) { return q1<DeliveryRow>(`SELECT * FROM deliveries WHERE order_id = ?`, [oid]); },
  byId(dsid: string) { return q1<DeliveryRow>(`SELECT * FROM deliveries WHERE id = ?`, [dsid]); },
  byDriver(did: string) { return q<DeliveryRow>(`SELECT * FROM deliveries WHERE driver_id = ? ORDER BY created_at DESC`, [did]); },
  active() { return q<DeliveryRow>(`SELECT * FROM deliveries WHERE status NOT IN ('delivered','cancelled','failed')`); },
  all() { return q<DeliveryRow>(`SELECT * FROM deliveries ORDER BY created_at DESC`); },
  async ensure(oid: string): Promise<DeliveryRow> {
    const existing = await deliveries.byOrderId(oid);
    if (existing) return existing;
    const dsid = id('dlv');
    const rows = await q<DeliveryRow>(
      `INSERT INTO deliveries (id, order_id, status) VALUES (?, ?, 'pending')
       ON CONFLICT (order_id) DO NOTHING RETURNING *`, [dsid, oid]);
    return rows[0] ?? (await deliveries.byOrderId(oid))!;
  },
  async update(dsid: string, patch: DeliveryPatch) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = ?`).join(', ');
    await q(`UPDATE deliveries SET ${set} WHERE id = ?`, [...keys.map((k) => (patch as Record<string, unknown>)[k]), dsid]);
  },
  async setStatus(dsid: string, to: DeliveryStatus, expectedFrom?: DeliveryStatus | DeliveryStatus[]): Promise<DeliveryRow> {
    const current = await deliveries.byId(dsid);
    if (!current) throw new Error('delivery not found');
    const allowed = expectedFrom ? (Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom]) : null;
    if (allowed && !allowed.includes(current.status)) {
      throw new Error(`delivery ${dsid} expected ${allowed.join('/')} but was ${current.status}`);
    }
    assertDeliveryTransition(current.status, to);
    const guard = allowed ?? [current.status];
    const rows = await q<DeliveryRow>(
      `UPDATE deliveries SET status = ? WHERE id = ? AND status IN (${inList(guard.length)}) RETURNING *`,
      [to, dsid, ...guard]);
    if (!rows.length) throw new Error(`delivery ${dsid} changed concurrently`);
    return rows[0];
  },
};

/* ------------------------------------------------------------------ routes */
export interface RouteRow {
  id: string; delivery_id: string; driver_id: string; origin_latitude: number; origin_longitude: number;
  legs_json: unknown; path_json: { toPickup?: GeoPoint[]; toDropoff?: GeoPoint[] };
  distance_km: number; eta_minutes: number; active: number; created_at: string;
}

export const routes = {
  activeForDelivery(dsid: string) {
    return q1<RouteRow>(`SELECT * FROM routes WHERE delivery_id = ? AND active = 1 ORDER BY created_at DESC, id DESC LIMIT 1`, [dsid]);
  },
  async create(input: { deliveryId: string; driverId: string; originLat: number; originLng: number; legs: unknown; path: unknown; distanceKm: number; etaMinutes: number }): Promise<RouteRow> {
    return tx(async () => {
      await q(`UPDATE routes SET active = 0 WHERE delivery_id = ?`, [input.deliveryId]);
      const rid = id('rte');
      const rows = await q<RouteRow>(`
        INSERT INTO routes (id, delivery_id, driver_id, origin_latitude, origin_longitude, legs_json, path_json, distance_km, eta_minutes, active)
        VALUES (?,?,?,?,?, ?::jsonb, ?::jsonb, ?,?, 1) RETURNING *`,
        [rid, input.deliveryId, input.driverId, input.originLat, input.originLng,
          JSON.stringify(input.legs), JSON.stringify(input.path), input.distanceKm, input.etaMinutes]);
      return rows[0];
    });
  },
};

/* ------------------------------------------------------------- assignments */
export interface AssignmentRow {
  id: string; order_id: string; driver_id: string; status: 'proposed' | 'active' | 'cancelled' | 'superseded' | 'rejected';
  score: number; reasoning_json: unknown; idempotency_key: string | null; created_at: string;
}

export const assignments = {
  activeForOrder(oid: string) {
    return q1<AssignmentRow>(`SELECT * FROM assignments WHERE order_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [oid]);
  },
  forOrder(oid: string) { return q<AssignmentRow>(`SELECT * FROM assignments WHERE order_id = ? ORDER BY created_at DESC`, [oid]); },
  byIdempotencyKey(key: string) { return q1<AssignmentRow>(`SELECT * FROM assignments WHERE idempotency_key = ?`, [key]); },
  async create(input: { orderId: string; driverId: string; score: number; reasoning: unknown; idempotencyKey?: string | null; status?: AssignmentRow['status'] }): Promise<AssignmentRow> {
    return tx(async () => {
      await q(`UPDATE assignments SET status = 'superseded' WHERE order_id = ? AND status IN ('proposed','active')`, [input.orderId]);
      const aid = id('asg');
      const rows = await q<AssignmentRow>(`
        INSERT INTO assignments (id, order_id, driver_id, status, score, reasoning_json, idempotency_key)
        VALUES (?,?,?,?,?, ?::jsonb, ?) RETURNING *`,
        [aid, input.orderId, input.driverId, input.status ?? 'active', input.score, JSON.stringify(input.reasoning), input.idempotencyKey ?? null]);
      return rows[0];
    });
  },
  async cancel(oid: string) {
    await q(`UPDATE assignments SET status = 'cancelled' WHERE order_id = ? AND status IN ('proposed','active')`, [oid]);
  },
};

