/**
 * What-If simulator. Pure, read-only projection: it never writes to the DB or
 * emits events. It takes the current world, applies a hypothetical, and runs the
 * same deterministic engines the agents use to project the consequences.
 */
import { drivers, deliveries, orders, roads, type DriverFull } from '../repo.js';
import { estimateDeliveryTime, calculateRoute, type Point, type Segment } from '../engine/routing.js';
import { scoreDriver, compareAssignments } from '../engine/scoring.js';
import { vehicleCanCarry } from './compat.js';

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

async function activeCtx() {
  const [fleet, active, segs] = await Promise.all([
    drivers.all(),
    deliveries.active().then((ds) => ds.filter((d) => ['assigned', 'en_route_pickup', 'picked_up', 'en_route_drop'].includes(d.status))),
    roads.segments(),
  ]);
  return { fleet, active, segs };
}

function slackMin(deadlineTs: string, projectedTotalMin: number): number | null {
  if (!Number.isFinite(projectedTotalMin)) return null;
  return Math.round((Date.parse(deadlineTs) - (Date.now() + projectedTotalMin * 60_000)) / 60_000);
}

async function projectDelivery(
  d: Awaited<ReturnType<typeof deliveries.active>>[number],
  fleet: DriverFull[], segs: Segment[], overrideDriverId?: string | null,
): Promise<{ order: NonNullable<Awaited<ReturnType<typeof orders.byId>>>; phase: 'to_pickup' | 'to_dropoff'; projectedTotalMin: number; driver: DriverFull | undefined }> {
  const order = (await orders.byId(d.order_id))!;
  const driverId = overrideDriverId === undefined ? d.driver_id : overrideDriverId;
  const driver = fleet.find((f) => f.id === driverId);
  const phase: 'to_pickup' | 'to_dropoff' = ['picked_up', 'en_route_drop'].includes(d.status) ? 'to_dropoff' : 'to_pickup';
  if (!driver || driver.lat == null) return { order, phase, projectedTotalMin: Infinity, driver };
  const pos: Point = { x: driver.lat, y: driver.lng as number };
  const pickup: Point = { x: order.pickup_lat, y: order.pickup_lng };
  const dropoff: Point = { x: order.delivery_lat, y: order.delivery_lng };
  const projectedTotalMin = phase === 'to_dropoff'
    ? calculateRoute(pos, dropoff, segs).etaMinutes
    : estimateDeliveryTime(pos, pickup, dropoff, segs).totalMinutes;
  return { order, phase, projectedTotalMin, driver };
}

/** Best replacement driver for an order, ignoring one or more excluded ids. */
function bestReplacement(order: NonNullable<Awaited<ReturnType<typeof orders.byId>>>, fleet: DriverFull[], segs: Segment[], exclude: string[]) {
  const eligible = fleet.filter((d) =>
    !exclude.includes(d.id)
    && (d.status === 'available' || d.status === 'on_route')
    && d.lat != null
    && d.capacity - d.current_order_count >= 1
    && vehicleCanCarry(d.vehicle_type, d.max_package_size, order.package_size));
  if (!eligible.length) return null;
  const breakdowns = eligible.map((d) => {
    const est = estimateDeliveryTime(
      { x: d.lat as number, y: d.lng as number },
      { x: order.pickup_lat, y: order.pickup_lng }, { x: order.delivery_lat, y: order.delivery_lng }, segs,
    );
    return scoreDriver(
      { orderId: order.id, packageSize: order.package_size, volume: order.volume, priority: order.priority, deadlineTs: order.deadline_ts },
      { driverId: d.id, name: d.name, status: d.status, vehicleType: d.vehicle_type, maxPackageSize: d.max_package_size, capacity: d.capacity, currentOrderCount: d.current_order_count },
      est,
    );
  });
  const winner = compareAssignments(breakdowns).winner;
  if (!winner) return null;
  const d = eligible.find((e) => e.id === winner.driverId)!;
  return { driver: d, slackMin: winner.factors.deadlineSlackMin };
}

export async function whatIfDriverOffline(driverId: string): Promise<WhatIfResult> {
  const { fleet, active, segs } = await activeCtx();
  const target = fleet.find((f) => f.id === driverId);
  const impacts: WhatIfImpact[] = [];
  for (const d of active) {
    if (d.driver_id !== driverId) continue;
    const base = await projectDelivery(d, fleet, segs);
    const baselineSlack = slackMin(base.order.deadline_ts, base.projectedTotalMin);
    const pickedUp = ['picked_up', 'en_route_drop'].includes(d.status);
    const repl = pickedUp ? null : bestReplacement(base.order, fleet, segs, [driverId]);
    let status: WhatIfImpact['status'] = 'broken';
    let remedy: WhatIfImpact['remedy'] = { strategy: 'none', note: 'package already collected — a human must intervene' };
    if (!pickedUp && repl) {
      status = repl.slackMin >= 0 ? 'at_risk' : 'broken';
      remedy = {
        strategy: 'reassign', driver: repl.driver.name, projectedSlackMin: repl.slackMin,
        note: repl.slackMin >= 0
          ? `reassign to ${repl.driver.name} — arrives with ${repl.slackMin} min to spare`
          : `no driver can beat the deadline; ${repl.driver.name} is the fastest (−${-repl.slackMin} min)`,
      };
    }
    impacts.push({
      orderCode: code(base.order.id), deliveryId: d.id,
      currentDriver: target?.name ?? driverId, phase: base.phase,
      baselineSlackMin: baselineSlack, projectedSlackMin: repl?.slackMin ?? null, status, remedy,
    });
  }
  return {
    scenario: 'driver_offline',
    hypothesis: `${target?.name ?? driverId} goes offline right now`,
    impacts,
    summary: summarise(impacts),
  };
}

