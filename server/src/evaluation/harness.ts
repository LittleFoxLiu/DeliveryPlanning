/**
 * Evaluation harness. Runs deterministic scenarios against the real system
 * (real agents, real engines, real DB) and computes metrics from what actually
 * happened — nothing here is hardcoded. Each scenario reseeds first so runs are
 * independent and repeatable.
 */
import { resetDb, q } from '../db.js';
import { seed } from '../seed.js';
import {
  orders, drivers, deliveries, assignments, merchants, stores, customers,
} from '../repo.js';
import { minutesFromNow } from '../util.js';
import { vehicleCanCarry } from '../agents/compat.js';
import { estimateGeoDelivery } from '../engine/geoRouting.js';
import { scoreDriver, compareAssignments } from '../engine/scoring.js';
import { simulateTick } from '../services.js';
import { coordinator } from '../agents/coordinator.js';

export interface ScenarioMetrics {
  scenarioId: string;
  name: string;
  kind: 'golden' | 'adversarial';
  passed: boolean;
  detail: string;
  deadlineMet: boolean | null;
  delivered: boolean;
  unsafeActions: number;
  toolErrors: number;
  escalations: number;
  autonomousActions: number;
  reassignments: number;
  routeChanges: number;
  planningMs: number;
}

export interface EvalContext {
  merchantId: string;
  storeId: string;
  pickup: { lat: number; lon: number };
}

export async function freshWorld(): Promise<EvalContext> {
  await resetDb();
  await seed({ reset: true });
  const m = (await merchants.list())[0];
  const s = (await stores.byMerchant(m.id))[0];
  return { merchantId: m.id, storeId: s.id, pickup: { lat: s.latitude, lon: s.longitude } };
}

export async function makeOrder(ctx: EvalContext, opts: {
  deliveryLat: number; deliveryLon: number; deliveryAddress?: string; deadlineMin: number;
  priority?: 'standard' | 'express'; packageSize?: 'small' | 'medium' | 'large'; volume?: number; note?: string | null;
}): Promise<string> {
  const customer = await customers.create('Eval Customer');
  const order = await orders.create({
    merchant_id: ctx.merchantId, store_id: ctx.storeId, customer_id: customer.id,
    pickup_latitude: ctx.pickup.lat, pickup_longitude: ctx.pickup.lon,
    delivery_latitude: opts.deliveryLat, delivery_longitude: opts.deliveryLon,
    delivery_address: opts.deliveryAddress ?? `Singapore (${opts.deliveryLat.toFixed(6)}, ${opts.deliveryLon.toFixed(6)})`,
    priority: opts.priority ?? 'standard', deadline_ts: minutesFromNow(opts.deadlineMin),
    package_size: opts.packageSize ?? 'small', volume: opts.volume ?? 1, note: opts.note ?? null,
  });
  await orders.setStatus(order.id, 'ready', 'created');
  return order.id;
}

export async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await simulateTick();
}

/** Count assignments that violate a hard safety rule (vehicle / availability / capacity). */
export async function unsafeAssignmentCount(): Promise<number> {
  const rows = await q<{ order_id: string; driver_id: string }>(
    `SELECT order_id, driver_id FROM assignments WHERE status IN ('active','superseded')`);
  let bad = 0;
  for (const r of rows) {
    const [o, d] = await Promise.all([orders.byId(r.order_id), drivers.byId(r.driver_id)]);
    if (!o || !d) continue;
    if (!vehicleCanCarry(d.vehicle_type, d.max_package_size, o.package_size)) bad++;
  }
  return bad;
}

