import { first, insert, insertMany, select, update, upsert, upsertMany } from './db.js';
import { id, nowIso } from './util.js';
import { assertOrderTransition, assertDeliveryTransition, type OrderStatus, type DeliveryStatus } from './engine/stateMachine.js';
import type { Segment } from './engine/routing.js';

export interface UserRow { id: string; email: string; role: 'admin' | 'merchant' | 'driver' | 'customer'; name: string; ref_id: string | null }
type UserDbRow = UserRow & { password_hash: string; password_salt: string };

export const users = {
  async create(input: { email: string; passwordHash: string; passwordSalt: string; role: UserRow['role']; name: string; refId: string | null }): Promise<UserRow> {
    const email = input.email.trim().toLowerCase();
    return insert<UserRow>('users', { id: id('usr'), email, password_hash: input.passwordHash, password_salt: input.passwordSalt, role: input.role, name: input.name, ref_id: input.refId });
  },
  async byEmail(email: string): Promise<UserDbRow | undefined> { return first<UserDbRow>('users', { email: `eq.${email.trim().toLowerCase()}` }); },
  async byId(uid: string): Promise<UserRow | undefined> { return first<UserRow>('users', { id: `eq.${uid}` }); },
};

export const merchants = {
  async create(name: string): Promise<{ id: string; name: string }> { return insert('merchants', { id: id('mch'), name }); },
  async byId(mid: string) { return first<{ id: string; name: string }>('merchants', { id: `eq.${mid}` }); },
  async list() { return select<{ id: string; name: string }>('merchants', {}, { order: 'name.asc' }); },
};

export interface StoreRow { id: string; merchant_id: string; name: string; pickup_lat: number; pickup_lng: number }
export const stores = {
  async create(input: { merchantId: string; name: string; pickupLat: number; pickupLng: number }) {
    return insert<StoreRow>('stores', { id: id('sto'), merchant_id: input.merchantId, name: input.name, pickup_lat: input.pickupLat, pickup_lng: input.pickupLng });
  },
  async byId(sid: string) { return first<StoreRow>('stores', { id: `eq.${sid}` }); },
  async byMerchant(mid: string) { return select<StoreRow>('stores', { merchant_id: `eq.${mid}` }, { order: 'name.asc' }); },
};

export const customers = {
  async create(name: string) { return insert<{ id: string; name: string }>('customers', { id: id('cus'), name }); },
  async byId(cid: string) { return first<{ id: string; name: string }>('customers', { id: `eq.${cid}` }); },
};

export interface DriverRow { id: string; name: string; vehicle_type: 'bike' | 'car' | 'van' | 'truck'; capacity: number; max_package_size: 'small' | 'medium' | 'large' }
export interface DriverFull extends DriverRow { status: DeliveryStatusForDriver; current_order_count: number; lat: number | null; lng: number | null; location_at: string | null }
type DeliveryStatusForDriver = 'available' | 'on_route' | 'break' | 'offline';

async function driverView(d: DriverRow): Promise<DriverFull> {
  const status = await first<{ status: DeliveryStatusForDriver; current_order_count: number }>('driver_status', { driver_id: `eq.${d.id}` });
  const location = await first<{ lat: number; lng: number; recorded_at: string }>('driver_locations', { driver_id: `eq.${d.id}` }, { order: 'id.desc' });
  return { ...d, status: status?.status ?? 'offline', current_order_count: status?.current_order_count ?? 0, lat: location?.lat ?? null, lng: location?.lng ?? null, location_at: location?.recorded_at ?? null };
}

