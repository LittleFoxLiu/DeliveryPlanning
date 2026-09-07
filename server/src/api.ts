import { Router, type Request } from 'express';
import { config } from './config.js';
import { authenticate, requireRole, hashPassword, verifyPassword, issueToken, type AuthUser } from './auth.js';
import { rateLimit, h } from './http.js';
import { badRequest, forbidden, notFound, conflict, HttpError } from './util.js';
import { asObject, str, enumVal, int, coord, futureTs, idParam } from './validation.js';
import {
  users, merchants, stores, customers, drivers, orders, deliveries, roads, traffic,
} from './repo.js';
import { listEvents, bus } from './events.js';
import { coordinator } from './agents/coordinator.js';
import { driverProgress, simulateTick, injectTraffic } from './services.js';
import {
  orderView, deliveryView, activeRouteView, driverAdminView, assignmentReasoningView, orderTrackingView,
} from './dto.js';

export const api = Router();

/* ------------------------------------------------------------------ health */
api.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), llm: config.llm.enabled }));
api.get('/meta/grid', authenticate(true), h(async (_req, res) => {
  res.json({
    size: config.grid.size,
    roads: (await roads.all()).map((r) => ({ id: r.id, ax: r.ax, ay: r.ay, bx: r.bx, by: r.by, status: r.status, delay: r.delay_minutes })),
  });
}));

/* -------------------------------------------------------------------- auth */
const authLimiter = rateLimit(config.rateLimit.authMax);

