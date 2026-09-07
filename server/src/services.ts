import { tx } from './db.js';
import { deliveries, orders, drivers, routes, roads, type DeliveryRow } from './repo.js';
import { emitAgentEvent } from './events.js';
import { nowIso, conflict, badRequest } from './util.js';
import { coordinator } from './agents/coordinator.js';
import type { Point } from './engine/routing.js';

type DriverAction = 'accept' | 'picked_up' | 'delivered';

/** Driver-reported progress. Deterministic state transitions with ownership
 *  already checked by the route handler. */
export function driverProgress(deliveryId: string, driverId: string, action: DriverAction): DeliveryRow {
  return tx(() => {
    const delivery = deliveries.byId(deliveryId);
    if (!delivery) throw conflict('delivery not found');
    if (delivery.driver_id !== driverId) throw conflict('not your delivery');
    const order = orders.byId(delivery.order_id)!;

    if (action === 'accept') {
      deliveries.setStatus(deliveryId, 'en_route_pickup', 'assigned');
      emitAgentEvent({ agent: 'Driver', eventType: 'delivery_accepted', orderId: order.id, deliveryId, driverId, message: `Driver ${driverId} accepted the delivery for order ${order.id}` });
    } else if (action === 'picked_up') {
      deliveries.setStatus(deliveryId, 'picked_up', ['en_route_pickup', 'assigned']);
      deliveries.update(deliveryId, { pickup_at: nowIso() });
      try { orders.setStatus(order.id, 'picked_up', ['assigned', 'dispatching']); } catch { /* keep */ }
      emitAgentEvent({ agent: 'Driver', eventType: 'package_picked_up', orderId: order.id, deliveryId, driverId, message: `Driver ${driverId} picked up order ${order.id} at the merchant` });
    } else {
      deliveries.setStatus(deliveryId, 'delivered', ['picked_up', 'en_route_drop']);
      const assignedMs = delivery.assigned_at ? Date.parse(delivery.assigned_at) : Date.now();
      const actual = Number(((Date.now() - assignedMs) / 60_000).toFixed(1));
      deliveries.update(deliveryId, { delivered_at: nowIso(), actual_delivery_minutes: actual });
      try { orders.setStatus(order.id, 'delivered', ['picked_up', 'delivering', 'assigned']); } catch { /* keep */ }
      drivers.adjustOrderCount(driverId, -1);
      const stillActive = deliveries.byDriver(driverId).filter((d) => d.id !== deliveryId && !['delivered', 'cancelled', 'failed'].includes(d.status));
      if (stillActive.length === 0) drivers.setStatus(driverId, 'available');
      emitAgentEvent({ agent: 'Driver', eventType: 'delivered', orderId: order.id, deliveryId, driverId, message: `Order ${order.id} delivered to the customer in ${actual} min` });
    }
    return deliveries.byId(deliveryId)!;
  });
}

const segKey = (a: Point, b: Point) => {
  const pts = [a, b].sort((m, n) => (m.x - n.x) || (m.y - n.y));
  return `${pts[0].x},${pts[0].y}-${pts[1].x},${pts[1].y}`;
};

function findRoadId(a: Point, b: Point): string | undefined {
  return roads.all().find((r) => segKey({ x: r.ax, y: r.ay }, { x: r.bx, y: r.by }) === segKey(a, b))?.id;
}

export interface TickResult {
  moved: { deliveryId: string; driverId: string; from: Point; to: Point; arrived?: string }[];
  monitoring: Awaited<ReturnType<typeof coordinator.runMonitoringCycle>>;
}

/** Simulator: advance every in-flight driver one grid step along their active
 *  route, auto-transitioning on arrival, then run one monitoring cycle. */
export async function simulateTick(): Promise<TickResult> {
  const moved: TickResult['moved'] = [];

  const active = deliveries.active().filter((d) => ['assigned', 'en_route_pickup', 'picked_up', 'en_route_drop'].includes(d.status));
  for (const delivery of active) {
    if (!delivery.driver_id) continue;
    const route = routes.activeForDelivery(delivery.id);
    if (!route) continue;
    const driver = drivers.byId(delivery.driver_id);
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

    tx(() => {
      drivers.recordLocation(delivery.driver_id!, next.x, next.y);
    });
    const record: TickResult['moved'][number] = { deliveryId: delivery.id, driverId: delivery.driver_id, from: pos, to: next };

    const atTarget = Math.hypot(next.x - target.x, next.y - target.y) < 0.5;
    if (atTarget && phasePickup) {
      try {
        driverProgress(delivery.id, delivery.driver_id, delivery.status === 'assigned' ? 'accept' : 'picked_up');
        if (deliveries.byId(delivery.id)?.status === 'en_route_pickup') {
          driverProgress(delivery.id, delivery.driver_id, 'picked_up');
        }
        record.arrived = 'pickup';
      } catch { /* ignore transition races */ }
    } else if (atTarget && !phasePickup) {
      try { driverProgress(delivery.id, delivery.driver_id, 'delivered'); record.arrived = 'dropoff'; } catch { /* ignore */ }
    } else if (phasePickup && delivery.status === 'assigned') {
      try { driverProgress(delivery.id, delivery.driver_id, 'accept'); } catch { /* ignore */ }
    }
    moved.push(record);
  }

  const monitoring = await coordinator.runMonitoringCycle();
  return { moved, monitoring };
}

