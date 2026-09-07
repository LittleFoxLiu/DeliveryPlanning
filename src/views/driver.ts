import { get, post, ApiError } from '../api';
import { poll, patchView, handleUnauthed, changed, resetSig } from '../main';
import { esc, toast, statusChip, fmtTime, minutesUntil } from '../ui';
import { renderMap, routeToPath, type MapMarker, type MapPath } from '../map';
import type { RoadSeg, Point } from '../types';

interface DriverDelivery {
  id: string; status: string; etaTs: string | null; estimatedDeliveryMinutes: number | null;
  order: { id: string; priority: string; packageSize: string; deadlineTs: string; items: { name: string; qty: number }[] };
  pickup: Point & { name?: string }; dropoff: Point;
  route: { path: { toPickup?: Point[]; toDropoff?: Point[] } } | null;
}

let grid: { size: number; roads: RoadSeg[] } = { size: 20, roads: [] };

export async function renderDriver(el: HTMLElement): Promise<void> {
  resetSig('driver');
  try { grid = await get('/meta/grid'); } catch { /* ignore */ }
  const draw = async () => {
    try {
      const { deliveries } = await get<{ deliveries: DriverDelivery[] }>('/driver/deliveries');
      const active = deliveries.filter((d) => !['delivered', 'cancelled', 'failed'].includes(d.status));
      if (!changed('driver', deliveries)) return;
      if (patchView(el, view(active, deliveries))) wire(el); else resetSig('driver');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) handleUnauthed();
    }
  };
  await draw();
  poll(draw, 4000);
}

function view(active: DriverDelivery[], all: DriverDelivery[]): string {
  const done = all.filter((d) => d.status === 'delivered').length;
  const markers: MapMarker[] = [];
  const paths: MapPath[] = [];
  active.forEach((d) => {
    markers.push({ x: d.pickup.x, y: d.pickup.y, kind: 'pickup', label: 'Pickup' });
    markers.push({ x: d.dropoff.x, y: d.dropoff.y, kind: 'dropoff', label: 'Customer' });
    const pts = routeToPath(d.route);
    if (pts.length > 1) paths.push({ points: pts, color: '#159c99', active: true });
  });

  return `
    <div class="page-head"><div><h1>Driver</h1><p>${active.length} active · ${done} delivered today</p></div>
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
        <div class="card-head"><h2>Route</h2></div>
        ${renderMap({ size: grid.size, roads: grid.roads, markers, paths })}
      </div>
    </div>`;
}

function card(d: DriverDelivery): string {
  const mins = minutesUntil(d.etaTs);
  const actions =
    d.status === 'assigned' ? `<button class="btn primary" data-accept="${esc(d.id)}">Accept delivery</button>` :
    d.status === 'en_route_pickup' ? `<button class="btn primary" data-do="picked_up" data-id="${esc(d.id)}">Confirm pickup</button>` :
    ['picked_up', 'en_route_drop'].includes(d.status) ? `<button class="btn primary" data-do="delivered" data-id="${esc(d.id)}">Mark delivered</button>` : '';
  return `<div class="card">
    <div class="card-head"><h2>Order ${esc(d.order.id.slice(-6))}</h2>${statusChip(d.status)}</div>
    <dl class="kv">
      <dt>Pickup</dt><dd>${esc(d.pickup.name || 'Merchant')} — (${d.pickup.x}, ${d.pickup.y})</dd>
      <dt>Customer</dt><dd>(${d.dropoff.x}, ${d.dropoff.y})</dd>
      <dt>Items</dt><dd>${d.order.items.map((i) => `${esc(i.name)} ×${i.qty}`).join(', ')}</dd>
      <dt>Package</dt><dd>${esc(d.order.packageSize)} · ${esc(d.order.priority)}</dd>
      <dt>Deadline</dt><dd>${fmtTime(d.order.deadlineTs)}</dd>
      <dt>ETA</dt><dd>${d.etaTs ? `${fmtTime(d.etaTs)}${mins !== null ? ` (${mins}m)` : ''}` : '—'}</dd>
    </dl>
    <div class="pill-row" style="margin-top:12px">${actions}</div>
  </div>`;
}

function wire(el: HTMLElement): void {
  el.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach((b) => b.addEventListener('click', () =>
    run(() => post(`/driver/deliveries/${b.dataset.accept}/accept`), 'Delivery accepted', el)));
  el.querySelectorAll<HTMLButtonElement>('[data-do]').forEach((b) => b.addEventListener('click', () =>
    run(() => post(`/driver/deliveries/${b.dataset.id}/status`, { action: b.dataset.do }), b.dataset.do === 'delivered' ? 'Delivered!' : 'Pickup confirmed', el)));
  el.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) => b.addEventListener('click', () =>
    run(() => post('/driver/status', { status: b.dataset.status }), `Status: ${b.dataset.status}`, el)));
}

async function run(fn: () => Promise<unknown>, ok: string, el: HTMLElement): Promise<void> {
  try { await fn(); toast(ok); renderDriver(el); }
  catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); }
}
