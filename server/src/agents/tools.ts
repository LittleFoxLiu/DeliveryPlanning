/**
 * Concrete tool definitions for the registry. Each is a thin typed wrapper over
 * a deterministic engine or repo function — the LLM never runs these, agents do,
 * and every call is recorded. Execution tools live in `execution.ts`.
 */
import { orders, drivers, deliveries, stores, customers, merchants, roads } from '../repo.js';
import { estimateDeliveryTime, type Point } from '../engine/routing.js';
import { calculateGeoRoute, estimateGeoDelivery } from '../engine/geoRouting.js';
import { scoreDriver, compareAssignments, type ScoreBreakdown } from '../engine/scoring.js';
import { driverAgent } from './driverAgent.js';
import { orderAgent } from './orderAgent.js';
import { routingAgent } from './routingAgent.js';
import { defineTool, obj, reqStr, idLike } from './toolRegistry.js';

/* --------------------------------------------------------------- Order Agent */

export const tGetOrder = defineTool({
  name: 'order.get',
  description: 'Fetch an order and its store/customer context.',
  access: 'read',
  allowed: ['OrderAgent', 'Coordinator'],
  input: (raw) => ({ orderId: idLike(reqStr(obj(raw, ['orderId'], 'order.get'), 'orderId', 'order.get'), 'ord', 'order.get') }),
  summariseInput: (i) => i.orderId,
  run: async ({ orderId }) => {
    const o = await orders.byId(orderId);
    if (!o) throw new Error('order_not_found');
    const [store, customer] = await Promise.all([stores.byId(o.store_id), customers.byId(o.customer_id)]);
    return {
      id: o.id, status: o.status, priority: o.priority, packageSize: o.package_size, volume: o.volume,
      deadlineTs: o.deadline_ts, note: o.note,
      pickup: { x: o.pickup_lat, y: o.pickup_lng }, dropoff: { x: o.delivery_lat, y: o.delivery_lng },
      storeName: store?.name ?? null, customerName: customer?.name ?? 'Customer',
    };
  },
  summariseOutput: (o) => `${o.status} · ${o.priority} · ${o.packageSize}`,
});

export const tValidateOrder = defineTool({
  name: 'order.validate',
  description: 'Run deterministic order validation (entities, coords, deadline).',
  access: 'read',
  allowed: ['OrderAgent'],
  input: (raw) => ({ orderId: idLike(reqStr(obj(raw, ['orderId'], 'order.validate'), 'orderId', 'order.validate'), 'ord', 'order.validate') }),
  summariseInput: (i) => i.orderId,
  run: ({ orderId }) => orderAgent.tools.validate_order(orderId),
  summariseOutput: (v) => (v.ok ? 'valid' : `invalid: ${v.issues.join(', ')}`),
});

export const tOrderConstraints = defineTool({
  name: 'order.constraints',
  description: 'Derive package size / volume / priority / deadline / waypoints.',
  access: 'read',
  allowed: ['OrderAgent', 'DispatchAgent', 'Coordinator'],
  input: (raw) => ({ orderId: idLike(reqStr(obj(raw, ['orderId'], 'order.constraints'), 'orderId', 'order.constraints'), 'ord', 'order.constraints') }),
  run: ({ orderId }) => orderAgent.tools.get_order_constraints(orderId),
});

/* -------------------------------------------------------------- Driver Agent */

export const tListEligibleDrivers = defineTool({
  name: 'drivers.list_eligible',
  description: 'Filter the fleet to drivers eligible for an order (status, location, capacity, vehicle, load).',
  access: 'read',
  allowed: ['DriverAgent'],
  input: (raw) => {
    const o = obj(raw, ['orderId', 'excludeDriverIds'], 'drivers.list_eligible');
    const exclude = Array.isArray(o.excludeDriverIds) ? o.excludeDriverIds.map((v) => idLike(String(v), 'drv', 'drivers.list_eligible')) : [];
    return { orderId: idLike(reqStr(o, 'orderId', 'drivers.list_eligible'), 'ord', 'drivers.list_eligible'), excludeDriverIds: exclude };
  },
  summariseInput: (i) => `${i.orderId}${i.excludeDriverIds.length ? ` (exclude ${i.excludeDriverIds.length})` : ''}`,
  run: async ({ orderId, excludeDriverIds }) => {
    const order = await orders.byId(orderId);
    if (!order) throw new Error('order_not_found');
    const res = await driverAgent.findCandidates(order, `tool_${orderId}`, excludeDriverIds, true);
    return {
      eligible: res.candidates.map((c) => ({
        driverId: c.driver.id, name: c.driver.name, vehicleType: c.driver.vehicle_type,
        maxPackageSize: c.driver.max_package_size, capacity: c.driver.capacity,
        currentOrderCount: c.driver.current_order_count, headroom: c.headroom, status: c.driver.status,
        location: { x: c.location.lat, y: c.location.lng },
      })),
      rejected: res.rejected,
    };
  },
  summariseOutput: (v) => `${v.eligible.length} eligible, ${v.rejected.length} filtered`,
});