export interface TrafficChange { closed: string[]; updated: string[] }

/** Simulator: inject a road/traffic change. Either explicit segments or
 *  `blockRouteOf` (closes a segment on that order's remaining route). */
export function injectTraffic(input: {
  segments?: string[];
  status?: 'clear' | 'moderate' | 'heavy' | 'closed';
  delayMinutes?: number;
  blockRouteOf?: string;
}): TrafficChange {
  const status = input.status ?? 'closed';
  const delay = input.delayMinutes ?? (status === 'heavy' ? 12 : status === 'moderate' ? 5 : 0);
  const changed: string[] = [];

  return tx(() => {
    let segmentIds = input.segments ?? [];

    if (input.blockRouteOf) {
      const order = orders.byId(input.blockRouteOf);
      if (!order) throw badRequest('order not found for blockRouteOf');
      const delivery = deliveries.byOrderId(order.id);
      if (!delivery) throw badRequest('order has no active delivery');
      const route = routes.activeForDelivery(delivery.id);
      if (!route) throw badRequest('delivery has no active route');
      const paths = JSON.parse(route.path_json) as { toPickup?: Point[]; toDropoff?: Point[] };
      const driver = drivers.byId(delivery.driver_id!);
      const pos: Point = driver && driver.lat != null ? { x: driver.lat, y: driver.lng as number } : { x: route.origin_lat, y: route.origin_lng };
      const phasePickup = ['assigned', 'en_route_pickup'].includes(delivery.status);
      const path = (phasePickup ? paths.toPickup : paths.toDropoff) ?? [];
      // choose a segment a couple of steps ahead of the driver
      let idx = 0; let bestD = Infinity;
      path.forEach((p, i) => { const d = Math.hypot(p.x - pos.x, p.y - pos.y); if (d < bestD) { bestD = d; idx = i; } });
      const a = path[Math.min(idx + 1, path.length - 2)];
      const b = path[Math.min(idx + 2, path.length - 1)];
      if (a && b && (a.x !== b.x || a.y !== b.y)) {
        const rid = findRoadId(a, b);
        if (rid) segmentIds = [rid];
      }
      if (segmentIds.length === 0) throw badRequest('could not locate a blockable segment on the remaining route');

      // Close the chosen segment and choke the surrounding block so any detour
      // is genuinely slower — this reliably trips the Monitoring Agent's delay
      // detection for the demo.
      const primary = roads.byId(segmentIds[0])!;
      roads.setStatus(primary.id, 'closed', 0);
      changed.push(primary.id);
      const nodes = new Set([`${primary.ax},${primary.ay}`, `${primary.bx},${primary.by}`]);
      for (const r of roads.all()) {
        if (r.id === primary.id || r.status === 'closed') continue;
        if (nodes.has(`${r.ax},${r.ay}`) || nodes.has(`${r.bx},${r.by}`)) {
          roads.setStatus(r.id, 'heavy', 15);
          changed.push(r.id);
        }
      }
      emitAgentEvent({
        agent: 'TrafficFeed', eventType: 'traffic_updated',
        message: `Incident on ${primary.id} — road closed and surrounding streets now heavily congested (+15 min)`,
        data: { segments: changed, closed: [primary.id] },
      });
      return { closed: [primary.id], updated: changed };
    }

    for (const sid of segmentIds) {
      const road = roads.byId(sid);
      if (!road) throw badRequest(`unknown road segment ${sid}`);
      roads.setStatus(sid, status, delay);
      changed.push(sid);
    }

    emitAgentEvent({
      agent: 'TrafficFeed', eventType: 'traffic_updated',
      message: status === 'closed'
        ? `Road closure reported on ${changed.length} segment(s): ${changed.join(', ')}`
        : `Traffic now ${status} on ${changed.length} segment(s) (+${delay} min): ${changed.join(', ')}`,
      data: { segments: changed, status, delay },
    });
    return { closed: status === 'closed' ? changed : [], updated: changed };
  });
}
