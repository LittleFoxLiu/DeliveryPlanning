import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateGeoRoute, compareGeoRoutes, estimateGeoDelivery } from '../src/engine/geoRouting.js';

const singaporeA = { lat: 1.3000, lon: 103.8000 };
const singaporeB = { lat: 1.3500, lon: 103.9000 };

afterEach(() => vi.unstubAllGlobals());

describe('OSRM routing engine', () => {
  it('requests OSRM in longitude,latitude order and returns Leaflet latitude,longitude points', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [{ distance: 12500, duration: 1800, geometry: { coordinates: [[103.8, 1.3], [103.85, 1.325], [103.9, 1.35]] } }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const route = await calculateGeoRoute(singaporeA, singaporeB);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/103.8,1.3;103.9,1.35?overview=full&geometries=geojson'),
      expect.any(Object),
    );
    expect(route.reachable).toBe(true);
    expect(route.path[0]).toEqual({ lat: 1.3, lon: 103.8 });
    expect(route.path.at(-1)).toEqual({ lat: 1.35, lon: 103.9 });
    expect(route.distanceKm).toBeCloseTo(12.5);
    expect(route.etaMinutes).toBe(30);
  });

  it('rejects locations outside the Singapore map scope', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const route = await calculateGeoRoute({ lat: 1.3, lon: 103.8 }, { lat: 51.5, lon: -0.1 });

    expect(route.reachable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chains driver, pickup, and drop-off legs through OSRM', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [{ distance: 4000, duration: 600, geometry: { coordinates: [[103.8, 1.3], [103.9, 1.35]] } }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const estimate = await estimateGeoDelivery(singaporeA, singaporeB, singaporeA);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(estimate.reachable).toBe(true);
    expect(estimate.totalMinutes).toBe(23);
    expect(estimate.totalDistanceKm).toBe(8);
  });

  it('ranks only reachable geographic routes by ETA', () => {
    const result = compareGeoRoutes([
      { label: 'slow', result: { path: [], distanceKm: 8, etaMinutes: 20, reachable: true } },
      { label: 'fast', result: { path: [], distanceKm: 5, etaMinutes: 10, reachable: true } },
      { label: 'unreachable', result: { path: [], distanceKm: 0, etaMinutes: Infinity, reachable: false } },
    ]);

    expect(result.map((item) => item.label)).toEqual(['fast', 'slow']);
  });
});
