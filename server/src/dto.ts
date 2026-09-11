import {
  orders, deliveries, drivers, routes, assignments, customers, stores,
  type OrderRow, type DeliveryRow, type DriverFull,
} from './repo.js';
import { listEvents } from './events.js';
import type { PlanningRun } from './agents/protocol.js';
import { latestRunForOrder } from './agents/runStore.js';

export async function orderView(o: OrderRow) {
  const [items, customer, store] = await Promise.all([
    orders.items(o.id), customers.byId(o.customer_id), stores.byId(o.store_id),
  ]);
  return {
    id: o.id,
    code: `#${o.id.replace(/^ord_/, '').slice(-6).toUpperCase()}`,
    merchantId: o.merchant_id,
    storeId: o.store_id,
    storeName: store?.name ?? null,
    customerId: o.customer_id,
    customerName: customer?.name ?? 'Customer',
    status: o.status,
    priority: o.priority,
    packageSize: o.package_size,
    volume: o.volume,
    deadlineTs: o.deadline_ts,
    note: o.note,
    pickup: { lat: o.pickup_latitude, lon: o.pickup_longitude, address: store?.address ?? null },
    dropoff: { lat: o.delivery_latitude, lon: o.delivery_longitude, address: o.delivery_address },
    createdAt: o.created_at,
    readyAt: o.ready_at,
    items,
    itemsTotalCents: items.reduce((n, i) => n + i.qty * (i.unitPriceCents ?? 0), 0),
  };
}

export function deliveryView(d: DeliveryRow) {
  return {
    id: d.id,
    orderId: d.order_id,
    driverId: d.driver_id,
    status: d.status,
    assignedAt: d.assigned_at,
    pickupAt: d.pickup_at,
    deliveredAt: d.delivered_at,
    estimatedDeliveryMinutes: d.estimated_delivery_minutes,
    actualDeliveryMinutes: d.actual_delivery_minutes,
    etaTs: d.eta_ts,
    routeId: d.route_id,
  };
}

export async function activeRouteView(deliveryId: string) {
  const route = await routes.activeForDelivery(deliveryId);
  if (!route) return null;
  return {
    id: route.id,
    origin: { lat: route.origin_latitude, lon: route.origin_longitude },
    distanceKm: route.distance_km,
    etaMinutes: route.eta_minutes,
    legs: route.legs_json,
    path: route.path_json,
    createdAt: route.created_at,
  };
}

/** Full driver record — admin / dispatch only. */
export function driverAdminView(d: DriverFull) {
  return {
    id: d.id,
    name: d.name,
    vehicleType: d.vehicle_type,
    capacity: d.capacity,
    maxPackageSize: d.max_package_size,
    status: d.status,
    currentOrderCount: d.current_order_count,
    location: d.latitude != null ? { lat: d.latitude, lon: d.longitude!, address: d.location_address } : null,
    locationAt: d.location_at,
  };
}

/** Minimal driver info safe to show a customer tracking their order. */
export function driverPublicView(d: DriverFull | undefined) {
  if (!d) return null;
  return {
    firstName: d.name.split(' ')[0],
    vehicleType: d.vehicle_type,
  };
}

export async function assignmentReasoningView(orderId: string) {
  const list = await assignments.forOrder(orderId);
  const names = new Map((await drivers.all()).map((d) => [d.id, d.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const humanize = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\bdrv_[a-z0-9]{6,40}\b/gi, (m) => nameOf(m));
    if (Array.isArray(v)) return v.map(humanize);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, humanize(val)]));
    return v;
  };
  return list.map((a) => {
    const reasoning = humanize(a.reasoning_json) as Record<string, unknown> & { selected?: string };
    return {
      id: a.id,
      driverId: a.driver_id,
      driverName: nameOf(a.driver_id),
      status: a.status,
      score: a.score,
      createdAt: a.created_at,
      reasoning: { ...reasoning, selectedName: a.driver_id ? nameOf(a.driver_id) : null },
    };
  });
}

export async function orderTrackingView(o: OrderRow) {
  const delivery = await deliveries.byOrderId(o.id);
  const driver = delivery?.driver_id ? await drivers.byId(delivery.driver_id) : undefined;
  const [items, events, run, store] = await Promise.all([
    orders.items(o.id), listEvents({ orderId: o.id, limit: 40 }), latestRunForOrder(o.id), stores.byId(o.store_id),
  ]);
  const route = delivery ? await activeRouteView(delivery.id) : null;
  return {
    order: {
      id: o.id, status: o.status, priority: o.priority, deadlineTs: o.deadline_ts,
      pickup: { lat: o.pickup_latitude, lon: o.pickup_longitude, address: store?.address ?? null },
      dropoff: { lat: o.delivery_latitude, lon: o.delivery_longitude, address: o.delivery_address }, items,
    },
    delivery: delivery
      ? {
        status: delivery.status,
        etaTs: delivery.eta_ts,
        estimatedDeliveryMinutes: delivery.estimated_delivery_minutes,
        pickupAt: delivery.pickup_at,
        deliveredAt: delivery.delivered_at,
        driver: driverPublicView(driver),
        driverPosition: driver && driver.latitude != null && ['en_route_pickup', 'picked_up', 'en_route_drop'].includes(delivery.status)
          ? { lat: driver.latitude, lon: driver.longitude! } : null,
        route,
      }
      : null,
    events: events
      .filter((e) => e.eventType !== 'candidates_evaluated')
      .map((e) => ({ ts: e.ts, agent: e.agent, message: e.message })),
    run: run ? publicRunView(run) : null,
  };
}

