import type { OrderDto, ProductDto } from '../types';
import { get, post, patch, del, ApiError } from '../api';
import { poll, patchView, handleUnauthed, changed, resetSig, goto } from '../main';
import { esc, toast, statusChip, fmtTime, minutesUntil, eventFeed, localDatetimeValue, money } from '../ui';
import { productGrid, cartSummary, cartCount, cartItems, wireCart, type Cart } from './shop';

interface MerchantOrders { orders: OrderDto[] }
interface OrderDetail {
  order: OrderDto;
  delivery: OrderDto['delivery'];
  assignedDriver: { name: string; vehicleType: string; status: string; location: { x: number; y: number } | null } | null;
  events: { agent: string; message: string; ts: string }[];
}

let selected: string | null = null;
let stores: { id: string; name: string; pickup: { x: number; y: number } }[] = [];
let productList: ProductDto[] = [];
let cart: Cart = {};
let currentPage = 'orders';

export async function renderMerchant(el: HTMLElement, _user: unknown, page = 'orders'): Promise<void> {
  resetSig('merchant');
  currentPage = page;
  try { stores = (await get<{ stores: typeof stores }>('/merchant/stores')).stores; } catch { /* ignore */ }
  try { productList = (await get<{ products: ProductDto[] }>('/merchant/products')).products; } catch { /* ignore */ }
  const draw = async () => {
    try {
      const { orders } = await get<MerchantOrders>('/merchant/orders');
      if (!selected && orders.length) selected = orders[0].id;
      let detail: OrderDetail | null = null;
      if (selected && page === 'orders') { try { detail = await get<OrderDetail>(`/merchant/orders/${selected}`); } catch { detail = null; } }
      if (!changed('merchant', { orders, detail, selected, page, productList, cart })) return;
      if (patchView(el, view(orders, detail))) wire(el); else resetSig('merchant');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) handleUnauthed();
    }
  };
  await draw();
  poll(draw, 4000);
}

const activeProducts = () => productList.filter((p) => p.active);

