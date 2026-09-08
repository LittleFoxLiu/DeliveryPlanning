import { get, post, ApiError } from '../api';
import { poll, patchView, handleUnauthed, changed, resetSig } from '../main';
import { esc, toast, statusChip, fmtTime, minutesUntil } from '../ui';
import { renderMap, routeToPath, enableMapTooltips, type MapMarker, type MapPath } from '../map';
import type { RoadSeg, Point } from '../types';

interface DriverDelivery {
  id: string; status: string; etaTs: string | null; estimatedDeliveryMinutes: number | null;
  order: { code: string; priority: string; packageSize: string; deadlineTs: string; note: string | null; customerName: string; items: { name: string; qty: number }[] };
  pickup: Point & { name?: string }; dropoff: Point;
  route: { path: { toPickup?: Point[]; toDropoff?: Point[] } } | null;
}
interface Me { location: Point | null; status: string; name: string; vehicleType: string }

let grid: { size: number; roads: RoadSeg[] } = { size: 20, roads: [] };

export async function renderDriver(el: HTMLElement): Promise<void> {
  resetSig('driver');
  try { grid = await get('/meta/grid'); } catch { /* ignore */ }
  const draw = async () => {
    try {
      const { deliveries, me } = await get<{ deliveries: DriverDelivery[]; me: Me }>('/driver/deliveries');
      const active = deliveries.filter((d) => !['delivered', 'cancelled', 'failed'].includes(d.status));
      if (!changed('driver', { deliveries, me })) return;
      if (patchView(el, view(active, deliveries, me))) wire(el); else resetSig('driver');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) handleUnauthed();
    }
  };
  await draw();
  poll(draw, 4000);
}

/** Where the driver needs to head next for a given delivery. */
function nextTarget(d: DriverDelivery): { label: string; at: Point } {
  return ['assigned', 'en_route_pickup'].includes(d.status)
    ? { label: `Pickup at ${d.pickup.name || 'the merchant'}`, at: d.pickup }
    : { label: `${d.order.customerName}'s address`, at: d.dropoff };
}

function view(active: DriverDelivery[], all: DriverDelivery[], me: Me): string {
  const done = all.filter((d) => d.status === 'delivered').length;
  const markers: MapMarker[] = [];
  const paths: MapPath[] = [];

  if (me.location) {
    markers.push({
      x: me.location.x, y: me.location.y, kind: 'driver', pulse: me.status === 'on_route',
      title: `You (${me.name})`,
      tip: [`${me.vehicleType} · ${me.status.replace(/_/g, ' ')}`, `at (${me.location.x}, ${me.location.y})`],
    });
  }
  active.forEach((d) => {
    const t = nextTarget(d);
    markers.push({ x: d.pickup.x, y: d.pickup.y, kind: 'pickup', title: `Pickup — ${d.pickup.name || 'Merchant'}`, tip: [d.order.code, `(${d.pickup.x}, ${d.pickup.y})`] });
    markers.push({ x: d.dropoff.x, y: d.dropoff.y, kind: 'dropoff', title: `${d.order.customerName} (customer)`, tip: [d.order.code, `(${d.dropoff.x}, ${d.dropoff.y})`], pulse: t.at === d.dropoff });
    const pts = routeToPath(d.route);
    if (pts.length > 1) paths.push({ points: pts, color: '#159c99', active: true });
  });

  const here = me.location ? `(${me.location.x}, ${me.location.y})` : 'unknown';

  return `
    <div class="page-head">
      <div><h1>Driver — ${esc(me.name)}</h1><p>${active.length} active · ${done} delivered today · you are at <strong>${here}</strong> ${statusChip(me.status)}</p></div>
      <div class="pill-row">
        <button class="btn ghost" data-status="break">Take a break</button>
        <button class="btn ghost" data-status="available">Go available</button>
      </div>
    </div>
    <div class="grid2">
      <div>
        ${active.length ? active.map(card).join('') : '<div class="card"><p class="muted">No active deliveries. Sit tight — Dispatch will notify you.</p></div>'}
      </div>
      <div class="card">
        <div class="card-head"><h2>Your route</h2><span class="muted">you are the teal dot</span></div>
        ${renderMap({ size: grid.size, roads: grid.roads, markers, paths })}
      </div>
    </div>`;
}

function card(d: DriverDelivery): string {
  const mins = minutesUntil(d.etaTs);
  const t = nextTarget(d);
  const actions =
    d.status === 'assigned' ? `<button class="btn primary" data-accept="${esc(d.id)}">Accept — head to pickup</button>` :
    d.status === 'en_route_pickup' ? `<button class="btn primary" data-do="picked_up" data-id="${esc(d.id)}">I've collected the package</button>` :
    ['picked_up', 'en_route_drop'].includes(d.status) ? `<button class="btn primary" data-do="delivered" data-id="${esc(d.id)}">Mark delivered</button>` : '';
  return `<div class="card">
    <div class="card-head"><h2>Order ${esc(d.order.code)}</h2>${statusChip(d.status)}</div>
    <div class="next-step">➜ Head to <strong>${esc(t.label)}</strong> — (${t.at.x}, ${t.at.y})</div>
    <dl class="kv" style="margin-top:10px">
      <dt>Customer</dt><dd>${esc(d.order.customerName)}</dd>
      <dt>Pickup</dt><dd>${esc(d.pickup.name || 'Merchant')} — (${d.pickup.x}, ${d.pickup.y})</dd>
      <dt>Drop-off</dt><dd>(${d.dropoff.x}, ${d.dropoff.y})</dd>
      <dt>Items</dt><dd>${d.order.items.map((i) => `${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ') || '—'}</dd>
      <dt>Package</dt><dd>${esc(d.order.packageSize)} · ${esc(d.order.priority)}</dd>
      ${d.order.note ? `<dt>Note</dt><dd>${esc(d.order.note)}</dd>` : ''}
      <dt>Deadline</dt><dd>${fmtTime(d.order.deadlineTs)}</dd>
      <dt>ETA</dt><dd>${d.etaTs ? `${fmtTime(d.etaTs)}${mins !== null ? ` (${mins}m)` : ''}` : '—'}</dd>
    </dl>
    <div class="pill-row" style="margin-top:12px">${actions}</div>
  </div>`;
}

function wire(el: HTMLElement): void {
  enableMapTooltips(el);
  el.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach((b) => b.addEventListener('click', () =>
    run(() => post(`/driver/deliveries/${b.dataset.accept}/accept`), 'Accepted — navigate to the pickup', el)));
  el.querySelectorAll<HTMLButtonElement>('[data-do]').forEach((b) => b.addEventListener('click', () =>
    run(() => post(`/driver/deliveries/${b.dataset.id}/status`, { action: b.dataset.do }), b.dataset.do === 'delivered' ? 'Delivered!' : 'Pickup confirmed — head to the customer', el)));
  el.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) => b.addEventListener('click', () =>
    run(() => post('/driver/status', { status: b.dataset.status }), `Status: ${b.dataset.status}`, el)));
}

async function run(fn: () => Promise<unknown>, ok: string, el: HTMLElement): Promise<void> {
  try { await fn(); toast(ok); renderDriver(el); }
  catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); }
}
