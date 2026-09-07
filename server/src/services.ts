import { tx } from './db.js';
import { deliveries, orders, drivers, routes, roads, type DeliveryRow } from './repo.js';
import { emitAgentEvent } from './events.js';
import { nowIso, conflict, badRequest } from './util.js';
import { coordinator } from './agents/coordinator.js';
import type { Point } from './engine/routing.js';

type DriverAction = 'accept' | 'picked_up' | 'delivered';

/** Driver-reported progress. Deterministic state transitions with ownership
 *  already checked by the route handler. */
export async function driverProgress(deliveryId: string, driverId: string, action: DriverAction): Promise<DeliveryRow> {
  return tx(async () => {
    const delivery = await deliveries.byId(deliveryId);
    if (!delivery) throw conflict('delivery not found');
    if (delivery.driver_id !== driverId) throw conflict('not your delivery');
    const order = (await orders.byId(delivery.order_id))!;

    if (action === 'accept') {
      await deliveries.setStatus(deliveryId, 'en_route_pickup', 'assigned');
      await emitAgentEvent({ agent: 'Driver', eventType: 'delivery_accepted', orderId: order.id, deliveryId, driverId, message: `Driver ${driverId} accepted the delivery for order ${order.id}` });
    } else if (action === 'picked_up') {
      await deliveries.setStatus(deliveryId, 'picked_up', ['en_route_pickup', 'assigned']);
      await deliveries.update(deliveryId, { pickup_at: nowIso() });
      try { await orders.setStatus(order.id, 'picked_up', ['assigned', 'dispatching']); } catch { /* keep */ }
      await emitAgentEvent({ agent: 'Driver', eventType: 'package_picked_up', orderId: order.id, deliveryId, driverId, message: `Driver ${driverId} picked up order ${order.id} at the merchant` });
    } else {
      await deliveries.setStatus(deliveryId, 'delivered', ['picked_up', 'en_route_drop']);
      const assignedMs = delivery.assigned_at ? Date.parse(delivery.assigned_at) : Date.now();
      const actual = Number(((Date.now() - assignedMs) / 60_000).toFixed(1));
      await deliveries.update(deliveryId, { delivered_at: nowIso(), actual_delivery_minutes: actual });
      try { await orders.setStatus(order.id, 'delivered', ['picked_up', 'delivering', 'assigned']); } catch { /* keep */ }
      await drivers.adjustOrderCount(driverId, -1);
      const stillActive = (await deliveries.byDriver(driverId)).filter((d) => d.id !== deliveryId && !['delivered', 'cancelled', 'failed'].includes(d.status));
      if (stillActive.length === 0) await drivers.setStatus(driverId, 'available');
      await emitAgentEvent({ agent: 'Driver', eventType: 'delivered', orderId: order.id, deliveryId, driverId, message: `Order ${order.id} delivered to the customer in ${actual} min` });
    }
    return (await deliveries.byId(deliveryId))!;
  });
}

const segKey = (a: Point, b: Point) => {
  const pts = [a, b].sort((m, n) => (m.x - n.x) || (m.y - n.y));
  return `${pts[0].x},${pts[0].y}-${pts[1].x},${pts[1].y}`;
};

async function findRoadId(a: Point, b: Point): Promise<string | undefined> {
  return (await roads.all()).find((r) => segKey({ x: r.ax, y: r.ay }, { x: r.bx, y: r.by }) === segKey(a, b))?.id;
}

export interface TickResult {
  moved: { deliveryId: string; driverId: string; from: Point; to: Point; arrived?: string }[];
  monitoring: Awaited<ReturnType<typeof coordinator.runMonitoringCycle>>;
}

/** Simulator: advance every in-flight driver one grid step along their active
 *  route, auto-transitioning on arrival, then run one monitoring cycle. */
