import type { DeliveryEstimate, RouteResult } from './routing.js';

const routingUrl = (process.env.ROUTING_URL || 'https://router.project-osrm.org/route/v1/driving').replace(/\/$/, '');
export interface GeoPoint { lat: number; lon: number }

export async function calculateGeoRoute(from: GeoPoint, to: GeoPoint): Promise<RouteResult> {
  // Ask for alternatives so the driver route is selected by distance rather
  // than the default fastest/traffic-weighted route.
  const response = await fetch(`${routingUrl}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&alternatives=true&geometries=geojson`);
  if (!response.ok) throw new Error('OSRM routing service unavailable');
  const data = await response.json() as { routes?: Array<{ distance: number; duration: number; geometry: { coordinates: [number, number][] } }> };
  const r = data.routes?.slice().sort((a, b) => a.distance - b.distance)[0];
  if (!r) return { path: [], distanceKm: 0, etaMinutes: Infinity, baselineMinutes: Infinity, trafficPenaltyMinutes: 0, reachable: false, blockedSegments: [] };
  return { path: r.geometry.coordinates.map(([lon, lat]) => ({ x: lon, y: lat })), distanceKm: r.distance / 1000, etaMinutes: r.duration / 60, baselineMinutes: r.duration / 60, trafficPenaltyMinutes: 0, reachable: true, blockedSegments: [] };
}

/** Authoritative driver ETA for the real-address workflow. OSRM owns the road
 * geometry and duration; route selection is based on travel distance and does
 * not use the legacy grid or traffic conditions. */
export async function estimateGeoDelivery(driver: GeoPoint, pickup: GeoPoint, dropoff: GeoPoint): Promise<DeliveryEstimate> {
  const [toPickup, toDropoff] = await Promise.all([calculateGeoRoute(driver, pickup), calculateGeoRoute(pickup, dropoff)]);
  const reachable = toPickup.reachable && toDropoff.reachable;
  return { toPickup, toDropoff, handlingMinutes: 3, totalMinutes: reachable ? Number((toPickup.etaMinutes + 3 + toDropoff.etaMinutes).toFixed(1)) : Infinity, totalDistanceKm: Number((toPickup.distanceKm + toDropoff.distanceKm).toFixed(2)), reachable };
}
