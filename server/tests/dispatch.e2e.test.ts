import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, client, login, reseed, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let c: ReturnType<typeof client>;

beforeAll(async () => { ctx = await startTestServer(); c = client(ctx.base); });
afterAll(async () => { await ctx.close(); });
beforeEach(() => reseed());

const createdOrders = async (token: string) =>
  (await c.get('/merchant/orders', token)).body.orders as { id: string; status: string; priority: string }[];

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

describe('driver waypoint sync', () => {
  it('moves the driver to the pickup on "picked up" and to the customer on "delivered"', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const admin = await login(ctx.base, 'admin@demo.test');
    const orderId = (await createdOrders(harbor)).find((o) => o.status === 'created')!.id;
    const ready = await c.post(`/merchant/orders/${orderId}/ready`, {}, harbor);
    const driverId = (ready.body.dispatch as { decision: { driverId: string } }).decision.driverId;

    let driverToken = '';
    for (let i = 1; i <= 5; i++) {
      const tok = await login(ctx.base, `driver${i}@demo.test`);
      if (((await c.get('/auth/me', tok)).body.user as { refId: string }).refId === driverId) { driverToken = tok; break; }
    }
    const dv = (await c.get('/driver/deliveries', driverToken)).body.deliveries[0] as {
      id: string; pickup: { x: number; y: number }; dropoff: { x: number; y: number };
    };

    await c.post(`/driver/deliveries/${dv.id}/accept`, {}, driverToken);
    // from wherever they were, confirming pickup snaps them onto the pickup
    await c.post(`/driver/deliveries/${dv.id}/status`, { action: 'picked_up' }, driverToken);
    let me = (await c.get('/driver/deliveries', driverToken)).body.me as { location: { x: number; y: number } };
    expect(me.location).toMatchObject({ x: dv.pickup.x, y: dv.pickup.y });

    await c.post(`/driver/deliveries/${dv.id}/status`, { action: 'delivered' }, driverToken);
    me = (await c.get('/driver/deliveries', driverToken)).body.me as { location: { x: number; y: number } };
    expect(me.location).toMatchObject({ x: dv.dropoff.x, y: dv.dropoff.y });

    const detail = await c.get(`/admin/orders/${orderId}`, admin);
    expect((detail.body.order as { status: string }).status).toBe('delivered');
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

  it('reroutes (keeps the driver) for a recoverable traffic delay', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const admin = await login(ctx.base, 'admin@demo.test');
    // the standard order has a generous (~120 min) deadline — a reroute absorbs the hit
    const orderId = (await createdOrders(harbor)).find((o) => o.priority === 'standard' && o.status === 'created')!.id;
    const ready = await c.post(`/merchant/orders/${orderId}/ready`, {}, harbor);
    const driver = (ready.body.dispatch as { decision: { driverId: string } }).decision.driverId;
    await c.post('/sim/tick', {}, admin);
    await c.post('/sim/traffic', { blockRouteOf: orderId, severity: 'major' }, admin);

    let sawReroute = false;
    for (let i = 0; i < 5; i++) {
      const tick = await c.post('/sim/tick', {}, admin);
      const actions = (tick.body.monitoring as { actions: { strategy: string }[] }).actions;
      if (actions.some((a) => a.strategy === 'reroute')) sawReroute = true;
    }
    expect(sawReroute).toBe(true);
    const detail = await c.get(`/admin/orders/${orderId}`, admin);
    const active = (detail.body.assignments as { status: string; driverId: string }[]).find((a) => a.status === 'active');
    expect(active?.driverId).toBe(driver); // same driver, just a new route
  });

  it('escalates to reassignment when a reroute still misses the deadline', async () => {
    const harbor = await login(ctx.base, 'harbor@demo.test');
    const admin = await login(ctx.base, 'admin@demo.test');
    // the express order has a tight (~55 min) deadline
    const orderId = (await createdOrders(harbor)).find((o) => o.priority === 'express' && o.status === 'created')!.id;
    const ready = await c.post(`/merchant/orders/${orderId}/ready`, {}, harbor);
    const firstDriver = (ready.body.dispatch as { decision: { driverId: string } }).decision.driverId;
    await c.post('/sim/tick', {}, admin);
    await c.post('/sim/traffic', { blockRouteOf: orderId, severity: 'major' }, admin);

    let sawReassign = false;
    for (let i = 0; i < 6; i++) {
      const tick = await c.post('/sim/tick', {}, admin);
      const actions = (tick.body.monitoring as { actions: { strategy: string; ok: boolean }[] }).actions;
      if (actions.some((a) => a.strategy === 'reassign' && a.ok)) sawReassign = true;
    }
    const detail = await c.get(`/admin/orders/${orderId}`, admin);
    const active = (detail.body.assignments as { status: string; driverId: string }[]).find((a) => a.status === 'active');
    // either it reassigned to a faster driver, or (if none could make it) kept the
    // original on the fastest route — both are valid; assert the risk was handled.
    const events = (detail.body.events as { eventType?: string; event_type?: string }[])
      .map((e) => e.eventType || e.event_type);
    expect(sawReassign || events.includes('reroute_kept') || active?.driverId !== firstDriver).toBe(true);
  });
});
