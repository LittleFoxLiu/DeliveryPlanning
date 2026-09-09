import { describe, it, expect, beforeAll } from 'vitest';
import { initDb } from '../src/db.js';
import { classifyRisk, validateAction, decideExecution, policyPassed } from '../src/agents/policy.js';
import { newRun, pid, currentProposal, type AgentProposal } from '../src/agents/protocol.js';
import { invokeTool, ToolAccessError, toolsForAgent, listTools } from '../src/agents/toolRegistry.js';
import '../src/agents/tools.js'; // register

beforeAll(async () => { await initDb(); });

const proposal = (over: Partial<AgentProposal> = {}): AgentProposal => ({
  id: pid('p'), ts: new Date().toISOString(), agent: 'DispatchAgent',
  action: 'assign_driver', target: 'drv_abcdef123456', summary: 's',
  evidence: [], constraintsSatisfied: [], risks: [], ...over,
});

describe('protocol + run state', () => {
  it('newRun is append-only and inspectable', () => {
    const r = newRun({ id: 'run_x', correlationId: 'c', kind: 'dispatch', trigger: 't', orderId: 'ord_1' });
    expect(r.proposals).toEqual([]);
    expect(r.status).toBe('running');
    r.proposals.push(proposal());
    expect(currentProposal(r)?.action).toBe('assign_driver');
  });
});

describe('risk classification', () => {
  it('a clean first assignment is medium risk and auto-executable', () => {
    const risk = classifyRisk(proposal(), { orderId: 'ord_1', deadlineMissMin: 0, reachable: true, candidatePool: 3 });
    expect(risk.level).toBe('medium');
    expect(risk.autoExecutable).toBe(true);
  });
  it('a plan that badly misses the deadline is HIGH risk', () => {
    const risk = classifyRisk(proposal(), { orderId: 'ord_1', deadlineMissMin: 40, reachable: true, candidatePool: 3 });
    expect(risk.level).toBe('high');
    expect(risk.autoExecutable).toBe(false);
  });
  it('no eligible driver (hold_order) is HIGH risk', () => {
    const risk = classifyRisk(proposal({ action: 'hold_order', target: null }), { orderId: 'ord_1', candidatePool: 0 });
    expect(risk.level).toBe('high');
  });
  it('a reroute is LOW risk', () => {
    const risk = classifyRisk(proposal({ action: 'reroute' }), { orderId: 'ord_1', reachable: true });
    expect(risk.level).toBe('low');
  });
});

describe('execution decision', () => {
  it('low risk + passing policy → auto', () => {
    const checks = [{ name: 'x', passed: true, detail: '' }];
    expect(decideExecution({ level: 'low', reasons: [], autoExecutable: true }, checks).mode).toBe('auto');
  });
  it('medium risk + passing policy → auto_policy', () => {
    const checks = [{ name: 'x', passed: true, detail: '' }];
    expect(decideExecution({ level: 'medium', reasons: [], autoExecutable: true }, checks).mode).toBe('auto_policy');
  });
  it('high risk → escalate even if policy passes', () => {
    const checks = [{ name: 'x', passed: true, detail: '' }];
    expect(decideExecution({ level: 'high', reasons: ['x'], autoExecutable: false }, checks).mode).toBe('escalate');
  });
  it('failed policy is never auto', () => {
    const checks = [{ name: 'x', passed: false, detail: 'bad' }];
    expect(policyPassed(checks)).toBe(false);
    expect(['block', 'escalate']).toContain(decideExecution({ level: 'medium', reasons: [], autoExecutable: true }, checks).mode);
  });
});

describe('tool registry — least privilege + validation', () => {
  it('each agent only sees its own tools', () => {
    expect(toolsForAgent('MonitoringAgent')).not.toContain('dispatch.score_candidates');
    expect(toolsForAgent('MonitoringAgent')).toContain('monitoring.assess_delivery');
    expect(toolsForAgent('DispatchAgent')).toContain('dispatch.score_candidates');
  });
  it('no execution/write tool is exposed to any read-only agent', () => {
    for (const t of listTools()) {
      if (t.access === 'write') expect(t.allowed).toEqual(['Coordinator']);
    }
  });
  it('an unknown tool returns a failed ToolResult, never throws', async () => {
    const run = newRun({ id: 'run_p', correlationId: 'c', kind: 'evaluation', trigger: 't' });
    const res = await invokeTool(run, 'DispatchAgent', 'totally.made.up', {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown_tool');
    expect(run.toolCalls).toHaveLength(1);
  });
  it('a malformed input is rejected with a typed error', async () => {
    const run = newRun({ id: 'run_q', correlationId: 'c', kind: 'evaluation', trigger: 't' });
    const res = await invokeTool(run, 'OrderAgent', 'order.get', { orderId: 'bad', extra: 1 });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('invalid_input');
  });
  it('a least-privilege violation throws ToolAccessError', async () => {
    const run = newRun({ id: 'run_r', correlationId: 'c', kind: 'evaluation', trigger: 't' });
    await expect(invokeTool(run, 'MonitoringAgent', 'dispatch.score_candidates', { orderId: 'ord_abcdef', candidates: [] }))
      .rejects.toBeInstanceOf(ToolAccessError);
  });
});

describe('policy validation against ground truth', () => {
  it('validateAction fails when the target driver does not exist', async () => {
    const checks = await validateAction(proposal({ target: 'drv_doesnotexist99' }), { orderId: 'ord_missing', reachable: true });
    // order missing + driver missing → not all pass
    expect(checks.some((c) => !c.passed)).toBe(true);
  });
});
