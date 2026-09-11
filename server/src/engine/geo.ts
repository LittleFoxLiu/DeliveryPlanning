/**
 * Single grid ↔ real-world projection.
 *
 * The deterministic routing / scoring engine works in an abstract 20×20 grid.
 * The UI shows a real Singapore map. This module is the ONE place that maps
 * between the two — every driver / store / drop-off position on the map comes
 * from `gridToGeo`, and every real address the user picks is turned into a grid
 * cell with `geoToGrid`, so the engine stays fully grid-based and deterministic.
 *
 * The box matches the seed's curated address band so seeded points and derived
 * points land in the same area.
 */
import { config } from '../config.js';

export const GEO_BOX = { latMin: 1.22, latMax: 1.39, lonMin: 103.74, lonMax: 104.02 } as const;

const SIZE = config.grid.size;

export interface Geo { lat: number; lon: number }

/** Grid cell (x = column ≈ longitude, y = row ≈ latitude) → lat/lon. */
export function gridToGeo(x: number, y: number): Geo {
  const cx = Math.max(0, Math.min(SIZE, x));
  const cy = Math.max(0, Math.min(SIZE, y));
  return {
    lat: Number((GEO_BOX.latMin + (cy / SIZE) * (GEO_BOX.latMax - GEO_BOX.latMin)).toFixed(6)),
    lon: Number((GEO_BOX.lonMin + (cx / SIZE) * (GEO_BOX.lonMax - GEO_BOX.lonMin)).toFixed(6)),
  };
}

/** lat/lon → nearest grid intersection. */
export function geoToGrid(lat: number, lon: number): { x: number; y: number } {
  const clampAxis = (v: number, lo: number, hi: number) =>
    Math.max(0, Math.min(SIZE, Math.round(((v - lo) / (hi - lo)) * SIZE)));
  return {
    x: clampAxis(lon, GEO_BOX.lonMin, GEO_BOX.lonMax),
    y: clampAxis(lat, GEO_BOX.latMin, GEO_BOX.latMax),
  };
}
