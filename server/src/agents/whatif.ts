/** Read-only what-if projections using the same Nominatim/OSRM workflow as
 * live dispatch. It never writes to the database or emits events. */
import { drivers, deliveries, orders, stores, type DriverFull, type OrderRow } from '../repo.js';
import { estimateGeoDelivery } from '../engine/geoRouting.js';
import { scoreDriver, compareAssignments } from '../engine/scoring.js';
import type { DeliveryEstimate } from '../engine/geoRouting.js';
import { vehicleCanCarry } from './compat.js';
import type { GeoPoint } from '../geo.js';

const code = (id: string) => `#${id.replace(/^ord_/, '').slice(-6).toUpperCase()}`;

export interface WhatIfImpact {
  orderCode: string;
  deliveryId: string;
  currentDriver: string;
  phase: 'to_pickup' | 'to_dropoff';
  baselineSlackMin: number | null;
  projectedSlackMin: number | null;
  status: 'unaffected' | 'at_risk' | 'broken';
  remedy: { strategy: 'none' | 'reroute' | 'reassign'; driver?: string; projectedSlackMin?: number; note: string };
}

export interface WhatIfResult {
  scenario: string;
  hypothesis: string;
  impacts: WhatIfImpact[];
  summary: { deliveries: number; atRisk: number; broken: number; autoRecoverable: number; needsHuman: number };
}

async function projectDelivery(
  delivery: Awaited<ReturnType<typeof deliveries.active>>[number], fleet: DriverFull[], overrideDriverId?: string | null,
): Promise<{ order: NonNullable<Awaited<ReturnType<typeof orders.byId>>>; phase: 'to_pickup' | 'to_dropoff'; projectedTotalMin: number; driver: DriverFull | undefined }> {
  const order = (await orders.byId(delivery.order_id))!;
  const driver = fleet.find((candidate) => candidate.id === (overrideDriverId === undefined ? delivery.driver_id : overrideDriverId));
  const store = await stores.byId(order.store_id);
  const phase: 'to_pickup' | 'to_dropoff' = ['picked_up', 'en_route_drop'].includes(delivery.status) ? 'to_dropoff' : 'to_pickup';
  if (!driver || driver.latitude == null || driver.longitude == null || !store) return { order, phase, projectedTotalMin: Infinity, driver };
  const estimate: DeliveryEstimate = await estimateGeoDelivery(
    { lat: driver.latitude, lon: driver.longitude },
    { lat: store.latitude, lon: store.longitude },
    { lat: order.delivery_latitude, lon: order.delivery_longitude },
  );
  return { order, phase, projectedTotalMin: phase === 'to_dropoff' ? estimate.toDropoff.etaMinutes : estimate.totalMinutes, driver };
}

function slackMin(deadlineTs: string, projectedTotalMin: number): number | null {
  if (!Number.isFinite(projectedTotalMin)) return null;
  return Math.round((Date.parse(deadlineTs) - (Date.now() + projectedTotalMin * 60_000)) / 60_000);
}

async function bestReplacement(order: OrderRow, fleet: DriverFull[], exclude: string[]) {
  const store = await stores.byId(order.store_id);
  if (!store) return null;
  const eligible = fleet.filter((driver) => !exclude.includes(driver.id)
    && (driver.status === 'available' || driver.status === 'on_route')
    && driver.latitude != null && driver.longitude != null
    && driver.capacity - driver.current_order_count >= 1
    && vehicleCanCarry(driver.vehicle_type, driver.max_package_size, order.package_size));
  if (!eligible.length) return null;
  const scored = await Promise.all(eligible.map(async (driver) => {
    const estimate = await estimateGeoDelivery(
      { lat: driver.latitude!, lon: driver.longitude! },
      { lat: store.latitude, lon: store.longitude },
      { lat: order.delivery_latitude, lon: order.delivery_longitude },
    );
    return { driver, breakdown: scoreDriver(
      { orderId: order.id, packageSize: order.package_size, volume: order.volume, priority: order.priority, deadlineTs: order.deadline_ts },
      { driverId: driver.id, name: driver.name, status: driver.status, vehicleType: driver.vehicle_type, maxPackageSize: driver.max_package_size, capacity: driver.capacity, currentOrderCount: driver.current_order_count },
      estimate,
    ) };
  }));
  const winner = compareAssignments(scored.map((item) => item.breakdown)).winner;
  if (!winner) return null;
  return { driver: scored.find((item) => item.driver.id === winner.driverId)!.driver, slackMin: winner.factors.deadlineSlackMin };
}

export async function whatIfDriverOffline(driverId: string): Promise<WhatIfResult> {
  const [fleet, active] = await Promise.all([
    drivers.all(), deliveries.active().then((items) => items.filter((item) => ['assigned', 'en_route_pickup', 'picked_up', 'en_route_drop'].includes(item.status))),
  ]);
  const target = fleet.find((driver) => driver.id === driverId);
  const impacts: WhatIfImpact[] = [];
  for (const delivery of active) {
    if (delivery.driver_id !== driverId) continue;
    const base = await projectDelivery(delivery, fleet);
    const baselineSlack = slackMin(base.order.deadline_ts, base.projectedTotalMin);
    const pickedUp = ['picked_up', 'en_route_drop'].includes(delivery.status);
    const replacement = pickedUp ? null : await bestReplacement(base.order, fleet, [driverId]);
    let status: WhatIfImpact['status'] = 'broken';
    let remedy: WhatIfImpact['remedy'] = { strategy: 'none', note: 'package already collected — a human must intervene' };
    if (!pickedUp && replacement) {
      status = replacement.slackMin >= 0 ? 'at_risk' : 'broken';
      remedy = {
        strategy: 'reassign', driver: replacement.driver.name, projectedSlackMin: replacement.slackMin,
        note: replacement.slackMin >= 0
          ? `reassign to ${replacement.driver.name} — arrives with ${replacement.slackMin} min to spare`
          : `no driver can beat the deadline; ${replacement.driver.name} is the fastest (−${-replacement.slackMin} min)`,
      };
    }
    impacts.push({ orderCode: code(base.order.id), deliveryId: delivery.id, currentDriver: target?.name ?? driverId, phase: base.phase, baselineSlackMin: baselineSlack, projectedSlackMin: replacement?.slackMin ?? null, status, remedy });
  }
  return { scenario: 'driver_offline', hypothesis: `${target?.name ?? driverId} goes offline right now`, impacts, summary: summarise(impacts) };
}

function summarise(impacts: WhatIfImpact[]): WhatIfResult['summary'] {
  return {
    deliveries: impacts.length,
    atRisk: impacts.filter((item) => item.status === 'at_risk').length,
    broken: impacts.filter((item) => item.status === 'broken').length,
    autoRecoverable: impacts.filter((item) => item.status !== 'unaffected' && item.remedy.strategy !== 'none' && (item.remedy.projectedSlackMin ?? -1) >= 0).length,
    needsHuman: impacts.filter((item) => item.status === 'broken' && (item.remedy.strategy === 'none' || (item.remedy.projectedSlackMin ?? -1) < 0)).length,
  };
}
