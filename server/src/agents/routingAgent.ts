import { drivers, stores, type OrderRow, type DeliveryRow } from '../repo.js';
import { emitAgentEvent } from '../events.js';
import {
  calculateGeoRoute, calculateGeoEta, calculateGeoDistance, estimateGeoDelivery, compareGeoRoutes,
  type GeoRoute, type DeliveryEstimate,
} from '../engine/geoRouting.js';
import type { GeoPoint } from '../geo.js';
import type { Candidate } from './driverAgent.js';

const NAME = 'RoutingAgent';

/** Runtime instructions for the routing agent. Every address is selected and
 * stored from Nominatim; every drivable path, distance, and ETA comes from
 * OSRM. No synthetic coordinates or local road graph are valid inputs. */
export const ROUTING_AGENT_PROMPT = [
  'Use Nominatim-selected Singapore addresses as the only location source.',
  'Use OSRM driving routes as the only authority for route geometry, distance, and duration.',
  'Keep coordinates in latitude/longitude order for storage and Leaflet; use longitude,latitude only in OSRM URLs.',
  'Never fabricate coordinates or alter the geocoder and router outputs.',
].join(' ');

export const routingTools = {
  calculate_route: (from: GeoPoint, to: GeoPoint) => calculateGeoRoute(from, to),
  calculate_eta: (from: GeoPoint, to: GeoPoint) => calculateGeoEta(from, to),
  calculate_distance: (from: GeoPoint, to: GeoPoint) => calculateGeoDistance(from, to),
  estimate_delivery_time: (driver: GeoPoint, pickup: GeoPoint, dropoff: GeoPoint) => estimateGeoDelivery(driver, pickup, dropoff),
  compare_routes: (named: { label: string; result: GeoRoute }[]) => compareGeoRoutes(named),
};

export interface RoutedCandidate {
  candidate: Candidate;
  estimate: DeliveryEstimate;
}

const missingEstimate = (): DeliveryEstimate => ({
  toPickup: { path: [], distanceKm: 0, etaMinutes: Infinity, reachable: false },
  toDropoff: { path: [], distanceKm: 0, etaMinutes: Infinity, reachable: false },
  handlingMinutes: 3, totalMinutes: Infinity, totalDistanceKm: Infinity, reachable: false,
});

export const routingAgent = {
  name: NAME,
  prompt: ROUTING_AGENT_PROMPT,
  tools: routingTools,

  /** Calculate the authoritative driver → pickup → customer route + ETA for
   * every candidate from their stored Nominatim location. */
  async computeCandidateRoutes(order: OrderRow, candidates: Candidate[], cycleId: string, quiet = false): Promise<RoutedCandidate[]> {
    const store = await stores.byId(order.store_id);
    const routed = await Promise.all(candidates.map(async (candidate) => ({
      candidate,
      estimate: candidate.driver.latitude != null && store
        ? await estimateGeoDelivery(
          { lat: candidate.driver.latitude, lon: candidate.driver.longitude! },
          { lat: store.latitude, lon: store.longitude },
          { lat: order.delivery_latitude, lon: order.delivery_longitude },
        )
        : missingEstimate(),
    })));
    const comparison = compareGeoRoutes(
      routed.filter((r) => r.estimate.reachable).map((r) => ({ label: r.candidate.driver.name, result: r.estimate.toDropoff })),
    );

    if (!quiet) await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'routes_calculated', orderId: order.id,
      message: `Calculated ${routed.length} OSRM route${routed.length === 1 ? '' : 's'} for order ${order.id}`,
      data: {
        provider: 'OSRM', source: 'Nominatim locations',
        routes: routed.map((r) => ({
          driverId: r.candidate.driver.id,
          driver: r.candidate.driver.name,
          etaToMerchantMin: r.estimate.reachable ? r.estimate.toPickup.etaMinutes : null,
          etaToCustomerMin: r.estimate.reachable ? r.estimate.toDropoff.etaMinutes : null,
          totalMin: r.estimate.reachable ? r.estimate.totalMinutes : null,
          distanceKm: r.estimate.totalDistanceKm,
          reachable: r.estimate.reachable,
        })),
        fastestByEta: comparison[0] ?? null,
      },
    });
    return routed;
  },

  /** Recalculate from the driver's current stored geographic position. */
  async recalculate(
    delivery: DeliveryRow, order: OrderRow, currentPos: GeoPoint, phase: 'to_pickup' | 'to_dropoff', cycleId: string,
  ): Promise<{ ok: boolean; route?: GeoRoute; dropoffRoute?: GeoRoute; etaMinutes: number; reason?: string }> {
    if (!delivery.driver_id) return { ok: false, etaMinutes: Infinity, reason: 'driver_unavailable' };
    const [driver, store] = await Promise.all([drivers.byId(delivery.driver_id), stores.byId(order.store_id)]);
    if (!store) return { ok: false, etaMinutes: Infinity, reason: 'store_unavailable' };
    const geoDriver = driver?.latitude != null && driver.longitude != null ? { lat: driver.latitude, lon: driver.longitude } : currentPos;
    const geoPickup = { lat: store.latitude, lon: store.longitude };
    const geoDropoff = { lat: order.delivery_latitude, lon: order.delivery_longitude };
    const route = phase === 'to_pickup'
      ? await calculateGeoRoute(geoDriver, geoPickup)
      : await calculateGeoRoute(geoDriver, geoDropoff);
    const dropoffRoute = phase === 'to_pickup' ? await calculateGeoRoute(geoPickup, geoDropoff) : undefined;
    let etaMinutes = route.etaMinutes;
    if (phase === 'to_pickup') {
      etaMinutes = route.reachable && dropoffRoute?.reachable
        ? Number((route.etaMinutes + 3 + dropoffRoute.etaMinutes).toFixed(1)) : Infinity;
    }

    if (!route.reachable || (phase === 'to_pickup' && !dropoffRoute?.reachable)) {
      await emitAgentEvent({
        cycleId, agent: NAME, eventType: 'reroute_failed', orderId: order.id, deliveryId: delivery.id,
        message: `OSRM found no drivable route from the current position to the ${phase === 'to_pickup' ? 'pickup' : 'customer'}`,
      });
      return { ok: false, etaMinutes: Infinity, reason: 'no_viable_route' };
    }

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'route_recalculated', orderId: order.id, deliveryId: delivery.id,
      message: `OSRM recalculated the route — ETA ${Number.isFinite(etaMinutes) ? `${etaMinutes} min` : 'n/a'}`,
      data: { provider: 'OSRM', distanceKm: route.distanceKm, etaMinutes, path: route.path },
    });
    return { ok: true, route, dropoffRoute, etaMinutes };
  },
};