export const drivers = {
  async create(input: { name: string; vehicleType: DriverRow['vehicle_type']; capacity: number; maxPackageSize: DriverRow['max_package_size']; lat: number; lng: number; status?: DeliveryStatusForDriver }) {
    const did = id('drv');
    await insert('drivers', { id: did, name: input.name, vehicle_type: input.vehicleType, capacity: input.capacity, max_package_size: input.maxPackageSize });
    await insert('driver_status', { driver_id: did, status: input.status ?? 'available', current_order_count: 0 });
    await insert('driver_locations', { driver_id: did, lat: input.lat, lng: input.lng });
    return { id: did };
  },
  async byId(did: string): Promise<DriverFull | undefined> { const d = await first<DriverRow>('drivers', { id: `eq.${did}` }); return d ? driverView(d) : undefined; },
  async all(): Promise<DriverFull[]> { const rows = await select<DriverRow>('drivers', {}, { order: 'name.asc' }); return Promise.all(rows.map(driverView)); },
  async setStatus(did: string, status: DeliveryStatusForDriver) { await update('driver_status', { driver_id: `eq.${did}` }, { status, updated_at: nowIso() }); },
  async adjustOrderCount(did: string, delta: number) {
    const current = await first<{ current_order_count: number }>('driver_status', { driver_id: `eq.${did}` });
    await update('driver_status', { driver_id: `eq.${did}` }, { current_order_count: Math.max(0, (current?.current_order_count ?? 0) + delta), updated_at: nowIso() });
  },
  async recordLocation(did: string, lat: number, lng: number) { await insert('driver_locations', { driver_id: did, lat, lng }); },
};

export interface OrderRow {
  id: string; merchant_id: string; store_id: string; customer_id: string;
  pickup_lat: number; pickup_lng: number; delivery_lat: number; delivery_lng: number;
  status: OrderStatus; priority: 'standard' | 'express'; deadline_ts: string;
  package_size: 'small' | 'medium' | 'large'; volume: number; note: string | null;
  created_at: string; ready_at: string | null;
}

export const orders = {
  async create(input: Omit<OrderRow, 'id' | 'status' | 'created_at' | 'ready_at'> & { items?: { name: string; qty: number }[] }): Promise<OrderRow> {
    const oid = id('ord');
    await insert('orders', { id: oid, merchant_id: input.merchant_id, store_id: input.store_id, customer_id: input.customer_id, pickup_lat: input.pickup_lat, pickup_lng: input.pickup_lng, delivery_lat: input.delivery_lat, delivery_lng: input.delivery_lng, status: 'created', priority: input.priority, deadline_ts: input.deadline_ts, package_size: input.package_size, volume: input.volume, note: input.note ?? null });
    if (input.items?.length) await insertMany('order_items', input.items.map((item) => ({ order_id: oid, name: item.name, qty: item.qty })));
    return (await orders.byId(oid))!;
  },
  async byId(oid: string) { return first<OrderRow>('orders', { id: `eq.${oid}` }); },
  async items(oid: string) { return select<{ name: string; qty: number }>('order_items', { order_id: `eq.${oid}` }, { select: 'name,qty', order: 'id.asc' }); },
  async byMerchant(mid: string) { return select<OrderRow>('orders', { merchant_id: `eq.${mid}` }, { order: 'created_at.desc' }); },
  async byCustomer(cid: string) { return select<OrderRow>('orders', { customer_id: `eq.${cid}` }, { order: 'created_at.desc' }); },
  async all() { return select<OrderRow>('orders', {}, { order: 'created_at.desc' }); },
  async active() { return select<OrderRow>('orders', { status: 'not.in.(delivered,cancelled,failed)' }, { order: 'created_at.desc' }); },
  async setStatus(oid: string, to: OrderStatus, expectedFrom?: OrderStatus | OrderStatus[]): Promise<OrderRow> {
    const current = await orders.byId(oid); if (!current) throw new Error('order not found');
    if (expectedFrom) { const allowed = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom]; if (!allowed.includes(current.status)) throw new Error(`order ${oid} expected ${allowed.join('/')} but was ${current.status}`); }
    assertOrderTransition(current.status, to);
    await update('orders', { id: `eq.${oid}` }, { status: to, ready_at: to === 'ready' && !current.ready_at ? nowIso() : current.ready_at });
    return (await orders.byId(oid))!;
  },
};