/* --------------------------------------------------- autonomous run traces */

export interface RunTraceEntry {
  ts: string;
  phase: 'tool' | 'proposal' | 'critique' | 'revision' | 'decision' | 'execution' | 'risk';
  agent: string;
  label: string;
  detail: string;
  evidence?: { label: string; value: string | number | boolean }[];
}

/** Full, judge-facing decision trace for one planning run. Structured, never
 *  hidden chain-of-thought — just typed messages + the evidence behind them. */
export function runTraceView(run: PlanningRun) {
  const entries: RunTraceEntry[] = [];

  for (const t of run.toolCalls) {
    entries.push({
      ts: t.ts, phase: 'tool', agent: t.agent,
      label: `${t.tool} (${t.access})`,
      detail: t.ok ? `→ ${t.outputSummary}` : `✗ ${t.error ?? 'failed'}`,
    });
  }
  for (const p of run.proposals) {
    const isRevision = run.revisions.some((r) => r.newProposal.id === p.id);
    entries.push({
      ts: p.ts, phase: isRevision ? 'revision' : 'proposal', agent: p.agent,
      label: isRevision ? `REVISED → ${p.action}` : `PROPOSED ${p.action}`,
      detail: p.summary,
      evidence: p.evidence.map((e) => ({ label: e.label, value: e.value })),
    });
  }
  for (const c of run.critiques) {
    entries.push({
      ts: c.ts, phase: 'critique', agent: c.agent,
      label: c.supported ? 'SUPPORTED' : 'OBJECTED',
      detail: c.supported
        ? (c.evidence[0] ? `${c.evidence[0].label}: ${c.evidence[0].value}` : 'proposal upheld')
        : c.objections.join('; ') + (c.alternative ? ` → suggests ${c.alternative.target ?? c.alternative.action}` : ''),
      evidence: c.evidence.map((e) => ({ label: e.label, value: e.value })),
    });
  }
  if (run.riskAssessment) {
    entries.push({
      ts: run.decision?.ts ?? run.startedAt, phase: 'risk', agent: 'Coordinator',
      label: `RISK ${run.riskAssessment.level.toUpperCase()}`,
      detail: run.riskAssessment.reasons.join(' '),
    });
  }
  if (run.decision) {
    entries.push({
      ts: run.decision.ts, phase: 'decision', agent: 'Coordinator',
      label: `DECISION — ${run.decision.mode}`,
      detail: run.decision.explanation,
      evidence: run.decision.policyChecks.map((c) => ({ label: c.name, value: c.passed ? `pass (${c.detail})` : `FAIL (${c.detail})` })),
    });
  }
  if (run.execution) {
    entries.push({
      ts: run.execution.ts, phase: 'execution', agent: 'Coordinator',
      label: run.execution.ok ? 'EXECUTED' : 'EXECUTION BLOCKED',
      detail: run.execution.detail + (run.execution.etaMinutes != null ? ` — ETA ${Math.round(run.execution.etaMinutes)} min` : ''),
    });
  }

  entries.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    orderId: run.orderId,
    deliveryId: run.deliveryId,
    orderCode: run.context.orderCode ?? null,
    trigger: run.context.trigger,
    risk: run.riskAssessment,
    decision: run.decision ? {
      mode: run.decision.mode, action: run.decision.action, target: run.decision.target,
      explanation: run.decision.explanation, policyChecks: run.decision.policyChecks,
    } : null,
    execution: run.execution,
    escalationId: run.escalationId,
    counts: {
      toolCalls: run.toolCalls.length,
      toolErrors: run.toolCalls.filter((t) => !t.ok).length,
      proposals: run.proposals.length,
      critiques: run.critiques.length,
      revisions: run.revisions.length,
    },
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    timeline: entries,
  };
}

export function runSummaryView(run: PlanningRun) {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    orderCode: run.context.orderCode ?? null,
    orderId: run.orderId,
    trigger: run.context.trigger,
    risk: run.riskAssessment?.level ?? null,
    mode: run.decision?.mode ?? null,
    action: run.decision?.action ?? null,
    escalationId: run.escalationId,
    counts: {
      toolCalls: run.toolCalls.length,
      proposals: run.proposals.length,
      critiques: run.critiques.length,
      revisions: run.revisions.length,
    },
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}

/** Trimmed, customer/merchant-safe view — the story without internal gates. */
export function publicRunView(run: PlanningRun) {
  const full = runTraceView(run);
  return {
    id: full.id,
    status: full.status,
    decisionMode: full.decision?.mode ?? null,
    timeline: full.timeline
      .filter((e) => e.phase !== 'tool' && e.phase !== 'risk')
      .map((e) => ({ ts: e.ts, agent: e.agent, label: e.label, detail: e.detail })),
  };
}
