import { deliveries, orders, drivers, routes, stores, type DeliveryRow, type OrderRow } from '../repo.js';
import { emitAgentEvent } from '../events.js';
import { calculateGeoRoute, estimateGeoDelivery } from '../engine/geoRouting.js';
import { distanceKm, type GeoPoint } from '../geo.js';
import { narrateRisk } from './llm.js';

const NAME = 'MonitoringAgent';
const DELAY_THRESHOLD_MIN = 3;
const DEVIATION_THRESHOLD_KM = 1.5; // distance from the planned OSRM geometry

export const monitoringTools = {
  get_driver_position: async (driverId: string) => {
    const d = await drivers.byId(driverId);
    return d && d.latitude != null ? { lat: d.latitude, lon: d.longitude as number, at: d.location_at } : undefined;
  },
  get_order_status: async (orderId: string) => (await orders.byId(orderId))?.status,
  get_current_route: (deliveryId: string) => routes.activeForDelivery(deliveryId),
  /** Compare the current OSRM projection with its baseline. Keeping this as a
   *  small pure helper makes deadline risk detectable even when no traffic
   *  provider is configured. */
  detect_delay: (delivery: DeliveryRow, projected: { totalMinutes: number; baselineMinutes: number }, order: OrderRow) => {
    const deadlineMs = Date.parse(order.deadline_ts);
    const projectedDoneMs = Date.now() + (Number.isFinite(projected.totalMinutes) ? projected.totalMinutes * 60_000 : 9e12);
    const slipMin = Number.isFinite(projected.totalMinutes)
      ? Math.round(projected.totalMinutes - projected.baselineMinutes)
      : 9999;
    void delivery;
    return {
      delayed: slipMin >= DELAY_THRESHOLD_MIN || projectedDoneMs > deadlineMs,
      slipMin,
      missesDeadline: projectedDoneMs > deadlineMs,
      projectedDoneTs: new Date(projectedDoneMs).toISOString(),
    };
  },
  detect_route_deviation: (pos: GeoPoint, path: GeoPoint[]) => {
    if (!path.length) return { deviating: false, distance: 0 };
    let min = Infinity;
    for (const p of path) {
      const d = distanceKm(p, pos);
      if (d < min) min = d;
    }
    return { deviating: min > DEVIATION_THRESHOLD_KM, distance: Number(min.toFixed(2)) };
  },
  estimate_new_eta: async (pos: GeoPoint, pickup: GeoPoint, dropoff: GeoPoint, phase: 'to_pickup' | 'to_dropoff') => {
    if (phase === 'to_dropoff') {
      const r = await calculateGeoRoute(pos, dropoff);
      return { totalMinutes: r.etaMinutes, baselineMinutes: r.etaMinutes, reachable: r.reachable };
    }
    const e = await estimateGeoDelivery(pos, pickup, dropoff);
    return { totalMinutes: e.totalMinutes, baselineMinutes: e.totalMinutes, reachable: e.reachable };
  },
  /** Raise a remediation request for the Coordinator to act on. The Monitoring
   *  Agent detects and recommends; it never mutates the assignment itself. */
  trigger_reassignment: async (deliveryId: string, orderId: string, reason: string, cycleId: string) => {
    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'reassignment_requested', orderId, deliveryId,
      message: `Monitoring Agent is requesting reassignment for order ${orderId}: ${reason}`,
      data: { reason },
    });
    return { deliveryId, orderId, reason, recommendedTrigger: 'reassign' as const };
  },
};

export type Trigger = 'none' | 'reroute' | 'reassign';

export interface Finding {
  deliveryId: string;
  orderId: string;
  driverId: string | null;
  phase: 'to_pickup' | 'to_dropoff';
  issues: string[];
  projectedTotalMin: number;
  slipMin: number;
  missesDeadline: boolean;
  deviationDistance: number;
  recommendedTrigger: Trigger;
}

