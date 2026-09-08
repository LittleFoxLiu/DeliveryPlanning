import { get, post, ApiError } from '../api';
import { poll, patchView, handleUnauthed, changed, resetSig } from '../main';
import { esc, toast, customerChip, fmtTime, minutesUntil, eventFeed, localDatetimeValue, parseItemsInput } from '../ui';
import { renderMap, enableMapTooltips, type MapMarker } from '../map';
import type { RoadSeg, Point } from '../types';

interface Tracking {
  order: { id: string; status: string; priority: string; deadlineTs: string; dropoff: Point; items: { name: string; qty: number }[] };
  delivery: {
    status: string; etaTs: string | null; estimatedDeliveryMinutes: number | null;
    deliveredAt: string | null; driver: { firstName: string; vehicleType: string } | null;
    driverPosition: Point | null;
  } | null;
  events: { agent: string; message: string; ts: string }[];
}

let selected: string | null = null;
let grid: { size: number; roads: RoadSeg[] } = { size: 20, roads: [] };
let merchants: { id: string; name: string; stores: { id: string; name: string }[] }[] = [];

export async function renderCustomer(el: HTMLElement): Promise<void> {
  resetSig('customer');
  try { grid = await get('/meta/grid'); } catch { /* ignore */ }
  try { merchants = (await get<{ merchants: typeof merchants }>('/directory/merchants')).merchants; } catch { /* ignore */ }
  const draw = async () => {
    try {
      const { orders } = await get<{ orders: { id: string; status: string }[] }>('/customer/orders');
      if (!selected && orders.length) selected = orders[0].id;
      let t: Tracking | null = null;
      if (selected) { try { t = await get<Tracking>(`/customer/orders/${selected}`); } catch { t = null; } }
      if (!changed('customer', { orders, t, selected })) return;
      if (patchView(el, view(orders, t))) wire(el, orders); else resetSig('customer');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) handleUnauthed();
    }
  };
  await draw();
  poll(draw, 4000);
}

function view(orders: { id: string; status: string }[], t: Tracking | null): string {
  return `
    <div class="page-head"><div><h1>Your deliveries</h1><p>Track progress and ETA in real time.</p></div></div>
    <div class="grid2">
      <div>
        <div class="card">
          <div class="card-head"><h2>Orders</h2></div>
          ${orders.length ? `<div class="pill-row">${orders.map((o) => `<button class="chip-btn" style="width:auto" data-pick="${esc(o.id)}">#${esc(o.id.replace(/^ord_/, '').slice(-6).toUpperCase())} ${customerChip(o.status)}</button>`).join('')}</div>` : '<p class="muted">No orders yet — place one below.</p>'}
        </div>
        ${t ? trackingCard(t) : ''}
      </div>
      <div>
        ${t ? `<div class="card"><div class="card-head"><h2>Live map</h2></div>${mapFor(t)}</div>` : ''}
        ${orderForm()}
      </div>
    </div>`;
}

function trackingCard(t: Tracking): string {
  const mins = minutesUntil(t.delivery?.etaTs);
  const done = t.order.status === 'delivered';
  return `<div class="card">
    <div class="card-head"><h2>Order #${esc(t.order.id.replace(/^ord_/, '').slice(-6).toUpperCase())}</h2>${customerChip(t.order.status, t.delivery?.status)}</div>
    <div class="big-eta">${done ? 'Delivered' : t.delivery?.etaTs ? `${fmtTime(t.delivery.etaTs)}` : 'Pending'}</div>
    <p class="muted">${done ? `Arrived ${fmtTime(t.delivery?.deliveredAt)}` : mins !== null ? `about ${mins} minutes away` : 'Waiting for a driver'}</p>
    <dl class="kv" style="margin-top:12px">
      <dt>Items</dt><dd>${t.order.items.map((i) => `${esc(i.name)} ×${i.qty}`).join(', ')}</dd>
      <dt>Driver</dt><dd>${t.delivery?.driver ? `${esc(t.delivery.driver.firstName)} · ${esc(t.delivery.driver.vehicleType)}` : '—'}</dd>
      <dt>Deadline</dt><dd>${fmtTime(t.order.deadlineTs)}</dd>
    </dl>
    <h3 style="margin-top:16px;font-size:13px">Progress</h3>
    ${eventFeed(t.events)}
  </div>`;
}