api.post('/auth/signup', authLimiter, h(async (req, res) => {
  const b = asObject(req.body);
  const email = str(b, 'email', { max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Invalid email');
  const password = str(b, 'password', { min: 8, max: 200 });
  const name = str(b, 'name', { min: 1, max: 120 });
  const role = enumVal(b, 'role', ['merchant', 'customer', 'driver'] as const);
  if (await users.byEmail(email)) throw conflict('Email already registered');

  const { hash, salt } = hashPassword(password);
  let refId: string | null = null;

  if (role === 'merchant') {
    const merchant = await merchants.create(str(b, 'businessName', { min: 1, max: 120 }));
    const sx = coord(b, 'storeLat');
    const sy = coord(b, 'storeLng');
    await stores.create({ merchantId: merchant.id, name: str(b, 'storeName', { min: 1, max: 120 }), pickupLat: sx, pickupLng: sy });
    refId = merchant.id;
  } else if (role === 'customer') {
    refId = (await customers.create(name)).id;
  } else {
    const created = await drivers.create({
      name,
      vehicleType: enumVal(b, 'vehicleType', ['bike', 'car', 'van', 'truck'] as const, 'car'),
      capacity: int(b, 'capacity', { min: 1, max: 20, fallback: 4 }),
      maxPackageSize: enumVal(b, 'maxPackageSize', ['small', 'medium', 'large'] as const, 'large'),
      lat: coord(b, 'lat'),
      lng: coord(b, 'lng'),
      status: 'available',
    });
    refId = created.id;
  }

  const row = await users.create({ email, passwordHash: hash, passwordSalt: salt, role, name, refId });
  const user: AuthUser = { id: row.id, email: row.email, role: row.role, name: row.name, refId: row.ref_id };
  res.status(201).json({ token: issueToken(user), user: publicUser(user) });
}));

api.post('/auth/login', authLimiter, h(async (req, res) => {
  const b = asObject(req.body);
  const email = str(b, 'email', { max: 200 });
  const password = str(b, 'password', { max: 200 });
  const row = await users.byEmail(email);
  if (!row || !verifyPassword(password, row.password_hash, row.password_salt)) {
    throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
  }
  const user: AuthUser = { id: row.id, email: row.email, role: row.role, name: row.name, refId: row.ref_id };
  res.json({ token: issueToken(user), user: publicUser(user) });
}));

api.get('/auth/me', authenticate(true), (req, res) => res.json({ user: publicUser(req.user!) }));

function publicUser(u: AuthUser) {
  return { id: u.id, email: u.email, role: u.role, name: u.name, refId: u.refId };
}

/* --------------------------------------------------------------- directory */
api.get('/directory/merchants', authenticate(true), h(async (_req, res) => {
  const list = await merchants.list();
  res.json({
    merchants: await Promise.all(list.map(async (m) => ({
      id: m.id,
      name: m.name,
      stores: (await stores.byMerchant(m.id)).map((s) => ({ id: s.id, name: s.name, pickup: { x: s.pickup_lat, y: s.pickup_lng } })),
    }))),
  });
}));

/* ---------------------------------------------------------------- ownership */
async function ownedOrderForMerchant(req: Request, orderId: string) {
  const order = await orders.byId(orderId);
  if (!order) throw notFound('Order not found');
  if (order.merchant_id !== req.user!.refId) throw forbidden('Not your order');
  return order;
}
async function ownedOrderForCustomer(req: Request, orderId: string) {
  const order = await orders.byId(orderId);
  if (!order) throw notFound('Order not found');
  if (order.customer_id !== req.user!.refId) throw forbidden('Not your order');
  return order;
}
async function ownedDeliveryForDriver(req: Request, deliveryId: string) {
  const delivery = await deliveries.byId(deliveryId);
  if (!delivery) throw notFound('Delivery not found');
  if (delivery.driver_id !== req.user!.refId) throw forbidden('Not your delivery');
  return delivery;
}

async function orderWithDelivery(o: Parameters<typeof orderView>[0]) {
  const d = await deliveries.byOrderId(o.id);
  return { ...(await orderView(o)), delivery: d ? deliveryView(d) : null };
}

/* ---------------------------------------------------------------- merchant */
const merchantOnly = [authenticate(true), requireRole('merchant')];

api.get('/merchant/stores', ...merchantOnly, h(async (req, res) => {
  res.json({ stores: (await stores.byMerchant(req.user!.refId!)).map((s) => ({ id: s.id, name: s.name, pickup: { x: s.pickup_lat, y: s.pickup_lng } })) });
}));

api.get('/merchant/orders', ...merchantOnly, h(async (req, res) => {
  const list = await orders.byMerchant(req.user!.refId!);
  res.json({ orders: await Promise.all(list.map(orderWithDelivery)) });
}));

api.post('/merchant/orders', ...merchantOnly, h(async (req, res) => {
  const b = asObject(req.body);
  const storeId = idParam(b.storeId, 'storeId');
  const store = await stores.byId(storeId);
  if (!store || store.merchant_id !== req.user!.refId) throw forbidden('Not your store');
  const customer = await customers.create(str(b, 'customerName', { min: 1, max: 120 }));
  const order = await orders.create({
    merchant_id: req.user!.refId!,
    store_id: storeId,
    customer_id: customer.id,
    pickup_lat: store.pickup_lat,
    pickup_lng: store.pickup_lng,
    delivery_lat: coord(b, 'deliveryLat'),
    delivery_lng: coord(b, 'deliveryLng'),
    priority: enumVal(b, 'priority', ['standard', 'express'] as const, 'standard'),
    deadline_ts: futureTs(b, 'deadlineTs', { maxHours: 12 }),
    package_size: enumVal(b, 'packageSize', ['small', 'medium', 'large'] as const, 'small'),
    volume: int(b, 'volume', { min: 1, max: 20, fallback: 1 }),
    note: str(b, 'note', { optional: true, max: 280 }) || null,
    items: parseItems(b.items),
  });
  res.status(201).json({ order: await orderView(order) });
}));

api.post('/merchant/orders/:id/ready', ...merchantOnly, h(async (req, res) => {
  const order = await ownedOrderForMerchant(req, idParam(req.params.id, 'order id'));
  if (order.status !== 'created') {
    if (['ready', 'validated', 'dispatching', 'assigned'].includes(order.status)) {
      return res.json({ order: await orderView((await orders.byId(order.id))!), note: 'already in dispatch' });
    }
    throw conflict(`Order is ${order.status}, cannot mark ready`);
  }
  await orders.setStatus(order.id, 'ready', 'created');
  const idempotencyKey = req.header('idempotency-key') ?? null;
  const outcome = await coordinator.dispatchOrder(order.id, { idempotencyKey });
  const delivery = await deliveries.byOrderId(order.id);
  res.json({
    order: await orderView((await orders.byId(order.id))!),
    dispatch: outcome,
    delivery: delivery ? deliveryView(delivery) : null,
  });
}));

api.get('/merchant/orders/:id', ...merchantOnly, h(async (req, res) => {
  const order = await ownedOrderForMerchant(req, idParam(req.params.id, 'order id'));
  const delivery = await deliveries.byOrderId(order.id);
  const driver = delivery?.driver_id ? await drivers.byId(delivery.driver_id) : undefined;
  res.json({
    order: await orderView(order),
    delivery: delivery ? deliveryView(delivery) : null,
    assignedDriver: driver ? { name: driver.name, vehicleType: driver.vehicle_type, status: driver.status } : null,
    route: delivery ? await activeRouteView(delivery.id) : null,
    events: await listEvents({ orderId: order.id, limit: 60 }),
  });
}));

/* ---------------------------------------------------------------- customer */
const customerOnly = [authenticate(true), requireRole('customer')];

api.post('/customer/orders', ...customerOnly, h(async (req, res) => {
  const b = asObject(req.body);
  const storeId = idParam(b.storeId, 'storeId');
  const store = await stores.byId(storeId);
  if (!store) throw notFound('Store not found');
  const order = await orders.create({
    merchant_id: store.merchant_id,
    store_id: storeId,
    customer_id: req.user!.refId!,
    pickup_lat: store.pickup_lat,
    pickup_lng: store.pickup_lng,
    delivery_lat: coord(b, 'deliveryLat'),
    delivery_lng: coord(b, 'deliveryLng'),
    priority: enumVal(b, 'priority', ['standard', 'express'] as const, 'standard'),
    deadline_ts: futureTs(b, 'deadlineTs', { maxHours: 12 }),
    package_size: enumVal(b, 'packageSize', ['small', 'medium', 'large'] as const, 'small'),
    volume: int(b, 'volume', { min: 1, max: 20, fallback: 1 }),
    note: str(b, 'note', { optional: true, max: 280 }) || null,
    items: parseItems(b.items),
  });
  res.status(201).json({ order: await orderView(order) });
}));

api.get('/customer/orders', ...customerOnly, h(async (req, res) => {
  const list = await orders.byCustomer(req.user!.refId!);
  res.json({ orders: await Promise.all(list.map(orderView)) });
}));

api.get('/customer/orders/:id', ...customerOnly, h(async (req, res) => {
  const order = await ownedOrderForCustomer(req, idParam(req.params.id, 'order id'));
  res.json(await orderTrackingView(order));
}));

/* ------------------------------------------------------------------ driver */
const driverOnly = [authenticate(true), requireRole('driver')];

api.get('/driver/deliveries', ...driverOnly, h(async (req, res) => {
  const list = await deliveries.byDriver(req.user!.refId!);
  res.json({
    deliveries: await Promise.all(list.map(async (d) => {
      const o = (await orders.byId(d.order_id))!;
      return {
        ...deliveryView(d),
        order: { id: o.id, priority: o.priority, packageSize: o.package_size, deadlineTs: o.deadline_ts, items: await orders.items(o.id) },
        pickup: { x: o.pickup_lat, y: o.pickup_lng },
        dropoff: { x: o.delivery_lat, y: o.delivery_lng },
        route: await activeRouteView(d.id),
      };
    })),
  });
}));

api.get('/driver/deliveries/:id', ...driverOnly, h(async (req, res) => {
  const delivery = await ownedDeliveryForDriver(req, idParam(req.params.id, 'delivery id'));
  const o = (await orders.byId(delivery.order_id))!;
  const store = await stores.byId(o.store_id);
  res.json({
    ...deliveryView(delivery),
    order: { id: o.id, priority: o.priority, packageSize: o.package_size, volume: o.volume, deadlineTs: o.deadline_ts, note: o.note, items: await orders.items(o.id) },
    pickup: { x: o.pickup_lat, y: o.pickup_lng, name: store?.name ?? 'Merchant' },
    dropoff: { x: o.delivery_lat, y: o.delivery_lng },
    route: await activeRouteView(delivery.id),
  });
}));

api.post('/driver/deliveries/:id/accept', ...driverOnly, h(async (req, res) => {
  const delivery = await ownedDeliveryForDriver(req, idParam(req.params.id, 'delivery id'));
  res.json({ delivery: deliveryView(await driverProgress(delivery.id, req.user!.refId!, 'accept')) });
}));

api.post('/driver/deliveries/:id/status', ...driverOnly, h(async (req, res) => {
  const b = asObject(req.body);
  const action = enumVal(b, 'action', ['picked_up', 'delivered'] as const);
  const delivery = await ownedDeliveryForDriver(req, idParam(req.params.id, 'delivery id'));
  res.json({ delivery: deliveryView(await driverProgress(delivery.id, req.user!.refId!, action)) });
}));

api.post('/driver/status', ...driverOnly, h(async (req, res) => {
  const b = asObject(req.body);
  const status = enumVal(b, 'status', ['available', 'break', 'offline'] as const);
  const inHand = (await deliveries.byDriver(req.user!.refId!)).some((d) => ['picked_up', 'en_route_drop'].includes(d.status));
  if (inHand && status !== 'available') throw conflict('Cannot change status while carrying a package');
  await drivers.setStatus(req.user!.refId!, status);
  res.json({ status });
}));

api.post('/driver/location', ...driverOnly, h(async (req, res) => {
  const b = asObject(req.body);
  await drivers.recordLocation(req.user!.refId!, coord(b, 'lat'), coord(b, 'lng'));
  res.json({ ok: true });
}));

/* --------------------------------------------------------------- admin */
const adminOnly = [authenticate(true), requireRole('admin')];

api.get('/admin/overview', ...adminOnly, h(async (_req, res) => {
  const [activeOrders, allDrivers, activeDeliveries, trafficRows, roadRows, events] = await Promise.all([
    orders.active(), drivers.all(), deliveries.active(), traffic.all(), roads.all(), listEvents({ limit: 60 }),
  ]);
  const assignmentsFlat = (await Promise.all(activeOrders.map((o) => assignmentReasoningView(o.id)))).flat().filter((a) => a.status === 'active');
  res.json({
    orders: await Promise.all(activeOrders.map(orderWithDelivery)),
    drivers: allDrivers.map(driverAdminView),
    deliveries: await Promise.all(activeDeliveries.map(async (d) => ({ ...deliveryView(d), route: await activeRouteView(d.id) }))),
    assignments: assignmentsFlat,
    traffic: trafficRows,
    roadIncidents: roadRows.filter((r) => r.status !== 'clear').map((r) => ({ id: r.id, status: r.status, delay: r.delay_minutes })),
    events,
    llmEnabled: config.llm.enabled,
  });
}));

api.get('/admin/orders', ...adminOnly, h(async (_req, res) => {
  res.json({ orders: await Promise.all((await orders.all()).map(orderWithDelivery)) });
}));

api.get('/admin/orders/:id', ...adminOnly, h(async (req, res) => {
  const order = await orders.byId(idParam(req.params.id, 'order id'));
  if (!order) throw notFound('Order not found');
  const delivery = await deliveries.byOrderId(order.id);
  res.json({
    order: await orderView(order),
    delivery: delivery ? deliveryView(delivery) : null,
    route: delivery ? await activeRouteView(delivery.id) : null,
    assignments: await assignmentReasoningView(order.id),
    events: await listEvents({ orderId: order.id, limit: 200 }),
  });
}));

api.get('/admin/drivers', ...adminOnly, h(async (_req, res) => res.json({ drivers: (await drivers.all()).map(driverAdminView) })));

api.get('/admin/events', ...adminOnly, h(async (req, res) => {
  const sinceId = req.query.sinceId !== undefined ? int({ sinceId: Number(req.query.sinceId) }, 'sinceId', { min: 0 }) : undefined;
  res.json({ events: await listEvents({ sinceId, limit: 200 }) });
}));

api.get('/admin/events/stream', ...adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`event: hello\ndata: {}\n\n`);
  const onEvent = (e: unknown) => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* client gone */ } };
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(`: ping\n\n`), 20_000);
  _req.on('close', () => { clearInterval(ping); bus.off('event', onEvent); });
});

