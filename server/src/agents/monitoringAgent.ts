import { deliveries, orders, drivers, routes, type DeliveryRow, type OrderRow } from '../repo.js';
import { emitAgentEvent } from '../events.js';
import { roads } from '../repo.js';
import { calculateRoute, estimateDeliveryTime, type Point } from '../engine/routing.js';

const NAME = 'MonitoringAgent';
const DELAY_THRESHOLD_MIN = 3;
const DEVIATION_THRESHOLD = 2.5; // grid units from the planned path

export const monitoringTools = {
  get_driver_position: (driverId: string) => {
    const d = drivers.byId(driverId);
    return d && d.lat != null ? { lat: d.lat, lng: d.lng as number, at: d.location_at } : undefined;
  },
  get_order_status: (orderId: string) => orders.byId(orderId)?.status,
  get_current_route: (deliveryId: string) => routes.activeForDelivery(deliveryId),
  detect_delay: (delivery: DeliveryRow, projectedTotalMin: number, order: OrderRow) => {
    const deadlineMs = Date.parse(order.deadline_ts);
    const assignedMs = delivery.assigned_at ? Date.parse(delivery.assigned_at) : Date.now();
    const projectedDoneMs = Date.now() + (Number.isFinite(projectedTotalMin) ? projectedTotalMin * 60_000 : 9e12);
    const originalEta = delivery.estimated_delivery_minutes ?? projectedTotalMin;
    const elapsedMin = (Date.now() - assignedMs) / 60_000;
    const projectedFromStart = elapsedMin + projectedTotalMin;
    const slipMin = Math.round(projectedFromStart - originalEta);
    return {
      delayed: slipMin >= DELAY_THRESHOLD_MIN || projectedDoneMs > deadlineMs,
      slipMin,
      missesDeadline: projectedDoneMs > deadlineMs,
      projectedDoneTs: new Date(projectedDoneMs).toISOString(),
    };
  },
  detect_route_deviation: (pos: Point, path: Point[]) => {
    if (!path.length) return { deviating: false, distance: 0 };
    let min = Infinity;
    for (const p of path) {
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d < min) min = d;
    }
    return { deviating: min > DEVIATION_THRESHOLD, distance: Number(min.toFixed(2)) };
  },
  estimate_new_eta: (pos: Point, pickup: Point, dropoff: Point, phase: 'to_pickup' | 'to_dropoff') => {
    const segs = roads.segments();
    if (phase === 'to_dropoff') {
      const r = calculateRoute(pos, dropoff, segs);
      return { totalMinutes: r.etaMinutes, reachable: r.reachable };
    }
    const e = estimateDeliveryTime(pos, pickup, dropoff, segs);
    return { totalMinutes: e.totalMinutes, reachable: e.reachable };
  },
  /** Raise a remediation request for the Coordinator to act on. The Monitoring
   *  Agent detects and recommends; it never mutates the assignment itself. */
  trigger_reassignment: (deliveryId: string, orderId: string, reason: string, cycleId: string) => {
    emitAgentEvent({
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
  evaluateActiveDeliveries(cycleId: string): Finding[] {
    const active = deliveries.active().filter((d) => ['assigned', 'en_route_pickup', 'picked_up', 'en_route_drop'].includes(d.status));
    const findings: Finding[] = [];

    for (const delivery of active) {
      const order = orders.byId(delivery.order_id);
      if (!order || !delivery.driver_id) continue;
      const driver = drivers.byId(delivery.driver_id);
      const pos = driver && driver.lat != null ? { x: driver.lat, y: driver.lng as number } : null;
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
        emitAgentEvent({
          cycleId, agent: NAME, eventType: 'driver_unavailable', orderId: order.id, deliveryId: delivery.id, driverId: delivery.driver_id,
          message: `Driver ${delivery.driver_id} went offline mid-delivery for order ${order.id} — reassignment required`,
        });
        continue;
      }
      if (!pos) continue;

      const pickup: Point = { x: order.pickup_lat, y: order.pickup_lng };
      const dropoff: Point = { x: order.delivery_lat, y: order.delivery_lng };
      const newEta = monitoringTools.estimate_new_eta(pos, pickup, dropoff, phase);
      const delay = monitoringTools.detect_delay(delivery, newEta.totalMinutes, order);

      const route = monitoringTools.get_current_route(delivery.id);
      const path: Point[] = route ? (JSON.parse(route.path_json).toPickup ?? []).concat(JSON.parse(route.path_json).toDropoff ?? []) : [];
      const deviation = monitoringTools.detect_route_deviation(pos, path);

      if (!newEta.reachable) { issues.push('route_blocked'); trigger = 'reroute'; }
      if (delay.delayed) { issues.push(delay.missesDeadline ? 'deadline_at_risk' : 'delayed'); if (trigger === 'none') trigger = 'reroute'; }
      if (deviation.deviating) { issues.push('route_deviation'); if (trigger === 'none') trigger = 'reroute'; }

      // If a reroute still can't beat the deadline, escalate to reassignment.
      if (delay.missesDeadline && (issues.includes('route_blocked') || delay.slipMin > 20)) trigger = 'reassign';

      if (issues.length) {
        emitAgentEvent({
          cycleId, agent: NAME,
          eventType: delay.missesDeadline ? 'deadline_risk_detected' : 'delay_detected',
          orderId: order.id, deliveryId: delivery.id, driverId: delivery.driver_id,
          message: delay.delayed
            ? `Detected ${delay.slipMin}-minute delay on order ${order.id} (${issues.join(', ')}) — projected done ${new Date(delay.projectedDoneTs).toLocaleTimeString()}`
            : `Detected ${issues.join(', ')} on order ${order.id}`,
          data: { issues, projectedTotalMin: newEta.totalMinutes, slipMin: delay.slipMin, deviation: deviation.distance, recommendedTrigger: trigger },
        });
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
