import type { DeliveryEstimate, RouteResult } from './routing.js';
import { geoToGrid } from './geo.js';
import { calculateRoute } from './routing.js';
import { roads } from '../repo.js';

const routingUrl = (process.env.ROUTING_URL || 'https://router.project-osrm.org/route/v1/driving').replace(/\/$/, '');
const OSRM_TIMEOUT_MS = Number(process.env.ROUTING_TIMEOUT_MS ?? 4000);
const OSRM_DISABLED = process.env.ROUTING_DISABLED === '1' || process.env.NODE_ENV === 'test';

export interface GeoPoint { lat: number; lon: number }

const KM_PER_DEG = 111; // rough, good enough for a projected simulation

/** Deterministic offline fallback: run the grid Dijkstra between the projected
 *  cells and hand back a lat/lon geometry. Keeps dispatch fully functional when
 *  OSRM is unreachable (CI, offline demo). */
async function gridFallbackRoute(from: GeoPoint, to: GeoPoint): Promise<RouteResult> {
  const a = geoToGrid(from.lat, from.lon);
  const b = geoToGrid(to.lat, to.lon);
  const segs = await roads.segments();
  const r = calculateRoute({ x: a.x, y: a.y }, { x: b.x, y: b.y }, segs);
  const span = { latMin: 1.22, latMax: 1.39, lonMin: 103.74, lonMax: 104.02 };
  const toGeo = (p: { x: number; y: number }) => ({
    x: span.lonMin + (p.x / 20) * (span.lonMax - span.lonMin),
    y: span.latMin + (p.y / 20) * (span.latMax - span.latMin),
  });
  const km = Math.hypot((to.lat - from.lat) * KM_PER_DEG, (to.lon - from.lon) * KM_PER_DEG * Math.cos((from.lat * Math.PI) / 180));
  // Use the grid Dijkstra time so the fallback stays traffic-aware (closures /
  // congestion lengthen the ETA); fall back to a straight-line guess only when
  // the grid route is unreachable.
  const straight = Number(((km / 25) * 60).toFixed(1)); // ~25 km/h city average
  const mins = r.reachable && Number.isFinite(r.etaMinutes) ? r.etaMinutes : straight;
  return {
    path: (r.path.length ? r.path : [{ x: a.x, y: a.y }, { x: b.x, y: b.y }]).map(toGeo),
    distanceKm: Number(km.toFixed(2)),
    etaMinutes: mins, baselineMinutes: straight, trafficPenaltyMinutes: r.trafficPenaltyMinutes,
    reachable: r.reachable, blockedSegments: r.blockedSegments,
  };
}

export async function calculateGeoRoute(from: GeoPoint, to: GeoPoint): Promise<RouteResult> {
  if (OSRM_DISABLED) return gridFallbackRoute(from, to);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OSRM_TIMEOUT_MS);
    const response = await fetch(
      `${routingUrl}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&alternatives=true&geometries=geojson`,
      { signal: ctrl.signal },
    ).finally(() => clearTimeout(timer));
    if (!response.ok) return gridFallbackRoute(from, to);
    const data = await response.json() as { routes?: Array<{ distance: number; duration: number; geometry: { coordinates: [number, number][] } }> };
    const r = data.routes?.slice().sort((a, b) => a.distance - b.distance)[0];
    if (!r) return gridFallbackRoute(from, to);
    return {
      path: r.geometry.coordinates.map(([lon, lat]) => ({ x: lon, y: lat })),
      distanceKm: r.distance / 1000, etaMinutes: r.duration / 60, baselineMinutes: r.duration / 60,
      trafficPenaltyMinutes: 0, reachable: true, blockedSegments: [],
    };
  } catch {
    return gridFallbackRoute(from, to);
  }
}

/** Authoritative driver ETA for the real-address workflow. OSRM owns the road
 * geometry and duration when reachable; a deterministic grid route is the
 * offline fallback. Route selection is by travel distance. */
export async function estimateGeoDelivery(driver: GeoPoint, pickup: GeoPoint, dropoff: GeoPoint): Promise<DeliveryEstimate> {
  const [toPickup, toDropoff] = await Promise.all([calculateGeoRoute(driver, pickup), calculateGeoRoute(pickup, dropoff)]);
  const reachable = toPickup.reachable && toDropoff.reachable;
  return {
    toPickup, toDropoff, handlingMinutes: 3,
    totalMinutes: reachable ? Number((toPickup.etaMinutes + 3 + toDropoff.etaMinutes).toFixed(1)) : Infinity,
    totalDistanceKm: Number((toPickup.distanceKm + toDropoff.distanceKm).toFixed(2)),
    reachable,
  };
}
