import { get, post, ApiError } from '../api';
import { poll, patchView, handleUnauthed, changed, resetSig, goto } from '../main';
import { esc, toast, customerChip, fmtTime, minutesUntil, eventFeed, localDatetimeValue, money, agentDecisionCard, type PublicRun } from '../ui';
import { enableMapTooltips } from '../map';
import { productGrid, cartSummary, cartCount, cartItems, cartTotalCents, wireCart, type Cart } from './shop';
import type { Point, ProductDto } from '../types';
import { mountLocationMap, openLocationPicker, routeWithOsrm, searchNominatim, type GeoPoint, type GeoRoute } from '../geoMap';
import { gridToGeo, geoToGrid } from '../geo';

interface Tracking {
  order: { id: string; status: string; priority: string; deadlineTs: string; pickup?: Point & { address?: string; lat?: number; lon?: number }; dropoff: Point & { address?: string; lat?: number; lon?: number }; items: { name: string; qty: number }[] };
  delivery: {
    status: string; etaTs: string | null; estimatedDeliveryMinutes: number | null;
    deliveredAt: string | null; driver: { firstName: string; vehicleType: string } | null;
    driverPosition: Point | null; driverPositionGeo: { lat: number; lon: number } | null;
    route?: { path: { toPickup?: Point[]; toDropoff?: Point[] } } | null;
  } | null;
  events: { agent: string; message: string; ts: string }[];
  run?: PublicRun | null;
}
interface Merchant { id: string; name: string; stores: { id: string; name: string; pickup?: Point & { address?: string | null; lat?: number | null; lon?: number | null } }[] }

let selected: string | null = null;
let merchants: Merchant[] = [];

// order wizard
let step = 1;
let pickedMerchantId: string | null = null;
let pickedStoreId: string | null = null;
let catalog: ProductDto[] = [];
let cart: Cart = {};
const draft = { deliveryLat: 17, deliveryLng: 3, priority: 'standard', deadlineTs: '', note: '' };
let deliveryGeo: GeoPoint | null = null;
let deliveryRoute: GeoRoute | null = null;
let deliveryAddress = '';
let lastOrders: { id: string; status: string }[] = [];
let lastTracking: Tracking | null = null;
let currentPage = 'order';

export async function renderCustomer(el: HTMLElement, _user: unknown, page = 'order'): Promise<void> {
  resetSig('customer');
  currentPage = page;
  if (!merchants.length) { try { merchants = (await get<{ merchants: Merchant[] }>('/directory/merchants')).merchants; } catch { /* ignore */ } }
  const draw = async () => {
    try {
      const { orders } = await get<{ orders: { id: string; status: string }[] }>('/customer/orders');
      if (!selected && orders.length) selected = orders[0].id;
      let t: Tracking | null = null;
      if (selected) { try { t = await get<Tracking>(`/customer/orders/${selected}`); } catch { t = null; } }
      lastOrders = orders; lastTracking = t;
      if (!changed('customer', { orders, t, selected, page, step, pickedStoreId, catalog, cart, draft })) return;
      repaint(el);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) handleUnauthed();
    }
  };
  await draw();
  poll(draw, 4000);
}

function repaint(el: HTMLElement): void {
  if (patchView(el, view(lastOrders, lastTracking))) wire(el);
  else resetSig('customer');
}

async function loadCatalog(el: HTMLElement): Promise<void> {
  catalog = [];
  if (pickedMerchantId) {
    try { catalog = (await get<{ products: ProductDto[] }>(`/directory/merchants/${pickedMerchantId}/products`)).products; }
    catch { catalog = []; }
  }
  repaint(el);
}

