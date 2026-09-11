import { describe, it, expect } from 'vitest';
import { scoreDriver, compareAssignments, type ScoringDriver, type ScoringOrder } from '../src/engine/scoring.js';
import type { DeliveryEstimate } from '../src/engine/geoRouting.js';

const baseOrder = (over: Partial<ScoringOrder> = {}): ScoringOrder => ({
  orderId: 'ord_x', packageSize: 'medium', volume: 2, priority: 'standard',
  deadlineTs: new Date(Date.now() + 90 * 60_000).toISOString(), nowMs: Date.now(), ...over,
});

const baseDriver = (over: Partial<ScoringDriver> = {}): ScoringDriver => ({
  driverId: 'drv_a', name: 'A', status: 'available', vehicleType: 'van',
  maxPackageSize: 'large', capacity: 4, currentOrderCount: 1, ...over,
});

const estimate = (toPickup: number, toDropoff: number): DeliveryEstimate => ({
  toPickup: { path: [], distanceKm: toPickup / 4, etaMinutes: toPickup, reachable: true },
  toDropoff: { path: [], distanceKm: toDropoff / 4, etaMinutes: toDropoff, reachable: true },
  handlingMinutes: 3, totalMinutes: toPickup + 3 + toDropoff, totalDistanceKm: (toPickup + toDropoff) / 4, reachable: true,
});

describe('scoring engine', () => {
  it('produces an explainable breakdown for an eligible driver', () => {
    const s = scoreDriver(baseOrder(), baseDriver(), estimate(10, 15));
    expect(s.eligible).toBe(true);
    expect(s.score).toBeGreaterThan(0);
    expect(s.explanation.join(' ')).toMatch(/ETA to merchant/);
    expect(Object.keys(s.contributions)).toEqual(['eta', 'efficiency', 'deadline', 'workload', 'vehicle', 'distance', 'latePenalty']);
    // ETA is the dominant factor (40% of 100)
    expect(s.contributions.eta).toBeGreaterThan(s.contributions.efficiency);
  });

  it('weights ETA above raw distance — the spec model', () => {
    // driver very close to pickup but a long total delivery
    const close = scoreDriver(baseOrder(), baseDriver({ driverId: 'drv_close' }), estimate(2, 70));
    // driver farther from pickup but a much shorter total delivery
    const fast = scoreDriver(baseOrder(), baseDriver({ driverId: 'drv_fast' }), estimate(14, 14));
    expect(compareAssignments([close, fast]).winner?.driverId).toBe('drv_fast');
  });

  it('disqualifies a vehicle that cannot carry the package', () => {
    const s = scoreDriver(baseOrder({ packageSize: 'large' }), baseDriver({ vehicleType: 'bike', maxPackageSize: 'small' }), estimate(5, 5));
    expect(s.eligible).toBe(false);
    expect(s.disqualifiers).toContain('vehicle_incompatible');
    expect(s.score).toBe(0);
  });

  it('still assigns a late driver but penalises the miss heavily', () => {
    const late = scoreDriver(baseOrder({ deadlineTs: new Date(Date.now() + 10 * 60_000).toISOString() }), baseDriver(), estimate(20, 20));
    // eligible (a late delivery beats no delivery), but carries a lateness penalty
    expect(late.eligible).toBe(true);
    expect(late.factors.deadlineSatisfied).toBe(false);
    expect(late.contributions.latePenalty).toBeLessThan(0);
    expect(late.explanation.join(' ')).toMatch(/at risk/);
    // an on-time driver on the same route always outranks the late one
    const onTime = scoreDriver(baseOrder(), baseDriver({ driverId: 'drv_ontime' }), estimate(20, 20));
    expect(compareAssignments([late, onTime]).winner?.driverId).toBe('drv_ontime');
  });

  it('disqualifies a full driver and a driver on break', () => {
    expect(scoreDriver(baseOrder(), baseDriver({ currentOrderCount: 4, capacity: 4 }), estimate(5, 5)).disqualifiers).toContain('capacity_full');
    expect(scoreDriver(baseOrder(), baseDriver({ status: 'break' }), estimate(5, 5)).disqualifiers).toContain('driver_on_break');
  });

  it('does NOT simply pick the closest driver — a faster total + better deadline wins', () => {
    // near driver but slow leg to customer, vs slightly farther driver with quick overall route
    const near = scoreDriver(baseOrder(), baseDriver({ driverId: 'drv_near' }), estimate(4, 40));
    const balanced = scoreDriver(baseOrder(), baseDriver({ driverId: 'drv_bal' }), estimate(12, 12));
    const cmp = compareAssignments([near, balanced]);
    expect(cmp.winner?.driverId).toBe('drv_bal');
    expect(cmp.rationale).toMatch(/margin/);
  });

  it('breaks ties deterministically by driverId', () => {
    const a = scoreDriver(baseOrder(), baseDriver({ driverId: 'drv_bbb' }), estimate(10, 10));
    const b = scoreDriver(baseOrder(), baseDriver({ driverId: 'drv_aaa' }), estimate(10, 10));
    expect(compareAssignments([a, b]).winner?.driverId).toBe('drv_aaa');
    expect(compareAssignments([b, a]).winner?.driverId).toBe('drv_aaa');
  });

  it('returns no winner when all candidates are ineligible', () => {
    const s = scoreDriver(baseOrder(), baseDriver({ status: 'offline' }), estimate(5, 5));
    expect(compareAssignments([s]).winner).toBeNull();
  });
});