api.post('/admin/dispatch/:orderId', ...adminOnly, h(async (req, res) => {
  const order = await orders.byId(idParam(req.params.orderId, 'order id'));
  if (!order) throw notFound('Order not found');
  if (['delivered', 'cancelled'].includes(order.status)) throw conflict(`Order is ${order.status}`);
  if (order.status === 'created') await orders.setStatus(order.id, 'ready', 'created');
  const outcome = await coordinator.dispatchOrder(order.id, { idempotencyKey: req.header('idempotency-key') ?? null });
  res.json({ outcome });
}));

api.post('/admin/monitor/tick', ...adminOnly, h(async (_req, res) => {
  res.json(await coordinator.runMonitoringCycle());
}));

/* ------------------------------------------------------------------- sim */
const simOnly = [authenticate(true), requireRole('admin')];

api.post('/sim/tick', ...simOnly, h(async (_req, res) => res.json(await simulateTick())));

api.post('/sim/traffic', ...simOnly, h(async (req, res) => {
  const b = asObject(req.body);
  const result = await injectTraffic({
    segments: Array.isArray(b.segments) ? b.segments.map((s) => idParam(s, 'segment id').toUpperCase()) : undefined,
    status: b.status ? enumVal(b, 'status', ['clear', 'moderate', 'heavy', 'closed'] as const) : undefined,
    delayMinutes: b.delayMinutes !== undefined ? int(b, 'delayMinutes', { min: 0, max: 120 }) : undefined,
    blockRouteOf: b.blockRouteOf ? idParam(b.blockRouteOf, 'order id') : undefined,
  });
  res.json(result);
}));

api.post('/sim/driver/:id/offline', ...simOnly, h(async (req, res) => {
  const did = idParam(req.params.id, 'driver id');
  if (!(await drivers.byId(did))) throw notFound('Driver not found');
  await drivers.setStatus(did, 'offline');
  res.json({ ok: true, driverId: did, status: 'offline' });
}));

api.post('/sim/reset', ...simOnly, h(async (_req, res) => {
  const { seed } = await import('./seed.js');
  await seed({ reset: true });
  res.json({ ok: true });
}));

/* --------------------------------------------------------------- helpers */
function parseItems(raw: unknown): { name: string; qty: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((it) => {
    const o = asObject(it);
    return { name: str(o, 'name', { min: 1, max: 80 }), qty: int(o, 'qty', { min: 1, max: 99, fallback: 1 }) };
  });
}
