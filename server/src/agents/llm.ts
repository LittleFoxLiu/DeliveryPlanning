import { config } from '../config.js';

export const llmEnabled = config.llm.enabled;

/* ------------------------------------------------------------------ transport */

interface ChatOpts {
  system: string;
  user: string;
  maxTokens?: number;
  json?: boolean;
  timeoutMs?: number;
}

/** One chat round-trip. Returns the raw assistant text, or null on any failure.
 *  Provider is chosen in config: an Ollama-format gateway (Bedrock proxy) or
 *  the direct Anthropic Messages API. Time-boxed; never throws. */
async function chat({ system, user, maxTokens = 400, json = false, timeoutMs }: ChatOpts): Promise<string | null> {
  if (!config.llm.enabled) return null;
  const llm = config.llm;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? llm.timeoutMs);
  try {
    if (llm.provider === 'gateway') {
      const res = await fetch(`${llm.url}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          stream: false,
          ...(json ? { format: 'json' } : {}),
          options: { temperature: 0, num_predict: maxTokens },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { message?: { content?: string } };
      return j.message?.content ?? null;
    }
    // direct Anthropic
    const res = await fetch(`${llm.url}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: llm.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: { type: string; text?: string }[] };
    return j.content?.find((b) => b.type === 'text')?.text ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** Ask for a JSON object and validate it. Returns the validated value or null. */
async function askJson<T>(system: string, user: string, validate: (v: unknown) => T | null, maxTokens = 400, timeoutMs?: number): Promise<T | null> {
  const raw = await chat({ system, user, maxTokens, json: true, timeoutMs });
  if (raw == null) return null;
  return validate(extractJson(raw));
}

/* --------------------------------------------------- 1. remediation strategy */

export type RemediationStrategy = 'reroute' | 'reassign';

export interface AdvisoryContext {
  orderId: string;
  issues: string[];
  slipMin: number;
  missesDeadline: boolean;
  rerouteFeasible: boolean;
  reassignFeasible: boolean;
  deterministicChoice: RemediationStrategy;
  alternativeDriver?: { name: string; deadlineSlackMin: number } | null;
}

export interface Advisory { strategy: RemediationStrategy; rationale: string; source: 'llm' | 'deterministic' }

export async function adviseRemediation(ctx: AdvisoryContext): Promise<Advisory> {
  const deterministic: Advisory = {
    strategy: ctx.deterministicChoice, source: 'deterministic', rationale: deterministicRemediationReason(ctx),
  };
  const allowed: RemediationStrategy[] = [];
  if (ctx.rerouteFeasible) allowed.push('reroute');
  if (ctx.reassignFeasible) allowed.push('reassign');
  if (allowed.length === 0) return deterministic;
  if (allowed.length === 1) return { ...deterministic, strategy: allowed[0] };
  if (!config.llm.enabled) return deterministic;

  const parsed = await askJson<Advisory>(
    'You are the Coordinator in an autonomous delivery dispatch system. A live delivery is at risk. '
    + 'Pick the best remediation from the allowed list. Use ONLY the numbers given — never invent any. '
    + 'Reply with JSON: {"strategy": <one of allowed>, "rationale": "<=200 chars, plain, dispatcher-facing"}.',
    JSON.stringify({
      allowed,
      situation: {
        order: ctx.orderId, issues: ctx.issues, minutesBehindSchedule: ctx.slipMin, willMissDeadline: ctx.missesDeadline,
        alternativeDriverIfReassigned: ctx.alternativeDriver ?? null,
      },
      guidance: 'reroute keeps the current driver on a fresh OSRM path; choose it when the current route has changed. '
        + 'reassign hands the order to another driver; choose it when the driver is unavailable or a reroute cannot beat the deadline and an alternative can.',
    }),
    (v) => {
      const o = v as { strategy?: unknown; rationale?: unknown };
      if (o?.strategy !== 'reroute' && o?.strategy !== 'reassign') return null;
      if (!allowed.includes(o.strategy)) return null;
      return {
        strategy: o.strategy, source: 'llm' as const,
        rationale: (typeof o.rationale === 'string' ? o.rationale : '').slice(0, 200) || deterministic.rationale,
      };
    },
    250,
  );
  return parsed ?? deterministic;
}

function deterministicRemediationReason(ctx: AdvisoryContext): string {
  if (ctx.issues.includes('driver_unavailable')) return 'Driver is unavailable — reassignment is the only recovery.';
  if (ctx.issues.includes('route_blocked') && !ctx.rerouteFeasible) return 'Every path is blocked for this driver — reassigning to one with a clear route.';
  if (ctx.deterministicChoice === 'reassign') {
    return ctx.alternativeDriver
      ? `A reroute leaves ${ctx.slipMin} min of unrecoverable slip; ${ctx.alternativeDriver.name} can still make the deadline — reassigning.`
      : `Projected slip of ${ctx.slipMin} min cannot be recovered by rerouting — reassigning.`;
  }
  return `Recoverable ${ctx.slipMin}-minute delay — recalculating the route for the current driver.`;
}

/* -------------------------------------------------- 2. assignment explanation */

export interface AssignmentExplainInput {
  orderCode: string;
  winner: { name: string; score: number; factors: Record<string, unknown>; contributions: Record<string, number> };
  runnerUp?: { name: string; score: number } | null;
  rejected: { name: string; reasons: string[] }[];
}

/** Turn the deterministic score breakdown into one dispatcher-facing sentence.
 *  The LLM may only rephrase the given numbers; the decision is already made. */
export async function explainAssignment(input: AssignmentExplainInput): Promise<{ text: string; source: 'llm' | 'deterministic' }> {
  const f = input.winner.factors;
  const fallback = `${input.winner.name} selected (score ${input.winner.score})`
    + `: ETA ${num(f.totalDeliveryMin)} min, ${num(f.deadlineSlackMin)} min of deadline slack, `
    + `route efficiency ${num(f.routeEfficiencyPct)}%`
    + (input.runnerUp ? `, ahead of ${input.runnerUp.name} (${input.runnerUp.score}).` : '.');
  if (!config.llm.enabled) return { text: fallback, source: 'deterministic' };

  const raw = await chat({
    system: 'You are the Dispatch Agent. A driver has already been chosen by a deterministic scorer. '
      + 'Write ONE clear sentence (max 240 chars) for a dispatcher explaining why, using ONLY the numbers provided. '
      + 'Do not invent numbers, do not hedge, do not add a preamble.',
    user: JSON.stringify(input),
    maxTokens: 160,
    timeoutMs: 5000,
  });
  const text = (raw ?? '').trim().replace(/^["']|["']$/g, '');
  return text.length >= 20 && text.length <= 400 ? { text, source: 'llm' } : { text: fallback, source: 'deterministic' };
}

/* ------------------------------------------------------ 3. risk-alert narration */

export type RiskSeverity = 'info' | 'warn' | 'critical';

export interface RiskNarrateInput {
  orderCode: string;
  driver: string;
  issues: string[];
  slipMin: number;
  missesDeadline: boolean;
  projectedDoneLocal: string;
}

export async function narrateRisk(input: RiskNarrateInput): Promise<{ message: string; severity: RiskSeverity; source: 'llm' | 'deterministic' }> {
  const detSeverity: RiskSeverity = input.issues.includes('driver_unavailable') || input.missesDeadline
    ? 'critical' : input.slipMin >= 10 ? 'warn' : 'info';
  const detMessage = input.slipMin >= 3
    ? `${input.driver} is ${input.slipMin} min behind on ${input.orderCode} (${input.issues.join(', ')}); projected arrival ${input.projectedDoneLocal}.`
    : `${input.driver}: ${input.issues.join(', ')} on ${input.orderCode}.`;
  if (!config.llm.enabled) return { message: detMessage, severity: detSeverity, source: 'deterministic' };

  const parsed = await askJson<{ message: string; severity: RiskSeverity }>(
    'You are the Monitoring Agent. Describe a delivery risk in one short sentence for a dispatcher, and rate its urgency. '
    + 'Use ONLY the numbers given. Reply JSON: {"message": "<=200 chars", "severity": "info"|"warn"|"critical"}.',
    JSON.stringify(input),
    (v) => {
      const o = v as { message?: unknown; severity?: unknown };
      const sev = o?.severity;
      if (sev !== 'info' && sev !== 'warn' && sev !== 'critical') return null;
      const msg = typeof o?.message === 'string' ? o.message.slice(0, 220) : '';
      return msg.length >= 10 ? { message: msg, severity: sev } : null;
    },
    160,
    5000,
  );
  return parsed ? { ...parsed, source: 'llm' } : { message: detMessage, severity: detSeverity, source: 'deterministic' };
}

/* ------------------------------------------------ 4. delivery-note interpretation */

export interface NoteFlags {
  contactRequired: boolean;
  leaveUnattended: boolean;
  fragile: boolean;
  accessNotes: string;
}

const EMPTY_FLAGS: NoteFlags = { contactRequired: false, leaveUnattended: false, fragile: false, accessNotes: '' };

export async function interpretNote(note: string | null): Promise<{ flags: NoteFlags; source: 'llm' | 'deterministic' | 'none' }> {
  if (!note || !note.trim()) return { flags: EMPTY_FLAGS, source: 'none' };
  // cheap deterministic keyword pass as the fallback
  const n = note.toLowerCase();
  const det: NoteFlags = {
    contactRequired: /\bcall\b|\bring\b|\bphone\b|\btext\b|\bknock\b/.test(n),
    leaveUnattended: /leave (it )?(at|by|with)|drop (it )?(at|off)|front desk|doorstep|no need to/.test(n),
    fragile: /fragile|handle with care|breakable|glass\b/.test(n),
    accessNotes: note.slice(0, 120),
  };
  if (!config.llm.enabled) return { flags: det, source: 'deterministic' };

  const parsed = await askJson<NoteFlags>(
    'You are the Order Agent. Extract structured delivery instructions from a customer note. '
    + 'Reply JSON: {"contactRequired": bool, "leaveUnattended": bool, "fragile": bool, "accessNotes": "<=120 chars plain summary"}.',
    JSON.stringify({ note }),
    (v) => {
      const o = v as Partial<NoteFlags>;
      if (typeof o !== 'object' || o === null) return null;
      return {
        contactRequired: !!o.contactRequired,
        leaveUnattended: !!o.leaveUnattended,
        fragile: !!o.fragile,
        accessNotes: (typeof o.accessNotes === 'string' ? o.accessNotes : note).slice(0, 120),
      };
    },
    200,
  );
  return parsed ? { flags: parsed, source: 'llm' } : { flags: det, source: 'deterministic' };
}

function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '—';
}
