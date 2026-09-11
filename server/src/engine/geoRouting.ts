import { isWithinSingapore, type GeoPoint } from '../geo.js';
import { config } from '../config.js';

export interface GeoRoute {
  path: GeoPoint[];
  distanceKm: number;
  etaMinutes: number;
  reachable: boolean;
}

export interface DeliveryEstimate {
  toPickup: GeoRoute;
  toDropoff: GeoRoute;
  handlingMinutes: number;
  totalMinutes: number;
  totalDistanceKm: number;
  reachable: boolean;
}

const unreachable = (): GeoRoute => ({
  path: [], distanceKm: 0, etaMinutes: Infinity, reachable: false,
});

/** Ask OSRM for the drivable route. Coordinates are always [longitude,latitude]
 * in the request and are returned as named geographic points for storage/UI. */
export async function calculateGeoRoute(from: GeoPoint, to: GeoPoint): Promise<GeoRoute> {
  if (!isWithinSingapore(from) || !isWithinSingapore(to)) return unreachable();
  const url = `${config.routingUrl}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return unreachable();
    const data = await response.json() as {
      code?: string;
      routes?: Array<{ distance: number; duration: number; geometry?: { coordinates?: [number, number][] } }>;
    };
    const route = data.routes?.[0];
    const coordinates = route?.geometry?.coordinates;
    if (!route || !coordinates?.length || (data.code && data.code !== 'Ok')) return unreachable();
    const minutes = route.duration / 60;
    const path = coordinates.map(([lon, lat]) => ({ lat, lon }));
    // Never save a clipped route: filtering points would join two separated
    // in-scope fragments and draw a false straight line in the UI.
    if (path.length < 2 || path.some((point) => !isWithinSingapore(point))) return unreachable();
    return {
      path,
      distanceKm: route.distance / 1000,
      etaMinutes: minutes,
      reachable: true,
    };
  } catch {
    return unreachable();
  }
}

export async function estimateGeoDelivery(driver: GeoPoint, pickup: GeoPoint, dropoff: GeoPoint): Promise<DeliveryEstimate> {
  const [toPickup, toDropoff] = await Promise.all([
    calculateGeoRoute(driver, pickup),
    calculateGeoRoute(pickup, dropoff),
  ]);
  const reachable = toPickup.reachable && toDropoff.reachable;
  return {
    toPickup,
    toDropoff,
    handlingMinutes: 3,
    totalMinutes: reachable ? Number((toPickup.etaMinutes + 3 + toDropoff.etaMinutes).toFixed(1)) : Infinity,
    totalDistanceKm: reachable ? Number((toPickup.distanceKm + toDropoff.distanceKm).toFixed(2)) : Infinity,
    reachable,
  };
}

export async function calculateGeoDistance(from: GeoPoint, to: GeoPoint): Promise<number> {
  return (await calculateGeoRoute(from, to)).distanceKm;
}

export async function calculateGeoEta(from: GeoPoint, to: GeoPoint): Promise<number> {
  return (await calculateGeoRoute(from, to)).etaMinutes;
}

export function compareGeoRoutes(named: { label: string; result: GeoRoute }[]) {
  return [...named]
    .filter((item) => item.result.reachable)
    .sort((a, b) => (a.result.etaMinutes - b.result.etaMinutes) || a.label.localeCompare(b.label))
    .map((item) => ({ label: item.label, etaMinutes: item.result.etaMinutes, distanceKm: item.result.distanceKm }));
}
