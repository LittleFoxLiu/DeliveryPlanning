export const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c] as string
));

export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  let el = document.querySelector<HTMLDivElement>('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show ${kind}`;
  window.setTimeout(() => { el!.className = 'toast'; }, 3200);
}

/** SQLite `datetime()` returns "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
 *  Normalise so the browser parses it as UTC, not local time. */
function parseTs(ts: string | null | undefined): number {
  if (!ts) return NaN;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts;
  return Date.parse(s);
}

export function fmtTime(ts: string | null | undefined): string {
  const t = parseTs(ts);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function minutesUntil(ts: string | null | undefined): number | null {
  const t = parseTs(ts);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - Date.now()) / 60_000);
}

/** Parse a comma-separated items string like "Coffee ×2, Oat milk" into
 *  [{name, qty}]. Accepts "x2", "×2", "*2" or "2x" quantity suffixes/prefixes. */
export function parseItemsInput(raw: string): { name: string; qty: number }[] {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((part) => {
      let qty = 1;
      let name = part;
      const m = part.match(/^(.*?)[\s]*[x×*]\s*(\d{1,2})$/i) || part.match(/^(\d{1,2})\s*[x×*]\s*(.*)$/i);
      if (m) {
        if (/^\d/.test(m[1])) { qty = Number(m[1]); name = m[2].trim(); }
        else { name = m[1].trim(); qty = Number(m[2]); }
      }
      return { name: name.slice(0, 80) || 'Item', qty: Math.min(Math.max(qty, 1), 99) };
    })
    .filter((i) => i.name);
}

/** Value for an <input type="datetime-local">, in LOCAL wall-clock time
 *  (not UTC — datetime-local has no timezone). */
export function localDatetimeValue(msFromNow: number): string {
  const d = new Date(Date.now() + msFromNow);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format integer cents as a currency string, e.g. 2400 → "$24.00". */
export function money(cents: number | null | undefined): string {
  const n = Number(cents) || 0;
  return `$${(n / 100).toFixed(2)}`;
}

export function relTime(ts: string): string {
  const diff = Date.now() - parseTs(ts);
  if (!Number.isFinite(diff)) return '';
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export const AGENT_COLOR: Record<string, string> = {
  Coordinator: '#5277d7',
  OrderAgent: '#159c99',
  DriverAgent: '#f1c75b',
  RoutingAgent: '#9b6dd1',
  DispatchAgent: '#f26249',
  MonitoringAgent: '#e0567d',
  Driver: '#4fa676',
  TrafficFeed: '#98a2b3',
};

export function statusChip(status: string): string {
  const map: Record<string, string> = {
    created: 'grey', ready: 'blue', validated: 'blue', dispatching: 'orange',
    assigned: 'teal', picked_up: 'teal', delivering: 'teal', en_route_pickup: 'teal',
    en_route_drop: 'teal', delivered: 'green', cancelled: 'grey', failed: 'red', pending: 'grey',
    available: 'green', on_route: 'blue', break: 'orange', offline: 'red',
  };
  return `<span class="chip ${map[status] || 'grey'}">${esc(status.replace(/_/g, ' '))}</span>`;
}

/** Customer-facing order status labels (spec vocabulary). */
const CUSTOMER_LABEL: Record<string, string> = {
  created: 'Placed', ready: 'Preparing', validated: 'Preparing', dispatching: 'Finding a driver',
  assigned: 'Driver assigned', picked_up: 'Picked up', delivering: 'In transit', en_route_drop: 'In transit',
  en_route_pickup: 'Driver assigned', delivered: 'Delivered', cancelled: 'Cancelled', failed: 'Delayed',
};
export function customerChip(orderStatus: string, deliveryStatus?: string): string {
  const s = deliveryStatus === 'en_route_drop' || deliveryStatus === 'picked_up'
    ? deliveryStatus : orderStatus;
  const label = CUSTOMER_LABEL[s] || CUSTOMER_LABEL[orderStatus] || orderStatus;
  const colorKey = s === 'delivered' ? 'green' : s === 'failed' || s === 'cancelled' ? 'red'
    : ['picked_up', 'delivering', 'en_route_drop'].includes(s) ? 'teal'
      : ['assigned', 'en_route_pickup'].includes(s) ? 'blue' : 'grey';
  return `<span class="chip ${colorKey}">${esc(label)}</span>`;
}

export function agentBadge(agent: string): string {
  return `<span class="agent-badge" style="--c:${AGENT_COLOR[agent] || '#98a2b3'}">${esc(agent)}</span>`;
}

export interface PublicRun {
  id: string; status: string; decisionMode: string | null;
  timeline: { ts: string; agent: string; label: string; detail: string }[];
}

const MODE_LABEL: Record<string, string> = {
  auto: 'Decided autonomously', auto_policy: 'Decided autonomously (policy-checked)',
  escalated: 'Escalated to a human dispatcher', blocked: 'Held for review',
};

/** Compact agent-decision summary for customer / merchant order views. */
export function agentDecisionCard(run: PublicRun | null | undefined): string {
  if (!run) return '';
  const mode = run.decisionMode ? MODE_LABEL[run.decisionMode] ?? run.decisionMode : null;
  return `<div class="card">
    <div class="card-head"><h2>How the agents decided</h2>${mode ? `<span class="chip ${run.decisionMode?.startsWith('auto') ? 'green' : 'orange'}">${esc(mode)}</span>` : ''}</div>
    <ol class="trace">${run.timeline.map((e) => `<li class="trace-${classifyPhase(e.label)}">
      <div class="trace-head">${agentBadge(e.agent)} <strong>${esc(e.label)}</strong> <time>${relTime(e.ts)}</time></div>
      <div class="trace-detail">${esc(e.detail)}</div>
    </li>`).join('')}</ol>
  </div>`;
}
function classifyPhase(label: string): string {
  if (label.startsWith('PROPOSED')) return 'proposal';
  if (label.startsWith('REVISED')) return 'revision';
  if (label === 'OBJECTED' || label === 'SUPPORTED') return 'critique';
  if (label.startsWith('DECISION')) return 'decision';
  if (label.startsWith('EXECUTED') || label.startsWith('EXECUTION')) return 'execution';
  return 'tool';
}

export function eventFeed(events: { agent: string; message: string; ts: string }[]): string {
  if (!events.length) return `<p class="muted">No agent activity yet.</p>`;
  return `<ul class="event-feed">${events.slice().reverse().map((e) => `
    <li>${agentBadge(e.agent)}<div><p>${esc(e.message)}</p><time>${relTime(e.ts)}</time></div></li>
  `).join('')}</ul>`;
}