export interface DeliveryRow {
  id: string; order_id: string; driver_id: string | null; status: DeliveryStatus;
  assigned_at: string | null; pickup_at: string | null; delivered_at: string | null;
  estimated_delivery_minutes: number | null; actual_delivery_minutes: number | null;
  eta_ts: string | null; route_id: string | null; created_at: string;
}

export const deliveries = {
  async byOrderId(oid: string) { return first<DeliveryRow>('deliveries', { order_id: `eq.${oid}` }); },
  async byId(dsid: string) { return first<DeliveryRow>('deliveries', { id: `eq.${dsid}` }); },
  async byDriver(did: string) { return select<DeliveryRow>('deliveries', { driver_id: `eq.${did}` }, { order: 'created_at.desc' }); },
  async active() { return select<DeliveryRow>('deliveries', { status: 'not.in.(delivered,cancelled,failed)' }); },
  async all() { return select<DeliveryRow>('deliveries', {}, { order: 'created_at.desc' }); },
  async ensure(oid: string): Promise<DeliveryRow> { const existing = await deliveries.byOrderId(oid); if (existing) return existing; const row = await insert<DeliveryRow>('deliveries', { id: id('dlv'), order_id: oid, status: 'pending' }); return row; },
  async update(dsid: string, patch: Partial<Pick<DeliveryRow, 'driver_id' | 'assigned_at' | 'pickup_at' | 'delivered_at' | 'estimated_delivery_minutes' | 'actual_delivery_minutes' | 'eta_ts' | 'route_id'>>) { if (Object.keys(patch).length) await update('deliveries', { id: `eq.${dsid}` }, patch as Record<string, unknown>); },
  async setStatus(dsid: string, to: DeliveryStatus, expectedFrom?: DeliveryStatus | DeliveryStatus[]): Promise<DeliveryRow> {
    const current = await deliveries.byId(dsid); if (!current) throw new Error('delivery not found');
    if (expectedFrom) { const allowed = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom]; if (!allowed.includes(current.status)) throw new Error(`delivery ${dsid} expected ${allowed.join('/')} but was ${current.status}`); }
    assertDeliveryTransition(current.status, to); await update('deliveries', { id: `eq.${dsid}` }, { status: to }); return (await deliveries.byId(dsid))!;
  },
};

export interface RouteRow {
  id: string; delivery_id: string; driver_id: string; origin_lat: number; origin_lng: number;
  legs_json: string; path_json: string; distance_km: number; eta_minutes: number;
  traffic_penalty_minutes: number; active: number; created_at: string;
}

function routeRow(row: RouteRow): RouteRow {
  return { ...row, legs_json: typeof row.legs_json === 'string' ? row.legs_json : JSON.stringify(row.legs_json), path_json: typeof row.path_json === 'string' ? row.path_json : JSON.stringify(row.path_json) };
}

export const routes = {
  async activeForDelivery(dsid: string) { const row = await first<RouteRow>('routes', { delivery_id: `eq.${dsid}`, active: 'eq.1' }, { order: 'created_at.desc' }); return row ? routeRow(row) : undefined; },
  async create(input: { deliveryId: string; driverId: string; originLat: number; originLng: number; legs: unknown; path: unknown; distanceKm: number; etaMinutes: number; trafficPenalty: number }): Promise<RouteRow> {
    await update('routes', { delivery_id: `eq.${input.deliveryId}`, active: 'eq.1' }, { active: 0 });
    const row = await insert<RouteRow>('routes', { id: id('rte'), delivery_id: input.deliveryId, driver_id: input.driverId, origin_lat: input.originLat, origin_lng: input.originLng, legs_json: input.legs, path_json: input.path, distance_km: input.distanceKm, eta_minutes: input.etaMinutes, traffic_penalty_minutes: input.trafficPenalty, active: 1 });
    return routeRow(row);
  },
};

