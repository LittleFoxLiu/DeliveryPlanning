import type { DeliveryEstimate } from './routing.js';

export type PackageSize = 'small' | 'medium' | 'large';
export type VehicleType = 'bike' | 'car' | 'van' | 'truck';
export type DriverStatus = 'available' | 'on_route' | 'break' | 'offline';

export interface ScoringDriver {
  driverId: string;
  name: string;
  status: DriverStatus;
  vehicleType: VehicleType;
  maxPackageSize: PackageSize;
  capacity: number;
  currentOrderCount: number;
}

export interface ScoringOrder {
  orderId: string;
  packageSize: PackageSize;
  volume: number;
  priority: 'standard' | 'express';
  deadlineTs: string;
  nowMs?: number;
}

export interface ScoreBreakdown {
  driverId: string;
  eligible: boolean;
  disqualifiers: string[];
  score: number; // 0..100, higher is better; 0 when ineligible
  factors: {
    etaToMerchantMin: number;
    etaMerchantToCustomerMin: number;
    totalDeliveryMin: number;
    deadlineSlackMin: number;
    deadlineSatisfied: boolean;
    capacityAvailable: boolean;
    capacityHeadroom: number;
    vehicleCompatible: boolean;
    availability: DriverStatus;
    routeEfficiencyPct: number; // straight-ish baseline vs actual
  };
  contributions: Record<string, number>;
  explanation: string[];
}

const sizeRank: Record<PackageSize, number> = { small: 1, medium: 2, large: 3 };
const vehicleMaxSize: Record<VehicleType, PackageSize> = { bike: 'small', car: 'medium', van: 'large', truck: 'large' };

const WEIGHTS = {
  time: 34,
  deadline: 26,
  efficiency: 16,
  availability: 14,
  capacity: 10,
} as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Deterministic, explainable multi-factor score for one driver/order pair.
 *  All numeric inputs come from the routing engine and the database. */
