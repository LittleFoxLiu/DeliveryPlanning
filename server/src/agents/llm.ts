import { config } from '../config.js';

export type RemediationStrategy = 'reroute' | 'reassign';

export interface AdvisoryContext {
  orderId: string;
  issues: string[];
  slipMin: number;
  missesDeadline: boolean;
  rerouteFeasible: boolean;
  reassignFeasible: boolean;
  deterministicChoice: RemediationStrategy;
}

export interface Advisory {
  strategy: RemediationStrategy;
  rationale: string;
  source: 'llm' | 'deterministic';
}

/**
 * Optional LLM advisory layer. The LLM only ORCHESTRATES — it picks between
 * pre-validated, feasible remediation strategies and explains the choice.
 * It never produces numbers, authorization, or database mutations. If it is
 * disabled, unreachable, or returns anything unexpected, the deterministic
 * choice wins.
 */
export async function adviseRemediation(ctx: AdvisoryContext): Promise<Advisory> {
  const deterministic: Advisory = {
    strategy: ctx.deterministicChoice,
    source: 'deterministic',
    rationale: buildDeterministicRationale(ctx),
  };
  if (!config.llm.enabled) return deterministic;
  if (!ctx.rerouteFeasible && !ctx.reassignFeasible) return deterministic;

  try {
    const allowed: RemediationStrategy[] = [];
    if (ctx.rerouteFeasible) allowed.push('reroute');
    if (ctx.reassignFeasible) allowed.push('reassign');
    if (allowed.length === 1) return { ...deterministic, strategy: allowed[0] };

    const body = {
      model: config.llm.model,
      max_tokens: 300,
      system:
        'You are the Coordinator agent in an autonomous delivery dispatch system. '
        + 'A delivery is at risk. Choose the best remediation strategy from the allowed list. '
        + 'You must NOT invent numbers — use only the values provided. '
        + 'Respond with a single JSON object: {"strategy": "<one of allowed>", "rationale": "<=200 chars"}.',
      messages: [{
        role: 'user',
        content: JSON.stringify({
          allowedStrategies: allowed,
          situation: {
            orderId: ctx.orderId,
            issues: ctx.issues,
            minutesBehindSchedule: ctx.slipMin,
            willMissDeadline: ctx.missesDeadline,
          },
          guidance: 'Prefer reroute for recoverable traffic/deviation. Prefer reassign when the driver is unavailable or a reroute cannot meet the deadline.',
        }),
      }],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${config.llm.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.llm.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    }).finally(() => clearTimeout(timer));

    if (!res.ok) return deterministic;
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = json.content?.find((b) => b.type === 'text')?.text ?? '';
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { strategy?: string; rationale?: string };
    if (parsed.strategy !== 'reroute' && parsed.strategy !== 'reassign') return deterministic;
    if (!allowed.includes(parsed.strategy)) return deterministic;
    return {
      strategy: parsed.strategy,
      source: 'llm',
      rationale: (typeof parsed.rationale === 'string' ? parsed.rationale : '').slice(0, 200) || deterministic.rationale,
    };
  } catch {
    return deterministic;
  }
}

function buildDeterministicRationale(ctx: AdvisoryContext): string {
  if (ctx.issues.includes('driver_unavailable')) return 'Driver is unavailable — reassignment is the only recovery.';
  if (ctx.issues.includes('route_blocked') && !ctx.rerouteFeasible) return 'All routes blocked for this driver — reassigning to a driver with a clear path.';
  if (ctx.deterministicChoice === 'reassign') return `Projected slip of ${ctx.slipMin} min cannot be recovered by rerouting — reassigning.`;
  return `Recoverable delay (${ctx.slipMin} min) — recalculating the route for the current driver.`;
}
