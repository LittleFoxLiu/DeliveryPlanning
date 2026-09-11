/** Geographic primitives shared by storage, routing, and validation. */
export interface GeoPoint {
  lat: number;
  lon: number;
}

/** A deliberately conservative Singapore bounding box.
 *  Nominatim country filtering is still the source of truth for addresses;
 *  this box prevents accidental offshore / cross-border map selections. */
export const SINGAPORE_BOUNDS = {
  south: 1.22,
  north: 1.48,
  west: 103.60,
  east: 104.05,
} as const;

export function isWithinSingapore(point: GeoPoint): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon)
    && point.lat >= SINGAPORE_BOUNDS.south && point.lat <= SINGAPORE_BOUNDS.north
    && point.lon >= SINGAPORE_BOUNDS.west && point.lon <= SINGAPORE_BOUNDS.east;
}

export function geoPoint(lat: number, lon: number): GeoPoint {
  return { lat, lon };
}

export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
