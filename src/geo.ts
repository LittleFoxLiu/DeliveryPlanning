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
