/**
 * Structured multi-agent protocol.
 *
 * Agents never talk to each other in free-form text. Every exchange is one of
 * these typed messages, appended to a `PlanningRun` (the shared, inspectable
 * state for one reasoning loop). The LLM may *produce* the prose fields
 * (`rationale`, `summary`) but every number and identifier is filled by
 * deterministic tools — see `toolRegistry.ts` and `policy.ts`.
 */

export type AgentName =
  | 'Coordinator' | 'OrderAgent' | 'DriverAgent' | 'RoutingAgent'
  | 'DispatchAgent' | 'MonitoringAgent';

export type RiskLevel = 'low' | 'medium' | 'high';

export type ActionKind =
  | 'assign_driver' | 'reroute' | 'reassign_driver' | 'hold_order' | 'no_action';

/** A concrete fact an agent used, always sourced from a tool result. */
export interface Evidence {
  label: string;
  value: string | number | boolean;
  /** name of the tool call that produced this fact */
  fromTool?: string;
}

/** One tool invocation, recorded on the run for full traceability. */
export interface ToolCall {
  id: string;
  ts: string;
  agent: AgentName;
  tool: string;
  access: 'read' | 'write';
  inputSummary: string;
  ok: boolean;
  outputSummary: string;
  error?: string;
  durationMs: number;
}

/** An agent's proposed action, with the evidence behind it. */
export interface AgentProposal {
  id: string;
  ts: string;
  agent: AgentName;
  action: ActionKind;
  /** driverId / routeId / orderId the action targets */
  target: string | null;
  summary: string;
  evidence: Evidence[];
  constraintsSatisfied: string[];
  risks: string[];
  supersedes?: string;
}

/** Another agent's structured response to a proposal. */
export interface AgentCritique {
  id: string;
  ts: string;
  agent: AgentName;
  proposalId: string;
  supported: boolean;
  objections: string[];
  evidence: Evidence[];
  /** if the critic has a concrete better option */
  alternative?: { action: ActionKind; target: string | null; reason: string };
}

/** A proposal revised in response to critiques. */
export interface AgentRevision {
  id: string;
  ts: string;
  agent: AgentName;
  previousProposalId: string;
  newProposal: AgentProposal;
  changes: string[];
  reason: string;
}

/** One deterministic policy gate the Coordinator ran before executing. */
export interface PolicyCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
  /** whether deterministic policy alone can authorise execution */
  autoExecutable: boolean;
}

export type DecisionMode = 'auto' | 'auto_policy' | 'escalated' | 'blocked';

export interface AgentDecision {
  ts: string;
  action: ActionKind;
  target: string | null;
  finalProposalId: string;
  mode: DecisionMode;
  explanation: string;
  policyChecks: PolicyCheck[];
  risk: RiskAssessment;
}

export interface ExecutionResult {
  ts: string;
  action: ActionKind;
  ok: boolean;
  detail: string;
  driverId?: string | null;
  deliveryId?: string | null;
  etaMinutes?: number | null;
}

export type RunKind = 'dispatch' | 'remediation' | 'whatif' | 'evaluation';
export type RunStatus = 'running' | 'executed' | 'escalated' | 'aborted' | 'no_action' | 'simulated';

/**
 * The shared state for one autonomous reasoning loop. Append-only: agents add
 * proposals / critiques / revisions; the Coordinator adds policy checks, the
 * decision and the execution result. The whole object is persisted and rendered
 * as a decision trace in the UI.
 */
export interface PlanningRun {
  id: string;
  correlationId: string;
  kind: RunKind;
  status: RunStatus;
  orderId: string | null;
  deliveryId: string | null;

  /** immutable inputs captured at run start */
  context: {
    trigger: string;
    orderCode?: string;
    constraints?: Record<string, unknown>;
    startedAt: string;
  };

  toolCalls: ToolCall[];
  proposals: AgentProposal[];
  critiques: AgentCritique[];
  revisions: AgentRevision[];
  riskAssessment: RiskAssessment | null;
  decision: AgentDecision | null;
  execution: ExecutionResult | null;
  escalationId: string | null;

  startedAt: string;
  endedAt: string | null;
}

let seq = 0;
export function pid(prefix: string): string {
  seq = (seq + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

export function newRun(input: {
  id: string;
  correlationId: string;
  kind: RunKind;
  orderId?: string | null;
  deliveryId?: string | null;
  trigger: string;
  orderCode?: string;
  constraints?: Record<string, unknown>;
}): PlanningRun {
  const now = new Date().toISOString();
  return {
    id: input.id,
    correlationId: input.correlationId,
    kind: input.kind,
    status: 'running',
    orderId: input.orderId ?? null,
    deliveryId: input.deliveryId ?? null,
    context: { trigger: input.trigger, orderCode: input.orderCode, constraints: input.constraints, startedAt: now },
    toolCalls: [],
    proposals: [],
    critiques: [],
    revisions: [],
    riskAssessment: null,
    decision: null,
    execution: null,
    escalationId: null,
    startedAt: now,
    endedAt: null,
  };
}

/** The proposal currently on the table (latest revision wins). */
export function currentProposal(run: PlanningRun): AgentProposal | null {
  return run.proposals.length ? run.proposals[run.proposals.length - 1] : null;
}