export async function simulateTick(): Promise<TickResult> {
  const moved: TickResult['moved'] = [];

  const active = (await deliveries.active()).filter((d) => ['assigned', 'en_route_pickup', 'picked_up', 'en_route_drop'].includes(d.status));
  for (const delivery of active) {
    if (!delivery.driver_id) continue;
    const route = await routes.activeForDelivery(delivery.id);
    if (!route) continue;
    const driver = await drivers.byId(delivery.driver_id);
    if (!driver || driver.lat == null || driver.status === 'offline') continue;
    const pos: Point = { x: driver.lat, y: driver.lng as number };

    const paths = JSON.parse(route.path_json) as { toPickup?: Point[]; toDropoff?: Point[] };
    const phasePickup = ['assigned', 'en_route_pickup'].includes(delivery.status);
    const path = (phasePickup ? paths.toPickup : paths.toDropoff) ?? [];
    if (path.length < 1) continue;

    // find nearest index on the path, then step toward the next point
    let idx = 0; let best = Infinity;
    path.forEach((p, i) => { const d = Math.hypot(p.x - pos.x, p.y - pos.y); if (d <= best) { best = d; idx = i; } });
    const next = path[Math.min(idx + 1, path.length - 1)];
    const target = path[path.length - 1];

    await tx(async () => { await drivers.recordLocation(delivery.driver_id!, next.x, next.y); });
    const record: TickResult['moved'][number] = { deliveryId: delivery.id, driverId: delivery.driver_id, from: pos, to: next };

    const atTarget = Math.hypot(next.x - target.x, next.y - target.y) < 0.5;
    if (atTarget && phasePickup) {
      try {
        await driverProgress(delivery.id, delivery.driver_id, delivery.status === 'assigned' ? 'accept' : 'picked_up');
        if ((await deliveries.byId(delivery.id))?.status === 'en_route_pickup') {
          await driverProgress(delivery.id, delivery.driver_id, 'picked_up');
        }
        record.arrived = 'pickup';
      } catch { /* ignore transition races */ }
    } else if (atTarget && !phasePickup) {
      try { await driverProgress(delivery.id, delivery.driver_id, 'delivered'); record.arrived = 'dropoff'; } catch { /* ignore */ }
    } else if (phasePickup && delivery.status === 'assigned') {
      try { await driverProgress(delivery.id, delivery.driver_id, 'accept'); } catch { /* ignore */ }
    }
    moved.push(record);
  }

  const monitoring = await coordinator.runMonitoringCycle();
  return { moved, monitoring };
}

export interface TrafficChange { closed: string[]; updated: string[]; statusCounts?: Record<'clear' | 'moderate' | 'heavy' | 'closed', number> }

/** Simulator: randomize the status of every road segment in Supabase. The
 * distribution keeps most roads usable while still producing meaningful
 * congestion and closure scenarios for the monitoring demo. */
export async function randomizeRoadStatus(): Promise<TrafficChange> {
  const current = await roads.all();
  const statusCounts: Record<'clear' | 'moderate' | 'heavy' | 'closed', number> = { clear: 0, moderate: 0, heavy: 0, closed: 0 };
  const randomized = current.map((road) => {
    const roll = Math.random();
    const status = roll < 0.55 ? 'clear' : roll < 0.8 ? 'moderate' : roll < 0.95 ? 'heavy' : 'closed';
    const delay = status === 'clear' ? 0 : status === 'moderate' ? 3 + Math.floor(Math.random() * 6) : status === 'heavy' ? 8 + Math.floor(Math.random() * 13) : 0;
    statusCounts[status] += 1;
    return { id: road.id, ax: road.ax, ay: road.ay, bx: road.bx, by: road.by, status, delay };
  });
  await roads.upsertMany(randomized);
  const closed = randomized.filter((road) => road.status === 'closed').map((road) => road.id);
  await emitAgentEvent({
    agent: 'TrafficFeed', eventType: 'traffic_randomized',
    message: `Randomized road status across ${randomized.length} segment(s): ${statusCounts.clear} clear, ${statusCounts.moderate} moderate, ${statusCounts.heavy} heavy, ${statusCounts.closed} closed`,
    data: { statusCounts, closed },
  });
  return { closed, updated: randomized.map((road) => road.id), statusCounts };
}

