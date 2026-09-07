import { roads, type OrderRow, type DeliveryRow } from '../repo.js';
import { emitAgentEvent } from '../events.js';
import {
  calculateRoute, calculateEta, calculateDistance, estimateDeliveryTime, compareRoutes,
  type Point, type RouteResult, type DeliveryEstimate,
} from '../engine/routing.js';
import type { Candidate } from './driverAgent.js';

const NAME = 'RoutingAgent';

export const routingTools = {
  calculate_route: (from: Point, to: Point) => calculateRoute(from, to, roads.segments()),
  calculate_eta: (from: Point, to: Point) => calculateEta(from, to, roads.segments()),
  calculate_distance: (from: Point, to: Point) => calculateDistance(from, to, roads.segments()),
  check_traffic: () => {
    const segs = roads.all();
    return {
      closed: segs.filter((s) => s.status === 'closed').map((s) => s.id),
      heavy: segs.filter((s) => s.status === 'heavy').map((s) => s.id),
      moderate: segs.filter((s) => s.status === 'moderate').map((s) => s.id),
    };
  },
  estimate_delivery_time: (driverLoc: Point, pickup: Point, dropoff: Point) =>
    estimateDeliveryTime(driverLoc, pickup, dropoff, roads.segments()),
  compare_routes: (named: { label: string; result: RouteResult }[]) => compareRoutes(named),
};

export interface RoutedCandidate {
  candidate: Candidate;
  estimate: DeliveryEstimate;
}

export const routingAgent = {
  name: NAME,
  tools: routingTools,

  /** Calculate the authoritative driver → pickup → customer route + ETA for
   *  every candidate. Traffic and closed roads are baked into the grid costs. */
  computeCandidateRoutes(order: OrderRow, candidates: Candidate[], cycleId: string): RoutedCandidate[] {
    const pickup: Point = { x: order.pickup_lat, y: order.pickup_lng };
    const dropoff: Point = { x: order.delivery_lat, y: order.delivery_lng };
    const routed = candidates.map((candidate) => ({
      candidate,
      estimate: routingTools.estimate_delivery_time({ x: candidate.location.lat, y: candidate.location.lng }, pickup, dropoff),
    }));

    const comparison = routingTools.compare_routes(
      routed.filter((r) => r.estimate.reachable).map((r) => ({
        label: r.candidate.driver.name,
        result: { ...r.estimate.toPickup, etaMinutes: r.estimate.totalMinutes } as RouteResult,
      })),
    );

    emitAgentEvent({
      cycleId, agent: NAME, eventType: 'routes_calculated', orderId: order.id,
      message: `Calculated ${routed.length} candidate route${routed.length === 1 ? '' : 's'} for order ${order.id}`,
      data: {
        routes: routed.map((r) => ({
          driverId: r.candidate.driver.id,
          driver: r.candidate.driver.name,
          etaToMerchantMin: r.estimate.reachable ? r.estimate.toPickup.etaMinutes : null,
          etaToCustomerMin: r.estimate.reachable ? r.estimate.toDropoff.etaMinutes : null,
          totalMin: r.estimate.reachable ? r.estimate.totalMinutes : null,
          distanceKm: r.estimate.totalDistanceKm,
          trafficPenaltyMin: r.estimate.reachable
            ? Number((r.estimate.toPickup.trafficPenaltyMinutes + r.estimate.toDropoff.trafficPenaltyMinutes).toFixed(1))
            : null,
          reachable: r.estimate.reachable,
        })),
        fastestByEta: comparison.best,
      },
    });
    return routed;
  },

  /** Recalculate a route for an in-flight delivery from the driver's current
   *  position. Returns the new route or a "no viable route" signal. */
  recalculate(
    delivery: DeliveryRow, order: OrderRow, currentPos: Point, phase: 'to_pickup' | 'to_dropoff', cycleId: string,
  ): { ok: boolean; route?: RouteResult; etaMinutes: number; reason?: string } {
    const target: Point = phase === 'to_pickup'
      ? { x: order.pickup_lat, y: order.pickup_lng }
      : { x: order.delivery_lat, y: order.delivery_lng };
    const route = routingTools.calculate_route(currentPos, target);
    let etaMinutes = route.etaMinutes;
    if (phase === 'to_pickup') {
      const leg2 = routingTools.calculate_route(
        { x: order.pickup_lat, y: order.pickup_lng }, { x: order.delivery_lat, y: order.delivery_lng });
      etaMinutes = route.reachable && leg2.reachable ? Number((route.etaMinutes + 3 + leg2.etaMinutes).toFixed(1)) : Infinity;
    }

    if (!route.reachable) {
      emitAgentEvent({
        cycleId, agent: NAME, eventType: 'reroute_failed', orderId: order.id, deliveryId: delivery.id,
        message: `No viable route from driver position to ${phase === 'to_pickup' ? 'pickup' : 'customer'} — road closure blocks all paths`,
        data: { blockedSegments: route.blockedSegments },
      });
      return { ok: false, etaMinutes: Infinity, reason: 'no_viable_route' };
    }

    emitAgentEvent({
      cycleId, agent: NAME, eventType: 'route_recalculated', orderId: order.id, deliveryId: delivery.id,
      message: `Alternative route found — new ETA ${Number.isFinite(etaMinutes) ? `${etaMinutes} min` : 'n/a'}, `
        + `${route.trafficPenaltyMinutes} min traffic penalty`,
      data: { distanceKm: route.distanceKm, etaMinutes, trafficPenaltyMinutes: route.trafficPenaltyMinutes, path: route.path },
    });
    return { ok: true, route, etaMinutes };
  },
};
