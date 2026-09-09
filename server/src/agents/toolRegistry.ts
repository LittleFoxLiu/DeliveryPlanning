/**
 * Typed tool registry with least-privilege access control.
 *
 * Every decision-relevant tool an agent uses goes through `invokeTool`, which:
 *   1. checks the calling agent is allowed this tool (allow-list, not deny-list)
 *   2. validates the input against a strict schema (unknown keys rejected)
 *   3. runs it with a timeout, catching every failure mode
 *   4. records a `ToolCall` on the active `PlanningRun` for the trace
 *
 * Read tools and write/execute tools are separated. Execution tools are only
 * reachable by the Coordinator, and only after `policy.ts` authorises them.
 */
import { pid, type AgentName, type ToolCall, type PlanningRun } from './protocol.js';
import { addToolCall } from './runStore.js';

export class ToolAccessError extends Error {
  constructor(agent: string, tool: string) {
    super(`Agent "${agent}" is not permitted to use tool "${tool}"`);
    this.name = 'ToolAccessError';
  }
}
export class ToolInputError extends Error {
  constructor(tool: string, detail: string) {
    super(`Invalid input for tool "${tool}": ${detail}`);
    this.name = 'ToolInputError';
  }
}

export interface ToolResult<O> {
  ok: boolean;
  value: O | null;
  error?: string;
  call: ToolCall;
}

type Validator<I> = (raw: unknown) => I;

export interface ToolDef<I, O> {
  name: string;
  description: string;
  access: 'read' | 'write';
  /** which agents may call this tool */
  allowed: AgentName[];
  /** strict schema: must throw ToolInputError on anything unexpected */
  input: Validator<I>;
  run: (input: I) => Promise<O>;
  timeoutMs?: number;
  summariseInput?: (input: I) => string;
  summariseOutput?: (output: O) => string;
}

const REGISTRY = new Map<string, ToolDef<unknown, unknown>>();

export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  if (REGISTRY.has(def.name)) throw new Error(`tool ${def.name} already defined`);
  REGISTRY.set(def.name, def as ToolDef<unknown, unknown>);
  return def;
}

export function listTools(): { name: string; description: string; access: string; allowed: string[] }[] {
  return [...REGISTRY.values()].map((t) => ({
    name: t.name, description: t.description, access: t.access, allowed: t.allowed,
  }));
}

/** Enforced least-privilege table (also derivable from each tool's `allowed`). */
export function toolsForAgent(agent: AgentName): string[] {
  return [...REGISTRY.values()].filter((t) => t.allowed.includes(agent)).map((t) => t.name);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`tool timed out after ${ms}ms`)), ms);
  });
  try { return await Promise.race([p, timeout]); }
  finally { clearTimeout(timer!); }
}

/**
 * The single entry point for agent tool use. Never throws for a *tool* failure
 * (returns `{ ok: false }`); only throws `ToolAccessError` for a
 * least-privilege violation, which is a programming/security error, not data.
 */
export async function invokeTool<O = unknown>(
  run: PlanningRun,
  agent: AgentName,
  toolName: string,
  rawInput: unknown,
): Promise<ToolResult<O>> {
  const def = REGISTRY.get(toolName);
  const started = Date.now();
  const base = { id: pid('tc'), ts: new Date().toISOString(), agent, tool: toolName };

  if (!def) {
    const call: ToolCall = { ...base, access: 'read', inputSummary: '(unknown tool)', ok: false, outputSummary: '', error: 'unknown_tool', durationMs: 0 };
    addToolCall(run, call);
    return { ok: false, value: null, error: 'unknown_tool', call };
  }
  if (!def.allowed.includes(agent)) {
    const call: ToolCall = { ...base, access: def.access, inputSummary: '(denied)', ok: false, outputSummary: '', error: 'access_denied', durationMs: 0 };
    addToolCall(run, call);
    throw new ToolAccessError(agent, toolName);
  }

  let input: unknown;
  try {
    input = def.input(rawInput);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const call: ToolCall = { ...base, access: def.access, inputSummary: safe(rawInput), ok: false, outputSummary: '', error: `invalid_input: ${detail}`, durationMs: Date.now() - started };
    addToolCall(run, call);
    return { ok: false, value: null, error: `invalid_input: ${detail}`, call };
  }

  const inputSummary = def.summariseInput ? def.summariseInput(input as never) : safe(input);
  try {
    const value = await withTimeout(def.run(input as never), def.timeoutMs ?? 8000) as O;
    const outputSummary = def.summariseOutput ? def.summariseOutput(value as never) : safe(value);
    const call: ToolCall = { ...base, access: def.access, inputSummary, ok: true, outputSummary, durationMs: Date.now() - started };
    addToolCall(run, call);
    return { ok: true, value, call };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const call: ToolCall = { ...base, access: def.access, inputSummary, ok: false, outputSummary: '', error: detail, durationMs: Date.now() - started };
    addToolCall(run, call);
    return { ok: false, value: null, error: detail, call };
  }
}

function safe(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 240 ? s.slice(0, 237) + '…' : s;
  } catch { return '[unserialisable]'; }
}

/* ------------------------------------------------------- schema helpers */

export function obj(raw: unknown, allowedKeys: string[], tool: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolInputError(tool, 'expected an object');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!allowedKeys.includes(k)) throw new ToolInputError(tool, `unexpected key "${k}"`);
  }
  return o;
}
export function reqStr(o: Record<string, unknown>, key: string, tool: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !v) throw new ToolInputError(tool, `"${key}" must be a non-empty string`);
  return v;
}
export function optStr(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v ? v : undefined;
}
export function reqArr(o: Record<string, unknown>, key: string, tool: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ToolInputError(tool, `"${key}" must be an array`);
  return v;
}
export function idLike(value: string, prefix: string, tool: string): string {
  if (!new RegExp(`^${prefix}_[a-z0-9]{6,40}$`, 'i').test(value)) {
    throw new ToolInputError(tool, `"${value}" is not a valid ${prefix} id`);
  }
  return value;
}