export const tDriverState = defineTool({
  name: 'driver.get_state',
  description: 'Live status / capacity / vehicle / position for one driver.',
  access: 'read',
  allowed: ['DriverAgent', 'MonitoringAgent', 'Coordinator'],
  input: (raw) => ({ driverId: idLike(reqStr(obj(raw, ['driverId'], 'driver.get_state'), 'driverId', 'driver.get_state'), 'drv', 'driver.get_state') }),
  run: async ({ driverId }) => {
    const d = await drivers.byId(driverId);
    if (!d) throw new Error('driver_not_found');
    return {
      id: d.id, name: d.name, status: d.status, vehicleType: d.vehicle_type,
      maxPackageSize: d.max_package_size, capacity: d.capacity, currentOrderCount: d.current_order_count,
      location: d.lat != null ? { x: d.lat, y: d.lng } : null,
    };
  },
});

/* ------------------------------------------------------------- Routing Agent */

export const tEstimateDelivery = defineTool({
  name: 'routing.estimate_delivery',
  description: 'Authoritative geo-routed driver→pickup→customer distance and ETA; traffic is currently ignored.',
  access: 'read',
  allowed: ['RoutingAgent', 'DispatchAgent'],
  input: (raw) => {
    const o = obj(raw, ['driverId', 'orderId'], 'routing.estimate_delivery');
    return {
      driverId: idLike(reqStr(o, 'driverId', 'routing.estimate_delivery'), 'drv', 'routing.estimate_delivery'),
      orderId: idLike(reqStr(o, 'orderId', 'routing.estimate_delivery'), 'ord', 'routing.estimate_delivery'),
    };
  },
  summariseInput: (i) => `${i.driverId} → ${i.orderId}`,
  run: async ({ driverId, orderId }) => {
    const [d, o] = await Promise.all([drivers.byId(driverId), orders.byId(orderId)]);
    if (!d || d.lat == null) throw new Error('driver_position_unknown');
    if (!o) throw new Error('order_not_found');
    const store = await stores.byId(o.store_id);
    const est = d.geo_lat != null && d.geo_lng != null && store?.geo_lat != null && store.geo_lng != null && o.delivery_geo_lat != null && o.delivery_geo_lng != null
      ? await estimateGeoDelivery({ lat: d.geo_lat, lon: d.geo_lng }, { lat: store.geo_lat, lon: store.geo_lng }, { lat: o.delivery_geo_lat, lon: o.delivery_geo_lng })
      : { toPickup: { path: [], distanceKm: Infinity, etaMinutes: Infinity, baselineMinutes: Infinity, trafficPenaltyMinutes: 0, reachable: false, blockedSegments: [] }, toDropoff: { path: [], distanceKm: Infinity, etaMinutes: Infinity, baselineMinutes: Infinity, trafficPenaltyMinutes: 0, reachable: false, blockedSegments: [] }, handlingMinutes: 3, totalMinutes: Infinity, totalDistanceKm: Infinity, reachable: false };
    return {
      reachable: est.reachable,
      etaToPickupMin: est.reachable ? est.toPickup.etaMinutes : null,
      etaToCustomerMin: est.reachable ? est.toDropoff.etaMinutes : null,
      totalMin: est.reachable ? est.totalMinutes : null,
      distanceKm: est.totalDistanceKm,
      trafficPenaltyMin: est.reachable
        ? Number((est.toPickup.trafficPenaltyMinutes + est.toDropoff.trafficPenaltyMinutes).toFixed(1)) : null,
      blockedSegments: [...est.toPickup.blockedSegments, ...est.toDropoff.blockedSegments],
    };
  },
  summariseOutput: (v) => (v.reachable ? `${v.totalMin} min total (+${v.trafficPenaltyMin} traffic)` : 'unreachable'),
});

