import { get, post, ApiError } from '../api';
import { poll, patchView, handleUnauthed, changed, resetSig } from '../main';
import { esc, toast, relTime, agentBadge } from '../ui';

interface RunSummary {
  id: string; kind: string; status: string; orderCode: string | null; orderId: string | null;
  trigger: string; risk: string | null; mode: string | null; action: string | null;
  escalationId: string | null;
  counts: { toolCalls: number; proposals: number; critiques: number; revisions: number };
  startedAt: string; endedAt: string | null;
}
interface TraceEntry { ts: string; phase: string; agent: string; label: string; detail: string; evidence?: { label: string; value: string | number | boolean }[] }
interface RunTrace {
  id: string; kind: string; status: string; orderCode: string | null; trigger: string;
  risk: { level: string; reasons: string[]; autoExecutable: boolean } | null;
  decision: { mode: string; action: string; target: string | null; explanation: string; policyChecks: { name: string; passed: boolean; detail: string }[] } | null;
  execution: { ok: boolean; detail: string; etaMinutes: number | null } | null;
  escalationId: string | null;
  counts: { toolCalls: number; toolErrors: number; proposals: number; critiques: number; revisions: number };
  timeline: TraceEntry[];
}
interface Escalation {
  id: string; runId: string; orderId: string | null; reason: string; status: string;
  proposal: { action?: string; summary?: string }; risk: { level?: string; reasons?: string[] };
  createdAt: string; resolvedBy: string | null; resolutionNote: string | null;
}

let selectedRun: string | null = null;
let trace: RunTrace | null = null;

export async function renderAdminOps(el: HTMLElement): Promise<void> {
  resetSig('admin-ops');
  const draw = async () => {
    try {
      const [{ runs }, { escalations }] = await Promise.all([
        get<{ runs: RunSummary[] }>('/admin/runs'),
        get<{ escalations: Escalation[] }>('/admin/escalations'),
      ]);
      if (!selectedRun && runs.length) selectedRun = runs[0].id;
      if (selectedRun) {
        try { trace = (await get<{ run: RunTrace }>(`/admin/runs/${selectedRun}`)).run; } catch { trace = null; }
      }
      if (!changed('admin-ops', { runs, escalations, selectedRun, trace })) return;
      if (patchView(el, view(runs, escalations))) wire(el); else resetSig('admin-ops');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) handleUnauthed();
    }
  };
  await draw();
  poll(draw, 3000);
}

const RISK_CLASS: Record<string, string> = { low: 'green', medium: 'orange', high: 'red' };
const MODE_LABEL: Record<string, string> = {
  auto: 'AUTONOMOUS', auto_policy: 'AUTONOMOUS (policy)', escalated: 'ESCALATED → HUMAN', blocked: 'BLOCKED',
};

