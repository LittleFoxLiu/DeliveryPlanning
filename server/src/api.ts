import { Router, type Request } from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { authenticate, requireRole, hashPassword, verifyPassword, issueToken, type AuthUser } from './auth.js';
import { rateLimit, h } from './http.js';
import { badRequest, forbidden, notFound, conflict, HttpError } from './util.js';
import { asObject, str, enumVal, int, coord, futureTs, idParam } from './validation.js';
import {
  users, merchants, stores, customers, drivers, orders, deliveries, roads, traffic, memberships,
} from './repo.js';
import { listEvents, bus } from './events.js';
import { coordinator } from './agents/coordinator.js';
import { driverProgress, simulateTick, injectTraffic } from './services.js';
import {
  orderView, deliveryView, activeRouteView, driverAdminView, assignmentReasoningView, orderTrackingView,
} from './dto.js';

export const api = Router();

/* ------------------------------------------------------------------ health */
api.get('/health', (_req, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  llm: config.llm.enabled ? { enabled: true, provider: config.llm.provider, model: config.llm.model } : { enabled: false },
}));
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
  const role = enumVal(b, 'role', ['merchant', 'customer', 'driver'] as const, 'customer');
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
  res.status(201).json({ token: issueToken(user), user: publicUser(user), needsOnboarding: true });
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

function oauthState(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 10 * 60_000, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  const sig = createHmac('sha256', config.authSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function validOauthState(state: string): boolean {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', config.authSecret).update(payload).digest('base64url');
  if (sig !== expected) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}

api.get('/auth/google', (_req, res) => {
  if (!config.google.clientId || !config.google.clientSecret) return res.status(503).json({ message: 'Google sign-in is not configured' });
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', config.google.clientId); u.searchParams.set('redirect_uri', config.google.redirectUri);
  u.searchParams.set('response_type', 'code'); u.searchParams.set('scope', 'openid email profile'); u.searchParams.set('state', oauthState());
  res.redirect(u.toString());
});
api.get('/auth/google/callback', async (req, res) => {
  const fail = (message: string) => res.redirect(`/#auth_error=${encodeURIComponent(message)}`);
  try {
    if (!config.google.clientId || !config.google.clientSecret) return fail('Google sign-in is not configured');
    if (typeof req.query.state !== 'string' || !validOauthState(req.query.state)) return fail('Invalid or expired Google sign-in request');
    if (typeof req.query.code !== 'string') return fail('Google sign-in was cancelled');
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: req.query.code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: config.google.redirectUri, grant_type: 'authorization_code' }) });
    if (!tokenRes.ok) return fail('Google sign-in could not be completed');
    const token = await tokenRes.json() as { access_token?: string };
    if (!token.access_token) return fail('Google did not return an access token');
    const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${token.access_token}` } });
    if (!profileRes.ok) return fail('Could not read Google account');
    const profile = await profileRes.json() as { email?: string; email_verified?: boolean; name?: string };
    if (!profile.email || profile.email_verified !== true) return fail('A verified Google email is required');
    let row = await users.byEmail(profile.email);
    let isNew = false;
    if (!row) {
      isNew = true;
      const p = hashPassword(randomBytes(32).toString('hex'));
      const customer = await customers.create(profile.name || profile.email.split('@')[0]);
      row = await users.create({ email: profile.email, passwordHash: p.hash, passwordSalt: p.salt, role: 'customer', name: profile.name || profile.email, refId: customer.id });
    }
    const user: AuthUser = { id: row.id, email: row.email, role: row.role, name: row.name, refId: row.ref_id };
    return res.redirect(`/#auth_token=${encodeURIComponent(issueToken(user))}&new=${isNew ? '1' : '0'}`);
  } catch { return fail('Google sign-in failed'); }
});
api.get('/auth/me', authenticate(true), (req, res) => res.json({ user: publicUser(req.user!) }));

