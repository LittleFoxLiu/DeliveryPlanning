/** Single projection between the engine's legacy grid and real Singapore coordinates. */
import { config } from '../config.js';

export const GEO_BOX = { latMin: 1.22, latMax: 1.39, lonMin: 103.74, lonMax: 104.02 } as const;
const SIZE = config.grid.size;

export interface Geo { lat: number; lon: number }

export function gridToGeo(x: number, y: number): Geo {
  const cx = Math.max(0, Math.min(SIZE, x));
  const cy = Math.max(0, Math.min(SIZE, y));
  return {
    lat: Number((GEO_BOX.latMin + (cy / SIZE) * (GEO_BOX.latMax - GEO_BOX.latMin)).toFixed(6)),
    lon: Number((GEO_BOX.lonMin + (cx / SIZE) * (GEO_BOX.lonMax - GEO_BOX.lonMin)).toFixed(6)),
  };
}

export function geoToGrid(lat: number, lon: number): { x: number; y: number } {
  const clampAxis = (value: number, min: number, max: number) =>
    Math.max(0, Math.min(SIZE, Math.round(((value - min) / (max - min)) * SIZE)));
  return {
    x: clampAxis(lon, GEO_BOX.lonMin, GEO_BOX.lonMax),
    y: clampAxis(lat, GEO_BOX.latMin, GEO_BOX.latMax),
  };
}
