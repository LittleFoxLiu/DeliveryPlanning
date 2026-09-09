/**
 * The genuine multi-agent dispatch reasoning loop.
 *
 *   observe → Order Agent validates → Driver Agent proposes a pool →
 *   Routing Agent supplies evidence → Dispatch Agent PROPOSES a driver →
 *   Monitoring/Routing CRITIQUE → Dispatch Agent REVISES →
 *   Coordinator runs deterministic policy + risk → execute | escalate | block
 *
 * Every step is a typed message on a persisted `PlanningRun`. The LLM is invited
 * to explain the final decision (non-blocking); it never picks the driver.
 */
import { orders, roads, drivers, type OrderRow } from '../repo.js';
import { estimateDeliveryTime, type DeliveryEstimate, type Point } from '../engine/routing.js';
import { type ScoreBreakdown } from '../engine/scoring.js';
import { emitAgentEvent } from '../events.js';
import { explainAssignment } from './llm.js';
import { orderAgent } from './orderAgent.js';
import { dispatchTools } from './dispatchAgent.js';
import {
  pid, currentProposal, type PlanningRun, type AgentProposal, type Evidence,
} from './protocol.js';
import {
  createRun, checkpoint, addProposal, addCritique, addRevision, setRisk, setDecision,
  setExecution, finishRun, createEscalation,
} from './runStore.js';
import { invokeTool } from './toolRegistry.js';
import {
  tGetOrder, tValidateOrder, tOrderConstraints, tListEligibleDrivers,
  tEstimateDelivery, tScoreCandidates, tTrafficState, type ScoredCandidate,
} from './tools.js';
import { classifyRisk, validateAction, decideExecution } from './policy.js';

/** slack below this (minutes) makes the Monitoring Agent object to a proposal */
const CRITIQUE_SLACK_MIN = 6;

export interface LoopResult {
  runId: string;
  assigned: boolean;
  escalated: boolean;
  driverId?: string;
  deliveryId?: string;
  score?: number;
  rationale: string;
  status: 'assigned' | 'no_driver' | 'escalated' | 'blocked' | 'invalid';
}

const code = (id: string) => `#${id.replace(/^ord_/, '').slice(-6).toUpperCase()}`;

function ev(run: PlanningRun, agent: AgentNameLoose, eventType: string, message: string, data?: unknown) {
  return emitAgentEvent({
    runId: run.id, cycleId: run.correlationId, agent, eventType,
    orderId: run.orderId, deliveryId: run.deliveryId, message, data,
  });
}
type AgentNameLoose = 'Coordinator' | 'OrderAgent' | 'DriverAgent' | 'RoutingAgent' | 'DispatchAgent' | 'MonitoringAgent';

function proposalFromBreakdown(b: ScoreBreakdown, driverName: string): AgentProposal {
  const late = !b.factors.deadlineSatisfied;
  const evidence: Evidence[] = [
    { label: 'total delivery time', value: `${b.factors.totalDeliveryMin} min`, fromTool: 'dispatch.score_candidates' },
    { label: 'deadline slack', value: `${b.factors.deadlineSlackMin} min`, fromTool: 'dispatch.score_candidates' },
    { label: 'route efficiency', value: `${b.factors.routeEfficiencyPct}%`, fromTool: 'routing.estimate_delivery' },
    { label: 'score', value: b.score, fromTool: 'dispatch.score_candidates' },
  ];
  return {
    id: pid('prop'), ts: new Date().toISOString(), agent: 'DispatchAgent',
    action: 'assign_driver', target: b.driverId,
    summary: `Assign ${driverName} — score ${b.score}, ${late ? `projected ${-b.factors.deadlineSlackMin} min late` : `${b.factors.deadlineSlackMin} min of deadline slack`}`,
    evidence,
    constraintsSatisfied: b.eligible ? ['vehicle_ok', 'capacity_ok', 'route_reachable'] : [],
    risks: late ? [`deadline miss projected: ${-b.factors.deadlineSlackMin} min`] : [],
  };
}

/** Recompute the authoritative full estimate for one driver (used at execution). */
async function fullEstimate(order: OrderRow, driverId: string): Promise<DeliveryEstimate | null> {
  const [d, segs] = await Promise.all([drivers.byId(driverId), roads.segments()]);
  if (!d || d.lat == null) return null;
  const pos: Point = { x: d.lat, y: d.lng as number };
  return estimateDeliveryTime(pos, { x: order.pickup_lat, y: order.pickup_lng }, { x: order.delivery_lat, y: order.delivery_lng }, segs);
}

