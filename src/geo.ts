/**
 * Client mirror of `server/src/engine/geo.ts` — the ONE grid ↔ real-world
 * projection. Keep the box in sync with the server.
 */
export const GEO_BOX = { latMin: 1.22, latMax: 1.39, lonMin: 103.74, lonMax: 104.02 } as const;
const SIZE = 20;

export interface Geo { lat: number; lon: number }

/** grid cell (x ≈ longitude, y ≈ latitude) → real coordinate */
export function gridToGeo(x: number, y: number): Geo {
  const cx = Math.max(0, Math.min(SIZE, x));
  const cy = Math.max(0, Math.min(SIZE, y));
  return {
    lat: GEO_BOX.latMin + (cy / SIZE) * (GEO_BOX.latMax - GEO_BOX.latMin),
    lon: GEO_BOX.lonMin + (cx / SIZE) * (GEO_BOX.lonMax - GEO_BOX.lonMin),
  };
}

export function geoToGrid(lat: number, lon: number): { x: number; y: number } {
  const axis = (v: number, lo: number, hi: number) => Math.max(0, Math.min(SIZE, Math.round(((v - lo) / (hi - lo)) * SIZE)));
  return { x: axis(lon, GEO_BOX.lonMin, GEO_BOX.lonMax), y: axis(lat, GEO_BOX.latMin, GEO_BOX.latMax) };
}

/**
 * The route polyline as it should be drawn *right now*: from the driver's live
 * position to the destination, with the already-travelled portion trimmed off.
 * `nodes` are the stored route path points ({ x: lon, y: lat }); `from` is the
 * driver's current { lat, lon } (omit it to draw the whole route).
 */
export function routeFromHere(
  nodes: { x: number; y: number }[],
  from: { lat: number; lon: number } | null | undefined,
): [number, number][] {
  const latlngs = nodes
    .filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y))
    .map((n) => [n.y, n.x] as [number, number]);
  if (!from || !Number.isFinite(from.lat) || !Number.isFinite(from.lon) || latlngs.length < 2) return latlngs;
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < latlngs.length; i++) {
    const d = (latlngs[i][0] - from.lat) ** 2 + (latlngs[i][1] - from.lon) ** 2;
    if (d < best) { best = d; idx = i; }
  }
  return [[from.lat, from.lon], ...latlngs.slice(idx)];
}
