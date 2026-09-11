import { tx } from './db.js';
import { deliveries, orders, drivers, routes, stores, type DeliveryRow } from './repo.js';
import { emitAgentEvent } from './events.js';
import { nowIso, conflict } from './util.js';
import { coordinator } from './agents/coordinator.js';
import { distanceKm, type GeoPoint } from './geo.js';

type DriverAction = 'accept' | 'picked_up' | 'delivered';

/** Driver-reported progress. Waypoint coordinates are the persisted Nominatim
 * locations and are never converted to another coordinate system. */
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
      await drivers.recordLocation(driverId, order.pickup_latitude, order.pickup_longitude, store?.address);
      await deliveries.setStatus(deliveryId, 'picked_up', ['en_route_pickup', 'assigned']);
      await deliveries.update(deliveryId, { pickup_at: nowIso() });
      try { await orders.setStatus(order.id, 'picked_up', ['assigned', 'dispatching']); } catch { /* keep */ }
      await emitAgentEvent({ agent: 'Driver', eventType: 'package_picked_up', orderId: order.id, deliveryId, driverId, message: `Driver ${driverId} picked up order ${order.id} at the merchant (${order.pickup_latitude}, ${order.pickup_longitude})` });
    } else {
      await drivers.recordLocation(driverId, order.delivery_latitude, order.delivery_longitude, order.delivery_address);
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

export interface TickResult {
  moved: { deliveryId: string; driverId: string; from: GeoPoint; to: GeoPoint; arrived?: string }[];
  monitoring: Awaited<ReturnType<typeof coordinator.runMonitoringCycle>>;
}

/** Demo simulator: advance each driver along the stored OSRM geometry by a
 * small number of geometry points, then run the monitoring cycle. */
export async function simulateTick(opts: { monitor?: boolean } = {}): Promise<TickResult> {
  const moved: TickResult['moved'] = [];
  const active = (await deliveries.active()).filter((d) => ['assigned', 'en_route_pickup', 'picked_up', 'en_route_drop'].includes(d.status));

  for (const delivery of active) {
    if (!delivery.driver_id) continue;
    const route = await routes.activeForDelivery(delivery.id);
    const driver = await drivers.byId(delivery.driver_id);
    const order = await orders.byId(delivery.order_id);
    if (!route || !driver || driver.latitude == null || driver.longitude == null || driver.status === 'offline' || !order) continue;

    const from: GeoPoint = { lat: driver.latitude, lon: driver.longitude };
    const phasePickup = ['assigned', 'en_route_pickup'].includes(delivery.status);
    const path = (phasePickup ? route.path_json.toPickup : route.path_json.toDropoff) ?? [];
    if (path.length === 0) continue;

    let nearest = 0;
    let best = Infinity;
    path.forEach((point, index) => {
      const d = distanceKm(point, from);
      if (d <= best) { best = d; nearest = index; }
    });
    const step = Math.max(1, Math.ceil(path.length / 8));
    const nextIndex = Math.min(nearest + step, path.length - 1);
    let to = path[nextIndex];
    const target = phasePickup
      ? { lat: order.pickup_latitude, lon: order.pickup_longitude }
      : { lat: order.delivery_latitude, lon: order.delivery_longitude };
    const arrived = nextIndex === path.length - 1;
    if (arrived) to = target;

    // A simulated intermediate waypoint is OSRM geometry, not a Nominatim
    // address. Clear the address so the UI cannot display the previous
    // geocoded location beside a new coordinate.
    const address = arrived
      ? phasePickup ? (await stores.byId(order.store_id))?.address : order.delivery_address
      : null;
    await drivers.recordLocation(delivery.driver_id, to.lat, to.lon, address);
    const record: TickResult['moved'][number] = { deliveryId: delivery.id, driverId: delivery.driver_id, from, to };
    if (arrived && phasePickup) {
      try {
        if (delivery.status === 'assigned') await driverProgress(delivery.id, delivery.driver_id, 'accept');
        if ((await deliveries.byId(delivery.id))?.status === 'en_route_pickup') await driverProgress(delivery.id, delivery.driver_id, 'picked_up');
        record.arrived = 'pickup';
      } catch { /* ignore transition races */ }
    } else if (arrived) {
      try { await driverProgress(delivery.id, delivery.driver_id, 'delivered'); record.arrived = 'dropoff'; } catch { /* ignore transition races */ }
    } else if (phasePickup && delivery.status === 'assigned') {
      try { await driverProgress(delivery.id, delivery.driver_id, 'accept'); } catch { /* ignore transition races */ }
    }
    moved.push(record);
  }

  const monitoring = opts.monitor === false
    ? { cycleId: '', findings: [], actions: [] }
    : await coordinator.runMonitoringCycle();
  return { moved, monitoring };
}