function view(orders: { id: string; status: string }[], t: Tracking | null): string {
  if (currentPage === 'order') {
    return `
      <div class="page-head"><div><h1>Place an order</h1><p>Choose a merchant, add products, then pick where and when.</p></div></div>
      ${orderWizard()}`;
  }
  return `
    <div class="page-head"><div><h1>My orders</h1><p>Track progress and ETA in real time.</p></div></div>
    ${orders.length ? '' : '<div class="card"><p class="muted">No orders yet. Head to <a href="#/customer/order">Order</a> to place one.</p></div>'}
    <div class="grid2">
      <div>
        ${orders.length ? `<div class="card">
          <div class="card-head"><h2>Orders</h2></div>
          <div class="pill-row">${orders.map((o) => `<button class="chip-btn" style="width:auto" data-pick="${esc(o.id)}">#${esc(o.id.replace(/^ord_/, '').slice(-6).toUpperCase())} ${customerChip(o.status)}</button>`).join('')}</div>
        </div>` : ''}
        ${t ? trackingCard(t) : ''}
        ${t ? agentDecisionCard(t.run) : ''}
      </div>
      <div>
        ${t ? `<div class="card"><div class="card-head"><h2>Live map</h2></div>${mapFor(t)}</div>` : ''}
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
  return '<div id="customer-live-map" data-keep="customer-live-map" class="geo-map"></div>';
}

/* ------------------------------------------------------------------ wizard */
const STEP_LABELS = ['Merchant', 'Products', 'Delivery', 'Review'];

function stepsBar(): string {
  return `<div class="wizard-steps">${STEP_LABELS.map((label, i) => {
    const n = i + 1;
    const cls = n === step ? 'active' : n < step ? 'done' : '';
    return `<span class="step ${cls}"><span class="num">${n < step ? '✓' : n}</span>${esc(label)}</span>`;
  }).join('')}</div>`;
}

function pickedStoreName(): string {
  for (const m of merchants) for (const s of m.stores) if (s.id === pickedStoreId) return `${m.name} — ${s.name}`;
  return '';
}

function orderWizard(): string {
  return `<div class="card">
    <div class="card-head"><h2>Place an order</h2>${step > 1 ? `<span class="muted">${cartCount(cart)} item(s) · ${money(cartTotalCents(cart, catalog))}</span>` : ''}</div>
    ${stepsBar()}
    ${step === 1 ? stepMerchant() : step === 2 ? stepProducts() : step === 3 ? stepDelivery() : stepReview()}
  </div>`;
}

function stepMerchant(): string {
  if (!merchants.length) return '<p class="muted">No merchants available yet.</p>';
  return `<div class="shop-grid">${merchants.flatMap((m) => m.stores.map((s) => `
    <button type="button" class="shop-card merch-card${s.id === pickedStoreId ? ' selected' : ''}" data-pick-store="${esc(s.id)}" data-merchant="${esc(m.id)}">
      <h3>${esc(m.name)}</h3>
      <span class="desc">${esc(s.name)}</span>
      ${s.pickup ? `<span class="muted" style="font-size:11px">picks up at ${esc(s.pickup.address || 'merchant address')}</span>` : ''}
    </button>`)).join('')}</div>
    <div class="pill-row" style="margin-top:14px">
      <button class="btn primary" data-wiz-next${pickedStoreId ? '' : ' disabled'}>Next: choose products</button>
    </div>`;
}

function stepProducts(): string {
  return `
    <p class="muted" style="margin-top:0">From <strong>${esc(pickedStoreName())}</strong></p>
    ${productGrid(catalog, cart)}
    <div style="margin:12px 0">${cartSummary(catalog, cart)}</div>
    <div class="pill-row">
      <button class="btn ghost" data-wiz-back>Back</button>
      <button class="btn primary" data-wiz-next${cartCount(cart) ? '' : ' disabled'}>Next: delivery details</button>
    </div>`;
}

function stepDelivery(): string {
  const soon = draft.deadlineTs || localDatetimeValue(80 * 60_000);
  return `
    <form class="inline-form" id="wiz-delivery">
      <label class="full">Delivery address<input id="delivery-search" placeholder="Type an address or search with Nominatim" autocomplete="off" value="${esc(deliveryGeo?.name || deliveryAddress)}"></label>
      <button type="button" class="btn full" data-open-location-picker>Open map in a new window</button>
      <div id="delivery-results" class="geo-results full"></div>
      <div id="delivery-map" data-keep="delivery-map" class="geo-map full"></div>
      <p class="muted full geo-help">Click the map to drop your delivery pin. ${deliveryGeo ? `Selected: <strong>${esc(deliveryGeo.name)}</strong>` : 'No pin selected yet.'}</p>
      <input name="deliveryLat" type="hidden" value="${draft.deliveryLat}">
      <input name="deliveryLng" type="hidden" value="${draft.deliveryLng}">
      <label>Priority<select name="priority"><option value="standard"${draft.priority === 'standard' ? ' selected' : ''}>standard</option><option value="express"${draft.priority === 'express' ? ' selected' : ''}>express</option></select></label>
      <label>Deadline<input name="deadlineTs" type="datetime-local" value="${esc(soon)}" required></label>
      <label class="full">Note <span class="muted">(optional)</span><input name="note" value="${esc(draft.note)}" placeholder="e.g. leave at the front desk"></label>
    </form>
    ${deliveryRoute ? `<div class="route-preview full">OSRM driving estimate: <strong>${deliveryRoute.distanceKm.toFixed(1)} km · ${Math.round(deliveryRoute.durationMinutes)} min</strong></div>` : ''}
    <div class="pill-row" style="margin-top:12px">
      <button class="btn ghost" data-wiz-back>Back</button>
      <button class="btn primary" data-wiz-next>Review order</button>
    </div>`;
}

function stepReview(): string {
  const lines = cartItems(cart).map((it) => {
    const p = catalog.find((c) => c.id === it.productId);
    return p ? `<div class="cart-line"><span>${esc(p.name)} × ${it.qty}</span><span>${money(p.priceCents * it.qty)}</span></div>` : '';
  }).join('');
  return `
    <dl class="kv">
      <dt>Store</dt><dd>${esc(pickedStoreName())}</dd>
      <dt>Deliver to</dt><dd>${esc(deliveryGeo?.name || deliveryAddress || 'address unavailable')}</dd>
      <dt>Priority</dt><dd>${esc(draft.priority)}</dd>
      <dt>Deadline</dt><dd>${fmtTime(new Date(draft.deadlineTs).toISOString())}</dd>
      ${draft.note ? `<dt>Note</dt><dd>${esc(draft.note)}</dd>` : ''}
    </dl>
    <div style="margin:12px 0">${lines}<div class="cart-total"><span>Total</span><span>${money(cartTotalCents(cart, catalog))}</span></div></div>
    <div class="pill-row">
      <button class="btn ghost" data-wiz-back>Back</button>
      <button class="btn primary" data-wiz-place>Place order</button>
    </div>
    <p class="muted" style="margin-top:8px">A merchant still has to mark it ready before dispatch begins.</p>`;
}

function saveDeliveryForm(el: HTMLElement): void {
  const f = el.querySelector<HTMLFormElement>('#wiz-delivery');
  if (!f) return;
  const fd = new FormData(f);
  draft.deliveryLat = Number(fd.get('deliveryLat'));
  draft.deliveryLng = Number(fd.get('deliveryLng'));
  draft.priority = String(fd.get('priority') || 'standard');
  draft.deadlineTs = String(fd.get('deadlineTs') || '');
  draft.note = String(fd.get('note') || '');
}

function wire(el: HTMLElement): void {
  enableMapTooltips(el);
  const liveMap = el.querySelector<HTMLElement>('#customer-live-map');
  if (liveMap && lastTracking) {
    const t = lastTracking;
    const dg = t.order.dropoff.lat != null && t.order.dropoff.lon != null
      ? { lat: t.order.dropoff.lat, lon: t.order.dropoff.lon } : gridToGeo(t.order.dropoff.x, t.order.dropoff.y);
    const points = [{ lat: dg.lat, lon: dg.lon, kind: 'Drop-off', name: t.order.dropoff.address || 'Delivery address' }];
    if (t.order.pickup) {
      const pg = t.order.pickup.lat != null && t.order.pickup.lon != null
        ? { lat: t.order.pickup.lat, lon: t.order.pickup.lon } : gridToGeo(t.order.pickup.x, t.order.pickup.y);
      points.push({ lat: pg.lat, lon: pg.lon, kind: 'Pickup', name: 'Merchant pickup' });
    }
    if (t.delivery?.driverPositionGeo) points.push({ lat: t.delivery.driverPositionGeo.lat, lon: t.delivery.driverPositionGeo.lon, kind: 'Driver', name: 'Your driver' });
    else if (t.delivery?.driverPosition) { const g = gridToGeo(t.delivery.driverPosition.x, t.delivery.driverPosition.y); points.push({ lat: g.lat, lon: g.lon, kind: 'Driver', name: 'Your driver' }); }
    const path = [...(t.delivery?.route?.path.toPickup ?? []), ...(t.delivery?.route?.path.toDropoff ?? [])];
    import('../geoMap').then(({ mountRouteMap }) => mountRouteMap(liveMap, points, path.length > 1 ? [path.map((p) => [p.y, p.x] as [number, number])] : []));
  }
  el.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) => b.addEventListener('click', () => { selected = b.dataset.pick!; repaint(el); }));

  el.querySelectorAll<HTMLButtonElement>('[data-pick-store]').forEach((b) => b.addEventListener('click', () => {
    if (pickedStoreId !== b.dataset.pickStore) { cart = {}; deliveryGeo = null; deliveryRoute = null; }
    pickedStoreId = b.dataset.pickStore!;
    pickedMerchantId = b.dataset.merchant!;
    repaint(el);
  }));

  el.querySelector<HTMLFormElement>('#wiz-delivery')?.addEventListener('submit', (e) => e.preventDefault());
  const geoMap = el.querySelector<HTMLElement>('#delivery-map');
  if (geoMap) {
    const store = merchants.flatMap((m) => m.stores).find((s) => s.id === pickedStoreId)?.pickup;
    const pickup = store?.lat != null && store.lon != null ? { lat: store.lat, lon: store.lon, name: store.address || 'Merchant pickup' } : null;
    mountLocationMap(geoMap, deliveryGeo, async (point) => {
      deliveryGeo = point;
      deliveryRoute = pickup ? await routeWithOsrm(pickup, point).catch(() => null) : null;
      const grid = geoToGrid(point.lat, point.lon);
      draft.deliveryLat = grid.x;
      draft.deliveryLng = grid.y;
      repaint(el);
    }, deliveryRoute);
  }
  const search = el.querySelector<HTMLInputElement>('#delivery-search');
  const results = el.querySelector<HTMLElement>('#delivery-results');
  let searchTimer: number | undefined;
  search?.addEventListener('input', () => { deliveryAddress = search.value; deliveryGeo = null; deliveryRoute = null; window.clearTimeout(searchTimer); searchTimer = window.setTimeout(async () => {
    if (!results) return; results.textContent = 'Searching Nominatim…';
    try { const found = await searchNominatim(search.value); results.innerHTML = found.map((p) => `<button type="button" data-geo-result="${p.lat},${p.lon}">${esc(p.name)} <small>${esc(p.district || 'Singapore')}</small></button>`).join('') || '<span class="muted">No places found.</span>';
      results.querySelectorAll<HTMLButtonElement>('[data-geo-result]').forEach((button, index) => button.addEventListener('click', () => { deliveryGeo = found[index]; deliveryAddress = found[index].name; deliveryRoute = null; repaint(el); }));
    } catch { results.textContent = 'Address search unavailable.'; }
  }, 500); });
  el.querySelector<HTMLButtonElement>('[data-open-location-picker]')?.addEventListener('click', () => openLocationPicker(deliveryGeo, (point) => {
    deliveryGeo = point; deliveryRoute = null;
    const grid = geoToGrid(point.lat, point.lon); draft.deliveryLat = grid.x; draft.deliveryLng = grid.y; repaint(el);
  }));
  wireCart(el, cart, () => repaint(el));

  el.querySelector<HTMLButtonElement>('[data-wiz-back]')?.addEventListener('click', () => {
    if (step === 3) saveDeliveryForm(el);
    step = Math.max(1, step - 1);
    repaint(el);
  });
  el.querySelector<HTMLButtonElement>('[data-wiz-next]')?.addEventListener('click', async () => {
    if (step === 1) { step = 2; await loadCatalog(el); return; }
    if (step === 3) { saveDeliveryForm(el); }
    step = Math.min(4, step + 1);
    repaint(el);
  });
  el.querySelector<HTMLButtonElement>('[data-wiz-place]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      const res = await post<{ order: { id: string } }>('/customer/orders', {
        storeId: pickedStoreId,
        items: cartItems(cart),
        deliveryLat: draft.deliveryLat,
        deliveryLng: draft.deliveryLng,
        deliveryAddress: deliveryGeo?.name || deliveryAddress || undefined,
        deliveryGeoLat: deliveryGeo?.lat,
        deliveryGeoLng: deliveryGeo?.lon,
        priority: draft.priority,
        note: draft.note || undefined,
        deadlineTs: new Date(draft.deadlineTs).toISOString(),
      });
      selected = res.order.id;
      cart = {};
      step = 1;
      pickedStoreId = null;
      pickedMerchantId = null;
      toast('Order placed');
      goto('orders');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed', 'error');
      btn.disabled = false;
    }
  });
}

