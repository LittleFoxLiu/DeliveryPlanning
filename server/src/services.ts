import { tx } from './db.js';
import { deliveries, orders, drivers, routes, roads, stores, type DeliveryRow } from './repo.js';
import { emitAgentEvent } from './events.js';
import { nowIso, conflict, badRequest } from './util.js';
import { coordinator } from './agents/coordinator.js';
import { calculateRoute, type Point } from './engine/routing.js';

type DriverAction = 'accept' | 'picked_up' | 'delivered';

/** Driver-reported progress. Deterministic state transitions with ownership
 *  already checked by the route handler. Confirming pickup / delivery also
 *  moves the driver onto that waypoint (they can only be there to do it). */
export function driverProgress(deliveryId: string, driverId: string, action: DriverAction): Promise<DeliveryRow> {
  return tx(async () => {
    const delivery = await deliveries.byId(deliveryId);
    if (!delivery) throw conflict('delivery not found');
    if (delivery.driver_id !== driverId) throw conflict('not your delivery');
    const order = (await orders.byId(delivery.order_id))!;

    if (action === 'accept') {
      await deliveries.setStatus(deliveryId, 'en_route_pickup', 'assigned');
      await emitAgentEvent({ agent: 'Driver', eventType: 'delivery_accepted', orderId: order.id, deliveryId, driverId, message: `Driver ${driverId} accepted the delivery for order ${order.id}` });
    } else if (action === 'picked_up') {
      const store = await stores.byId(order.store_id);
      await drivers.recordLocation(driverId, order.pickup_lat, order.pickup_lng, store?.address, store?.geo_lat, store?.geo_lng);
      await deliveries.setStatus(deliveryId, 'picked_up', ['en_route_pickup', 'assigned']);
      await deliveries.update(deliveryId, { pickup_at: nowIso() });
      try { await orders.setStatus(order.id, 'picked_up', ['assigned', 'dispatching']); } catch { /* keep */ }
      await emitAgentEvent({ agent: 'Driver', eventType: 'package_picked_up', orderId: order.id, deliveryId, driverId, message: `Driver ${driverId} picked up order ${order.id} at the merchant (${order.pickup_lat}, ${order.pickup_lng})` });
    } else {
      await drivers.recordLocation(driverId, order.delivery_lat, order.delivery_lng, order.delivery_address, order.delivery_geo_lat, order.delivery_geo_lng);
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

/** Simulator: advance every in-flight driver a step or two along their
 *  deterministic grid route (which respects traffic / closures), then run one
 *  monitoring cycle. The map shows the projected real-world position;
 *  `monitor: false` skips the monitoring/remediation pass. */
export async function simulateTick(opts: { monitor?: boolean } = {}): Promise<TickResult> {
  const moved: TickResult['moved'] = [];

  const active = (await deliveries.active()).filter((d) => ['assigned', 'en_route_pickup', 'picked_up', 'en_route_drop'].includes(d.status));
  const segs = await roads.segments();
  for (const delivery of active) {
    if (!delivery.driver_id) continue;
    const route = await routes.activeForDelivery(delivery.id);
    if (!route) continue;
    const driver = await drivers.byId(delivery.driver_id);
    if (!driver || driver.status === 'offline' || driver.lat == null) continue;
    const order = await orders.byId(delivery.order_id);
    if (!order) continue;

    const phasePickup = ['assigned', 'en_route_pickup'].includes(delivery.status);
    const pos: Point = { x: driver.lat, y: driver.lng as number };
    const target: Point = phasePickup
      ? { x: order.pickup_lat, y: order.pickup_lng }
      : { x: order.delivery_lat, y: order.delivery_lng };

    // Grid Dijkstra picks the route around any closures; move ~2 cells per tick.
    const path = calculateRoute(pos, target, segs).path;
    const atTarget = path.length <= 2 || (Math.abs(pos.x - target.x) + Math.abs(pos.y - target.y)) <= 1;
    const next: Point = atTarget ? target : (path[Math.min(2, path.length - 1)] ?? target);

    await drivers.recordLocation(delivery.driver_id, next.x, next.y);
    const record: TickResult['moved'][number] = { deliveryId: delivery.id, driverId: delivery.driver_id, from: pos, to: next };
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

  const monitoring = opts.monitor === false
    ? { cycleId: '', findings: [], actions: [] }
    : await coordinator.runMonitoringCycle();
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
  /** minor: slow one segment (recoverable → reroute). major: close it + choke
   *  the surrounding block (usually blows the deadline → reassignment). */
  severity?: 'minor' | 'major';
}): Promise<TrafficChange> {
  // With no explicit target, create a small reproducible demo incident rather
  // than touching the whole network. This makes the traffic feature useful
  // from a console/API smoke test as well as from the active-route button.
  const status = input.status ?? (input.severity ? 'closed' : 'heavy');
  const delay = input.delayMinutes ?? (status === 'heavy' ? 12 : status === 'moderate' ? 5 : 0);
  const changed: string[] = [];

  return tx(async () => {
    let segmentIds = input.segments ?? [];

    if (!input.blockRouteOf && segmentIds.length === 0) {
      const candidates = (await roads.all()).filter((road) => road.status !== 'closed');
      segmentIds = candidates.sort(() => Math.random() - 0.5).slice(0, Math.min(3, candidates.length)).map((road) => road.id);
    }

    if (input.blockRouteOf) {
      const order = await orders.byId(input.blockRouteOf);
      if (!order) throw badRequest('order not found for blockRouteOf');
      const delivery = await deliveries.byOrderId(order.id);
      if (!delivery) throw badRequest('order has no active delivery');
      const route = await routes.activeForDelivery(delivery.id);
      if (!route) throw badRequest('delivery has no active route');
      const driver = delivery.driver_id ? await drivers.byId(delivery.driver_id) : undefined;
      const phasePickup = ['assigned', 'en_route_pickup'].includes(delivery.status);
      const target: Point = phasePickup
        ? { x: order.pickup_lat, y: order.pickup_lng }
        : { x: order.delivery_lat, y: order.delivery_lng };
      const gridPos: Point = driver && driver.lat != null
        ? { x: driver.lat, y: driver.lng as number }
        : { x: route.origin_lat as number, y: route.origin_lng as number };

      // Block a real road segment 1–2 cells ahead on the grid route the driver
      // is actually following, so the closure is unavoidably on their path.
      const segs = await roads.segments();
      const path = calculateRoute(gridPos, target, segs).path;
      const idx = 0;
      for (let k = 0; k < path.length - 1 && segmentIds.length === 0; k++) {
        if (path[k].x === path[k + 1].x && path[k].y === path[k + 1].y) continue;
        const rid = await findRoadId(path[k], path[k + 1]);
        if (rid) segmentIds = [rid];
      }
      if (segmentIds.length === 0) throw badRequest('could not locate a blockable segment on the remaining route');

      const primary = (await roads.byId(segmentIds[0]))!;
      const severity = input.severity ?? 'major';
      if (severity === 'minor') {
        // slow a few consecutive segments on the route so the delay is real but
        // a detour still beats the deadline
        for (let k = idx + 1; k < Math.min(idx + 4, path.length); k++) {
          const rid = await findRoadId(path[k - 1], path[k]);
          if (rid && !changed.includes(rid)) { await roads.setStatus(rid, 'heavy', 10); changed.push(rid); }
        }
        if (!changed.length) { await roads.setStatus(primary.id, 'heavy', 10); changed.push(primary.id); }
        await emitAgentEvent({
          agent: 'TrafficFeed', eventType: 'traffic_updated',
          message: `Heavy traffic building on the active route near ${primary.id} (+10 min) — a recoverable delay`,
          data: { segments: changed, status: 'heavy', incidentType: 'congestion' },
        });
        return { closed: [], updated: changed };
      }
      await roads.setStatus(primary.id, 'closed', 0);
      changed.push(primary.id);
      // Gridlock the surrounding block (~2 cells) so the driver can't just nip
      // around it — a sustained delay the Monitoring Agent will keep seeing.
      const cx = (primary.ax + primary.bx) / 2;
      const cy = (primary.ay + primary.by) / 2;
      for (const r of await roads.all()) {
        if (r.id === primary.id || r.status === 'closed') continue;
        const near = Math.hypot((r.ax + r.bx) / 2 - cx, (r.ay + r.by) / 2 - cy);
        if (near <= 2.6) { await roads.setStatus(r.id, 'heavy', 18); changed.push(r.id); }
      }
      await emitAgentEvent({
        agent: 'TrafficFeed', eventType: 'traffic_updated',
        message: `Traffic incident on ${primary.id} — road closed and surrounding streets heavily congested (+15 min)`,
        data: { segments: changed, closed: [primary.id], incidentType: 'accident' },
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
