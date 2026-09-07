import { describe, it, expect } from 'vitest';
import { buildRoadGrid, calculateRoute, estimateDeliveryTime, compareRoutes } from '../src/engine/routing.js';

const grid = buildRoadGrid();

describe('routing engine', () => {
  it('computes a Manhattan-distance shortest path on a clear grid', () => {
    const r = calculateRoute({ x: 0, y: 0 }, { x: 3, y: 2 }, grid);
    expect(r.reachable).toBe(true);
    expect(r.path[0]).toEqual({ x: 0, y: 0 });
    expect(r.path.at(-1)).toEqual({ x: 3, y: 2 });
    expect(r.path.length - 1).toBe(5); // 3 + 2 segments
    expect(r.distanceKm).toBeCloseTo(2.5);
    expect(r.etaMinutes).toBe(10); // 5 segments * 2 min base
    expect(r.trafficPenaltyMinutes).toBe(0);
  });

  it('routes around a closed segment and reports the detour as a penalty', () => {
    const g = grid.map((s) => (s.ax === 0 && s.ay === 0 && s.bx === 1 && s.by === 0 ? { ...s, status: 'closed' as const } : s));
    const r = calculateRoute({ x: 0, y: 0 }, { x: 1, y: 0 }, g);
    expect(r.reachable).toBe(true);
    expect(r.path.length - 1).toBe(3); // 3-segment detour
    expect(r.baselineMinutes).toBe(2); // ideal free-flow for a 1-segment hop
    expect(r.trafficPenaltyMinutes).toBe(4); // 6 min detour - 2 min ideal
  });

  it('reports unreachable when every path is blocked', () => {
    const g = grid.map((s) => {
      const touchesOrigin = (s.ax === 0 && s.ay === 0) || (s.bx === 0 && s.by === 0);
      return touchesOrigin ? { ...s, status: 'closed' as const } : s;
    });
    const r = calculateRoute({ x: 0, y: 0 }, { x: 5, y: 5 }, g);
    expect(r.reachable).toBe(false);
    expect(r.etaMinutes).toBe(Infinity);
  });

  it('adds heavy-traffic multiplier and per-segment delay to ETA', () => {
    // heavy "wall" of horizontal segments at x=2 forces one costly crossing
    const g = grid.map((s) => (s.ay === s.by && s.ax === 2
      ? { ...s, status: 'heavy' as const, delay_minutes: 5 } : s));
    const r = calculateRoute({ x: 0, y: 0 }, { x: 5, y: 0 }, g);
    // 4 clear (2*4) + 1 heavy crossing (2*3 + 5 = 11) = 19
    expect(r.etaMinutes).toBe(19);
    expect(r.baselineMinutes).toBe(10);
    expect(r.trafficPenaltyMinutes).toBe(9);
  });

  it('estimateDeliveryTime chains driver -> pickup -> dropoff with handling time', () => {
    const est = estimateDeliveryTime({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 3 }, grid);
    expect(est.reachable).toBe(true);
    expect(est.totalMinutes).toBe(est.toPickup.etaMinutes + est.handlingMinutes + est.toDropoff.etaMinutes);
  });

  it('compareRoutes ranks by ETA and ignores unreachable candidates', () => {
    const a = calculateRoute({ x: 0, y: 0 }, { x: 1, y: 0 }, grid);
    const b = calculateRoute({ x: 0, y: 0 }, { x: 6, y: 6 }, grid);
    const cmp = compareRoutes([{ label: 'near', result: a }, { label: 'far', result: b }]);
    expect(cmp.best).toBe('near');
  });
});