/** Simulator: inject a road/traffic change. Either explicit segments or
 *  `blockRouteOf` (closes a segment on that order's remaining route). */
export async function injectTraffic(input: {
  segments?: string[];
  status?: 'clear' | 'moderate' | 'heavy' | 'closed';
  delayMinutes?: number;
  blockRouteOf?: string;
}): Promise<TrafficChange> {
  const status = input.status ?? 'closed';
  const delay = input.delayMinutes ?? (status === 'heavy' ? 12 : status === 'moderate' ? 5 : 0);
  const changed: string[] = [];

  return tx(async () => {
    let segmentIds = input.segments ?? [];

    if (input.blockRouteOf) {
      const order = await orders.byId(input.blockRouteOf);
      if (!order) throw badRequest('order not found for blockRouteOf');
      const delivery = await deliveries.byOrderId(order.id);
      if (!delivery) throw badRequest('order has no active delivery');
      const route = await routes.activeForDelivery(delivery.id);
      if (!route) throw badRequest('delivery has no active route');
      const paths = JSON.parse(route.path_json) as { toPickup?: Point[]; toDropoff?: Point[] };
      const driver = await drivers.byId(delivery.driver_id!);
      const pos: Point = driver && driver.lat != null ? { x: driver.lat, y: driver.lng as number } : { x: route.origin_lat, y: route.origin_lng };
      const phasePickup = ['assigned', 'en_route_pickup'].includes(delivery.status);
      const path = (phasePickup ? paths.toPickup : paths.toDropoff) ?? [];
      // choose a segment a couple of steps ahead of the driver
      let idx = 0; let bestD = Infinity;
      path.forEach((p, i) => { const d = Math.hypot(p.x - pos.x, p.y - pos.y); if (d < bestD) { bestD = d; idx = i; } });
      const a = path[Math.min(idx + 1, path.length - 2)];
      const b = path[Math.min(idx + 2, path.length - 1)];
      if (a && b && (a.x !== b.x || a.y !== b.y)) {
        const rid = await findRoadId(a, b);
        if (rid) segmentIds = [rid];
      }
      if (segmentIds.length === 0) throw badRequest('could not locate a blockable segment on the remaining route');

      // Close the chosen segment and choke the surrounding block so any detour
      // is genuinely slower — this reliably trips the Monitoring Agent's delay
      // detection for the demo.
      const primary = (await roads.byId(segmentIds[0]))!;
      await roads.setStatus(primary.id, 'closed', 0);
      changed.push(primary.id);
      const nodes = new Set([`${primary.ax},${primary.ay}`, `${primary.bx},${primary.by}`]);
      for (const r of await roads.all()) {
        if (r.id === primary.id || r.status === 'closed') continue;
        if (nodes.has(`${r.ax},${r.ay}`) || nodes.has(`${r.bx},${r.by}`)) {
          await roads.setStatus(r.id, 'heavy', 15);
          changed.push(r.id);
        }
      }
      await emitAgentEvent({
        agent: 'TrafficFeed', eventType: 'traffic_updated',
        message: `Incident on ${primary.id} — road closed and surrounding streets now heavily congested (+15 min)`,
        data: { segments: changed, closed: [primary.id] },
      });
      return { closed: [primary.id], updated: changed };
    }

    for (const sid of segmentIds) {
      const road = await roads.byId(sid);
      if (!road) throw badRequest(`unknown road segment ${sid}`);
      await roads.setStatus(sid, status, delay);
      changed.push(sid);
    }

    await emitAgentEvent({
      agent: 'TrafficFeed', eventType: 'traffic_updated',
      message: status === 'closed'
        ? `Road closure reported on ${changed.length} segment(s): ${changed.join(', ')}`
        : `Traffic now ${status} on ${changed.length} segment(s) (+${delay} min): ${changed.join(', ')}`,
      data: { segments: changed, status, delay },
    });
    return { closed: status === 'closed' ? changed : [], updated: changed };
  });
}
