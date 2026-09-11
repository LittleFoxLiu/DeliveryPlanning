import type { DeliveryEstimate } from './geoRouting.js';
import { distanceKm as geographicDistanceKm } from '../geo.js';

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
    routeEfficiencyPct: number; // direct geographic distance vs OSRM distance
    physicalDistanceKm: number; // OSRM distance from driver to pickup
    workloadRatio: number; // currentOrderCount / capacity
  };
  contributions: Record<string, number>;
  explanation: string[];
}

const sizeRank: Record<PackageSize, number> = { small: 1, medium: 2, large: 3 };
const vehicleMaxSize: Record<VehicleType, PackageSize> = { bike: 'small', car: 'medium', van: 'large', truck: 'large' };

const WEIGHTS = {
  eta: 40,
  efficiency: 20,
  deadline: 15,
  workload: 10,
  vehicle: 8,
  distance: 7,
} as const;
const DISTANCE_SPAN_KM = 40;

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
  // A driver who will be late is NOT disqualified — a late delivery still beats
  // no delivery, and the Monitoring Agent tracks the risk. Lateness is a heavy
  // soft penalty instead (below), so an on-time driver always wins when one
  // exists. Only a genuinely unreachable route is a hard routing failure.

  const directLegDistance = (route: DeliveryEstimate['toPickup']) => {
    const first = route.path[0];
    const last = route.path[route.path.length - 1];
    return first && last ? geographicDistanceKm(first, last) : route.distanceKm;
  };
  const directDistanceKm = estimate.reachable
    ? directLegDistance(estimate.toPickup) + directLegDistance(estimate.toDropoff)
    : Infinity;
  const routedDistanceKm = estimate.reachable
    ? estimate.toPickup.distanceKm + estimate.toDropoff.distanceKm
    : Infinity;
  const routeEfficiencyPct = estimate.reachable && routedDistanceKm > 0
    ? Math.round(clamp((directDistanceKm / routedDistanceKm) * 100, 0, 100))
    : 0;
  const physicalDistanceKm = estimate.reachable
    ? Number(estimate.toPickup.distanceKm.toFixed(2))
    : Infinity;
  const workloadRatio = Number((driver.currentOrderCount / Math.max(driver.capacity, 1)).toFixed(2));

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
    physicalDistanceKm,
    workloadRatio,
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

  // --- scoring (only for eligible drivers), each sub-score in [0, 1] ---
  // eta: 0 min -> full marks; 90 min -> 0
  const etaScore = clamp(1 - totalDeliveryMin / 90, 0, 1);
  const efficiencyScore = routeEfficiencyPct / 100;
  // deadline: >=45 min slack -> full; 0 slack -> 0.35
  const deadlineScore = clamp(0.35 + (deadlineSlackMin / 45) * 0.65, 0, 1);
  // Lateness remains a soft penalty: a late driver can still be the safest
  // available option, but an otherwise comparable on-time driver wins.
  const latePenalty = deadlineSatisfied ? 0 : -Math.min(20, Math.ceil(-deadlineSlackMin / 3));
  // workload: idle driver -> full; at capacity -> 0. `available` beats `on_route`.
  const workloadScore = clamp(1 - workloadRatio, 0, 1) * (driver.status === 'available' ? 1 : 0.7);
  // vehicle: exact fit -> 0.6; roomier vehicle than needed -> up to 1
  const vehicleSlack = sizeRank[vehicleMaxSize[driver.vehicleType]] - sizeRank[order.packageSize];
  const vehicleScore = clamp(0.6 + vehicleSlack * 0.2, 0, 1);
  // distance: driver already at pickup -> full; longer Singapore routes score lower
  const distanceScore = clamp(1 - physicalDistanceKm / DISTANCE_SPAN_KM, 0, 1);

  const contributions = {
    eta: Number((etaScore * WEIGHTS.eta).toFixed(2)),
    efficiency: Number((efficiencyScore * WEIGHTS.efficiency).toFixed(2)),
    deadline: Number((deadlineScore * WEIGHTS.deadline).toFixed(2)),
    workload: Number((workloadScore * WEIGHTS.workload).toFixed(2)),
    vehicle: Number((vehicleScore * WEIGHTS.vehicle).toFixed(2)),
    distance: Number((distanceScore * WEIGHTS.distance).toFixed(2)),
    latePenalty,
  };
  const score = Math.max(0, Number(Object.values(contributions).reduce((a, b) => a + b, 0).toFixed(2)));

  const explanation = [
    `ETA to merchant: ${factors.etaToMerchantMin} min`,
    `ETA merchant → customer: ${factors.etaMerchantToCustomerMin} min`,
    `Total delivery time: ${totalDeliveryMin} min`,
    deadlineSatisfied
      ? `Deadline: satisfied with ${deadlineSlackMin} min to spare`
      : `Deadline: at risk — projected ${-deadlineSlackMin} min late`,
    `Route efficiency: ${routeEfficiencyPct}%`,
    `Driver workload: ${driver.currentOrderCount}/${driver.capacity} active`,
    `Vehicle: ${driver.vehicleType} (fits ${order.packageSize}, ${vehicleSlack} size${vehicleSlack === 1 ? '' : 's'} of spare)`,
    `Distance to pickup: ${physicalDistanceKm} km`,
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

  const lateNote = winner && !winner.factors.deadlineSatisfied
    ? ` Best effort only — projected ${-winner.factors.deadlineSlackMin} min past the deadline.` : '';

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
  return { ranked, winner, margin, rationale: rationale + lateNote };
}
