import { resetDb, q } from '../db.js';
import { seed } from '../seed.js';
import {
  orders, drivers, deliveries, merchants, stores, customers,
} from '../repo.js';
import { minutesFromNow } from '../util.js';
import { simulateTick, injectTraffic } from '../services.js';
import { coordinator } from '../agents/coordinator.js';
import { baselineDispatch } from './baseline.js';
import { SCENARIOS, runScenario } from './scenarios.js';
import type { ScenarioMetrics } from './harness.js';

export interface ComparisonRow {
  scenario: string;
  autonomous: { delivered: number; onTime: number; avgDeliveryMin: number | null; recoveries: number };
  baseline: { delivered: number; onTime: number; avgDeliveryMin: number | null; recoveries: number };
}

export interface EvalReport {
  ranAt: string;
  durationMs: number;
  scenarios: ScenarioMetrics[];
  summary: {
    total: number; passed: number;
    golden: { total: number; passed: number };
    adversarial: { total: number; passed: number };
    totalUnsafeActions: number;
    totalToolErrors: number;
    totalEscalations: number;
  };
  comparison: {
    rows: ComparisonRow[];
    totals: {
      autonomous: { delivered: number; onTime: number; recoveries: number };
      baseline: { delivered: number; onTime: number; recoveries: number };
    };
  };
}

let lastReport: EvalReport | null = null;
let running = false;

export function getLastEvalReport(): EvalReport | null { return lastReport; }
export function evalRunning(): boolean { return running; }

/* -------------------------------------------------- comparison scenario set */

interface CompareCtx { merchantId: string; storeId: string; pickup: { lat: number; lng: number } }

async function freshCompareWorld(): Promise<CompareCtx> {
  await resetDb();
  await seed({ reset: true });
  const m = (await merchants.list())[0];
  const s = (await stores.byMerchant(m.id))[0];
  return { merchantId: m.id, storeId: s.id, pickup: { lat: s.pickup_lat, lng: s.pickup_lng } };
}

async function mkOrder(ctx: CompareCtx, lat: number, lng: number, deadlineMin: number, priority: 'standard' | 'express' = 'standard'): Promise<string> {
  const c = await customers.create('Compare Customer');
  const o = await orders.create({
    merchant_id: ctx.merchantId, store_id: ctx.storeId, customer_id: c.id,
    pickup_lat: ctx.pickup.lat, pickup_lng: ctx.pickup.lng, delivery_lat: lat, delivery_lng: lng,
    priority, deadline_ts: minutesFromNow(deadlineMin), package_size: 'small', volume: 1, note: null,
  });
  await orders.setStatus(o.id, 'ready', 'created');
  return o.id;
}

type Mode = 'autonomous' | 'baseline';

const COMPARE_CASES: { name: string; run: (ctx: CompareCtx, mode: Mode) => Promise<string[]> }[] = [
  {
    name: 'Standard delivery',
    run: async (ctx, mode) => {
      const id = await mkOrder(ctx, 18, 17, 120);
      if (mode === 'autonomous') await coordinator.dispatchOrder(id); else await baselineDispatch(id);
      for (let i = 0; i < 45; i++) await simulateTick({ monitor: mode === 'autonomous' });
      return [id];
    },
  },
  {
    name: 'Express delivery',
    run: async (ctx, mode) => {
      const id = await mkOrder(ctx, 6, 14, 70, 'express');
      if (mode === 'autonomous') await coordinator.dispatchOrder(id); else await baselineDispatch(id);
      for (let i = 0; i < 45; i++) await simulateTick({ monitor: mode === 'autonomous' });
      return [id];
    },
  },
  {
    name: 'Driver drops out mid-delivery',
    run: async (ctx, mode) => {
      const id = await mkOrder(ctx, 18, 17, 120);
      let first: string | undefined;
      if (mode === 'autonomous') first = (await coordinator.dispatchOrder(id)).decision?.driverId;
      else first = (await baselineDispatch(id)).driverId;
      await simulateTick({ monitor: mode === 'autonomous' });
      if (first) await drivers.setStatus(first, 'offline');
      for (let i = 0; i < 40; i++) await simulateTick({ monitor: mode === 'autonomous' });
      return [id];
    },
  },
  {
    name: 'Road closure on the route',
    run: async (ctx, mode) => {
      const id = await mkOrder(ctx, 18, 17, 120);
      if (mode === 'autonomous') await coordinator.dispatchOrder(id); else await baselineDispatch(id);
      await simulateTick({ monitor: mode === 'autonomous' });
      try { await injectTraffic({ blockRouteOf: id, severity: 'major' }); } catch { /* no route yet */ }
      for (let i = 0; i < 40; i++) await simulateTick({ monitor: mode === 'autonomous' });
      return [id];
    },
  },
];

