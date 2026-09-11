/**
 * Deterministic policy + risk layer. The LLM proposes; this module decides
 * whether an action may execute autonomously, needs a policy pass, or must be
 * escalated to a human. Nothing here calls an LLM.
 */
import { orders, drivers, deliveries } from '../repo.js';
import { vehicleCanCarry } from './compat.js';
import type {
  AgentProposal, PolicyCheck, RiskAssessment, RiskLevel, ActionKind,
} from './protocol.js';

export interface ActionContext {
  orderId: string | null;
  deliveryId?: string | null;
  /** projected minutes past the deadline for the proposed plan; <=0 means on time */
  deadlineMissMin?: number;
  reachable?: boolean;
  /** recovery attempts already made for this delivery in this incident */
  priorRecoveryAttempts?: number;
  /** eligible-driver count considered */
  candidatePool?: number;
}

/* -------------------------------------------------------------- risk levels */

const RISK_BY_ACTION: Record<ActionKind, RiskLevel> = {
  no_action: 'low',
  reroute: 'low',
  assign_driver: 'medium',
  reassign_driver: 'medium',
  hold_order: 'high',
};

export function classifyRisk(proposal: AgentProposal, ctx: ActionContext): RiskAssessment {
  const reasons: string[] = [];
  let level: RiskLevel = RISK_BY_ACTION[proposal.action] ?? 'medium';

  if (proposal.action === 'reroute') reasons.push('Route recalculation is reversible and does not change who is responsible.');
  if (proposal.action === 'assign_driver') reasons.push('First assignment of an unstarted order — reversible before pickup.');
  if (proposal.action === 'reassign_driver') reasons.push('Hands the order to a different driver — reversible only before pickup.');

  const miss = ctx.deadlineMissMin ?? 0;
  if (miss > 0 && miss <= 10) { reasons.push(`Plan is ~${miss} min late — recoverable, still actionable.`); }
  if (miss > 10) { level = 'high'; reasons.push(`Plan is ~${miss} min past the deadline with no better option — needs a human call.`); }
  if (ctx.reachable === false) { level = 'high'; reasons.push('No viable route exists for the proposed plan.'); }
  if (proposal.action === 'hold_order') { level = 'high'; reasons.push('No eligible driver — the order cannot be actioned automatically.'); }
  if ((ctx.priorRecoveryAttempts ?? 0) >= 2) { level = 'high'; reasons.push(`${ctx.priorRecoveryAttempts} recovery attempts already failed for this delivery.`); }
  if ((ctx.candidatePool ?? 1) === 0 && proposal.action !== 'reroute') { level = 'high'; reasons.push('Candidate pool is empty.'); }

  const autoExecutable = level !== 'high';
  return { level, reasons, autoExecutable };
}

/* --------------------------------------------------- deterministic validation */

/**
 * Re-checks the proposal against ground truth (never trusting the proposal's own
 * numbers). Returns one `PolicyCheck` per gate; all must pass to execute.
 */
export async function validateAction(proposal: AgentProposal, ctx: ActionContext): Promise<PolicyCheck[]> {
  const checks: PolicyCheck[] = [];
  const order = ctx.orderId ? await orders.byId(ctx.orderId) : null;

  if (proposal.action === 'no_action' || proposal.action === 'hold_order') {
    checks.push({ name: 'action_is_terminal', passed: true, detail: `${proposal.action} needs no state mutation` });
    return checks;
  }

  // order must exist and be in an actionable state
  if (proposal.action === 'assign_driver') {
    checks.push({
      name: 'order_state',
      passed: !!order && ['validated', 'dispatching', 'ready'].includes(order.status),
      detail: order ? `order is ${order.status}` : 'order not found',
    });
  }
  if (proposal.action === 'reassign_driver') {
    const dv = ctx.deliveryId ? await deliveries.byId(ctx.deliveryId) : null;
    checks.push({
      name: 'package_not_collected',
      passed: !!dv && !['picked_up', 'en_route_drop', 'delivered', 'cancelled'].includes(dv.status),
      detail: dv ? `delivery is ${dv.status}` : 'delivery not found',
    });
  }

  // driver-facing checks for assign / reassign
  if ((proposal.action === 'assign_driver' || proposal.action === 'reassign_driver') && proposal.target) {
    const d = await drivers.byId(proposal.target);
    checks.push({ name: 'driver_exists', passed: !!d, detail: d ? d.name : 'driver not found' });
    if (d && order) {
      checks.push({
        name: 'driver_available',
        passed: d.status === 'available' || d.status === 'on_route',
        detail: `driver status ${d.status}`,
      });
      checks.push({
        name: 'capacity_headroom',
        passed: d.capacity - d.current_order_count >= 1,
        detail: `${d.current_order_count}/${d.capacity} used`,
      });
      checks.push({
        name: 'vehicle_compatible',
        passed: vehicleCanCarry(d.vehicle_type, d.max_package_size, order.package_size),
        detail: `${d.vehicle_type} vs ${order.package_size} package`,
      });
      checks.push({
        name: 'driver_has_position',
        passed: d.latitude != null,
        detail: d.latitude != null ? `at ${d.latitude.toFixed(6)}, ${d.longitude?.toFixed(6)}` : 'no location fix',
      });
    }
  }

  // routing feasibility is a hard gate for every mutating action
  checks.push({
    name: 'route_reachable',
    passed: ctx.reachable !== false,
    detail: ctx.reachable === false ? 'no viable route' : 'route exists',
  });

  return checks;
}

export function policyPassed(checks: PolicyCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.passed);
}

/* ---------------------------------------------------- execution mode decision */

export type ExecMode = 'auto' | 'auto_policy' | 'escalate' | 'block';

export interface ExecPlan {
  mode: ExecMode;
  explanation: string;
}

export function decideExecution(risk: RiskAssessment, checks: PolicyCheck[]): ExecPlan {
  const passed = policyPassed(checks);
  if (!passed) {
    const failed = checks.filter((c) => !c.passed).map((c) => c.name);
    if (risk.level === 'high') {
      return { mode: 'escalate', explanation: `HIGH risk and policy checks failed (${failed.join(', ')}) — escalating to a human dispatcher.` };
    }
    return { mode: 'block', explanation: `Policy checks failed (${failed.join(', ')}) — action blocked, order left for a later cycle.` };
  }
  if (risk.level === 'low') {
    return { mode: 'auto', explanation: 'LOW risk and all deterministic policy checks passed — executing autonomously.' };
  }
  if (risk.level === 'medium') {
    return { mode: 'auto_policy', explanation: 'MEDIUM risk but every deterministic policy gate passed — autonomous execution authorised by policy.' };
  }
  return { mode: 'escalate', explanation: `HIGH risk (${risk.reasons[0] ?? 'unusual conditions'}) — requesting human approval before execution.` };
}