export const tTrafficState = defineTool({
  name: 'routing.traffic_state',
  description: 'Current per-segment incidents and area conditions.',
  access: 'read',
  allowed: ['RoutingAgent', 'MonitoringAgent', 'Coordinator'],
  input: (raw) => { obj(raw ?? {}, [], 'routing.traffic_state'); return {}; },
  run: () => routingAgent.tools.get_traffic_conditions(),
  summariseOutput: (v) => `${v.summary.closed} closed, ${v.summary.heavy} heavy, ${v.summary.moderate} moderate`,
});

/* ------------------------------------------------------------ Dispatch Agent */

export interface ScoredCandidate {
  driverId: string;
  name: string;
  breakdown: ScoreBreakdown;
}

export const tScoreCandidates = defineTool({
  name: 'dispatch.score_candidates',
  description: 'Deterministic weighted score for each routed candidate (ETA/efficiency/deadline/workload/vehicle/distance).',
  access: 'read',
  allowed: ['DispatchAgent'],
  input: (raw) => {
    const o = obj(raw, ['orderId', 'candidates'], 'dispatch.score_candidates');
    const candidates = (Array.isArray(o.candidates) ? o.candidates : []).map((c) => {
      const cc = obj(c, ['driverId'], 'dispatch.score_candidates');
      return { driverId: idLike(reqStr(cc, 'driverId', 'dispatch.score_candidates'), 'drv', 'dispatch.score_candidates') };
    });
    return { orderId: idLike(reqStr(o, 'orderId', 'dispatch.score_candidates'), 'ord', 'dispatch.score_candidates'), candidates };
  },
  summariseInput: (i) => `${i.candidates.length} candidates for ${i.orderId}`,
  run: async ({ orderId, candidates }): Promise<{ scored: ScoredCandidate[]; winnerId: string | null; rationale: string; margin: number }> => {
    const [order, fleet] = await Promise.all([orders.byId(orderId), drivers.all()]);
    if (!order) throw new Error('order_not_found');
    const byId = new Map(fleet.map((d) => [d.id, d]));
    const scored: ScoredCandidate[] = [];
    for (const { driverId } of candidates) {
      const d = byId.get(driverId);
      if (!d || d.lat == null) continue;
      const store = await stores.byId(order.store_id);
      const est = d.geo_lat != null && d.geo_lng != null && store?.geo_lat != null && store.geo_lng != null && order.delivery_geo_lat != null && order.delivery_geo_lng != null
        ? await estimateGeoDelivery({ lat: d.geo_lat, lon: d.geo_lng }, { lat: store.geo_lat, lon: store.geo_lng }, { lat: order.delivery_geo_lat, lon: order.delivery_geo_lng })
        : { toPickup: { path: [], distanceKm: Infinity, etaMinutes: Infinity, baselineMinutes: Infinity, trafficPenaltyMinutes: 0, reachable: false, blockedSegments: [] }, toDropoff: { path: [], distanceKm: Infinity, etaMinutes: Infinity, baselineMinutes: Infinity, trafficPenaltyMinutes: 0, reachable: false, blockedSegments: [] }, handlingMinutes: 3, totalMinutes: Infinity, totalDistanceKm: Infinity, reachable: false };
      const breakdown = scoreDriver(
        { orderId: order.id, packageSize: order.package_size, volume: order.volume, priority: order.priority, deadlineTs: order.deadline_ts },
        { driverId: d.id, name: d.name, status: d.status, vehicleType: d.vehicle_type, maxPackageSize: d.max_package_size, capacity: d.capacity, currentOrderCount: d.current_order_count },
        est,
      );
      scored.push({ driverId: d.id, name: d.name, breakdown });
    }
    const cmp = compareAssignments(scored.map((s) => s.breakdown));
    return { scored, winnerId: cmp.winner?.driverId ?? null, rationale: cmp.rationale, margin: cmp.margin };
  },
  summariseOutput: (v) => (v.winnerId ? `winner ${v.winnerId} (margin ${v.margin})` : 'no winner'),
});

/* ---------------------------------------------------------- Monitoring Agent */

