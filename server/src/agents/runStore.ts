import { q, q1 } from '../db.js';
import { id } from '../util.js';
import {
  newRun, type PlanningRun, type RunKind, type AgentProposal, type AgentCritique,
  type AgentRevision, type ToolCall, type PolicyCheck, type AgentDecision,
  type ExecutionResult, type RiskAssessment, type RunStatus,
} from './protocol.js';

/**
 * Persistence + lifecycle for `PlanningRun`s. The whole append-only state object
 * lives in a `jsonb` column; every mutation checkpoints it so the Operations
 * Center can render a run *while it is still executing*.
 */

export async function createRun(input: {
  kind: RunKind;
  correlationId?: string;
  orderId?: string | null;
  deliveryId?: string | null;
  trigger: string;
  orderCode?: string;
  constraints?: Record<string, unknown>;
}): Promise<PlanningRun> {
  const runId = id('run');
  const run = newRun({
    id: runId,
    correlationId: input.correlationId ?? runId,
    kind: input.kind,
    orderId: input.orderId,
    deliveryId: input.deliveryId,
    trigger: input.trigger,
    orderCode: input.orderCode,
    constraints: input.constraints,
  });
  await q(
    `INSERT INTO agent_runs (id, correlation_id, kind, order_id, delivery_id, status, state_json)
     VALUES (?, ?, ?, ?, ?, 'running', ?::jsonb)`,
    [run.id, run.correlationId, run.kind, run.orderId, run.deliveryId, JSON.stringify(run)],
  );
  return run;
}

/** Persist the current in-memory run state. Call after every append. */
export async function checkpoint(run: PlanningRun): Promise<void> {
  await q(
    `UPDATE agent_runs SET state_json = ?::jsonb, status = ?, risk_level = ?, ended_at = ?
     WHERE id = ?`,
    [
      JSON.stringify(run), run.status,
      run.riskAssessment?.level ?? null,
      run.endedAt, run.id,
    ],
  );
}

export function addToolCall(run: PlanningRun, call: ToolCall): void { run.toolCalls.push(call); }
export function addProposal(run: PlanningRun, p: AgentProposal): void { run.proposals.push(p); }
export function addCritique(run: PlanningRun, c: AgentCritique): void { run.critiques.push(c); }
export function addRevision(run: PlanningRun, r: AgentRevision): void {
  run.revisions.push(r);
  run.proposals.push(r.newProposal);
}
export function setPolicy(run: PlanningRun, checks: PolicyCheck[]): void {
  if (run.decision) run.decision.policyChecks = checks;
}
export function setRisk(run: PlanningRun, risk: RiskAssessment): void { run.riskAssessment = risk; }
export function setDecision(run: PlanningRun, d: AgentDecision): void { run.decision = d; }
export function setExecution(run: PlanningRun, e: ExecutionResult): void { run.execution = e; }

export async function finishRun(run: PlanningRun, status: RunStatus): Promise<void> {
  run.status = status;
  run.endedAt = new Date().toISOString();
  await checkpoint(run);
}

/* ---------------------------------------------------------------- read side */

interface RunRow {
  id: string; correlation_id: string; kind: string; order_id: string | null;
  delivery_id: string | null; status: string; risk_level: string | null;
  state_json: PlanningRun; started_at: string; ended_at: string | null;
}

function toRun(r: RunRow): PlanningRun {
  const s = typeof r.state_json === 'string' ? JSON.parse(r.state_json) as PlanningRun : r.state_json;
  return { ...s, status: r.status as RunStatus, startedAt: r.started_at, endedAt: r.ended_at };
}

export async function getRun(runId: string): Promise<PlanningRun | null> {
  const row = await q1<RunRow>(`SELECT * FROM agent_runs WHERE id = ?`, [runId]);
  return row ? toRun(row) : null;
}

export async function latestRunForOrder(orderId: string): Promise<PlanningRun | null> {
  const row = await q1<RunRow>(
    `SELECT * FROM agent_runs WHERE order_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`, [orderId]);
  return row ? toRun(row) : null;
}

export async function listRuns(opts: { limit?: number; kind?: RunKind } = {}): Promise<PlanningRun[]> {
  const limit = Math.min(opts.limit ?? 40, 200);
  const rows = opts.kind
    ? await q<RunRow>(`SELECT * FROM agent_runs WHERE kind = ? ORDER BY started_at DESC LIMIT ?`, [opts.kind, limit])
    : await q<RunRow>(`SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?`, [limit]);
  return rows.map(toRun);
}

/* --------------------------------------------------------------- escalations */

export interface Escalation {
  id: string; runId: string; orderId: string | null; deliveryId: string | null;
  reason: string; proposal: unknown; risk: unknown; status: 'pending' | 'approved' | 'rejected' | 'expired';
  resolvedBy: string | null; resolutionNote: string | null; createdAt: string; resolvedAt: string | null;
}

interface EscRow {
  id: string; run_id: string; order_id: string | null; delivery_id: string | null;
  reason: string; proposal_json: unknown; risk_json: unknown; status: Escalation['status'];
  resolved_by: string | null; resolution_note: string | null; created_at: string; resolved_at: string | null;
}
const toEsc = (r: EscRow): Escalation => ({
  id: r.id, runId: r.run_id, orderId: r.order_id, deliveryId: r.delivery_id, reason: r.reason,
  proposal: r.proposal_json, risk: r.risk_json, status: r.status,
  resolvedBy: r.resolved_by, resolutionNote: r.resolution_note, createdAt: r.created_at, resolvedAt: r.resolved_at,
});

export async function createEscalation(input: {
  runId: string; orderId: string | null; deliveryId: string | null;
  reason: string; proposal: unknown; risk: unknown;
}): Promise<Escalation> {
  const escId = id('esc');
  await q(
    `INSERT INTO agent_escalations (id, run_id, order_id, delivery_id, reason, proposal_json, risk_json)
     VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)`,
    [escId, input.runId, input.orderId, input.deliveryId, input.reason,
      JSON.stringify(input.proposal), JSON.stringify(input.risk)],
  );
  return (await getEscalation(escId))!;
}

export async function getEscalation(escId: string): Promise<Escalation | null> {
  const row = await q1<EscRow>(`SELECT * FROM agent_escalations WHERE id = ?`, [escId]);
  return row ? toEsc(row) : null;
}

export async function listEscalations(status?: Escalation['status']): Promise<Escalation[]> {
  const rows = status
    ? await q<EscRow>(`SELECT * FROM agent_escalations WHERE status = ? ORDER BY created_at DESC LIMIT 100`, [status])
    : await q<EscRow>(`SELECT * FROM agent_escalations ORDER BY created_at DESC LIMIT 100`);
  return rows.map(toEsc);
}

export async function resolveEscalation(
  escId: string, decision: 'approved' | 'rejected', by: string, note: string,
): Promise<Escalation | null> {
  const rows = await q<EscRow>(
    `UPDATE agent_escalations SET status = ?, resolved_by = ?, resolution_note = ?, resolved_at = now()
     WHERE id = ? AND status = 'pending' RETURNING *`,
    [decision, by, note, escId],
  );
  return rows.length ? toEsc(rows[0]) : null;
}