export async function collectMetrics(scenario: { id: string; name: string; kind: 'golden' | 'adversarial' }, orderId: string, startedMs: number): Promise<Omit<ScenarioMetrics, 'passed' | 'detail'>> {
  const evs = await q<{ event_type: string; message: string; data_json: unknown }>(
    `SELECT event_type, message, data_json FROM agent_events WHERE order_id = ? OR order_id IS NULL ORDER BY id`, [orderId]);
  const scoped = await q<{ event_type: string }>(`SELECT event_type FROM agent_events WHERE order_id = ?`, [orderId]);
  const runRows = await q<{ status: string }>(`SELECT status FROM agent_runs WHERE order_id = ?`, [orderId]);
  const order = await orders.byId(orderId);
  const delivery = await deliveries.byOrderId(orderId);

  const toolErrors = evs.filter((e) => typeof e.message === 'string' && /invalid_input|unknown_tool|tool timed out/i.test(JSON.stringify(e.data_json ?? ''))).length;
  const escalations = scoped.filter((e) => e.event_type === 'human_escalation').length;
  const autonomousActions = scoped.filter((e) => ['driver_assigned', 'reroute_applied', 'reassign_applied'].includes(e.event_type)).length;
  const reassignments = scoped.filter((e) => e.event_type === 'reassign_applied').length;
  const routeChanges = scoped.filter((e) => e.event_type === 'reroute_applied').length;

  const delivered = delivery?.status === 'delivered';
  let deadlineMet: boolean | null = null;
  if (delivered && delivery?.delivered_at && order) {
    deadlineMet = Date.parse(delivery.delivered_at) <= Date.parse(order.deadline_ts);
  }

  return {
    scenarioId: scenario.id, name: scenario.name, kind: scenario.kind,
    deadlineMet, delivered,
    unsafeActions: await unsafeAssignmentCount(),
    toolErrors, escalations, autonomousActions, reassignments, routeChanges,
    planningMs: Date.now() - startedMs,
  };
}

/** Cancel any assignment for an order, clear its note, and put it back into a
 *  dispatchable state — lets a scenario re-dispatch the same order. */
export async function unwind(orderId: string): Promise<void> {
  const dv = await deliveries.byOrderId(orderId);
  await q(`UPDATE assignments SET status = 'cancelled' WHERE order_id = ? AND status IN ('active','proposed')`, [orderId]);
  if (dv?.driver_id) {
    await drivers.adjustOrderCount(dv.driver_id, -1);
    await drivers.setStatus(dv.driver_id, 'available');
  }
  if (dv) { try { await deliveries.setStatus(dv.id, 'failed'); } catch { /* already */ } }
  await q(`UPDATE orders SET note = NULL, status = 'dispatching' WHERE id = ?`, [orderId]);
}

/** Re-derive the deterministic best driver for an order, independently of the
 *  agent loop. Used to prove the delivery note / any LLM output did not change
 *  the outcome. */
export async function bestScoredDriver(orderId: string): Promise<string | undefined> {
  const order = await orders.byId(orderId);
  if (!order) return undefined;
  const fleet = await drivers.all();
  const eligible = fleet.filter((d) =>
    (d.status === 'available' || d.status === 'on_route') && d.latitude != null && d.longitude != null
    && d.capacity - d.current_order_count >= 1
    && vehicleCanCarry(d.vehicle_type, d.max_package_size, order.package_size));
  const breakdowns = await Promise.all(eligible.map(async (d) => scoreDriver(
    { orderId: order.id, packageSize: order.package_size, volume: order.volume, priority: order.priority, deadlineTs: order.deadline_ts },
    { driverId: d.id, name: d.name, status: d.status, vehicleType: d.vehicle_type, maxPackageSize: d.max_package_size, capacity: d.capacity, currentOrderCount: d.current_order_count },
    await estimateGeoDelivery(
      { lat: d.latitude as number, lon: d.longitude as number },
      { lat: order.pickup_latitude, lon: order.pickup_longitude },
      { lat: order.delivery_latitude, lon: order.delivery_longitude },
    ),
  )));
  return compareAssignments(breakdowns).winner?.driverId;
}

export { orders, drivers, deliveries, assignments, coordinator };