export const tAssessDelivery = defineTool({
  name: 'monitoring.assess_delivery',
  description: 'Re-estimate an in-flight delivery from the driver’s current position and classify risk.',
  access: 'read',
  allowed: ['MonitoringAgent'],
  input: (raw) => ({ deliveryId: idLike(reqStr(obj(raw, ['deliveryId'], 'monitoring.assess_delivery'), 'deliveryId', 'monitoring.assess_delivery'), 'dlv', 'monitoring.assess_delivery') }),
  run: async ({ deliveryId }) => {
    const dv = await deliveries.byId(deliveryId);
    if (!dv) throw new Error('delivery_not_found');
    const [order, driver] = await Promise.all([
      orders.byId(dv.order_id), dv.driver_id ? drivers.byId(dv.driver_id) : Promise.resolve(undefined),
    ]);
    if (!order) throw new Error('order_not_found');
    const phase: 'to_pickup' | 'to_dropoff' = ['picked_up', 'en_route_drop'].includes(dv.status) ? 'to_dropoff' : 'to_pickup';
    if (!driver || driver.status === 'offline' || driver.lat == null) {
      return { phase, driverAvailable: false, reachable: false, projectedTotalMin: null, deadlineMs: Date.parse(order.deadline_ts), missesDeadline: true, slipMin: 9999 };
    }
    const store = await stores.byId(order.store_id);
    const hasGeo = driver.geo_lat != null && driver.geo_lng != null && store?.geo_lat != null && store.geo_lng != null
      && order.delivery_geo_lat != null && order.delivery_geo_lng != null;
    if (!hasGeo) return { phase, driverAvailable: true, reachable: false, projectedTotalMin: null, deadlineMs: Date.parse(order.deadline_ts), missesDeadline: true, slipMin: 9999 };
    const projected = phase === 'to_dropoff'
      ? (await calculateGeoRoute({ lat: driver.geo_lat!, lon: driver.geo_lng! }, { lat: order.delivery_geo_lat!, lon: order.delivery_geo_lng! })).etaMinutes
      : (await estimateGeoDelivery({ lat: driver.geo_lat!, lon: driver.geo_lng! }, { lat: store.geo_lat!, lon: store.geo_lng! }, { lat: order.delivery_geo_lat!, lon: order.delivery_geo_lng! })).totalMinutes;
    const reachable = Number.isFinite(projected);
    const deadlineMs = Date.parse(order.deadline_ts);
    const projectedDoneMs = Date.now() + (reachable ? projected * 60_000 : 9e12);
    const originalEta = dv.estimated_delivery_minutes ?? projected;
    const slipMin = Math.round(projected - originalEta);
    return {
      phase, driverAvailable: true, reachable,
      projectedTotalMin: reachable ? Number(projected.toFixed(1)) : null,
      deadlineMs, missesDeadline: projectedDoneMs > deadlineMs, slipMin,
    };
  },
  summariseOutput: (v) => (!v.driverAvailable ? 'driver unavailable'
    : v.missesDeadline ? `misses deadline (slip ${v.slipMin} min)` : `on track (slip ${v.slipMin} min)`),
});

/* -------------------------------------------------------------- Coordinator */

export const tNetworkState = defineTool({
  name: 'network.state',
  description: 'Fleet + active deliveries + incidents snapshot for the Coordinator.',
  access: 'read',
  allowed: ['Coordinator'],
  input: (raw) => { obj(raw ?? {}, [], 'network.state'); return {}; },
  run: async () => {
    const [fleet, active, incidents] = await Promise.all([
      drivers.all(), deliveries.active(),
      roads.all().then((rs) => rs.filter((r) => r.status !== 'clear')),
    ]);
    return {
      driversTotal: fleet.length,
      driversAvailable: fleet.filter((d) => d.status === 'available').length,
      deliveriesInFlight: active.filter((d) => ['assigned', 'en_route_pickup', 'picked_up', 'en_route_drop'].includes(d.status)).length,
      roadIncidents: incidents.length,
    };
  },
  summariseOutput: (v) => `${v.driversAvailable}/${v.driversTotal} free, ${v.deliveriesInFlight} in flight, ${v.roadIncidents} incidents`,
});

/** Force registration side-effects. */
export const ALL_TOOLS = [
  tGetOrder, tValidateOrder, tOrderConstraints,
  tListEligibleDrivers, tDriverState,
  tEstimateDelivery, tTrafficState,
  tScoreCandidates, tAssessDelivery, tNetworkState,
];
