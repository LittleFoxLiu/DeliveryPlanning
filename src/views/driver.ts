import { get, post, ApiError } from '../api';
import { poll, patchView, handleUnauthed, changed, resetSig } from '../main';
import { esc, toast, statusChip, fmtTime, minutesUntil } from '../ui';
import { enableMapTooltips } from '../map';
import type { Point } from '../types';
import { mountLocationMap, mountRouteMap, type GeoPoint } from '../geoMap';
import { gridToGeo, geoToGrid } from '../geo';

interface DriverDelivery {
  id: string; status: string; etaTs: string | null; estimatedDeliveryMinutes: number | null;
  order: { code: string; priority: string; packageSize: string; deadlineTs: string; note: string | null; customerName: string; items: { name: string; qty: number }[] };
  pickup: Point & { name?: string; address?: string | null; lat?: number | null; lon?: number | null }; dropoff: Point & { address?: string | null; lat?: number | null; lon?: number | null };
  route: { path: { toPickup?: Point[]; toDropoff?: Point[] } } | null;
}
interface Me { location: Point | null; geoLocation?: { lat: number; lon: number } | null; address?: string | null; status: string; name: string; vehicleType: string }

let selectingPosition = false;
let currentPage = 'deliveries';

export async function renderDriver(el: HTMLElement, _user: unknown, page = 'deliveries'): Promise<void> {
  resetSig('driver');
  currentPage = page;
  const draw = async () => {
    try {
      const { deliveries, me } = await get<{ deliveries: DriverDelivery[]; me: Me }>('/driver/deliveries');
      const active = deliveries.filter((d) => !['delivered', 'cancelled', 'failed'].includes(d.status));
      if (!changed('driver', { deliveries, me, page, selectingPosition })) return;
      if (patchView(el, view(active, deliveries, me))) wire(el, active, me); else resetSig('driver');
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
  const here = me.address || 'Current location unavailable';
  const mapCard = (selectable: boolean) => `<div class="card">
    <div class="card-head"><h2>${selectable ? 'Your position' : 'Your route'}</h2><span class="muted">hover a pin for details</span></div>
    ${selectable ? `<div id="driver-position-map" data-keep="driver-position-map" class="geo-map" data-driver-location="${me.location ? `${me.location.x},${me.location.y}` : ''}"></div><p class="muted geo-help">Click anywhere on the map to set your current position.</p>` : `<div id="driver-route-map" data-keep="driver-route-map" class="geo-map"></div>${!active.length ? '<p class="muted">No active delivery route to show.</p>' : ''}`}
  </div>`;

  if (currentPage === 'account') {
    return `
      <div class="page-head"><div><h1>Account</h1><p>Current position: <strong>${esc(me.address || here)}</strong> ${statusChip(me.status)}</p></div></div>
      <div class="grid2">
        <div class="card">
          <div class="card-head"><h2>Availability</h2></div>
          <dl class="kv">
            <dt>Name</dt><dd>${esc(me.name)}</dd>
            <dt>Vehicle</dt><dd>${esc(me.vehicleType)}</dd>
            <dt>Status</dt><dd>${statusChip(me.status)}</dd>
            <dt>Position</dt><dd>${esc(me.address || here)}</dd>
          </dl>
          <div class="pill-row" style="margin-top:12px">
            <button class="btn ghost" data-status="break">Take a break</button>
            <button class="btn ghost" data-status="available">Go available</button>
            <button class="btn ghost" data-status="offline">Go offline</button>
            ${me.status !== 'available' ? `<button class="btn" data-position-start>${selectingPosition ? 'Cancel' : 'Set position on map'}</button>` : ''}
          </div>
          ${me.status === 'available' ? '<p class="muted" style="margin-top:8px">Switch to break or offline to reposition yourself on the map.</p>' : ''}
        </div>
        ${mapCard(selectingPosition)}
      </div>`;
  }

  return `
    <div class="page-head">
      <div><h1>Deliveries</h1><p>${active.length} active · ${done} delivered today · at <strong>${esc(me.address || here)}</strong> ${statusChip(me.status)}</p></div>
    </div>
    <div class="grid2">
      <div>
        ${active.length ? active.map(card).join('') : '<div class="card"><p class="muted">No active deliveries. Sit tight — Dispatch will notify you.</p></div>'}
      </div>
      ${mapCard(false)}
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
    <div class="next-step">➜ ${d.status === 'en_route_pickup' ? 'Collecting at' : ['picked_up', 'en_route_drop'].includes(d.status) ? 'Delivering to' : 'Head to'} <strong>${esc(t.label)}</strong></div>
    <dl class="kv" style="margin-top:10px">
      <dt>Customer</dt><dd>${esc(d.order.customerName)}</dd>
      <dt>Pickup</dt><dd>${esc(d.pickup.name || 'Merchant')} — ${esc(d.pickup.address || 'address unavailable')}</dd>
      <dt>Drop-off</dt><dd>${esc(d.dropoff.address || 'address unavailable')}</dd>
      <dt>Items</dt><dd>${d.order.items.map((i) => `${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ') || '—'}</dd>
      <dt>Package</dt><dd>${esc(d.order.packageSize)} · ${esc(d.order.priority)}</dd>
      ${d.order.note ? `<dt>Note</dt><dd>${esc(d.order.note)}</dd>` : ''}
      <dt>Deadline</dt><dd>${fmtTime(d.order.deadlineTs)}</dd>
      <dt>ETA</dt><dd>${d.etaTs ? `${fmtTime(d.etaTs)}${mins !== null ? ` (${mins}m)` : ''}` : '—'}</dd>
    </dl>
    <div class="pill-row" style="margin-top:12px">${actions}</div>
  </div>`;
}

function wire(el: HTMLElement, active: DriverDelivery[], me: Me): void {
  enableMapTooltips(el);
  const repaint = () => renderDriver(el, null, currentPage);
  el.querySelector<HTMLButtonElement>('[data-position-start]')?.addEventListener('click', () => {
    selectingPosition = !selectingPosition;
    repaint();
  });
  const positionMap = el.querySelector<HTMLElement>('#driver-position-map');
  if (positionMap) {
    const location = el.querySelector<HTMLElement>('[data-driver-location]');
    const raw = location?.dataset.driverLocation?.split(',').map(Number);
    const g = raw && raw.length === 2 ? gridToGeo(raw[0], raw[1]) : null;
    const initial: GeoPoint | null = g ? { ...g, name: me.address || 'Current position' } : null;
    mountLocationMap(positionMap, initial, async (point) => {
      const grid = geoToGrid(point.lat, point.lon);
      try { await post('/driver/location', { lat: grid.x, lng: grid.y, geoLat: point.lat, geoLng: point.lon, address: point.name }); selectingPosition = false; toast(`Position updated to ${point.name || 'selected location'}`); repaint(); }
      catch (err) { toast(err instanceof ApiError ? err.message : 'Position update failed', 'error'); }
    });
  }
  const routeMap = el.querySelector<HTMLElement>('#driver-route-map');
  if (routeMap) {
    const points: Array<GeoPoint & { kind: string; name: string; detail?: string }> = [];
    const paths: [number, number][][] = [];
    if (me.geoLocation) points.push({ ...me.geoLocation, kind: 'Driver', name: `You (${me.name})`, detail: me.status.replace(/_/g, ' ') });
    active.forEach((d) => {
      const pg = d.pickup.lat != null && d.pickup.lon != null ? { lat: d.pickup.lat, lon: d.pickup.lon } : gridToGeo(d.pickup.x, d.pickup.y);
      const dg = d.dropoff.lat != null && d.dropoff.lon != null ? { lat: d.dropoff.lat, lon: d.dropoff.lon } : gridToGeo(d.dropoff.x, d.dropoff.y);
      points.push({ lat: pg.lat, lon: pg.lon, kind: 'Pickup', name: d.pickup.name || 'Merchant', detail: d.order.code });
      points.push({ lat: dg.lat, lon: dg.lon, kind: 'Drop-off', name: d.order.customerName, detail: d.order.code });
      const path = [...(d.route?.path.toPickup ?? []), ...(d.route?.path.toDropoff ?? [])];
      if (path.length > 1) paths.push(path.map((p) => [p.y, p.x]));
    });
    mountRouteMap(routeMap, points, paths);
  }
  el.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach((b) => b.addEventListener('click', () =>
    run(() => post(`/driver/deliveries/${b.dataset.accept}/accept`), 'Accepted — navigate to the pickup', el)));
  el.querySelectorAll<HTMLButtonElement>('[data-do]').forEach((b) => b.addEventListener('click', () =>
    run(() => post(`/driver/deliveries/${b.dataset.id}/status`, { action: b.dataset.do }), b.dataset.do === 'delivered' ? 'Delivered!' : 'Pickup confirmed — head to the customer', el)));
  el.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.status === 'available') selectingPosition = false;
    run(() => post('/driver/status', { status: b.dataset.status }), `Status: ${b.dataset.status}`, el);
  }));
}

async function run(fn: () => Promise<unknown>, ok: string, el: HTMLElement): Promise<void> {
  try { await fn(); toast(ok); renderDriver(el, null, currentPage); }
  catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); }
}