export function scoreDriver(
  order: ScoringOrder,
  driver: ScoringDriver,
  estimate: DeliveryEstimate,
): ScoreBreakdown {
  const now = order.nowMs ?? Date.now();
  const disqualifiers: string[] = [];

  const vehicleCompatible = sizeRank[driver.maxPackageSize] >= sizeRank[order.packageSize]
    && sizeRank[vehicleMaxSize[driver.vehicleType]] >= sizeRank[order.packageSize];
  if (!vehicleCompatible) disqualifiers.push('vehicle_incompatible');

  if (driver.status === 'break') disqualifiers.push('driver_on_break');
  if (driver.status === 'offline') disqualifiers.push('driver_offline');

  const capacityHeadroom = driver.capacity - driver.currentOrderCount;
  const capacityAvailable = capacityHeadroom >= 1;
  if (!capacityAvailable) disqualifiers.push('capacity_full');

  if (!estimate.reachable) disqualifiers.push('no_viable_route');

  const totalDeliveryMin = estimate.totalMinutes;
  const deadlineMs = Date.parse(order.deadlineTs);
  const etaCompletionMs = now + totalDeliveryMin * 60_000;
  const deadlineSlackMin = Number.isFinite(totalDeliveryMin)
    ? Math.round((deadlineMs - etaCompletionMs) / 60_000)
    : -9999;
  const deadlineSatisfied = deadlineSlackMin >= 0;
  if (!deadlineSatisfied) disqualifiers.push('deadline_missed');

  const straightBaseline = estimate.reachable
    ? estimate.toPickup.baselineMinutes + estimate.handlingMinutes + estimate.toDropoff.baselineMinutes
    : Infinity;
  const routeEfficiencyPct = estimate.reachable && totalDeliveryMin > 0
    ? Math.round(clamp((straightBaseline / totalDeliveryMin) * 100, 0, 100))
    : 0;

  const factors: ScoreBreakdown['factors'] = {
    etaToMerchantMin: estimate.reachable ? estimate.toPickup.etaMinutes : Infinity,
    etaMerchantToCustomerMin: estimate.reachable ? estimate.toDropoff.etaMinutes : Infinity,
    totalDeliveryMin,
    deadlineSlackMin,
    deadlineSatisfied,
    capacityAvailable,
    capacityHeadroom,
    vehicleCompatible,
    availability: driver.status,
    routeEfficiencyPct,
  };

  if (disqualifiers.length) {
    return {
      driverId: driver.driverId,
      eligible: false,
      disqualifiers,
      score: 0,
      factors,
      contributions: {},
      explanation: [`Not eligible: ${disqualifiers.join(', ')}`],
    };
  }

  // --- scoring (only for eligible drivers) ---
  // time: 0 min -> full marks; 90 min -> 0
  const timeScore = clamp(1 - totalDeliveryMin / 90, 0, 1);
  // deadline: >=45 min slack -> full; 0 slack -> 0.35
  const deadlineScore = clamp(0.35 + (deadlineSlackMin / 45) * 0.65, 0, 1);
  const efficiencyScore = routeEfficiencyPct / 100;
  const availabilityScore = driver.status === 'available' ? 1 : 0.6;
  const capacityScore = clamp(capacityHeadroom / Math.max(driver.capacity, 1), 0, 1);

  const contributions = {
    time: Number((timeScore * WEIGHTS.time).toFixed(2)),
    deadline: Number((deadlineScore * WEIGHTS.deadline).toFixed(2)),
    efficiency: Number((efficiencyScore * WEIGHTS.efficiency).toFixed(2)),
    availability: Number((availabilityScore * WEIGHTS.availability).toFixed(2)),
    capacity: Number((capacityScore * WEIGHTS.capacity).toFixed(2)),
  };
  const score = Number(Object.values(contributions).reduce((a, b) => a + b, 0).toFixed(2));

  const explanation = [
    `ETA to merchant: ${factors.etaToMerchantMin} min`,
    `ETA merchant → customer: ${factors.etaMerchantToCustomerMin} min`,
    `Total delivery time: ${totalDeliveryMin} min`,
    `Deadline: satisfied with ${deadlineSlackMin} min to spare`,
    `Capacity: ${capacityHeadroom} of ${driver.capacity} slots free`,
    `Vehicle: ${driver.vehicleType} compatible with ${order.packageSize} package`,
    `Route efficiency: ${routeEfficiencyPct}%`,
    `Availability: ${driver.status}`,
  ];

  return { driverId: driver.driverId, eligible: true, disqualifiers: [], score, factors, contributions, explanation };
}

export interface Comparison {
  ranked: ScoreBreakdown[];
  winner: ScoreBreakdown | null;
  margin: number;
  rationale: string;
}

/** Compare candidate assignments and pick the best. Ties broken deterministically
 *  by driverId so repeated runs are stable. */
export function compareAssignments(breakdowns: ScoreBreakdown[]): Comparison {
  const eligible = breakdowns.filter((b) => b.eligible);
  const ranked = [...breakdowns].sort((a, b) => (b.score - a.score) || a.driverId.localeCompare(b.driverId));
  const eligRanked = eligible.sort((a, b) => (b.score - a.score) || a.driverId.localeCompare(b.driverId));
  const winner = eligRanked[0] ?? null;
  const runnerUp = eligRanked[1];
  const margin = winner && runnerUp ? Number((winner.score - runnerUp.score).toFixed(2)) : winner ? winner.score : 0;

  let rationale: string;
  if (!winner) {
    rationale = 'No eligible driver: ' + (breakdowns[0]?.disqualifiers.join(', ') || 'none available');
  } else if (runnerUp) {
    rationale = `Driver ${winner.driverId} scored ${winner.score} vs ${runnerUp.score} for ${runnerUp.driverId} `
      + `(margin ${margin}). Decisive factors: total time ${winner.factors.totalDeliveryMin} min, `
      + `deadline slack ${winner.factors.deadlineSlackMin} min, route efficiency ${winner.factors.routeEfficiencyPct}%.`;
  } else {
    rationale = `Driver ${winner.driverId} is the only eligible candidate (score ${winner.score}).`;
  }
  return { ranked, winner, margin, rationale };
}
