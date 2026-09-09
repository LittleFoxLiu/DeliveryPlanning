import { orders, deliveries, routes, drivers, assignments, type OrderRow } from '../repo.js';
import { emitAgentEvent } from '../events.js';
import { id, minutesFromNow } from '../util.js';
import { driverAgent } from './driverAgent.js';
import { routingAgent } from './routingAgent.js';
import { dispatchTools, type DispatchDecision } from './dispatchAgent.js';
import { monitoringAgent, type Finding } from './monitoringAgent.js';
import { adviseRemediation } from './llm.js';
import type { Point } from '../engine/routing.js';
import { runDispatchLoop } from './dispatchLoop.js';
import {
  createRun, checkpoint, finishRun, setRisk, setDecision, createEscalation,
} from './runStore.js';
import { pid, type PlanningRun, type AgentProposal, type ActionKind } from './protocol.js';
import { classifyRisk, validateAction, decideExecution } from './policy.js';

const NAME = 'Coordinator';

export interface DispatchOutcome {
  cycleId: string;
  runId: string;
  orderId: string;
  status: 'assigned' | 'no_driver' | 'invalid' | 'reused' | 'escalated';
  decision?: DispatchDecision;
  issues?: string[];
}

/** SILENT what-if scoring for an alternative driver — no agent events emitted.
 *  Lets the Coordinator compare a (late) reroute against a reassignment. */
async function bestAlternative(order: OrderRow, excludeDriverIds: string[], cycleId: string) {
  const { candidates } = await driverAgent.findCandidates(order, cycleId, excludeDriverIds, true);
  const routed = await routingAgent.computeCandidateRoutes(order, candidates, cycleId, true);
  const breakdowns = routed.map(({ candidate, estimate }) => dispatchTools.score_driver(
    { orderId: order.id, packageSize: order.package_size, volume: order.volume, priority: order.priority, deadlineTs: order.deadline_ts },
    {
      driverId: candidate.driver.id, name: candidate.driver.name, status: candidate.driver.status,
      vehicleType: candidate.driver.vehicle_type, maxPackageSize: candidate.driver.max_package_size,
      capacity: candidate.driver.capacity, currentOrderCount: candidate.driver.current_order_count,
    },
    estimate,
  ));
  return dispatchTools.compare_assignments(breakdowns).winner;
}