export const monitoringAgent = {
  name: NAME,
  tools: monitoringTools,

  /** Continuously evaluate every active delivery. Returns findings + a
   *  recommended remediation trigger for the Coordinator to act on. */
  async evaluateActiveDeliveries(cycleId: string): Promise<Finding[]> {
    const active = (await deliveries.active()).filter((d) => ['assigned', 'en_route_pickup', 'picked_up', 'en_route_drop'].includes(d.status));
    const findings: Finding[] = [];

    for (const delivery of active) {
      const order = await orders.byId(delivery.order_id);
      if (!order || !delivery.driver_id) continue;
      const driver = await drivers.byId(delivery.driver_id);
      const pos = driver && driver.latitude != null ? { lat: driver.latitude, lon: driver.longitude as number } : null;
      const phase: Finding['phase'] = ['picked_up', 'en_route_drop'].includes(delivery.status) ? 'to_dropoff' : 'to_pickup';
      const issues: string[] = [];
      let trigger: Trigger = 'none';

      if (!driver || driver.status === 'offline') {
        issues.push('driver_unavailable');
        trigger = 'reassign';
        findings.push({
          deliveryId: delivery.id, orderId: order.id, driverId: delivery.driver_id, phase,
          issues, projectedTotalMin: Infinity, slipMin: 9999, missesDeadline: true, deviationDistance: 0,
          recommendedTrigger: trigger,
        });
        await emitAgentEvent({
          cycleId, agent: NAME, eventType: 'driver_unavailable', orderId: order.id, deliveryId: delivery.id, driverId: delivery.driver_id,
          message: `Driver ${delivery.driver_id} went offline mid-delivery for order ${order.id} — reassignment required`,
        });
        continue;
      }
      if (!pos) continue;

      const pickup: GeoPoint = { lat: order.pickup_latitude, lon: order.pickup_longitude };
      const dropoff: GeoPoint = { lat: order.delivery_latitude, lon: order.delivery_longitude };
      const store = await stores.byId(order.store_id);
      if (!store) continue;
      const newEta = await monitoringTools.estimate_new_eta(
        pos, { lat: store.latitude, lon: store.longitude }, dropoff, phase,
      );
      const delay = monitoringTools.detect_delay(delivery, newEta, order);

      const route = await monitoringTools.get_current_route(delivery.id);
      const rp = route?.path_json ?? {};
      const path: GeoPoint[] = [...(rp.toPickup ?? []), ...(rp.toDropoff ?? [])];
      const deviation = monitoringTools.detect_route_deviation(pos, path);

      if (!newEta.reachable) { issues.push('route_blocked'); trigger = 'reroute'; }
      if (delay.delayed) { issues.push(delay.missesDeadline ? 'deadline_at_risk' : 'delayed'); if (trigger === 'none') trigger = 'reroute'; }
      if (deviation.deviating) { issues.push('route_deviation'); if (trigger === 'none') trigger = 'reroute'; }

      // If a reroute still can't beat the deadline, escalate to reassignment.
      if (delay.missesDeadline && (issues.includes('route_blocked') || delay.slipMin > 20)) trigger = 'reassign';

      if (issues.length) {
        const orderCode = `#${order.id.replace(/^ord_/, '').slice(-6).toUpperCase()}`;
        const severity: 'info' | 'warn' | 'critical' = delay.missesDeadline ? 'critical' : delay.slipMin >= 10 ? 'warn' : 'info';
        await emitAgentEvent({
          cycleId, agent: NAME,
          eventType: delay.missesDeadline ? 'deadline_risk_detected' : 'delay_detected',
          orderId: order.id, deliveryId: delivery.id, driverId: delivery.driver_id,
          message: delay.delayed
            ? `${driver.name} is ${delay.slipMin} min behind on ${orderCode} (${issues.join(', ')}) — projected arrival ${new Date(delay.projectedDoneTs).toLocaleTimeString()}`
            : `${issues.join(', ')} on ${orderCode} (${driver.name})`,
          data: {
            issues, projectedTotalMin: newEta.totalMinutes, slipMin: delay.slipMin, deviation: deviation.distance,
            recommendedTrigger: trigger, severity,
          },
        });
        // LLM adds a plain-language read of the risk as a follow-up (non-blocking).
        void narrateRisk({
          orderCode, driver: driver.name, issues, slipMin: delay.slipMin,
          missesDeadline: delay.missesDeadline,
          projectedDoneLocal: new Date(delay.projectedDoneTs).toLocaleTimeString(),
        }).then(async (n) => {
          if (n.source === 'llm') {
            await emitAgentEvent({
              cycleId, agent: NAME, eventType: 'risk_assessed', orderId: order.id, deliveryId: delivery.id, driverId: delivery.driver_id,
              message: n.message, data: { severity: n.severity, source: 'llm' },
            });
          }
        }).catch(() => undefined);
        findings.push({
          deliveryId: delivery.id, orderId: order.id, driverId: delivery.driver_id, phase,
          issues, projectedTotalMin: newEta.totalMinutes, slipMin: delay.slipMin,
          missesDeadline: delay.missesDeadline, deviationDistance: deviation.distance, recommendedTrigger: trigger,
        });
      }
    }

    return findings;
  },
};