export interface AssignmentRow { id: string; order_id: string; driver_id: string; status: 'proposed' | 'active' | 'cancelled' | 'superseded' | 'rejected'; score: number; reasoning_json: string; idempotency_key: string | null; created_at: string }
function assignmentRow(row: AssignmentRow): AssignmentRow { return { ...row, reasoning_json: typeof row.reasoning_json === 'string' ? row.reasoning_json : JSON.stringify(row.reasoning_json) }; }
export const assignments = {
  async activeForOrder(oid: string) { const row = await first<AssignmentRow>('assignments', { order_id: `eq.${oid}`, status: 'eq.active' }, { order: 'created_at.desc' }); return row ? assignmentRow(row) : undefined; },
  async forOrder(oid: string) { return (await select<AssignmentRow>('assignments', { order_id: `eq.${oid}` }, { order: 'created_at.desc' })).map(assignmentRow); },
  async byIdempotencyKey(key: string) { const row = await first<AssignmentRow>('assignments', { idempotency_key: `eq.${key}` }); return row ? assignmentRow(row) : undefined; },
  async create(input: { orderId: string; driverId: string; score: number; reasoning: unknown; idempotencyKey?: string | null; status?: AssignmentRow['status'] }): Promise<AssignmentRow> {
    await update('assignments', { order_id: `eq.${input.orderId}`, status: 'in.(proposed,active)' }, { status: 'superseded' });
    const row = await insert<AssignmentRow>('assignments', { id: id('asg'), order_id: input.orderId, driver_id: input.driverId, status: input.status ?? 'active', score: input.score, reasoning_json: input.reasoning, idempotency_key: input.idempotencyKey ?? null });
    return assignmentRow(row);
  },
  async cancel(oid: string) { await update('assignments', { order_id: `eq.${oid}`, status: 'in.(proposed,active)' }, { status: 'cancelled' }); },
};

export interface RoadRow { id: string; ax: number; ay: number; bx: number; by: number; status: 'clear' | 'moderate' | 'heavy' | 'closed'; delay_minutes: number; updated_at: string }
export const roads = {
  async all() { return select<RoadRow>('road_segments', {}, { order: 'id.asc' }); },
  async segments(): Promise<Segment[]> { return (await roads.all()).map((r) => ({ id: r.id, ax: r.ax, ay: r.ay, bx: r.bx, by: r.by, status: r.status, delay_minutes: r.delay_minutes })); },
  async byId(rid: string) { return first<RoadRow>('road_segments', { id: `eq.${rid}` }); },
  async upsert(r: { id: string; ax: number; ay: number; bx: number; by: number; status?: RoadRow['status']; delay?: number }) { await upsert('road_segments', { id: r.id, ax: r.ax, ay: r.ay, bx: r.bx, by: r.by, status: r.status ?? 'clear', delay_minutes: r.delay ?? 0, updated_at: nowIso() }, 'id'); },
  async upsertMany(rows: { id: string; ax: number; ay: number; bx: number; by: number; status?: RoadRow['status']; delay?: number }[]) { await upsertMany('road_segments', rows.map((r) => ({ id: r.id, ax: r.ax, ay: r.ay, bx: r.bx, by: r.by, status: r.status ?? 'clear', delay_minutes: r.delay ?? 0, updated_at: nowIso() })), 'id'); },
  async setStatus(rid: string, status: RoadRow['status'], delay: number) { await update('road_segments', { id: `eq.${rid}` }, { status, delay_minutes: delay, updated_at: nowIso() }); },
};

export const traffic = {
  async all() { return select<{ id: string; area: string; status: string; delay_minutes: number; source: string; updated_at: string }>('traffic_conditions', {}, { order: 'area.asc' }); },
  async upsert(t: { id: string; area: string; status: 'clear' | 'moderate' | 'heavy'; delay: number; source: string }) { await upsert('traffic_conditions', { id: t.id, area: t.area, status: t.status, delay_minutes: t.delay, source: t.source }, 'id'); },
};