export async function runDispatchLoop(input: {
  orderId: string;
  kind?: 'dispatch' | 'remediation';
  excludeDriverIds?: string[];
  idempotencyKey?: string | null;
  correlationId?: string;
  deliveryId?: string | null;
  priorRecoveryAttempts?: number;
  /** a human dispatcher has approved a HIGH-risk action — execute if policy still passes */
  humanApproved?: boolean;
  approvedBy?: string;
}): Promise<LoopResult> {
  const order0 = await orders.byId(input.orderId);
  if (!order0) {
    return { runId: '', assigned: false, escalated: false, rationale: 'order not found', status: 'invalid' };
  }

  const run = await createRun({
    kind: input.kind ?? 'dispatch',
    correlationId: input.correlationId,
    orderId: order0.id,
    deliveryId: input.deliveryId ?? null,
    trigger: input.kind === 'remediation' ? 'coordinator_remediation' : 'order_ready',
    orderCode: code(order0.id),
    constraints: { priority: order0.priority, packageSize: order0.package_size, deadlineTs: order0.deadline_ts },
  });
  await ev(run, 'Coordinator', 'run_started', `Autonomous planning run ${run.id} started for ${code(order0.id)} (${run.kind})`);

  // ---------- 1. Order Agent: observe + validate ----------
  if (['assigned', 'picked_up', 'delivering', 'delivered', 'cancelled'].includes(order0.status)) {
    await finishRun(run, 'aborted');
    return { runId: run.id, assigned: false, escalated: false, rationale: `order is ${order0.status}`, status: 'invalid' };
  }
  await invokeTool(run, 'OrderAgent', tGetOrder.name, { orderId: order0.id });
  const vres = await invokeTool<{ ok: boolean; issues: string[] }>(run, 'OrderAgent', tValidateOrder.name, { orderId: order0.id });
  await invokeTool(run, 'OrderAgent', tOrderConstraints.name, { orderId: order0.id });

  // real validation also advances state (ready→validated) + interprets the note
  let validationOk = false;
  let validationIssues: string[] = [];
  try {
    const validation = await orderAgent.validate(order0.id, run.correlationId);
    validationOk = validation.ok;
    validationIssues = validation.issues;
  } catch {
    // order moved under us (concurrent dispatch) — abort cleanly
    await finishRun(run, 'aborted');
    return { runId: run.id, assigned: false, escalated: false, rationale: 'order changed concurrently', status: 'invalid' };
  }
  await checkpoint(run);

  if (!validationOk || !vres.value?.ok) {
    const issues = validationIssues.length ? validationIssues : (vres.value?.issues ?? [vres.error ?? 'validation_failed']);
    await finishRun(run, 'aborted');
    return { runId: run.id, assigned: false, escalated: false, rationale: `invalid: ${issues.join(', ')}`, status: 'invalid' };
  }

  // advance to `dispatching` so the atomic assignment CAS can claim the order
  try {
    const cur = (await orders.byId(order0.id))!;
    if (['validated', 'failed'].includes(cur.status)) {
      await orders.setStatus(order0.id, 'dispatching', ['validated', 'failed']);
    } else if (cur.status !== 'dispatching') {
      await finishRun(run, 'aborted');
      return { runId: run.id, assigned: false, escalated: false, rationale: `order is ${cur.status}`, status: 'invalid' };
    }
  } catch {
    await finishRun(run, 'aborted');
    return { runId: run.id, assigned: false, escalated: false, rationale: 'order changed concurrently', status: 'invalid' };
  }
  await ev(run, 'Coordinator', 'delegating', `Order ${code(order0.id)} validated — engaging Driver → Routing → Dispatch agents`);

  // ---------- 2. Driver Agent: eligible pool ----------
  const pool = await invokeTool<{ eligible: { driverId: string; name: string }[]; rejected: { driverId: string; name: string; reasons: string[] }[] }>(
    run, 'DriverAgent', tListEligibleDrivers.name, { orderId: order0.id, excludeDriverIds: input.excludeDriverIds ?? [] },
  );
  const eligible = pool.value?.eligible ?? [];
  await ev(run, 'DriverAgent', 'candidates_found',
    `${eligible.length} eligible driver${eligible.length === 1 ? '' : 's'} (${pool.value?.rejected.length ?? 0} filtered out)`,
    { eligible, rejected: pool.value?.rejected ?? [] });
  await checkpoint(run);

  if (eligible.length === 0) {
    // HIGH-risk: no driver at all → hold the order and escalate.
    const proposal: AgentProposal = {
      id: pid('prop'), ts: new Date().toISOString(), agent: 'DispatchAgent', action: 'hold_order', target: null,
      summary: 'No eligible driver — hold the order for a human dispatcher', evidence: [
        { label: 'eligible drivers', value: 0, fromTool: 'drivers.list_eligible' },
        { label: 'filtered out', value: pool.value?.rejected.length ?? 0, fromTool: 'drivers.list_eligible' },
      ], constraintsSatisfied: [], risks: ['no_capacity_in_fleet'],
    };
    addProposal(run, proposal);
    const risk = classifyRisk(proposal, { orderId: order0.id, candidatePool: 0 });
    setRisk(run, risk);
    const checks = await validateAction(proposal, { orderId: order0.id, candidatePool: 0 });
    const plan = decideExecution(risk, checks);
    setDecision(run, {
      ts: new Date().toISOString(), action: 'hold_order', target: null, finalProposalId: proposal.id,
      mode: 'escalated', explanation: plan.explanation, policyChecks: checks, risk,
    });
    const esc = await createEscalation({
      runId: run.id, orderId: order0.id, deliveryId: run.deliveryId,
      reason: 'No eligible driver in the fleet for this order', proposal, risk,
    });
    run.escalationId = esc.id;
    await ev(run, 'Coordinator', 'human_escalation',
      `No eligible driver for ${code(order0.id)} — escalated to a human dispatcher (escalation ${esc.id})`,
      { escalationId: esc.id, risk });
    await finishRun(run, 'escalated');
    return { runId: run.id, assigned: false, escalated: true, rationale: 'no eligible driver — escalated', status: 'no_driver' };
  }

  // ---------- 3. Routing Agent: evidence per candidate ----------
  await invokeTool(run, 'RoutingAgent', tTrafficState.name, {});
  for (const c of eligible) {
    await invokeTool(run, 'RoutingAgent', tEstimateDelivery.name, { driverId: c.driverId, orderId: order0.id });
  }
  await ev(run, 'RoutingAgent', 'routes_calculated', `Computed ${eligible.length} candidate route${eligible.length === 1 ? '' : 's'} with live traffic`);
  await checkpoint(run);

  // ---------- 4. Dispatch Agent: score + PROPOSE ----------
  const scoreRes = await invokeTool<{ scored: ScoredCandidate[]; winnerId: string | null; rationale: string; margin: number }>(
    run, 'DispatchAgent', tScoreCandidates.name,
    { orderId: order0.id, candidates: eligible.map((c) => ({ driverId: c.driverId })) },
  );
  const scored = scoreRes.value?.scored ?? [];
  if (!scored.length || !scoreRes.value?.winnerId) {
    await ev(run, 'DispatchAgent', 'assignment_failed', `No scoreable candidate for ${code(order0.id)}`);
    await finishRun(run, 'no_action');
    return { runId: run.id, assigned: false, escalated: false, rationale: 'no scoreable candidate', status: 'no_driver' };
  }
  const byId = new Map(scored.map((s) => [s.driverId, s]));
  const eligScored = [...scored].sort((a, b) => (b.breakdown.score - a.breakdown.score) || a.driverId.localeCompare(b.driverId))
    .filter((s) => s.breakdown.eligible);
  let winner = byId.get(scoreRes.value.winnerId)!;

  const proposal = proposalFromBreakdown(winner.breakdown, winner.name);
  addProposal(run, proposal);
  await ev(run, 'DispatchAgent', 'assignment_proposed',
    `Dispatch Agent proposes ${winner.name} for ${code(order0.id)} — ${proposal.summary}`,
    { proposal });
  await checkpoint(run);

  // ---------- 5. Monitoring / Routing: CRITIQUE ----------
  const w = winner.breakdown.factors;
  const winnerLate = !w.deadlineSatisfied;
  const winnerThin = w.deadlineSlackMin < CRITIQUE_SLACK_MIN;
  if (winnerLate || winnerThin) {
    const alt = eligScored.find((s) => s.driverId !== winner.driverId && s.breakdown.factors.deadlineSatisfied
      && s.breakdown.factors.deadlineSlackMin >= CRITIQUE_SLACK_MIN);
    const critique = {
      id: pid('crit'), ts: new Date().toISOString(), agent: 'MonitoringAgent' as const,
      proposalId: proposal.id, supported: false,
      objections: [
        winnerLate
          ? `${winner.name} is projected ${-w.deadlineSlackMin} min past the deadline`
          : `${winner.name} has only ${w.deadlineSlackMin} min of deadline slack — one traffic event breaks it`,
      ],
      evidence: [
        { label: 'winner slack', value: `${w.deadlineSlackMin} min` },
        { label: 'traffic penalty', value: `${w.physicalDistanceUnits} units to pickup` },
      ] as Evidence[],
      alternative: alt ? {
        action: 'assign_driver' as const, target: alt.driverId,
        reason: `${alt.name} arrives with ${alt.breakdown.factors.deadlineSlackMin} min of slack (score ${alt.breakdown.score})`,
      } : undefined,
    };
    addCritique(run, critique);
    await ev(run, 'MonitoringAgent', 'proposal_critiqued',
      `Monitoring Agent objects: ${critique.objections[0]}${alt ? ` — suggests ${alt.name}` : ' — no safer alternative exists'}`,
      { critique });
    await checkpoint(run);

    // ---------- 6. Dispatch Agent: REVISE ----------
    if (alt) {
      const revised = proposalFromBreakdown(alt.breakdown, alt.name);
      revised.supersedes = proposal.id;
      addRevision(run, {
        id: pid('rev'), ts: new Date().toISOString(), agent: 'DispatchAgent',
        previousProposalId: proposal.id, newProposal: revised,
        changes: [`driver ${winner.name} → ${alt.name}`],
        reason: `Monitoring critique upheld — ${alt.name} meets the deadline, ${winner.name} does not`,
      });
      winner = alt;
      await ev(run, 'DispatchAgent', 'assignment_revised',
        `Dispatch Agent revises: ${alt.name} for ${code(order0.id)} (${revised.summary})`, { proposal: revised });
      await checkpoint(run);
    } else {
      // critic acknowledged: keep the best-effort driver, note it explicitly
      const ack = {
        id: pid('crit'), ts: new Date().toISOString(), agent: 'DispatchAgent' as const,
        proposalId: proposal.id, supported: true,
        objections: [] as string[],
        evidence: [{ label: 'best-effort rationale', value: 'no on-time driver exists; a late delivery beats none' }] as Evidence[],
      };
      addCritique(run, ack);
      await ev(run, 'DispatchAgent', 'critique_acknowledged',
        `Dispatch Agent: no on-time alternative — keeping ${winner.name} as a best-effort assignment`, { critique: ack });
    }
  } else {
    const support = {
      id: pid('crit'), ts: new Date().toISOString(), agent: 'RoutingAgent' as const,
      proposalId: proposal.id, supported: true, objections: [] as string[],
      evidence: [{ label: 'deadline slack', value: `${w.deadlineSlackMin} min — comfortable` }] as Evidence[],
    };
    addCritique(run, support);
    await ev(run, 'RoutingAgent', 'proposal_supported',
      `Routing Agent confirms ${winner.name} is feasible with ${w.deadlineSlackMin} min of slack`, { critique: support });
  }

  // ---------- 7. Coordinator: policy + risk + decision ----------
  const finalProp = currentProposal(run)!;
  const fb = winner.breakdown.factors;
  const deadlineMissMin = fb.deadlineSatisfied ? 0 : -fb.deadlineSlackMin;
  const est = await fullEstimate(order0, winner.driverId);
  const ctx = {
    orderId: order0.id, deliveryId: run.deliveryId, deadlineMissMin,
    reachable: !!est?.reachable, candidatePool: eligible.length,
    priorRecoveryAttempts: input.priorRecoveryAttempts ?? 0,
  };
  const risk = classifyRisk(finalProp, ctx);
  setRisk(run, risk);
  const checks = await validateAction(finalProp, ctx);
  const plan = decideExecution(risk, checks);
  setDecision(run, {
    ts: new Date().toISOString(), action: finalProp.action, target: finalProp.target,
    finalProposalId: finalProp.id, mode: plan.mode === 'auto' ? 'auto' : plan.mode === 'auto_policy' ? 'auto_policy' : plan.mode === 'escalate' ? 'escalated' : 'blocked',
    explanation: plan.explanation, policyChecks: checks, risk,
  });
  await ev(run, 'Coordinator', 'policy_validated',
    `Coordinator: risk ${risk.level.toUpperCase()}, ${checks.filter((c) => c.passed).length}/${checks.length} policy checks passed → ${plan.mode}`,
    { risk, checks, mode: plan.mode });
  await checkpoint(run);

  // ---------- 8. Execute / escalate / block ----------
  const policyOk = checks.every((c) => c.passed);
  if (plan.mode === 'escalate' && !(input.humanApproved && policyOk)) {
    const esc = await createEscalation({
      runId: run.id, orderId: order0.id, deliveryId: run.deliveryId,
      reason: plan.explanation, proposal: finalProp, risk,
    });
    run.escalationId = esc.id;
    await ev(run, 'Coordinator', 'human_escalation',
      `${code(order0.id)}: ${plan.explanation} (escalation ${esc.id})`, { escalationId: esc.id });
    await finishRun(run, 'escalated');
    return { runId: run.id, assigned: false, escalated: true, rationale: plan.explanation, status: 'escalated' };
  }
  if (input.humanApproved && plan.mode === 'escalate' && policyOk && run.decision) {
    run.decision.mode = 'auto_policy';
    run.decision.explanation = `Human dispatcher ${input.approvedBy ?? ''} approved this HIGH-risk action; deterministic policy still passes — executing.`;
    await ev(run, 'Coordinator', 'human_approved',
      `${code(order0.id)}: dispatcher approved the escalated action — executing`, { approvedBy: input.approvedBy });
  }
  if (plan.mode === 'block' || !est) {
    await ev(run, 'Coordinator', 'action_blocked', `${code(order0.id)}: ${plan.explanation}`, { checks });
    await finishRun(run, 'no_action');
    return { runId: run.id, assigned: false, escalated: false, rationale: plan.explanation, status: 'blocked' };
  }

  // auto / auto_policy — perform the atomic, idempotent assignment
  const reasoning = {
    selected: winner.driverId, score: winner.breakdown.score,
    factors: winner.breakdown.factors, contributions: winner.breakdown.contributions,
    explanation: winner.breakdown.explanation,
    rationale: `${plan.explanation} ${scoreRes.value.rationale}`,
    rejected: scored.filter((s) => !s.breakdown.eligible).map((s) => ({ driverId: s.driverId, disqualifiers: s.breakdown.disqualifiers })),
    runId: run.id,
    negotiation: { proposals: run.proposals.length, critiques: run.critiques.length, revisions: run.revisions.length },
  };

  let assignOk = false;
  let deliveryId: string | undefined;
  let reused = false;
  try {
    const res = await dispatchTools.assign_order({
      order: order0, driverId: winner.driverId, score: winner.breakdown.score,
      reasoning, estimate: est, idempotencyKey: input.idempotencyKey ?? null, cycleId: run.correlationId,
    });
    assignOk = true;
    deliveryId = res.deliveryId;
    reused = res.reused;
    run.deliveryId = res.deliveryId;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    setExecution(run, { ts: new Date().toISOString(), action: 'assign_driver', ok: false, detail });
    await ev(run, 'Coordinator', 'execution_conflict', `Assignment blocked for ${code(order0.id)}: ${detail}`);
    await finishRun(run, 'no_action');
    return { runId: run.id, assigned: false, escalated: false, rationale: detail, status: 'blocked' };
  }

  setExecution(run, {
    ts: new Date().toISOString(), action: 'assign_driver', ok: true,
    detail: reused ? 'idempotent reuse' : `assigned ${winner.name}`,
    driverId: winner.driverId, deliveryId, etaMinutes: est.totalMinutes,
  });
  await ev(run, reused ? 'DispatchAgent' : 'Coordinator', reused ? 'assignment_reused' : 'driver_assigned',
    reused
      ? `Assignment for ${code(order0.id)} already in place → ${winner.name}`
      : `Coordinator EXECUTED: ${code(order0.id)} → ${winner.name} (score ${winner.breakdown.score}, ${plan.mode})`,
    { reasoning, mode: plan.mode });
  await dispatchTools.notify_driver(winner.driverId, order0.id, deliveryId!, run.correlationId, winner.breakdown.factors.totalDeliveryMin);
  await finishRun(run, 'executed');

  if (!reused) {
    void explainAssignment({
      orderCode: code(order0.id),
      winner: { name: winner.name, score: winner.breakdown.score, factors: winner.breakdown.factors as unknown as Record<string, unknown>, contributions: winner.breakdown.contributions },
      runnerUp: eligScored[1] && eligScored[1].driverId !== winner.driverId ? { name: eligScored[1].name, score: eligScored[1].breakdown.score } : null,
      rejected: scored.filter((s) => !s.breakdown.eligible).map((s) => ({ name: s.name, reasons: s.breakdown.disqualifiers })),
    }).then((ex) => {
      if (ex.source === 'llm') {
        return emitAgentEvent({
          runId: run.id, cycleId: run.correlationId, agent: 'DispatchAgent', eventType: 'assignment_explained',
          orderId: order0.id, deliveryId, driverId: winner.driverId, message: ex.text, data: { source: 'llm' },
        });
      }
    }).catch(() => undefined);
  }

  return {
    runId: run.id, assigned: true, escalated: false, driverId: winner.driverId, deliveryId,
    score: winner.breakdown.score, rationale: reasoning.rationale, status: 'assigned',
  };
}
