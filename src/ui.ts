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

export function agentBadge(agent: string): string {
  return `<span class="agent-badge" style="--c:${AGENT_COLOR[agent] || '#98a2b3'}">${esc(agent)}</span>`;
}

export function eventFeed(events: { agent: string; message: string; ts: string }[]): string {
  if (!events.length) return `<p class="muted">No agent activity yet.</p>`;
  return `<ul class="event-feed">${events.slice().reverse().map((e) => `
    <li>${agentBadge(e.agent)}<div><p>${esc(e.message)}</p><time>${relTime(e.ts)}</time></div></li>
  `).join('')}</ul>`;
}
