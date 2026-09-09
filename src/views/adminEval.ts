import { get, post, ApiError } from '../api';
import { poll, patchView, handleUnauthed, changed, resetSig } from '../main';
import { esc, toast } from '../ui';

interface ScenarioMetrics {
  scenarioId: string; name: string; kind: 'golden' | 'adversarial'; passed: boolean; detail: string;
  deadlineMet: boolean | null; delivered: boolean; unsafeActions: number; toolErrors: number;
  escalations: number; autonomousActions: number; reassignments: number; routeChanges: number; planningMs: number;
}
interface ComparisonRow {
  scenario: string;
  autonomous: { delivered: number; onTime: number; avgDeliveryMin: number | null; recoveries: number };
  baseline: { delivered: number; onTime: number; avgDeliveryMin: number | null; recoveries: number };
}
interface Report {
  ranAt: string; durationMs: number; scenarios: ScenarioMetrics[];
  summary: { total: number; passed: number; golden: { total: number; passed: number }; adversarial: { total: number; passed: number }; totalUnsafeActions: number; totalToolErrors: number; totalEscalations: number };
  comparison: { rows: ComparisonRow[]; totals: { autonomous: { delivered: number; onTime: number; recoveries: number }; baseline: { delivered: number; onTime: number; recoveries: number } } };
}

let report: Report | null = null;
let running = false;

export async function renderAdminEval(el: HTMLElement): Promise<void> {
  resetSig('admin-eval');
  const draw = async () => {
    try {
      const r = await get<{ report: Report | null; running: boolean }>('/admin/eval/results');
      report = r.report; running = r.running;
      if (!changed('admin-eval', { report, running })) return;
      if (patchView(el, view())) wire(el); else resetSig('admin-eval');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) handleUnauthed();
    }
  };
  await draw();
  poll(draw, 3000);
}

function view(): string {
  return `
    <div class="page-head">
      <div><h1>Evaluation Center</h1><p>Deterministic golden &amp; adversarial scenarios, run live against the real agents. Every number below comes from an actual simulation.</p></div>
      <div class="pill-row"><button class="btn primary" data-run-eval ${running ? 'disabled' : ''}>${running ? 'Running…' : '▶ Run evaluation'}</button></div>
    </div>
    ${!report ? `<div class="card"><p class="muted">${running ? 'Evaluation in progress — this reseeds the demo and runs ~10 scenarios plus a baseline comparison (about 20–40s).' : 'No results yet. Click “Run evaluation”. It reseeds the demo world afterwards.'}</p></div>` : reportView(report)}`;
}

function reportView(r: Report): string {
  const s = r.summary;
  const c = r.comparison.totals;
  return `
    <div class="grid3" style="margin-bottom:18px">
      <div class="stat"><div class="n">${s.passed}/${s.total}</div><div class="l">Scenarios passed</div></div>
      <div class="stat"><div class="n">${s.totalUnsafeActions}</div><div class="l">Unsafe actions</div></div>
      <div class="stat"><div class="n">${s.totalToolErrors}</div><div class="l">Tool errors</div></div>
      <div class="stat"><div class="n">${s.totalEscalations}</div><div class="l">Human escalations</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Autonomous Delivery Planner vs. nearest-feasible-driver baseline</h2>
        <span class="muted">identical scenarios, real simulation</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Scenario</th><th>Planner delivered</th><th>Baseline delivered</th><th>Planner on-time</th><th>Baseline on-time</th><th>Planner recoveries</th></tr></thead>
        <tbody>${r.comparison.rows.map((row) => `<tr>
          <td>${esc(row.scenario)}</td>
          <td><b>${row.autonomous.delivered}</b></td><td>${row.baseline.delivered}</td>
          <td><b>${row.autonomous.onTime}</b></td><td>${row.baseline.onTime}</td>
          <td>${row.autonomous.recoveries}</td>
        </tr>`).join('')}
        <tr style="border-top:2px solid var(--line)">
          <td><strong>Total</strong></td>
          <td><strong>${c.autonomous.delivered}</strong></td><td><strong>${c.baseline.delivered}</strong></td>
          <td><strong>${c.autonomous.onTime}</strong></td><td><strong>${c.baseline.onTime}</strong></td>
          <td><strong>${c.autonomous.recoveries}</strong></td>
        </tr></tbody>
      </table></div>
      <p class="muted" style="margin-top:8px">The baseline has no monitoring and no recovery — when a driver drops out or a road closes it simply fails.</p>
    </div>

    <div class="card">
      <div class="card-head"><h2>Scenario results</h2><span class="muted">ran ${new Date(r.ranAt).toLocaleTimeString()} · ${(r.durationMs / 1000).toFixed(1)}s</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th></th><th>Scenario</th><th>Type</th><th>Result</th><th>Autonomy</th><th>Escalations</th><th>Detail</th></tr></thead>
        <tbody>${r.scenarios.map((sc) => `<tr>
          <td>${sc.passed ? '<span class="chip green">PASS</span>' : '<span class="chip red">FAIL</span>'}</td>
          <td><strong>${esc(sc.name)}</strong></td>
          <td><span class="chip ${sc.kind === 'golden' ? 'blue' : 'orange'}">${esc(sc.kind)}</span></td>
          <td>${sc.delivered ? 'delivered' : '—'}${sc.deadlineMet === true ? ' · on time' : sc.deadlineMet === false ? ' · late' : ''}</td>
          <td>${sc.autonomousActions} action(s)${sc.reassignments ? ` · ${sc.reassignments} reassign` : ''}${sc.routeChanges ? ` · ${sc.routeChanges} reroute` : ''}</td>
          <td>${sc.escalations}</td>
          <td class="muted" style="font-size:12px">${esc(sc.detail)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

function wire(el: HTMLElement): void {
  el.querySelector<HTMLButtonElement>('[data-run-eval]')?.addEventListener('click', async (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    toast('Evaluation started — reseeding and running scenarios…');
    try {
      const r = await post<{ report: Report }>('/admin/eval/run');
      report = r.report;
      toast(`Evaluation complete — ${r.report.summary.passed}/${r.report.summary.total} passed`);
      renderAdminEval(el);
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Evaluation failed', 'error'); renderAdminEval(el); }
  });
}