/* ------------------------------------------------------------- onboarding */
api.post('/onboarding/role', authenticate(true), authLimiter, h(async (req, res) => {
  const b = asObject(req.body);
  const role = enumVal(b, 'role', ['admin', 'merchant', 'driver', 'customer'] as const);
  const current = await users.byId(req.user!.id);
  if (!current) throw notFound('Account not found');
  let refId = current.ref_id;
  if (role === 'merchant') {
    const merchant = await merchants.create(str(b, 'businessName', { min: 1, max: 120 }));
    await stores.create({ merchantId: merchant.id, name: str(b, 'storeName', { min: 1, max: 120 }), pickupLat: coord(b, 'storeLat'), pickupLng: coord(b, 'storeLng') });
    refId = merchant.id;
  } else if (role === 'driver') {
    const driver = await drivers.create({
      name: current.name, vehicleType: enumVal(b, 'vehicleType', ['bike', 'car', 'van', 'truck'] as const, 'car'),
      capacity: int(b, 'capacity', { min: 1, max: 20, fallback: 4 }), maxPackageSize: enumVal(b, 'maxPackageSize', ['small', 'medium', 'large'] as const, 'large'),
      lat: coord(b, 'lat'), lng: coord(b, 'lng'), status: 'available',
    });
    refId = driver.id;
  } else if (role === 'customer') {
    if (!refId) refId = (await customers.create(current.name)).id;
  } else refId = null;
  const updated = await users.setRole(req.user!.id, role, refId);
  const user: AuthUser = { id: updated!.id, email: updated!.email, role: updated!.role, name: updated!.name, refId: updated!.ref_id };
  res.json({ token: issueToken(user), user: publicUser(user) });
}));

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
  const dest = deliveryPoint(b, store);
  const customer = await customers.create(str(b, 'customerName', { min: 1, max: 120 }));
  const order = await orders.create({
    merchant_id: req.user!.refId!,
    store_id: storeId,
    customer_id: customer.id,
    pickup_lat: store.pickup_lat,
    pickup_lng: store.pickup_lng,
    delivery_lat: dest.lat,
    delivery_lng: dest.lng,
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

  // Already has a driver and is in flight — nothing to (re)dispatch.
  if (['assigned', 'picked_up', 'delivering'].includes(order.status)) {
    const delivery = await deliveries.byOrderId(order.id);
    return res.json({
      order: await orderView(order),
      dispatch: { status: 'reused', orderId: order.id },
      delivery: delivery ? deliveryView(delivery) : null,
      note: 'already assigned',
    });
  }
  if (['delivered', 'cancelled', 'failed'].includes(order.status)) {
    throw conflict(`Order is ${order.status}, cannot mark ready`);
  }

  // created → ready; a ready/validated/dispatching order simply re-enters dispatch
  // (covers a first attempt that found no driver or hit a transient error).
  if (order.status === 'created') await orders.setStatus(order.id, 'ready', 'created');

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
    assignedDriver: driver
      ? { name: driver.name, vehicleType: driver.vehicle_type, status: driver.status, location: driver.lat != null ? { x: driver.lat, y: driver.lng } : null }
      : null,
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
  const dest = deliveryPoint(b, store);
  const order = await orders.create({
    merchant_id: store.merchant_id,
    store_id: storeId,
    customer_id: req.user!.refId!,
    pickup_lat: store.pickup_lat,
    pickup_lng: store.pickup_lng,
    delivery_lat: dest.lat,
    delivery_lng: dest.lng,
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

async function driverSelf(refId: string) {
  const me = await drivers.byId(refId);
  return me && me.lat != null
    ? { location: { x: me.lat, y: me.lng }, status: me.status, name: me.name, vehicleType: me.vehicle_type }
    : { location: null, status: me?.status ?? 'offline', name: me?.name ?? '', vehicleType: me?.vehicle_type ?? '' };
}

api.get('/driver/deliveries', ...driverOnly, h(async (req, res) => {
  const list = await deliveries.byDriver(req.user!.refId!);
  res.json({
    me: await driverSelf(req.user!.refId!),
    deliveries: await Promise.all(list.map(async (d) => {
      const o = (await orders.byId(d.order_id))!;
      const [items, cust, store] = await Promise.all([orders.items(o.id), customers.byId(o.customer_id), stores.byId(o.store_id)]);
      return {
        ...deliveryView(d),
        order: {
          code: `#${o.id.replace(/^ord_/, '').slice(-6).toUpperCase()}`,
          priority: o.priority, packageSize: o.package_size, deadlineTs: o.deadline_ts, note: o.note, items,
          customerName: cust?.name ?? 'Customer',
        },
        pickup: { x: o.pickup_lat, y: o.pickup_lng, name: store?.name ?? 'Merchant' },
        dropoff: { x: o.delivery_lat, y: o.delivery_lng },
        route: await activeRouteView(d.id),
      };
    })),
  });
}));

api.get('/driver/deliveries/:id', ...driverOnly, h(async (req, res) => {
  const delivery = await ownedDeliveryForDriver(req, idParam(req.params.id, 'delivery id'));
  const o = (await orders.byId(delivery.order_id))!;
  const [store, cust, items] = await Promise.all([stores.byId(o.store_id), customers.byId(o.customer_id), orders.items(o.id)]);
  res.json({
    ...deliveryView(delivery),
    me: await driverSelf(req.user!.refId!),
    order: {
      code: `#${o.id.replace(/^ord_/, '').slice(-6).toUpperCase()}`,
      priority: o.priority, packageSize: o.package_size, volume: o.volume, deadlineTs: o.deadline_ts, note: o.note, items,
      customerName: cust?.name ?? 'Customer',
    },
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
  const driver = await drivers.byId(req.user!.refId!);
  if (!driver) throw notFound('Driver profile not found');
  if (driver.status === 'available') throw conflict('Set your status to break or offline before changing your position');
  const lat = coord(b, 'lat');
  const lng = coord(b, 'lng');
  if (!Number.isInteger(lat) || !Number.isInteger(lng)) throw badRequest('Position must be on a grid intersection');
  await drivers.recordLocation(req.user!.refId!, lat, lng);
  res.json({ ok: true });
}));

/* --------------------------------------------------------------- admin */
const adminOnly = [authenticate(true), requireRole('admin')];

/* ------------------------------------------------------------- memberships */
api.get('/admin/membership', ...adminOnly, h(async (req, res) => {
  res.json({ inviteCode: await memberships.inviteForAdmin(req.user!.id), requests: await memberships.adminRequests(req.user!.id) });
}));
api.post('/admin/membership/:id', ...adminOnly, h(async (req, res) => {
  await memberships.decideAdminRequest(req.user!.id, idParam(req.params.id, 'request id'), req.body?.accept === true);
  res.json({ ok: true });
}));
api.post('/merchant/admin-request', ...merchantOnly, h(async (req, res) => {
  await memberships.requestMerchantAdmin(req.user!.id, str(asObject(req.body), 'inviteCode', { min: 4, max: 80 }));
  res.json({ ok: true });
}));
api.get('/merchant/membership', ...merchantOnly, h(async (req, res) => {
  res.json({ requests: await memberships.merchantRequests(req.user!.refId!) });
}));
api.post('/merchant/membership/:id', ...merchantOnly, h(async (req, res) => {
  await memberships.decideDriverRequest(req.user!.refId!, idParam(req.params.id, 'request id'), req.body?.accept === true);
  res.json({ ok: true });
}));
api.post('/driver/store-request', ...driverOnly, h(async (req, res) => {
  await memberships.requestDriverStore(req.user!.id, idParam(String(asObject(req.body).storeId), 'store id'));
  res.json({ ok: true });
}));
api.get('/driver/membership', ...driverOnly, h(async (req, res) => {
  res.json({ stores: await memberships.storesForDriver(req.user!.refId!) });
}));

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

api.post('/admin/roads/randomize', ...adminOnly, h(async (_req, res) => {
  const statuses = ['clear', 'moderate', 'heavy', 'closed'] as const;
  const segments = await roads.all();
  for (const segment of segments) {
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    await roads.setStatus(segment.id, status, status === 'clear' ? 0 : status === 'moderate' ? 4 : status === 'heavy' ? 10 : 0);
  }
  res.json({ updated: segments.length });
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
    severity: b.severity ? enumVal(b, 'severity', ['minor', 'major'] as const) : undefined,
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
/** Validate a delivery destination against the store's pickup point so the
 *  order can't be dispatched as a zero-distance no-op. */
function deliveryPoint(b: Record<string, unknown>, store: { pickup_lat: number; pickup_lng: number }): { lat: number; lng: number } {
  const lat = coord(b, 'deliveryLat');
  const lng = coord(b, 'deliveryLng');
  if (Math.abs(lat - store.pickup_lat) < 1 && Math.abs(lng - store.pickup_lng) < 1) {
    throw badRequest(`The delivery address (${lat}, ${lng}) is at the pickup location — choose a destination away from the store.`);
  }
  return { lat, lng };
}

function parseItems(raw: unknown): { name: string; qty: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((it) => {
    const o = asObject(it);
    return { name: str(o, 'name', { min: 1, max: 80 }), qty: int(o, 'qty', { min: 1, max: 99, fallback: 1 }) };
  });
}