export const coordinator = {
  name: NAME,

  /** Full multi-agent dispatch reasoning loop for a freshly-ready order. */
  async dispatchOrder(orderId: string, opts: { idempotencyKey?: string | null } = {}): Promise<DispatchOutcome> {
    const cycleId = id('cyc');
    const order = await orders.byId(orderId);
    if (!order) return { cycleId, runId: '', orderId, status: 'invalid', issues: ['order_not_found'] };

    // Idempotent short-circuit — covers concurrent triggers.
    if (['assigned', 'picked_up', 'delivering'].includes(order.status)) {
      const active = await assignments.activeForOrder(orderId);
      if (active) {
        return {
          cycleId, runId: '', orderId, status: 'reused',
          decision: { assigned: true, driverId: active.driver_id, deliveryId: (await deliveries.byOrderId(orderId))?.id, score: active.score, ranked: [], rationale: 'already assigned', reused: true },
        };
      }
    }
    if (['delivered', 'cancelled'].includes(order.status)) {
      return { cycleId, runId: '', orderId, status: 'invalid', issues: [`order_${order.status}`] };
    }

    const result = await runDispatchLoop({
      orderId, kind: 'dispatch', idempotencyKey: opts.idempotencyKey ?? null, correlationId: cycleId,
    });

    if (result.status === 'invalid') {
      return { cycleId, runId: result.runId, orderId, status: 'invalid', issues: [result.rationale] };
    }
    if (result.status === 'escalated') {
      // leave the order dispatchable for a human / a later cycle
      try { await orders.setStatus(orderId, 'validated', 'dispatching'); } catch { /* moved */ }
      return {
        cycleId, runId: result.runId, orderId, status: 'escalated',
        decision: { assigned: false, ranked: [], rationale: result.rationale },
      };
    }
    if (!result.assigned) {
      try { await orders.setStatus(orderId, 'validated', 'dispatching'); } catch { /* moved */ }
      return {
        cycleId, runId: result.runId, orderId, status: 'no_driver',
        decision: { assigned: false, ranked: [], rationale: result.rationale },
      };
    }
    return {
      cycleId, runId: result.runId, orderId, status: 'assigned',
      decision: {
        assigned: true, driverId: result.driverId, deliveryId: result.deliveryId,
        score: result.score, ranked: [], rationale: result.rationale,
      },
    };
  },

  /** One monitoring pass over all active deliveries + remediation. */
  async runMonitoringCycle(): Promise<{ cycleId: string; findings: Finding[]; actions: unknown[] }> {
    const cycleId = id('cyc');
    const findings = await monitoringAgent.evaluateActiveDeliveries(cycleId);
    const actions: unknown[] = [];
    if (findings.length === 0) return { cycleId, findings, actions };

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'monitoring_alert',
      message: `Monitoring Agent surfaced ${findings.length} at-risk deliver${findings.length === 1 ? 'y' : 'ies'} — Coordinator deciding remediation`,
      data: { findings },
    });

    for (const finding of findings) {
      actions.push(await coordinator.remediate(finding, cycleId));
    }
    return { cycleId, findings, actions };
  },

  async remediate(finding: Finding, cycleId: string): Promise<{ orderId: string; strategy: string; ok: boolean; detail: string; runId: string }> {
    const order = await orders.byId(finding.orderId);
    const delivery = await deliveries.byId(finding.deliveryId);
    if (!order || !delivery || !delivery.driver_id) {
      return { orderId: finding.orderId, strategy: 'none', ok: false, detail: 'stale', runId: '' };
    }

    const run = await createRun({
      kind: 'remediation', correlationId: cycleId, orderId: order.id, deliveryId: delivery.id,
      trigger: `monitoring:${finding.issues.join(',')}`, orderCode: shortCode(order.id),
    });
    await emitAgentEvent({
      runId: run.id, cycleId, agent: NAME, eventType: 'run_started', orderId: order.id, deliveryId: delivery.id,
      message: `Recovery run ${run.id} started for ${shortCode(order.id)} — ${finding.issues.join(', ')}`,
    });

    const alreadyPickedUp = ['picked_up', 'en_route_drop'].includes(delivery.status);
    const rerouteFeasible = finding.projectedTotalMin !== Infinity && !finding.issues.includes('driver_unavailable');
    const reassignFeasible = !alreadyPickedUp;

    let deterministicChoice: 'reroute' | 'reassign' = finding.recommendedTrigger === 'reassign' ? 'reassign' : 'reroute';
    if (deterministicChoice === 'reassign' && !reassignFeasible) deterministicChoice = 'reroute';
    if (deterministicChoice === 'reroute' && !rerouteFeasible && reassignFeasible) deterministicChoice = 'reassign';

    const alt = reassignFeasible ? await bestAlternative(order, [delivery.driver_id], cycleId) : null;
    const altDriver = alt ? { name: (await drivers.byId(alt.driverId))?.name ?? alt.driverId, deadlineSlackMin: alt.factors.deadlineSlackMin } : null;

    const advisory = await adviseRemediation({
      orderId: shortCode(order.id),
      issues: finding.issues,
      slipMin: finding.slipMin,
      missesDeadline: finding.missesDeadline,
      rerouteFeasible,
      reassignFeasible: reassignFeasible && !!alt,
      deterministicChoice,
      alternativeDriver: altDriver,
    });

    const action: ActionKind = advisory.strategy === 'reassign' ? 'reassign_driver' : 'reroute';
    const proposal: AgentProposal = {
      id: pid('prop'), ts: new Date().toISOString(), agent: 'Coordinator', action,
      target: advisory.strategy === 'reassign' ? (alt?.driverId ?? null) : delivery.driver_id,
      summary: `${advisory.strategy} ${shortCode(order.id)} — ${advisory.rationale}`,
      evidence: [
        { label: 'minutes behind', value: finding.slipMin },
        { label: 'misses deadline', value: finding.missesDeadline },
        { label: 'reroute feasible', value: rerouteFeasible },
        ...(altDriver ? [{ label: 'alternative driver slack', value: `${altDriver.deadlineSlackMin} min` } as const] : []),
      ],
      constraintsSatisfied: [], risks: finding.issues,
    };
    run.proposals.push(proposal);

    // Risk is judged on the PROPOSED recovery, not the current broken plan.
    // A reroute keeps the driver (LOW risk; its own logic escalates internally).
    // A reassignment is judged on whether the alternative driver can deliver —
    // EXCEPT when the current driver is gone (offline / abandoned): there is no
    // "keep the driver" option, so any eligible alternative is strictly better
    // than a stranded package. Only escalate when no alternative exists at all.
    const driverGone = finding.issues.includes('driver_unavailable');
    const altSlack = alt ? alt.factors.deadlineSlackMin : null;
    const proposedMissMin = advisory.strategy !== 'reassign' ? 0
      : altSlack == null ? 999
        : driverGone ? 0
          : altSlack < 0 ? -altSlack : 0;
    const ctx = {
      orderId: order.id, deliveryId: delivery.id, deadlineMissMin: proposedMissMin,
      reachable: advisory.strategy === 'reroute' ? (rerouteFeasible || reassignFeasible) : !!alt,
      priorRecoveryAttempts: 0,
    };
    const risk = classifyRisk(proposal, ctx);
    setRisk(run, risk);
    const checks = await validateAction(proposal, ctx);
    const plan = decideExecution(risk, checks);
    setDecision(run, {
      ts: new Date().toISOString(), action, target: proposal.target, finalProposalId: proposal.id,
      mode: plan.mode === 'auto' ? 'auto' : plan.mode === 'auto_policy' ? 'auto_policy' : plan.mode === 'escalate' ? 'escalated' : 'blocked',
      explanation: plan.explanation, policyChecks: checks, risk,
    });
    await emitAgentEvent({
      runId: run.id, cycleId, agent: NAME, eventType: 'remediation_decided', orderId: order.id, deliveryId: delivery.id,
      message: `Coordinator chose to ${advisory.strategy} ${shortCode(order.id)} (${advisory.source}, risk ${risk.level.toUpperCase()}): ${advisory.rationale}`,
      data: { advisory, risk, checks, mode: plan.mode },
    });
    await checkpoint(run);

    if (plan.mode === 'escalate') {
      const esc = await createEscalation({
        runId: run.id, orderId: order.id, deliveryId: delivery.id,
        reason: `${plan.explanation} (${finding.issues.join(', ')})`, proposal, risk,
      });
      run.escalationId = esc.id;
      await emitAgentEvent({
        runId: run.id, cycleId, agent: NAME, eventType: 'human_escalation', orderId: order.id, deliveryId: delivery.id,
        message: `${shortCode(order.id)}: recovery needs human approval — ${plan.explanation} (escalation ${esc.id})`,
        data: { escalationId: esc.id },
      });
      await finishRun(run, 'escalated');
      return { orderId: order.id, strategy: 'escalate', ok: false, detail: plan.explanation, runId: run.id };
    }

    const out = advisory.strategy === 'reroute'
      ? await coordinator.reroute(finding, cycleId, run)
      : await coordinator.reassign(finding, cycleId, [delivery.driver_id], run);
    await finishRun(run, out.ok ? 'executed' : 'no_action');
    return { ...out, runId: run.id };
  },

  async reroute(finding: Finding, cycleId: string, run?: PlanningRun): Promise<{ orderId: string; strategy: string; ok: boolean; detail: string }> {
    const order = (await orders.byId(finding.orderId))!;
    const delivery = (await deliveries.byId(finding.deliveryId))!;
    const driver = (await drivers.byId(delivery.driver_id!))!;
    const pos: Point = { x: driver.lat as number, y: driver.lng as number };
    const runId = run?.id;
    await emitAgentEvent({
      runId, cycleId, agent: NAME, eventType: 'reroute_requested', orderId: order.id, deliveryId: delivery.id,
      message: `Coordinator asked Routing Agent to recalculate the route for order ${order.id} from the driver's current position`,
    });

    const result = await routingAgent.recalculate(delivery, order, pos, finding.phase, cycleId);
    const canReassign = !['picked_up', 'en_route_drop'].includes(delivery.status);
    if (!result.ok) {
      if (canReassign) return coordinator.reassign(finding, cycleId, [delivery.driver_id!], run);
      await deliveries.update(delivery.id, { eta_ts: null });
      return { orderId: order.id, strategy: 'reroute', ok: false, detail: 'no_viable_route_and_package_in_transit' };
    }

    const deadlineMs = Date.parse(order.deadline_ts);
    const stillLate = Date.now() + result.etaMinutes * 60_000 > deadlineMs;
    if (stillLate && canReassign) {
      const alt = await bestAlternative(order, [delivery.driver_id!], cycleId);
      if (alt && alt.factors.deadlineSlackMin >= 0) {
        await emitAgentEvent({
          runId, cycleId, agent: NAME, eventType: 'reroute_insufficient', orderId: order.id, deliveryId: delivery.id,
          message: `Rerouted ETA for ${delivery.driver_id} (${result.etaMinutes} min) still misses the deadline; `
            + `${alt.driverId} can make it with ${alt.factors.deadlineSlackMin} min to spare — reassigning`,
          data: { reroutedEtaMin: result.etaMinutes, alternative: alt.driverId, altSlackMin: alt.factors.deadlineSlackMin },
        });
        return coordinator.reassign(finding, cycleId, [delivery.driver_id!], run);
      }
      await emitAgentEvent({
        runId, cycleId, agent: NAME, eventType: 'reroute_kept', orderId: order.id, deliveryId: delivery.id,
        message: `No available driver can beat the deadline either — keeping ${delivery.driver_id} on the fastest route (ETA ${result.etaMinutes} min)`,
      });
    }

    const newEtaTs = minutesFromNow(result.etaMinutes);
    await routes.create({
      deliveryId: delivery.id,
      driverId: delivery.driver_id!,
      originLat: pos.x,
      originLng: pos.y,
      legs: finding.phase === 'to_pickup'
        ? { toPickup: { etaMinutes: result.route!.etaMinutes, distanceKm: result.route!.distanceKm } }
        : { toDropoff: { etaMinutes: result.route!.etaMinutes, distanceKm: result.route!.distanceKm } },
      path: finding.phase === 'to_pickup' ? { toPickup: result.route!.path } : { toDropoff: result.route!.path },
      distanceKm: result.route!.distanceKm,
      etaMinutes: result.etaMinutes,
      trafficPenalty: result.route!.trafficPenaltyMinutes,
    });
    await deliveries.update(delivery.id, { eta_ts: newEtaTs, estimated_delivery_minutes: result.etaMinutes });

    if (run) run.execution = { ts: new Date().toISOString(), action: 'reroute', ok: true, detail: `eta ${result.etaMinutes} min`, deliveryId: delivery.id, driverId: delivery.driver_id, etaMinutes: result.etaMinutes };
    await emitAgentEvent({
      runId, cycleId, agent: NAME, eventType: 'reroute_applied', orderId: order.id, deliveryId: delivery.id, driverId: delivery.driver_id,
      message: `Route updated for order ${order.id} — customer ETA now ${new Date(newEtaTs).toLocaleTimeString()}`,
      data: { etaMinutes: result.etaMinutes, etaTs: newEtaTs },
    });
    return { orderId: order.id, strategy: 'reroute', ok: true, detail: `eta ${result.etaMinutes} min` };
  },

  async reassign(finding: Finding, cycleId: string, excludeDriverIds: string[], run?: PlanningRun): Promise<{ orderId: string; strategy: string; ok: boolean; detail: string }> {
    const order = (await orders.byId(finding.orderId))!;
    const delivery = (await deliveries.byId(finding.deliveryId))!;
    const runId = run?.id;
    if (['delivered', 'cancelled'].includes(delivery.status)) {
      return { orderId: order.id, strategy: 'reassign', ok: false, detail: 'delivery_terminal' };
    }
    if (['picked_up', 'en_route_drop'].includes(delivery.status)) {
      return { orderId: order.id, strategy: 'reassign', ok: false, detail: 'package_in_transit' };
    }

    await emitAgentEvent({
      runId, cycleId, agent: NAME, eventType: 'reassign_requested', orderId: order.id, deliveryId: delivery.id,
      message: `Coordinator initiating reassignment for order ${order.id} — excluding ${excludeDriverIds.join(', ')}`,
    });

    await dispatchTools.reassign_order(order.id, `reassignment: ${finding.issues.join(', ')}`, cycleId);
    try { await deliveries.setStatus(delivery.id, 'failed'); } catch { /* may already be pending */ }
    try { await orders.setStatus(order.id, 'dispatching'); } catch { /* fallthrough */ }

    // Re-run the full reasoning loop, excluding the old driver.
    const loop = await runDispatchLoop({
      orderId: order.id, kind: 'remediation', excludeDriverIds, correlationId: cycleId,
      deliveryId: delivery.id, priorRecoveryAttempts: 1,
    });

    if (!loop.assigned) {
      try { await orders.setStatus(order.id, 'validated', 'dispatching'); } catch { /* ignore */ }
      await emitAgentEvent({
        runId, cycleId, agent: NAME, eventType: loop.escalated ? 'reassign_escalated' : 'reassign_failed',
        orderId: order.id, deliveryId: delivery.id,
        message: `Reassignment ${loop.escalated ? 'escalated' : 'failed'} for order ${order.id}: ${loop.rationale}`,
      });
      if (run) run.execution = { ts: new Date().toISOString(), action: 'reassign_driver', ok: false, detail: loop.rationale };
      return { orderId: order.id, strategy: 'reassign', ok: false, detail: loop.rationale };
    }

    if (run) run.execution = { ts: new Date().toISOString(), action: 'reassign_driver', ok: true, detail: `now ${loop.driverId}`, driverId: loop.driverId, deliveryId: loop.deliveryId };
    await emitAgentEvent({
      runId, cycleId, agent: NAME, eventType: 'reassign_applied', orderId: order.id, deliveryId: loop.deliveryId, driverId: loop.driverId,
      message: `Order ${order.id} reassigned from ${excludeDriverIds.join(', ')} to ${loop.driverId} — score ${loop.score}`,
      data: { rationale: loop.rationale },
    });
    return { orderId: order.id, strategy: 'reassign', ok: true, detail: `now ${loop.driverId}` };
  },

  /** A human dispatcher approved an escalated action — execute it, still subject
   *  to the deterministic policy gates (a human cannot approve an unsafe assign). */
  async executeApprovedEscalation(
    esc: { id: string; orderId: string | null; deliveryId: string | null; proposal: unknown },
    _run: PlanningRun | null, approvedBy: string,
  ): Promise<{ ok: boolean; status: string; detail: string; runId?: string }> {
    if (!esc.orderId) return { ok: false, status: 'invalid', detail: 'escalation has no order' };
    const p = esc.proposal as { action?: string } | null;
    const action = p?.action ?? 'assign_driver';
    const cycleId = id('cyc');

    if (action === 'reassign_driver' && esc.deliveryId) {
      const dv = await deliveries.byId(esc.deliveryId);
      const exclude = dv?.driver_id ? [dv.driver_id] : [];
      try { await orders.setStatus(esc.orderId, 'dispatching'); } catch { /* keep */ }
      const loop = await runDispatchLoop({
        orderId: esc.orderId, kind: 'remediation', excludeDriverIds: exclude, deliveryId: esc.deliveryId,
        correlationId: cycleId, humanApproved: true, approvedBy, priorRecoveryAttempts: 1,
      });
      return { ok: loop.assigned, status: loop.status, detail: loop.rationale, runId: loop.runId };
    }

    // assign_driver / hold_order — re-run the dispatch loop with human approval
    try { await orders.setStatus(esc.orderId, 'dispatching', ['validated', 'failed']); } catch { /* keep */ }
    const loop = await runDispatchLoop({
      orderId: esc.orderId, kind: 'dispatch', correlationId: cycleId, humanApproved: true, approvedBy,
    });
    return { ok: loop.assigned, status: loop.status, detail: loop.rationale, runId: loop.runId };
  },
};

function shortCode(id: string): string {
  return `#${id.replace(/^ord_/, '').slice(-6).toUpperCase()}`;
}
