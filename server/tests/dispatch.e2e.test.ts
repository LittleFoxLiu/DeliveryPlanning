import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, client, login, reseed, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let c: ReturnType<typeof client>;

beforeAll(async () => { ctx = await startTestServer(); c = client(ctx.base); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await reseed(); });

const createdOrders = async (token: string) =>
  (await c.get('/merchant/orders', token)).body.orders as { id: string; status: string }[];

describe('end-to-end dispatch', () => {
  it('runs the full multi-agent pipeline and assigns the best driver', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const admin = await login(ctx.base, 'admin@demo.test');
    const orderId = (await createdOrders(harbor)).find((o) => o.status === 'created')!.id;

    const ready = await c.post(`/merchant/orders/${orderId}/ready`, {}, harbor);
    expect(ready.status).toBe(200);
    const dispatch = ready.body.dispatch as { status: string; decision: { driverId: string; score: number } };
    expect(dispatch.status).toBe('assigned');
    expect(dispatch.decision.driverId).toMatch(/^drv_/);
    expect(dispatch.decision.score).toBeGreaterThan(0);

    const detail = await c.get(`/admin/orders/${orderId}`, admin);
    const agents = new Set((detail.body.events as { agent: string }[]).map((e) => e.agent));
    for (const a of ['Coordinator', 'OrderAgent', 'DriverAgent', 'RoutingAgent', 'DispatchAgent']) {
      expect(agents.has(a)).toBe(true);
    }
    const assignment = (detail.body.assignments as { status: string; reasoning: { explanation: string[] } }[])[0];
    expect(assignment.status).toBe('active');
    expect(assignment.reasoning.explanation.length).toBeGreaterThan(4);
  });

  it('is idempotent under the same Idempotency-Key', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const orderId = (await createdOrders(harbor)).find((o) => o.status === 'created')!.id;
    const key = 'test-key-123456';
    const a = await c.post(`/merchant/orders/${orderId}/ready`, {}, harbor, { 'idempotency-key': key });
    const first = (a.body.dispatch as { decision?: { driverId: string } }).decision?.driverId;
    // second ready call is a no-op (already dispatching); force via admin dispatch with same key
    const b = await c.post(`/admin/dispatch/${orderId}`, {}, await login(ctx.base, 'admin@demo.test'), { 'idempotency-key': key });
    const outcome = b.body.outcome as { status: string; decision?: { driverId: string } };
    expect(['assigned', 'reused']).toContain(outcome.status);
    if (outcome.decision) expect(outcome.decision.driverId).toBe(first);
  });

  it('does not double-assign when dispatch is triggered concurrently', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const admin = await login(ctx.base, 'admin@demo.test');
    const orderId = (await createdOrders(harbor)).find((o) => o.status === 'created')!.id;
    await c.post(`/merchant/orders/${orderId}/ready`, {}, harbor);

    // hammer the dispatch endpoint in parallel
    const results = await Promise.all(
      Array.from({ length: 8 }, () => c.post(`/admin/dispatch/${orderId}`, {}, admin)),
    );
    const drivers = new Set(
      results
        .map((r) => (r.body.outcome as { decision?: { driverId?: string } }).decision?.driverId)
        .filter(Boolean),
    );
    expect(drivers.size).toBeLessThanOrEqual(1);

    const detail = await c.get(`/admin/orders/${orderId}`, admin);
    const active = (detail.body.assignments as { status: string }[]).filter((a) => a.status === 'active');
    expect(active.length).toBe(1);
  });

  it('rejects an illegal state transition (marking a delivered order ready)', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const admin = await login(ctx.base, 'admin@demo.test');
    const orderId = (await createdOrders(harbor)).find((o) => o.status === 'created')!.id;
    await c.post(`/merchant/orders/${orderId}/ready`, {}, harbor);
    // drive it to delivered via the simulator
    for (let i = 0; i < 40; i++) {
      await c.post('/sim/tick', {}, admin);
      const o = (await c.get(`/admin/orders/${orderId}`, admin)).body.order as { status: string };
      if (o.status === 'delivered') break;
    }
    const o = (await c.get(`/admin/orders/${orderId}`, admin)).body.order as { status: string };
    expect(o.status).toBe('delivered');
    const res = await c.post(`/merchant/orders/${orderId}/ready`, {}, harbor);
    expect(res.status).toBe(409);
  });
});

describe('monitoring & remediation', () => {
  it('reassigns when the assigned driver goes offline mid-delivery', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const admin = await login(ctx.base, 'admin@demo.test');
    const orderId = (await createdOrders(harbor)).find((o) => o.status === 'created')!.id;
    const ready = await c.post(`/merchant/orders/${orderId}/ready`, {}, harbor);
    const firstDriver = (ready.body.dispatch as { decision: { driverId: string } }).decision.driverId;

    await c.post('/sim/tick', {}, admin);
    await c.post(`/sim/driver/${firstDriver}/offline`, {}, admin);
    const tick = await c.post('/sim/tick', {}, admin);
    const actions = tick.body.monitoring as { actions: { strategy: string; ok: boolean }[] };
    expect(actions.actions.some((a) => a.strategy === 'reassign')).toBe(true);

    const detail = await c.get(`/admin/orders/${orderId}`, admin);
    const active = (detail.body.assignments as { status: string; driverId: string }[]).find((a) => a.status === 'active');
    expect(active).toBeTruthy();
    expect(active!.driverId).not.toBe(firstDriver);
  });

  it('reroutes (not reassigns) a recoverable traffic delay', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const admin = await login(ctx.base, 'admin@demo.test');
    const orderId = (await createdOrders(harbor)).find((o) => o.status === 'created')!.id;
    await c.post(`/merchant/orders/${orderId}/ready`, {}, harbor);
    await c.post('/sim/tick', {}, admin);
    const blocked = await c.post('/sim/traffic', { blockRouteOf: orderId }, admin);
    expect((blocked.body.closed as string[]).length).toBeGreaterThan(0);

    let sawReroute = false;
    for (let i = 0; i < 5; i++) {
      const tick = await c.post('/sim/tick', {}, admin);
      const actions = (tick.body.monitoring as { actions: { strategy: string }[] }).actions;
      if (actions.some((a) => a.strategy === 'reroute')) sawReroute = true;
    }
    expect(sawReroute).toBe(true);
  });
});