function view(runs: RunSummary[], escalations: Escalation[]): string {
  const pending = escalations.filter((e) => e.status === 'pending');
  return `
    <div class="page-head"><div><h1>Autonomous Operations</h1>
      <p>Every dispatch and recovery decision the agents make — proposed, critiqued, revised, validated, executed.</p></div></div>

    ${pending.length ? `<div class="card" style="border-color:var(--red)">
      <div class="card-head"><h2>⚠ Human approval required (${pending.length})</h2></div>
      ${pending.map((e) => `<div class="request-row">
        <span><strong>${esc(e.orderId ? shortCode(e.orderId) : e.id)}</strong> — ${esc(e.reason)}<br>
          <span class="muted">${esc(String(e.proposal?.summary ?? e.proposal?.action ?? ''))} · risk ${esc(e.risk?.level ?? '?')}</span></span>
        <span>
          <button class="btn sm primary" data-esc="${esc(e.id)}" data-decision="approved">Approve &amp; execute</button>
          <button class="btn sm" data-esc="${esc(e.id)}" data-decision="rejected">Reject</button>
        </span>
      </div>`).join('')}
    </div>` : ''}

    <div class="grid2">
      <div class="card">
        <div class="card-head"><h2>Planning runs</h2><span class="muted">${runs.length} recent</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Run</th><th>Trigger</th><th>Risk</th><th>Outcome</th><th>Loop</th></tr></thead>
          <tbody>${runs.map((r) => `
            <tr data-run="${esc(r.id)}" style="cursor:pointer;${r.id === selectedRun ? 'background:#faf3f1' : ''}">
              <td><strong>${esc(r.orderCode ?? r.kind)}</strong><br><span class="muted">${esc(r.kind)} · ${relTime(r.startedAt)}</span></td>
              <td><span class="muted">${esc(r.trigger.slice(0, 40))}</span></td>
              <td>${r.risk ? `<span class="chip ${RISK_CLASS[r.risk] ?? 'grey'}">${esc(r.risk)}</span>` : '—'}</td>
              <td><span class="chip ${r.status === 'executed' ? 'green' : r.status === 'escalated' ? 'red' : 'grey'}">${esc(MODE_LABEL[r.mode ?? ''] ?? r.status)}</span></td>
              <td class="muted">${r.counts.proposals}p · ${r.counts.critiques}c · ${r.counts.revisions}r · ${r.counts.toolCalls}t</td>
            </tr>`).join('') || '<tr><td colspan="5" class="muted">No runs yet. Mark an order ready.</td></tr>'}</tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Decision trace</h2>${trace ? `<span class="muted">${esc(trace.orderCode ?? trace.id)}</span>` : ''}</div>
        ${trace ? traceView(trace) : '<p class="muted">Select a run to see the agent reasoning chain.</p>'}
      </div>
    </div>`;
}

function traceView(t: RunTrace): string {
  return `
    ${t.risk ? `<div class="next-step" style="background:${t.risk.level === 'high' ? '#fbe4df' : t.risk.level === 'medium' ? '#fcefdd' : '#e3f4ea'};color:#333">
      <strong>Risk: ${esc(t.risk.level.toUpperCase())}</strong> — ${esc(t.risk.reasons.join(' '))}</div>` : ''}
    ${t.decision ? `<p style="margin:10px 0"><strong>${esc(MODE_LABEL[t.decision.mode] ?? t.decision.mode)}</strong>: ${esc(t.decision.explanation)}</p>
      <p class="muted" style="font-size:12px">Policy gates: ${t.decision.policyChecks.map((c) => `${c.passed ? '✓' : '✗'} ${esc(c.name)}`).join(' · ')}</p>` : ''}
    <ol class="trace">
      ${t.timeline.map((e) => `<li class="trace-${esc(e.phase)}">
        <div class="trace-head">${agentBadge(e.agent)} <strong>${esc(e.label)}</strong> <time>${relTime(e.ts)}</time></div>
        <div class="trace-detail">${esc(e.detail)}</div>
        ${e.evidence && e.evidence.length ? `<div class="trace-evidence">${e.evidence.map((ev) => `<span>${esc(ev.label)}: <b>${esc(String(ev.value))}</b></span>`).join('')}</div>` : ''}
      </li>`).join('')}
    </ol>
    ${t.execution ? `<div class="next-step" style="margin-top:10px">${t.execution.ok ? '✓ Executed' : '✗ Not executed'} — ${esc(t.execution.detail)}</div>` : ''}`;
}

function wire(el: HTMLElement): void {
  el.querySelectorAll<HTMLElement>('[data-run]').forEach((r) => r.addEventListener('click', () => {
    selectedRun = r.dataset.run!;
    renderAdminOps(el);
  }));
  el.querySelectorAll<HTMLButtonElement>('[data-esc]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const res = await post<{ outcome?: { status?: string; detail?: string } }>(`/admin/escalations/${b.dataset.esc}`, { decision: b.dataset.decision, note: '' });
      toast(b.dataset.decision === 'approved'
        ? `Approved — ${res.outcome?.status ?? 'done'}${res.outcome?.detail ? `: ${res.outcome.detail}` : ''}`
        : 'Escalation rejected');
      renderAdminOps(el);
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); b.disabled = false; }
  }));
}

function shortCode(id: string): string {
  return `#${id.replace(/^ord_/, '').slice(-6).toUpperCase()}`;
}