async function measure(orderIds: string[]): Promise<{ delivered: number; onTime: number; avgDeliveryMin: number | null; recoveries: number }> {
  let delivered = 0; let onTime = 0; const mins: number[] = [];
  for (const id of orderIds) {
    const [o, dv] = await Promise.all([orders.byId(id), deliveries.byOrderId(id)]);
    if (dv?.status === 'delivered') {
      delivered++;
      if (dv.actual_delivery_minutes != null) mins.push(dv.actual_delivery_minutes);
      if (o && dv.delivered_at && Date.parse(dv.delivered_at) <= Date.parse(o.deadline_ts)) onTime++;
    }
  }
  let recoveries = 0;
  if (orderIds.length) {
    const rec = await q<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM agent_events
       WHERE event_type IN ('reroute_applied','reassign_applied')
         AND order_id IN (${orderIds.map(() => '?').join(',')})`, orderIds);
    recoveries = Number(rec[0]?.n ?? 0);
  }
  return {
    delivered, onTime,
    avgDeliveryMin: mins.length ? Number((mins.reduce((a, b) => a + b, 0) / mins.length).toFixed(1)) : null,
    recoveries,
  };
}

async function runComparison(): Promise<EvalReport['comparison']> {
  const rows: ComparisonRow[] = [];
  const totals = {
    autonomous: { delivered: 0, onTime: 0, recoveries: 0 },
    baseline: { delivered: 0, onTime: 0, recoveries: 0 },
  };
  for (const c of COMPARE_CASES) {
    const aCtx = await freshCompareWorld();
    const aIds = await c.run(aCtx, 'autonomous');
    const a = await measure(aIds);
    const bCtx = await freshCompareWorld();
    const bIds = await c.run(bCtx, 'baseline');
    const b = await measure(bIds);
    rows.push({ scenario: c.name, autonomous: a, baseline: b });
    totals.autonomous.delivered += a.delivered; totals.autonomous.onTime += a.onTime; totals.autonomous.recoveries += a.recoveries;
    totals.baseline.delivered += b.delivered; totals.baseline.onTime += b.onTime; totals.baseline.recoveries += b.recoveries;
  }
  return { rows, totals };
}

/* --------------------------------------------------------------- entrypoint */

export async function runEvaluation(): Promise<EvalReport> {
  if (running) return lastReport ?? emptyReport();
  running = true;
  const started = Date.now();
  try {
    const results: ScenarioMetrics[] = [];
    for (const s of SCENARIOS) {
      try { results.push(await runScenario(s)); }
      catch (err) {
        results.push({
          scenarioId: s.id, name: s.name, kind: s.kind, passed: false,
          detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
          deadlineMet: null, delivered: false, unsafeActions: 0, toolErrors: 0,
          escalations: 0, autonomousActions: 0, reassignments: 0, routeChanges: 0, planningMs: 0,
        });
      }
    }
    const comparison = await runComparison();

    const golden = results.filter((r) => r.kind === 'golden');
    const adversarial = results.filter((r) => r.kind === 'adversarial');
    const report: EvalReport = {
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      scenarios: results,
      summary: {
        total: results.length,
        passed: results.filter((r) => r.passed).length,
        golden: { total: golden.length, passed: golden.filter((r) => r.passed).length },
        adversarial: { total: adversarial.length, passed: adversarial.filter((r) => r.passed).length },
        totalUnsafeActions: results.reduce((n, r) => n + r.unsafeActions, 0),
        totalToolErrors: results.reduce((n, r) => n + r.toolErrors, 0),
        totalEscalations: results.reduce((n, r) => n + r.escalations, 0),
      },
      comparison,
    };
    lastReport = report;

    // restore the demo world for the operator
    await resetDb();
    await seed({ reset: true });
    return report;
  } finally {
    running = false;
  }
}

function emptyReport(): EvalReport {
  return {
    ranAt: new Date().toISOString(), durationMs: 0, scenarios: [],
    summary: { total: 0, passed: 0, golden: { total: 0, passed: 0 }, adversarial: { total: 0, passed: 0 }, totalUnsafeActions: 0, totalToolErrors: 0, totalEscalations: 0 },
    comparison: { rows: [], totals: { autonomous: { delivered: 0, onTime: 0, recoveries: 0 }, baseline: { delivered: 0, onTime: 0, recoveries: 0 } } },
  };
}