function view(orders: OrderDto[], detail: OrderDetail | null): string {
  if (currentPage === 'catalogue') {
    return `<div class="page-head"><div><h1>Catalogue</h1><p>Products customers can order from your store.</p></div></div>${catalogueCard()}`;
  }
  if (currentPage === 'new') {
    return `<div class="page-head"><div><h1>New order</h1><p>Take an order over the counter or phone.</p></div></div>${newOrderCard()}`;
  }
  if (currentPage === 'account') {
    return `<div class="page-head"><div><h1>Account</h1><p>Organisation membership.</p></div></div>
      <div class="card"><div class="card-head"><h2>Join an admin</h2></div>
        <form class="inline-form" id="admin-request"><label>Admin invite code<input name="inviteCode" placeholder="ADMIN-XXXXXXXX" required></label><button class="btn" type="submit">Request control</button></form>
        <p class="muted">Requests are visible to that admin for approval.</p></div>`;
  }
  return `
    <div class="page-head"><div><h1>Orders</h1><p>Mark orders ready — the agents handle dispatch.</p></div>
      <div class="pill-row"><a class="btn primary" href="#/merchant/new">+ New order</a></div></div>
    <div class="grid2">
      <div>
        <div class="card">
          <div class="card-head"><h2>${orders.length} order${orders.length === 1 ? '' : 's'}</h2></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th><th>Deadline</th><th></th></tr></thead>
            <tbody>${orders.map((o) => `
              <tr data-open="${esc(o.id)}" style="cursor:pointer;${o.id === selected ? 'background:#faf3f1' : ''}">
                <td><strong>${esc(o.code)}</strong><br><span class="muted">${o.items.map((i) => `${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ') || '—'}</span></td>
                <td>${esc(o.customerName)}<br><span class="muted">to (${o.dropoff.x}, ${o.dropoff.y})</span></td>
                <td>${o.itemsTotalCents ? money(o.itemsTotalCents) : '—'}</td>
                <td>${statusChip(o.status)}</td>
                <td>${fmtTime(o.deadlineTs)}</td>
                <td>${o.status === 'created'
                  ? `<button class="btn primary sm" data-ready="${esc(o.id)}">Mark ready</button>`
                  : ['ready', 'validated', 'dispatching'].includes(o.status)
                    ? `<button class="btn sm" data-ready="${esc(o.id)}">Retry dispatch</button>`
                    : ''}</td>
              </tr>`).join('') || `<tr><td colspan="6" class="muted">No orders yet — <a href="#/merchant/new">create one</a>.</td></tr>`}</tbody>
          </table></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>${detail ? `Order ${esc(detail.order.code)}` : 'Select an order'}</h2></div>
        ${detail ? detailBody(detail) : '<p class="muted">Pick an order to see its dispatch status and the agent trail.</p>'}
      </div>
    </div>`;
}

function catalogueCard(): string {
  return `<div class="card">
    <div class="card-head"><h2>Catalogue</h2><span class="muted">${activeProducts().length} active · ${productList.length} total</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Product</th><th>Price</th><th>Package</th><th>Status</th><th></th></tr></thead>
      <tbody>${productList.map((p) => `
        <tr>
          <td><strong>${esc(p.name)}</strong>${p.description ? `<br><span class="muted">${esc(p.description)}</span>` : ''}</td>
          <td>${money(p.priceCents)}</td>
          <td>${esc(p.packageSize)}</td>
          <td>${p.active ? '<span class="chip green">active</span>' : '<span class="chip grey">hidden</span>'}</td>
          <td class="pill-row">
            <button class="btn sm" data-prod-toggle="${esc(p.id)}" data-active="${p.active ? '0' : '1'}">${p.active ? 'Hide' : 'Show'}</button>
            <button class="btn sm ghost" data-prod-del="${esc(p.id)}">Remove</button>
          </td>
        </tr>`).join('') || `<tr><td colspan="5" class="muted">No products yet — add your first below.</td></tr>`}</tbody>
    </table></div>
    <form class="inline-form" id="new-product" style="margin-top:14px">
      <label>Name<input name="name" required></label>
      <label>Price (USD)<input name="price" type="number" min="0" step="0.01" value="5.00" required></label>
      <label>Package<select name="packageSize"><option>small</option><option>medium</option><option>large</option></select></label>
      <label>Description<input name="description" placeholder="optional"></label>
      <button class="btn primary full" type="submit">Add product</button>
    </form>
  </div>`;
}

function detailBody(d: OrderDetail): string {
  const mins = minutesUntil(d.delivery?.etaTs);
  const drv = d.assignedDriver;
  return `
    <dl class="kv">
      <dt>Customer</dt><dd>${esc(d.order.customerName)}</dd>
      <dt>Deliver to</dt><dd>(${d.order.dropoff.x}, ${d.order.dropoff.y})</dd>
      <dt>Items</dt><dd>${d.order.items.map((i) => `${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ') || '—'}</dd>
      <dt>Order total</dt><dd>${d.order.itemsTotalCents ? money(d.order.itemsTotalCents) : '—'}</dd>
      <dt>Status</dt><dd>${statusChip(d.order.status)}</dd>
      <dt>Priority</dt><dd>${esc(d.order.priority)}</dd>
      <dt>Package</dt><dd>${esc(d.order.packageSize)} · vol ${d.order.volume}</dd>
      <dt>Deadline</dt><dd>${fmtTime(d.order.deadlineTs)} (${minutesUntil(d.order.deadlineTs)}m)</dd>
      <dt>Driver</dt><dd>${drv ? `${esc(drv.name)} · ${esc(drv.vehicleType)}${drv.location ? ` · at (${drv.location.x}, ${drv.location.y})` : ''}` : '—'}</dd>
      <dt>ETA</dt><dd>${d.delivery?.etaTs ? `${fmtTime(d.delivery.etaTs)}${mins !== null ? ` (${mins}m)` : ''}` : '—'}</dd>
    </dl>
    <h3 style="margin-top:16px;font-size:13px">Agent trail</h3>
    ${eventFeed(d.events)}`;
}

function newOrderCard(): string {
  const soon = localDatetimeValue(75 * 60_000);
  const products = activeProducts();
  return `<div class="card">
    <div class="card-head"><h2>New order</h2><span class="muted">${cartCount(cart)} item(s)</span></div>
    <form class="inline-form" id="new-order">
      <label class="full">Store<select name="storeId">${stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
      <label>Customer name<input name="customerName" value="Sofia Lin" required></label>
      <label>Priority<select name="priority"><option value="standard">standard</option><option value="express">express</option></select></label>
    </form>
    <div style="margin:12px 0">${productGrid(products, cart)}</div>
    <div style="margin-bottom:12px">${cartSummary(products, cart)}</div>
    <form class="inline-form" id="new-order-tail">
      <label>Drop X (0-20)<input name="deliveryLat" type="number" min="0" max="20" step="1" value="7" required></label>
      <label>Drop Y (0-20)<input name="deliveryLng" type="number" min="0" max="20" step="1" value="4" required></label>
      <label class="full">Note<input name="note" placeholder="optional delivery note"></label>
      <label class="full">Deadline<input name="deadlineTs" type="datetime-local" value="${soon}" required></label>
      <button class="btn primary full" type="submit"${cartCount(cart) ? '' : ' disabled'}>Create order</button>
    </form>
  </div>`;
}

function wire(el: HTMLElement): void {
  const repaint = () => renderMerchant(el, null, currentPage);

  el.querySelectorAll<HTMLElement>('[data-open]').forEach((r) => r.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    selected = r.dataset.open!;
    repaint();
  }));

  el.querySelectorAll<HTMLButtonElement>('[data-ready]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    try {
      const res = await post<{ dispatch: { status: string; decision?: { driverId: string; score: number; rationale?: string }; issues?: string[] } }>(
        `/merchant/orders/${b.dataset.ready}/ready`, {}, { 'idempotency-key': `ready-${b.dataset.ready}-${Date.now()}` });
      const d = res.dispatch;
      if (d.status === 'assigned' && d.decision) toast(`Assigned to a driver (score ${d.decision.score})`);
      else if (d.status === 'reused') toast('Already assigned to a driver');
      else if (d.status === 'no_driver') toast(`No driver available — ${d.decision?.rationale || 'try again shortly'}`, 'error');
      else if (d.status === 'invalid') toast(`Cannot dispatch: ${(d.issues || []).join(', ') || 'order invalid'}`, 'error');
      else toast(`Dispatch: ${d.status}`);
      selected = b.dataset.ready!;
      repaint();
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); b.disabled = false; }
  }));

  el.querySelector<HTMLFormElement>('#admin-request')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    try { await post('/merchant/admin-request', { inviteCode: fd.get('inviteCode') }); toast('Request sent'); repaint(); }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); }
  });

  // catalogue management
  el.querySelector<HTMLFormElement>('#new-product')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    try {
      await post('/merchant/products', {
        name: fd.get('name'),
        priceCents: Math.round(Number(fd.get('price')) * 100),
        packageSize: fd.get('packageSize'),
        description: fd.get('description') || undefined,
      });
      toast('Product added');
      repaint();
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); }
  });
  el.querySelectorAll<HTMLButtonElement>('[data-prod-toggle]').forEach((b) => b.addEventListener('click', async () => {
    try { await patch(`/merchant/products/${b.dataset.prodToggle}`, { active: b.dataset.active === '1' }); repaint(); }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); }
  }));
  el.querySelectorAll<HTMLButtonElement>('[data-prod-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await del(`/merchant/products/${b.dataset.prodDel}`); toast('Product removed'); delete cart[b.dataset.prodDel!]; repaint(); }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); }
  }));

  // new order
  el.querySelector<HTMLFormElement>('#new-order')?.addEventListener('submit', (e) => e.preventDefault());
  wireCart(el, cart, repaint);
  el.querySelector<HTMLFormElement>('#new-order-tail')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const head = el.querySelector<HTMLFormElement>('#new-order')!;
    const tail = e.currentTarget as HTMLFormElement;
    const h = new FormData(head);
    const t = new FormData(tail);
    if (!cartCount(cart)) { toast('Add at least one product', 'error'); return; }
    try {
      await post('/merchant/orders', {
        storeId: h.get('storeId'), customerName: h.get('customerName'), priority: h.get('priority'),
        deliveryLat: Number(t.get('deliveryLat')), deliveryLng: Number(t.get('deliveryLng')),
        note: t.get('note') || undefined,
        deadlineTs: new Date(String(t.get('deadlineTs'))).toISOString(),
        items: cartItems(cart),
      });
      cart = {};
      toast('Order created');
      selected = null;
      goto('orders');
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); }
  });
}
