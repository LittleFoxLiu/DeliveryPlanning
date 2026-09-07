import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, client, login, reseed, type TestCtx } from './helpers.js';
import { beforeEach } from 'vitest';

let ctx: TestCtx;
let c: ReturnType<typeof client>;

beforeAll(async () => { ctx = await startTestServer(); c = client(ctx.base); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await reseed(); });

async function firstCreatedOrder(token: string): Promise<string> {
  const res = await c.get('/merchant/orders', token);
  const orders = (res.body.orders as { id: string; status: string; merchantId: string }[]);
  return orders.find((o) => o.status === 'created')!.id;
}

describe('auth', () => {
  it('rejects unauthenticated access to protected routes', async () => {
    expect((await c.get('/admin/overview')).status).toBe(401);
    expect((await c.get('/merchant/orders')).status).toBe(401);
  });

  it('rejects a tampered token', async () => {
    const token = await login(ctx.base, 'admin@demo.test');
    const tampered = token.slice(0, -3) + 'aaa';
    expect((await c.get('/admin/overview', tampered)).status).toBe(401);
  });

  it('enforces role separation', async () => {
    const merchant = await login(ctx.base, 'harbor@demo.test');
    expect((await c.get('/admin/overview', merchant)).status).toBe(403);
    const customer = await login(ctx.base, 'maya@demo.test');
    expect((await c.get('/merchant/orders', customer)).status).toBe(403);
  });

  it('does not leak whether an email exists on failed login', async () => {
    const a = await c.post('/auth/login', { email: 'nobody@demo.test', password: 'x' });
    const b = await c.post('/auth/login', { email: 'admin@demo.test', password: 'wrongpass' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('rejects weak passwords and invalid emails on signup', async () => {
    expect((await c.post('/auth/signup', { email: 'x@y.z', password: 'short', name: 'X', role: 'customer' })).status).toBe(400);
    expect((await c.post('/auth/signup', { email: 'bad', password: 'longenough', name: 'X', role: 'customer' })).status).toBe(400);
  });
});

describe('IDOR / ownership', () => {
  it('prevents a merchant from reading another merchant\'s order', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const bakery = await login(ctx.base, 'bakery@demo.test');
    const harborOrder = await firstCreatedOrder(harbor);
    const res = await c.get(`/merchant/orders/${harborOrder}`, bakery);
    expect(res.status).toBe(403);
  });

  it('prevents a merchant from marking another merchant\'s order ready', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const bakery = await login(ctx.base, 'bakery@demo.test');
    const harborOrder = await firstCreatedOrder(harbor);
    const res = await c.post(`/merchant/orders/${harborOrder}/ready`, {}, bakery);
    expect(res.status).toBe(403);
  });

  it('prevents a customer from reading another customer\'s order', async () => {
    const maya = await login(ctx.base, 'maya@demo.test');
    const james = await login(ctx.base, 'james@demo.test');
    const mine = await c.post('/customer/orders', {
      storeId: (await c.get('/directory/merchants', maya)).body.merchants[0].stores[0].id,
      deliveryLat: 5, deliveryLng: 5, packageSize: 'small', priority: 'standard',
      deadlineTs: new Date(Date.now() + 3_600_000).toISOString(), volume: 1,
    }, maya);
    expect(mine.status).toBe(201);
    const orderId = (mine.body.order as { id: string }).id;
    expect((await c.get(`/customer/orders/${orderId}`, james)).status).toBe(403);
    expect((await c.get(`/customer/orders/${orderId}`, maya)).status).toBe(200);
  });

  it('prevents a driver from touching a delivery they do not own', async () => {
    const admin = await login(ctx.base, 'admin@demo.test');
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const orderId = await firstCreatedOrder(harbor);
    await c.post(`/merchant/orders/${orderId}/ready`, {}, harbor);
    const overview = await c.get('/admin/overview', admin);
    const delivery = (overview.body.deliveries as { id: string; driverId: string }[]).find((d) => d.driverId);
    expect(delivery).toBeTruthy();

    // every other driver must be refused
    for (let i = 1; i <= 5; i++) {
      const drv = await login(ctx.base, `driver${i}@demo.test`);
      const me = (await c.get('/auth/me', drv)).body.user as { refId: string };
      const res = await c.post(`/driver/deliveries/${delivery!.id}/accept`, {}, drv);
      if (me.refId === delivery!.driverId) expect([200, 409]).toContain(res.status);
      else expect(res.status).toBe(403);
    }
  });
});

describe('input validation', () => {
  it('rejects out-of-bounds coordinates from the client', async () => {
    const maya = await login(ctx.base, 'maya@demo.test');
    const storeId = (await c.get('/directory/merchants', maya)).body.merchants[0].stores[0].id;
    const res = await c.post('/customer/orders', {
      storeId, deliveryLat: 999, deliveryLng: -4, packageSize: 'small', priority: 'standard',
      deadlineTs: new Date(Date.now() + 3_600_000).toISOString(), volume: 1,
    }, maya);
    expect(res.status).toBe(400);
  });

  it('rejects a deadline in the past', async () => {
    const maya = await login(ctx.base, 'maya@demo.test');
    const storeId = (await c.get('/directory/merchants', maya)).body.merchants[0].stores[0].id;
    const res = await c.post('/customer/orders', {
      storeId, deliveryLat: 5, deliveryLng: 5, packageSize: 'small', priority: 'standard',
      deadlineTs: new Date(Date.now() - 3_600_000).toISOString(), volume: 1,
    }, maya);
    expect(res.status).toBe(400);
  });

  it('rejects invalid id shapes in path params', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    expect((await c.get('/merchant/orders/not-a-real-id', harbor)).status).toBe(400);
    expect((await c.get("/merchant/orders/' OR 1=1--", harbor)).status).toBe(400);
  });
});

