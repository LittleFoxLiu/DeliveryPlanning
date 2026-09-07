import type { OrderDto } from '../types';
import { get, post, ApiError } from '../api';
import { poll } from '../main';
import { esc, toast, statusChip, fmtTime, minutesUntil, eventFeed } from '../ui';

interface MerchantOrders { orders: OrderDto[] }
interface OrderDetail { order: OrderDto; delivery: OrderDto['delivery']; assignedDriver: { name: string; vehicleType: string; status: string } | null; events: { agent: string; message: string; ts: string }[] }

let selected: string | null = null;
let stores: { id: string; name: string; pickup: { x: number; y: number } }[] = [];

export async function renderMerchant(el: HTMLElement): Promise<void> {
  try { stores = (await get<{ stores: typeof stores }>('/merchant/stores')).stores; } catch { /* ignore */ }
  const draw = async () => {
    try {
      const { orders } = await get<MerchantOrders>('/merchant/orders');
      if (!selected && orders.length) selected = orders[0].id;
      let detail: OrderDetail | null = null;
      if (selected) { try { detail = await get<OrderDetail>(`/merchant/orders/${selected}`); } catch { detail = null; } }
      el.innerHTML = view(orders, detail);
      wire(el, orders);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) location.reload();
    }
  };
  await draw();
  poll(draw, 3500);
}

function view(orders: OrderDto[], detail: OrderDetail | null): string {
  return `
    <div class="page-head"><div><h1>Merchant workspace</h1><p>Mark orders ready — the agents handle dispatch.</p></div></div>
    <div class="grid2">
      <div>
        <div class="card">
          <div class="card-head"><h2>Orders</h2></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Order</th><th>Customer drop</th><th>Status</th><th>Deadline</th><th></th></tr></thead>
            <tbody>${orders.map((o) => `
              <tr data-open="${esc(o.id)}" style="cursor:pointer;${o.id === selected ? 'background:#faf3f1' : ''}">
                <td><code>${esc(o.id.slice(-6))}</code><br><span class="muted">${o.items.map((i) => esc(i.name)).join(', ')}</span></td>
                <td>(${o.dropoff.x}, ${o.dropoff.y})</td>
                <td>${statusChip(o.status)}</td>
                <td>${fmtTime(o.deadlineTs)}</td>
                <td>${o.status === 'created' ? `<button class="btn primary sm" data-ready="${esc(o.id)}">Mark ready</button>` : ''}</td>
              </tr>`).join('') || `<tr><td colspan="5" class="muted">No orders yet.</td></tr>`}</tbody>
          </table></div>
        </div>
        ${newOrderCard()}
      </div>
      <div class="card">
        <div class="card-head"><h2>${detail ? `Order ${esc(detail.order.id.slice(-6))}` : 'Select an order'}</h2></div>
        ${detail ? detailBody(detail) : '<p class="muted">Pick an order to see its dispatch status and the agent trail.</p>'}
      </div>
    </div>`;
}

function detailBody(d: OrderDetail): string {
  const mins = minutesUntil(d.delivery?.etaTs);
  return `
    <dl class="kv">
      <dt>Status</dt><dd>${statusChip(d.order.status)}</dd>
      <dt>Priority</dt><dd>${esc(d.order.priority)}</dd>
      <dt>Package</dt><dd>${esc(d.order.packageSize)} · vol ${d.order.volume}</dd>
      <dt>Deadline</dt><dd>${fmtTime(d.order.deadlineTs)} (${minutesUntil(d.order.deadlineTs)}m)</dd>
      <dt>Driver</dt><dd>${d.assignedDriver ? `${esc(d.assignedDriver.name)} · ${esc(d.assignedDriver.vehicleType)}` : '—'}</dd>
      <dt>ETA</dt><dd>${d.delivery?.etaTs ? `${fmtTime(d.delivery.etaTs)}${mins !== null ? ` (${mins}m)` : ''}` : '—'}</dd>
    </dl>
    <h3 style="margin-top:16px;font-size:13px">Agent trail</h3>
    ${eventFeed(d.events)}`;
}

function newOrderCard(): string {
  const soon = new Date(Date.now() + 75 * 60_000).toISOString().slice(0, 16);
  return `<div class="card">
    <div class="card-head"><h2>New order</h2></div>
    <form class="inline-form" id="new-order">
      <label class="full">Store<select name="storeId">${stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
      <label>Customer name<input name="customerName" value="Sofia Lin" required></label>
      <label>Priority<select name="priority"><option value="standard">standard</option><option value="express">express</option></select></label>
      <label>Drop X (0-20)<input name="deliveryLat" type="number" min="0" max="20" step="1" value="7" required></label>
      <label>Drop Y (0-20)<input name="deliveryLng" type="number" min="0" max="20" step="1" value="4" required></label>
      <label>Package<select name="packageSize"><option>small</option><option>medium</option><option>large</option></select></label>
      <label>Deadline<input name="deadlineTs" type="datetime-local" value="${soon}" required></label>
      <button class="btn primary full" type="submit">Create order</button>
    </form>
  </div>`;
}

function wire(el: HTMLElement, orders: OrderDto[]): void {
  el.querySelectorAll<HTMLElement>('[data-open]').forEach((r) => r.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    selected = r.dataset.open!;
    renderMerchant(el);
  }));
  el.querySelectorAll<HTMLButtonElement>('[data-ready]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    try {
      const res = await post<{ dispatch: { status: string; decision?: { driverId: string; score: number } } }>(`/merchant/orders/${b.dataset.ready}/ready`, {}, { 'idempotency-key': `ready-${b.dataset.ready}` });
      const dec = res.dispatch.decision;
      toast(res.dispatch.status === 'assigned' && dec ? `Assigned to a driver (score ${dec.score})` : `Dispatch: ${res.dispatch.status}`);
      selected = b.dataset.ready!;
      renderMerchant(el);
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); b.disabled = false; }
  }));
  const form = el.querySelector<HTMLFormElement>('#new-order');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      storeId: fd.get('storeId'), customerName: fd.get('customerName'), priority: fd.get('priority'),
      deliveryLat: Number(fd.get('deliveryLat')), deliveryLng: Number(fd.get('deliveryLng')),
      packageSize: fd.get('packageSize'),
      deadlineTs: new Date(String(fd.get('deadlineTs'))).toISOString(),
      volume: 1,
    };
    try { await post('/merchant/orders', body); toast('Order created'); renderMerchant(el); }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); }
  });
  void orders;
}
