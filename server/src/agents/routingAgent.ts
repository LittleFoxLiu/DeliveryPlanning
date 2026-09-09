import { roads, traffic, stores, type OrderRow, type DeliveryRow } from '../repo.js';
import { emitAgentEvent } from '../events.js';
import {
  calculateRoute, calculateEta, calculateDistance, estimateDeliveryTime, compareRoutes,
  type Point, type RouteResult, type DeliveryEstimate, type Segment,
} from '../engine/routing.js';
import type { Candidate } from './driverAgent.js';
import { estimateGeoDelivery } from '../engine/geoRouting.js';

const NAME = 'RoutingAgent';

export const routingTools = {
  calculate_route: async (from: Point, to: Point) => calculateRoute(from, to, await roads.segments()),
  calculate_eta: async (from: Point, to: Point) => calculateEta(from, to, await roads.segments()),
  calculate_distance: async (from: Point, to: Point) => calculateDistance(from, to, await roads.segments()),
  check_traffic: async () => {
    const segs = await roads.all();
    return {
      closed: segs.filter((s) => s.status === 'closed').map((s) => s.id),
      heavy: segs.filter((s) => s.status === 'heavy').map((s) => s.id),
      moderate: segs.filter((s) => s.status === 'moderate').map((s) => s.id),
    };
  },
  /** Full traffic picture: per-segment incidents + area-level conditions. */
  get_traffic_conditions: async () => {
    const [segs, areas] = await Promise.all([roads.all(), traffic.all()]);
    const incidents = segs.filter((s) => s.status !== 'clear')
      .map((s) => ({ segmentId: s.id, status: s.status, delayMinutes: s.delay_minutes }));
    return {
      incidents,
      areas: areas.map((a) => ({ area: a.area, status: a.status, delayMinutes: a.delay_minutes, source: a.source })),
      summary: { closed: incidents.filter((i) => i.status === 'closed').length, heavy: incidents.filter((i) => i.status === 'heavy').length, moderate: incidents.filter((i) => i.status === 'moderate').length },
    };
  },
  estimate_delivery_time: async (driverLoc: Point, pickup: Point, dropoff: Point) =>
    estimateDeliveryTime(driverLoc, pickup, dropoff, await roads.segments()),
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
  async computeCandidateRoutes(order: OrderRow, candidates: Candidate[], cycleId: string, quiet = false): Promise<RoutedCandidate[]> {
    const segs: Segment[] = await roads.segments();
    const pickup: Point = { x: order.pickup_lat, y: order.pickup_lng };
    const dropoff: Point = { x: order.delivery_lat, y: order.delivery_lng };
    const store = await stores.byId(order.store_id);
    const routed = await Promise.all(candidates.map(async (candidate) => ({
      candidate,
      estimate: candidate.driver.geo_lat != null && candidate.driver.geo_lng != null && store?.geo_lat != null && store.geo_lng != null && order.delivery_geo_lat != null && order.delivery_geo_lng != null
        ? await estimateGeoDelivery({ lat: candidate.driver.geo_lat, lon: candidate.driver.geo_lng }, { lat: store.geo_lat, lon: store.geo_lng }, { lat: order.delivery_geo_lat, lon: order.delivery_geo_lng })
        : estimateDeliveryTime({ x: candidate.location.lat, y: candidate.location.lng }, pickup, dropoff, segs),
    })));

    const comparison = compareRoutes(
      routed.filter((r) => r.estimate.reachable).map((r) => ({
        label: r.candidate.driver.name,
        result: { ...r.estimate.toPickup, etaMinutes: r.estimate.totalMinutes } as RouteResult,
      })),
    );

    if (!quiet) await emitAgentEvent({
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
  async recalculate(
    delivery: DeliveryRow, order: OrderRow, currentPos: Point, phase: 'to_pickup' | 'to_dropoff', cycleId: string,
  ): Promise<{ ok: boolean; route?: RouteResult; etaMinutes: number; reason?: string }> {
    const segs = await roads.segments();
    const target: Point = phase === 'to_pickup'
      ? { x: order.pickup_lat, y: order.pickup_lng }
      : { x: order.delivery_lat, y: order.delivery_lng };
    const route = calculateRoute(currentPos, target, segs);
    let etaMinutes = route.etaMinutes;
    if (phase === 'to_pickup') {
      const leg2 = calculateRoute({ x: order.pickup_lat, y: order.pickup_lng }, { x: order.delivery_lat, y: order.delivery_lng }, segs);
      etaMinutes = route.reachable && leg2.reachable ? Number((route.etaMinutes + 3 + leg2.etaMinutes).toFixed(1)) : Infinity;
    }

    if (!route.reachable) {
      await emitAgentEvent({
        cycleId, agent: NAME, eventType: 'reroute_failed', orderId: order.id, deliveryId: delivery.id,
        message: `No viable route from driver position to ${phase === 'to_pickup' ? 'pickup' : 'customer'} — road closure blocks all paths`,
        data: { blockedSegments: route.blockedSegments },
      });
      return { ok: false, etaMinutes: Infinity, reason: 'no_viable_route' };
    }

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'route_recalculated', orderId: order.id, deliveryId: delivery.id,
      message: `Alternative route found — new ETA ${Number.isFinite(etaMinutes) ? `${etaMinutes} min` : 'n/a'}, `
        + `${route.trafficPenaltyMinutes} min traffic penalty`,
      data: { distanceKm: route.distanceKm, etaMinutes, trafficPenaltyMinutes: route.trafficPenaltyMinutes, path: route.path },
    });
    return { ok: true, route, etaMinutes };
  },
};