export async function whatIfRoadClosure(orderId: string): Promise<WhatIfResult> {
  const { fleet, active, segs } = await activeCtx();
  const order = await orders.byId(orderId);
  const delivery = active.find((d) => d.order_id === orderId);
  if (!order || !delivery) {
    return { scenario: 'road_close', hypothesis: `close a road on ${code(orderId)}'s route`, impacts: [], summary: summarise([]) };
  }
  // hypothetically close the busiest segment on this delivery's remaining route
  const driver = fleet.find((f) => f.id === delivery.driver_id);
  const pos: Point = driver && driver.lat != null ? { x: driver.lat, y: driver.lng as number } : { x: order.pickup_lat, y: order.pickup_lng };
  const phase: 'to_pickup' | 'to_dropoff' = ['picked_up', 'en_route_drop'].includes(delivery.status) ? 'to_dropoff' : 'to_pickup';
  const target = phase === 'to_pickup' ? { x: order.pickup_lat, y: order.pickup_lng } : { x: order.delivery_lat, y: order.delivery_lng };
  const path = calculateRoute(pos, target, segs).path;
  const hypSegs: Segment[] = segs.map((s) => ({ ...s }));
  if (path.length >= 2) {
    const a = path[Math.min(1, path.length - 1)]; const b = path[Math.min(2, path.length - 1)];
    for (const s of hypSegs) {
      const onSeg = (s.ax === a.x && s.ay === a.y && s.bx === b.x && s.by === b.y) || (s.ax === b.x && s.ay === b.y && s.bx === a.x && s.by === a.y);
      if (onSeg) s.status = 'closed';
    }
  }

  const impacts: WhatIfImpact[] = [];
  for (const d of active) {
    const base = await projectDelivery(d, fleet, segs);
    const hyp = await projectDelivery(d, fleet, hypSegs);
    const baseSlack = slackMin(base.order.deadline_ts, base.projectedTotalMin);
    const hypSlack = slackMin(base.order.deadline_ts, hyp.projectedTotalMin);
    let status: WhatIfImpact['status'] = 'unaffected';
    let remedy: WhatIfImpact['remedy'] = { strategy: 'none', note: 'no change' };
    if (hypSlack == null) { status = 'broken'; remedy = { strategy: 'reassign', note: 'route becomes impassable for this driver' }; }
    else if (hypSlack < 0 && (baseSlack ?? 0) >= 0) {
      status = 'at_risk';
      const repl = ['picked_up', 'en_route_drop'].includes(d.status) ? null : bestReplacement(base.order, fleet, hypSegs, [d.driver_id ?? '']);
      remedy = repl && repl.slackMin >= 0
        ? { strategy: 'reassign', driver: repl.driver.name, projectedSlackMin: repl.slackMin, note: `reassign to ${repl.driver.name} (${repl.slackMin} min slack)` }
        : { strategy: 'reroute', projectedSlackMin: hypSlack, note: `keep the driver on the fastest detour (best effort, −${-hypSlack} min)` };
    } else if (hypSlack != null && baseSlack != null && hypSlack < baseSlack - 3) {
      status = 'at_risk';
      remedy = { strategy: 'reroute', projectedSlackMin: hypSlack, note: `detour costs ~${baseSlack - hypSlack} min but still on time` };
    }
    impacts.push({
      orderCode: code(base.order.id), deliveryId: d.id,
      currentDriver: base.driver?.name ?? '—', phase: base.phase,
      baselineSlackMin: baseSlack, projectedSlackMin: hypSlack, status, remedy,
    });
  }
  return {
    scenario: 'road_close',
    hypothesis: `close a road on ${code(orderId)}'s active route`,
    impacts,
    summary: summarise(impacts),
  };
}

function summarise(impacts: WhatIfImpact[]): WhatIfResult['summary'] {
  return {
    deliveries: impacts.length,
    atRisk: impacts.filter((i) => i.status === 'at_risk').length,
    broken: impacts.filter((i) => i.status === 'broken').length,
    autoRecoverable: impacts.filter((i) => i.status !== 'unaffected' && i.remedy.strategy !== 'none' && (i.remedy.projectedSlackMin ?? -1) >= 0).length,
    needsHuman: impacts.filter((i) => i.status === 'broken' && (i.remedy.strategy === 'none' || (i.remedy.projectedSlackMin ?? -1) < 0)).length,
  };
}