function mapFor(t: Tracking): string {
  const code = `#${t.order.id.replace(/^ord_/, '').slice(-6).toUpperCase()}`;
  const itemStr = t.order.items.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ') || '—';
  const markers: MapMarker[] = [{
    x: t.order.dropoff.x, y: t.order.dropoff.y, kind: 'dropoff', title: `Your delivery ${code}`,
    tip: [itemStr, `Status: ${(t.delivery?.status ?? t.order.status).replace(/_/g, ' ')}`, `Deadline ${fmtTime(t.order.deadlineTs)}`],
  }];
  if (t.delivery?.driverPosition) {
    markers.push({
      x: t.delivery.driverPosition.x, y: t.delivery.driverPosition.y, kind: 'driver', pulse: true,
      title: t.delivery.driver ? `${t.delivery.driver.firstName} (your driver)` : 'Your driver',
      tip: [t.delivery.driver ? t.delivery.driver.vehicleType : 'en route', t.delivery.etaTs ? `ETA ${fmtTime(t.delivery.etaTs)}` : ''],
    });
  }
  return renderMap({ size: grid.size, roads: grid.roads, markers, paths: [] });
}

function orderForm(): string {
  const soon = localDatetimeValue(80 * 60_000);
  const storeOpts = merchants.flatMap((m) => m.stores.map((s) => `<option value="${esc(s.id)}">${esc(m.name)} — ${esc(s.name)}</option>`)).join('');
  return `<div class="card">
    <div class="card-head"><h2>Place an order</h2></div>
    <form class="inline-form" id="cust-order">
      <label class="full">Merchant / store<select name="storeId">${storeOpts}</select></label>
      <label class="full">What do you want? <span class="muted">(comma-separated)</span><input name="items" value="Sourdough loaf, Almond croissant ×2" required></label>
      <label>Deliver to X<input name="deliveryLat" type="number" min="0" max="20" value="17" required></label>
      <label>Deliver to Y<input name="deliveryLng" type="number" min="0" max="20" value="3" required></label>
      <label>Priority<select name="priority"><option>standard</option><option>express</option></select></label>
      <label>Package<select name="packageSize"><option>small</option><option>medium</option><option>large</option></select></label>
      <label class="full">Deadline<input name="deadlineTs" type="datetime-local" value="${soon}" required></label>
      <button class="btn primary full" type="submit">Place order</button>
    </form>
    <p class="muted" style="margin-top:8px">A merchant still has to mark it ready before dispatch begins.</p>
  </div>`;
}

function wire(el: HTMLElement, _orders: unknown): void {
  enableMapTooltips(el);
  el.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) => b.addEventListener('click', () => { selected = b.dataset.pick!; renderCustomer(el); }));
  const form = el.querySelector<HTMLFormElement>('#cust-order');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      const items = parseItemsInput(String(fd.get('items') || ''));
      const res = await post<{ order: { id: string } }>('/customer/orders', {
        storeId: fd.get('storeId'),
        deliveryLat: Number(fd.get('deliveryLat')), deliveryLng: Number(fd.get('deliveryLng')),
        priority: fd.get('priority'), packageSize: fd.get('packageSize'),
        deadlineTs: new Date(String(fd.get('deadlineTs'))).toISOString(),
        items, volume: Math.max(1, items.reduce((n, i) => n + i.qty, 0)),
      });
      selected = res.order.id;
      toast('Order placed');
      renderCustomer(el);
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); }
  });
}
