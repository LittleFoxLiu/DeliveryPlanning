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
api.get('/meta/grid', authenticate(true), (_req, res) => {
  res.json({
    size: config.grid.size,
    roads: roads.all().map((r) => ({ id: r.id, ax: r.ax, ay: r.ay, bx: r.bx, by: r.by, status: r.status, delay: r.delay_minutes })),
  });
});

/* -------------------------------------------------------------------- auth */
const authLimiter = rateLimit(config.rateLimit.authMax);

api.post('/auth/signup', authLimiter, h((req, res) => {
  const b = asObject(req.body);
  const email = str(b, 'email', { max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Invalid email');
  const password = str(b, 'password', { min: 8, max: 200 });
  const name = str(b, 'name', { min: 1, max: 120 });
  const role = enumVal(b, 'role', ['merchant', 'customer', 'driver'] as const);
  if (users.byEmail(email)) throw conflict('Email already registered');

  const { hash, salt } = hashPassword(password);
  let refId: string | null = null;

  if (role === 'merchant') {
    const merchant = merchants.create(str(b, 'businessName', { min: 1, max: 120 }));
    const sx = coord(b, 'storeLat');
    const sy = coord(b, 'storeLng');
    stores.create({ merchantId: merchant.id, name: str(b, 'storeName', { min: 1, max: 120 }), pickupLat: sx, pickupLng: sy });
    refId = merchant.id;
  } else if (role === 'customer') {
    refId = customers.create(name).id;
  } else {
    const created = drivers.create({
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

  const row = users.create({ email, passwordHash: hash, passwordSalt: salt, role, name, refId });
  const user: AuthUser = { id: row.id, email: row.email, role: row.role, name: row.name, refId: row.ref_id };
  res.status(201).json({ token: issueToken(user), user: publicUser(user) });
}));

api.post('/auth/login', authLimiter, h((req, res) => {
  const b = asObject(req.body);
  const email = str(b, 'email', { max: 200 });
  const password = str(b, 'password', { max: 200 });
  const row = users.byEmail(email);
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
api.get('/directory/merchants', authenticate(true), (_req, res) => {
  res.json({
    merchants: merchants.list().map((m) => ({
      id: m.id,
      name: m.name,
      stores: stores.byMerchant(m.id).map((s) => ({ id: s.id, name: s.name, pickup: { x: s.pickup_lat, y: s.pickup_lng } })),
    })),
  });
});

/* ---------------------------------------------------------------- ownership */
function ownedOrderForMerchant(req: Request, orderId: string) {
  const order = orders.byId(orderId);
  if (!order) throw notFound('Order not found');
  if (order.merchant_id !== req.user!.refId) throw forbidden('Not your order');
  return order;
}
function ownedOrderForCustomer(req: Request, orderId: string) {
  const order = orders.byId(orderId);
  if (!order) throw notFound('Order not found');
  if (order.customer_id !== req.user!.refId) throw forbidden('Not your order');
  return order;
}
function ownedDeliveryForDriver(req: Request, deliveryId: string) {
  const delivery = deliveries.byId(deliveryId);
  if (!delivery) throw notFound('Delivery not found');
  if (delivery.driver_id !== req.user!.refId) throw forbidden('Not your delivery');
  return delivery;
}

/* ---------------------------------------------------------------- merchant */
const merchantOnly = [authenticate(true), requireRole('merchant')];

api.get('/merchant/stores', ...merchantOnly, (req, res) => {
  res.json({ stores: stores.byMerchant(req.user!.refId!).map((s) => ({ id: s.id, name: s.name, pickup: { x: s.pickup_lat, y: s.pickup_lng } })) });
});

api.get('/merchant/orders', ...merchantOnly, (req, res) => {
  const list = orders.byMerchant(req.user!.refId!);
  res.json({
    orders: list.map((o) => {
      const d = deliveries.byOrderId(o.id);
      return { ...orderView(o), delivery: d ? deliveryView(d) : null };
    }),
  });
});

api.post('/merchant/orders', ...merchantOnly, h((req, res) => {
  const b = asObject(req.body);
  const storeId = idParam(b.storeId, 'storeId');
  const store = stores.byId(storeId);
  if (!store || store.merchant_id !== req.user!.refId) throw forbidden('Not your store');
  const customerName = str(b, 'customerName', { min: 1, max: 120 });
  const customer = customers.create(customerName);
  const order = orders.create({
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
  res.status(201).json({ order: orderView(order) });
}));

api.post('/merchant/orders/:id/ready', ...merchantOnly, h(async (req, res) => {
  const order = ownedOrderForMerchant(req, idParam(req.params.id, 'order id'));
  if (order.status !== 'created') {
    if (['ready', 'validated', 'dispatching', 'assigned'].includes(order.status)) {
      return res.json({ order: orderView(orders.byId(order.id)!), note: 'already in dispatch' });
    }
    throw conflict(`Order is ${order.status}, cannot mark ready`);
  }
  orders.setStatus(order.id, 'ready', 'created');
  const idempotencyKey = req.header('idempotency-key') ?? null;
  const outcome = coordinator.dispatchOrder(order.id, { idempotencyKey });
  res.json({
    order: orderView(orders.byId(order.id)!),
    dispatch: outcome,
    delivery: deliveries.byOrderId(order.id) ? deliveryView(deliveries.byOrderId(order.id)!) : null,
  });
}));

api.get('/merchant/orders/:id', ...merchantOnly, h((req, res) => {
  const order = ownedOrderForMerchant(req, idParam(req.params.id, 'order id'));
  const delivery = deliveries.byOrderId(order.id);
  const driver = delivery?.driver_id ? drivers.byId(delivery.driver_id) : undefined;
  res.json({
    order: orderView(order),
    delivery: delivery ? deliveryView(delivery) : null,
    assignedDriver: driver ? { name: driver.name, vehicleType: driver.vehicle_type, status: driver.status } : null,
    route: delivery ? activeRouteView(delivery.id) : null,
    events: listEvents({ orderId: order.id, limit: 60 }),
  });
}));

/* ---------------------------------------------------------------- customer */
const customerOnly = [authenticate(true), requireRole('customer')];

api.post('/customer/orders', ...customerOnly, h((req, res) => {
  const b = asObject(req.body);
  const storeId = idParam(b.storeId, 'storeId');
  const store = stores.byId(storeId);
  if (!store) throw notFound('Store not found');
  const order = orders.create({
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
  res.status(201).json({ order: orderView(order) });
}));

api.get('/customer/orders', ...customerOnly, (req, res) => {
  res.json({ orders: orders.byCustomer(req.user!.refId!).map(orderView) });
});

api.get('/customer/orders/:id', ...customerOnly, h((req, res) => {
  const order = ownedOrderForCustomer(req, idParam(req.params.id, 'order id'));
  res.json(orderTrackingView(order));
}));

/* ------------------------------------------------------------------ driver */
const driverOnly = [authenticate(true), requireRole('driver')];

api.get('/driver/deliveries', ...driverOnly, (req, res) => {
  const list = deliveries.byDriver(req.user!.refId!);
  res.json({
    deliveries: list.map((d) => {
      const o = orders.byId(d.order_id)!;
      return {
        ...deliveryView(d),
        order: { id: o.id, priority: o.priority, packageSize: o.package_size, deadlineTs: o.deadline_ts, items: orders.items(o.id) },
        pickup: { x: o.pickup_lat, y: o.pickup_lng },
        dropoff: { x: o.delivery_lat, y: o.delivery_lng },
        route: activeRouteView(d.id),
      };
    }),
  });
});

api.get('/driver/deliveries/:id', ...driverOnly, h((req, res) => {
  const delivery = ownedDeliveryForDriver(req, idParam(req.params.id, 'delivery id'));
  const o = orders.byId(delivery.order_id)!;
  const store = stores.byId(o.store_id);
  res.json({
    ...deliveryView(delivery),
    order: { id: o.id, priority: o.priority, packageSize: o.package_size, volume: o.volume, deadlineTs: o.deadline_ts, note: o.note, items: orders.items(o.id) },
    pickup: { x: o.pickup_lat, y: o.pickup_lng, name: store?.name ?? 'Merchant' },
    dropoff: { x: o.delivery_lat, y: o.delivery_lng },
    route: activeRouteView(delivery.id),
  });
}));

api.post('/driver/deliveries/:id/accept', ...driverOnly, h((req, res) => {
  const delivery = ownedDeliveryForDriver(req, idParam(req.params.id, 'delivery id'));
  const updated = driverProgress(delivery.id, req.user!.refId!, 'accept');
  res.json({ delivery: deliveryView(updated) });
}));

api.post('/driver/deliveries/:id/status', ...driverOnly, h((req, res) => {
  const b = asObject(req.body);
  const action = enumVal(b, 'action', ['picked_up', 'delivered'] as const);
  const delivery = ownedDeliveryForDriver(req, idParam(req.params.id, 'delivery id'));
  const updated = driverProgress(delivery.id, req.user!.refId!, action);
  res.json({ delivery: deliveryView(updated) });
}));

api.post('/driver/status', ...driverOnly, h((req, res) => {
  const b = asObject(req.body);
  const status = enumVal(b, 'status', ['available', 'break', 'offline'] as const);
  // guard: cannot go offline/break with an accepted, in-hand package
  const inHand = deliveries.byDriver(req.user!.refId!).some((d) => ['picked_up', 'en_route_drop'].includes(d.status));
  if (inHand && status !== 'available') throw conflict('Cannot change status while carrying a package');
  drivers.setStatus(req.user!.refId!, status);
  res.json({ status });
}));

api.post('/driver/location', ...driverOnly, h((req, res) => {
  const b = asObject(req.body);
  drivers.recordLocation(req.user!.refId!, coord(b, 'lat'), coord(b, 'lng'));
  res.json({ ok: true });
}));

/* --------------------------------------------------------------- admin */
const adminOnly = [authenticate(true), requireRole('admin')];

api.get('/admin/overview', ...adminOnly, (_req, res) => {
  const activeOrders = orders.active();
  const allDrivers = drivers.all();
  const activeDeliveries = deliveries.active();
  res.json({
    orders: activeOrders.map((o) => ({ ...orderView(o), delivery: deliveries.byOrderId(o.id) ? deliveryView(deliveries.byOrderId(o.id)!) : null })),
    drivers: allDrivers.map(driverAdminView),
    deliveries: activeDeliveries.map((d) => ({ ...deliveryView(d), route: activeRouteView(d.id) })),
    assignments: activeOrders.flatMap((o) => assignmentReasoningView(o.id).filter((a) => a.status === 'active')),
    traffic: traffic.all(),
    roadIncidents: roads.all().filter((r) => r.status !== 'clear').map((r) => ({ id: r.id, status: r.status, delay: r.delay_minutes })),
    events: listEvents({ limit: 60 }),
    llmEnabled: config.llm.enabled,
  });
});

api.get('/admin/orders', ...adminOnly, (_req, res) => {
  res.json({ orders: orders.all().map((o) => ({ ...orderView(o), delivery: deliveries.byOrderId(o.id) ? deliveryView(deliveries.byOrderId(o.id)!) : null })) });
});

api.get('/admin/orders/:id', ...adminOnly, h((req, res) => {
  const order = orders.byId(idParam(req.params.id, 'order id'));
  if (!order) throw notFound('Order not found');
  const delivery = deliveries.byOrderId(order.id);
  res.json({
    order: orderView(order),
    delivery: delivery ? deliveryView(delivery) : null,
    route: delivery ? activeRouteView(delivery.id) : null,
    assignments: assignmentReasoningView(order.id),
    events: listEvents({ orderId: order.id, limit: 200 }),
  });
}));

api.get('/admin/drivers', ...adminOnly, (_req, res) => res.json({ drivers: drivers.all().map(driverAdminView) }));
api.get('/admin/events', ...adminOnly, h((req, res) => {
  const sinceId = req.query.sinceId !== undefined ? int({ sinceId: Number(req.query.sinceId) }, 'sinceId', { min: 0 }) : undefined;
  res.json({ events: listEvents({ sinceId, limit: 200 }) });
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
  const order = orders.byId(idParam(req.params.orderId, 'order id'));
  if (!order) throw notFound('Order not found');
  if (['delivered', 'cancelled'].includes(order.status)) throw conflict(`Order is ${order.status}`);
  if (order.status === 'created') orders.setStatus(order.id, 'ready', 'created');
  const outcome = coordinator.dispatchOrder(order.id, { idempotencyKey: req.header('idempotency-key') ?? null });
  res.json({ outcome });
}));

api.post('/admin/monitor/tick', ...adminOnly, h(async (_req, res) => {
  res.json(await coordinator.runMonitoringCycle());
}));

/* ------------------------------------------------------------------- sim */
const simOnly = [authenticate(true), requireRole('admin')];

api.post('/sim/tick', ...simOnly, h(async (_req, res) => res.json(await simulateTick())));

api.post('/sim/traffic', ...simOnly, h((req, res) => {
  const b = asObject(req.body);
  const result = injectTraffic({
    segments: Array.isArray(b.segments) ? b.segments.map((s) => idParam(s, 'segment id').toUpperCase()) : undefined,
    status: b.status ? enumVal(b, 'status', ['clear', 'moderate', 'heavy', 'closed'] as const) : undefined,
    delayMinutes: b.delayMinutes !== undefined ? int(b, 'delayMinutes', { min: 0, max: 120 }) : undefined,
    blockRouteOf: b.blockRouteOf ? idParam(b.blockRouteOf, 'order id') : undefined,
  });
  res.json(result);
}));

api.post('/sim/driver/:id/offline', ...simOnly, h((req, res) => {
  const did = idParam(req.params.id, 'driver id');
  if (!drivers.byId(did)) throw notFound('Driver not found');
  drivers.setStatus(did, 'offline');
  res.json({ ok: true, driverId: did, status: 'offline' });
}));

api.post('/sim/reset', ...simOnly, h(async (_req, res) => {
  const { seed } = await import('./seed.js');
  seed({ reset: true });
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
