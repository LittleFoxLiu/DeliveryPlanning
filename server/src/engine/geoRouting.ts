import type { DeliveryEstimate, RouteResult } from './routing.js';

const routingUrl = (process.env.ROUTING_URL || 'https://router.project-osrm.org/route/v1/driving').replace(/\/$/, '');
export interface GeoPoint { lat: number; lon: number }

async function route(from: GeoPoint, to: GeoPoint): Promise<RouteResult> {
  const response = await fetch(`${routingUrl}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`);
  if (!response.ok) throw new Error('OSRM routing service unavailable');
  const data = await response.json() as { routes?: Array<{ distance: number; duration: number; geometry: { coordinates: [number, number][] } }> };
  const r = data.routes?.[0];
  if (!r) return { path: [], distanceKm: 0, etaMinutes: Infinity, baselineMinutes: Infinity, trafficPenaltyMinutes: 0, reachable: false, blockedSegments: [] };
  return { path: r.geometry.coordinates.map(([lon, lat]) => ({ x: lon, y: lat })), distanceKm: r.distance / 1000, etaMinutes: r.duration / 60, baselineMinutes: r.duration / 60, trafficPenaltyMinutes: 0, reachable: true, blockedSegments: [] };
}

/** Authoritative ETA for the real-address workflow. OSRM owns the road
 * geometry and duration; no grid approximation is used when all geo fixes exist. */
export async function estimateGeoDelivery(driver: GeoPoint, pickup: GeoPoint, dropoff: GeoPoint): Promise<DeliveryEstimate> {
  const [toPickup, toDropoff] = await Promise.all([route(driver, pickup), route(pickup, dropoff)]);
  const reachable = toPickup.reachable && toDropoff.reachable;
  return { toPickup, toDropoff, handlingMinutes: 3, totalMinutes: reachable ? Number((toPickup.etaMinutes + 3 + toDropoff.etaMinutes).toFixed(1)) : Infinity, totalDistanceKm: Number((toPickup.distanceKm + toDropoff.distanceKm).toFixed(2)), reachable };
}
