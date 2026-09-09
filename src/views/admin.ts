import type { OrderDto, DriverDto, AgentEvent, RoadSeg } from '../types';
import { get, post, ApiError } from '../api';
import { poll, patchView, handleUnauthed, changed, resetSig } from '../main';
import { esc, toast, statusChip, eventFeed, fmtTime, minutesUntil } from '../ui';
import { renderMap, routeToPath, enableMapTooltips, type MapMarker, type MapPath } from '../map';

interface Overview {
  orders: OrderDto[];
  drivers: DriverDto[];
  deliveries: (OrderDto['delivery'] & { route?: unknown })[];
  assignments: { driverId: string; score: number; reasoning: Reasoning }[];
  traffic: { id: string; area: string; status: string; delay_minutes: number }[];
  roadIncidents: { id: string; status: string; delay: number }[];
  events: AgentEvent[];
  llmEnabled: boolean;
}
interface Reasoning {
  selected: string; score: number; margin: number;
  explanation: string[]; rationale: string;
  rejected: { driverId: string; disqualifiers: string[] }[];
}
interface Membership { inviteCode: string; requests: { id: string; email: string; name: string; status: string }[] }

const ROUTE_COLORS = ['#f26249', '#159c99', '#5277d7', '#9b6dd1', '#e0902a', '#3f9d6b'];
const itemText = (o: OrderDto) => o.items.map((it) => `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`).join(', ') || '—';
let grid: { size: number; roads: RoadSeg[] } = { size: 20, roads: [] };
let expanded = new Set<string>();
let created: { kind: string; name: string; email: string; password: string }[] = [];

let currentPage = 'overview';

export async function renderAdmin(el: HTMLElement, _user: unknown, page = 'overview'): Promise<void> {
  resetSig('admin');
  currentPage = page;
  if (!grid.roads.length) { try { grid = await get('/meta/grid'); } catch { /* retry next poll */ } }
  const draw = async () => {
    try {
      const [ov, membership] = await Promise.all([get<Overview>('/admin/overview'), get<Membership>('/admin/membership')]);
      if (!changed('admin', { ov, membership, page, expanded: [...expanded], created })) return;
      if (patchView(el, view(ov, membership))) wire(el, ov, membership); else resetSig('admin');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) handleUnauthed();
    }
  };
  await draw();
  poll(draw, 3500);
}

function view(ov: Overview, membership: Membership): string {
  if (currentPage === 'orders') {
    return `<div class="page-head"><div><h1>Orders</h1><p>Every order and the agent reasoning behind each assignment.</p></div></div>${ordersCard(ov)}`;
  }
  if (currentPage === 'fleet') {
    return `<div class="page-head"><div><h1>Fleet</h1><p>Driver status, load, and position.</p></div></div>${fleetCard(ov)}`;
  }
  if (currentPage === 'network') {
    return `<div class="page-head"><div><h1>Network</h1><p>Merchants, drivers, customers, and join requests.</p></div></div>
      <div class="card">
        <div class="card-head"><h2>Merchant join requests</h2><span class="muted">Invite code: <code>${esc(membership.inviteCode)}</code></span></div>
        ${membership.requests.length ? membership.requests.map((r) => `<div class="request-row"><span>${esc(r.name)} · ${esc(r.email)}</span><span>${r.status === 'pending' ? `<button class="btn sm" data-join="${esc(r.id)}" data-accept="true">Accept</button> <button class="btn sm" data-join="${esc(r.id)}" data-accept="false">Reject</button>` : esc(r.status)}</span></div>`).join('') : '<p class="muted">Share the invite code with a merchant.</p>'}
      </div>
      ${addToNetworkCard()}`;
  }
  return overviewPage(ov);
}

function overviewPage(ov: Overview): string {
  const availableDrivers = ov.drivers.filter((d) => d.status === 'available').length;
  const activeDeliveries = ov.deliveries.filter((d) => d && !['delivered', 'cancelled', 'failed'].includes(d.status)).length;

  const markers: MapMarker[] = [];
  const paths: MapPath[] = [];
  const ordersByDriver = new Map<string, OrderDto[]>();
  ov.orders.forEach((o) => {
    if (o.delivery?.driverId) {
      const arr = ordersByDriver.get(o.delivery.driverId) ?? [];
      arr.push(o); ordersByDriver.set(o.delivery.driverId, arr);
    }
  });
  ov.drivers.forEach((d) => {
    if (!d.location) return;
    const carrying = ordersByDriver.get(d.id) ?? [];
    markers.push({
      x: d.location.x, y: d.location.y, kind: 'driver', title: `${d.name} (driver)`,
      pulse: d.status === 'on_route',
      tip: [
        `${d.vehicleType} · fits ${d.maxPackageSize}`,
        `Status: ${d.status.replace(/_/g, ' ')}`,
        `Load: ${d.currentOrderCount}/${d.capacity}`,
        `At (${d.location.x}, ${d.location.y})`,
        ...(carrying.length ? [`Order: ${carrying.map((o) => `${o.code} for ${o.customerName}`).join(', ')}`] : []),
      ],
    });
  });
  ov.orders.forEach((o, i) => {
    const dlv = ov.deliveries.find((d) => d && d.orderId === o.id) as { route?: Parameters<typeof routeToPath>[0] } | undefined;
    markers.push({
      x: o.pickup.x, y: o.pickup.y, kind: 'pickup', title: `Pickup — ${o.storeName ?? 'Merchant'}`,
      tip: [`${o.code} · ${o.priority}`, `Items: ${itemText(o)}`, `at (${o.pickup.x}, ${o.pickup.y})`],
    });
    markers.push({
      x: o.dropoff.x, y: o.dropoff.y, kind: 'dropoff', title: `${o.customerName} (customer)`,
      tip: [`${o.code} · ${o.status.replace(/_/g, ' ')}`, `Items: ${itemText(o)}`, `Deadline ${fmtTime(o.deadlineTs)}`, `at (${o.dropoff.x}, ${o.dropoff.y})`],
    });
    const pts = routeToPath(dlv?.route);
    if (pts.length > 1) paths.push({ points: pts, color: ROUTE_COLORS[i % ROUTE_COLORS.length], active: true });
  });

  return `
    <div class="page-head">
      <div><h1>Dispatch Control</h1><p>Live multi-agent coordination ${ov.llmEnabled ? '· LLM advisory ON' : '· deterministic orchestration'}</p></div>
      <div class="pill-row">
        <button class="btn primary" data-act="tick">▶ Simulate tick</button>
        <button class="btn" data-act="monitor">Run monitoring</button>
        <button class="btn road-sim-btn" data-act="randomize-roads">Simulate road status</button>
        <button class="btn ghost" data-act="reset">Reset demo</button>
      </div>
    </div>

    <div class="grid3" style="margin-bottom:18px">
      <div class="stat"><div class="n">${ov.orders.length}</div><div class="l">Active orders</div></div>
      <div class="stat"><div class="n">${availableDrivers}/${ov.drivers.length}</div><div class="l">Drivers available</div></div>
      <div class="stat"><div class="n">${activeDeliveries}</div><div class="l">Deliveries in flight</div></div>
      <div class="stat"><div class="n">${ov.roadIncidents.length}</div><div class="l">Road incidents</div></div>
    </div>

    <div class="grid2">
      <div class="card">
        <div class="card-head"><h2>Network map</h2><span class="muted">${grid.roads.filter((r) => r.status !== 'clear').length} congested segments</span></div>
        ${renderMap({ size: grid.size, roads: grid.roads, markers, paths })}
      </div>
      <div class="card">
        <div class="card-head"><h2>Agent activity</h2><a class="muted" href="#/admin/orders">order details →</a></div>
        ${eventFeed(ov.events.map((e) => ({ agent: e.agent, message: e.message, ts: e.ts })))}
      </div>
    </div>`;
}

function ordersCard(ov: Overview): string {
  return `<div class="card">
    <div class="card-head"><h2>${ov.orders.length} active order${ov.orders.length === 1 ? '' : 's'}</h2></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Priority</th><th>Deadline</th><th>Assigned driver</th><th>ETA</th><th></th></tr></thead>
      <tbody>${ov.orders.map((o) => orderRow(o, ov)).join('') || `<tr><td colspan="8" class="muted">No active orders. Have a merchant mark an order ready.</td></tr>`}</tbody>
    </table></div>
  </div>`;
}

function fleetCard(ov: Overview): string {
  return `<div class="card">
    <div class="card-head"><h2>${ov.drivers.length} drivers</h2></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Driver</th><th>Vehicle</th><th>Status</th><th>Load</th><th>Position</th><th></th></tr></thead>
      <tbody>${ov.drivers.map(driverRow).join('')}</tbody>
    </table></div>
  </div>`;
}

function orderRow(o: OrderDto, ov: Overview): string {
  const d = o.delivery;
  const asg = ov.assignments.find((a) => a.driverId === d?.driverId);
  const driver = ov.drivers.find((x) => x.id === d?.driverId);
  const mins = minutesUntil(d?.etaTs);
  const isOpen = expanded.has(o.id);
  const rows = `
    <tr>
      <td><strong>${esc(o.code)}</strong><br><span class="muted">${esc(itemText(o))}</span></td>
      <td>${esc(o.customerName)}<br><span class="muted">to (${o.dropoff.x}, ${o.dropoff.y})</span></td>
      <td>${statusChip(o.status)}</td>
      <td>${statusChip(o.priority)}</td>
      <td>${fmtTime(o.deadlineTs)}<br><span class="muted">${minutesUntil(o.deadlineTs)}m</span></td>
      <td>${driver ? esc(driver.name) : '<span class="muted">—</span>'}</td>
      <td>${d?.etaTs ? `${fmtTime(d.etaTs)}${mins !== null ? ` <span class="muted">(${mins}m)</span>` : ''}` : '—'}</td>
      <td>${asg ? `<button class="btn sm" data-toggle="${esc(o.id)}">${isOpen ? 'Hide' : 'Why?'}</button>` : ''}</td>
    </tr>`;
  if (!isOpen || !asg) return rows;
  const r = asg.reasoning;
  const contrib = (r as { contributions?: Record<string, number> }).contributions;
  return rows + `
    <tr><td colspan="8" style="background:#fbfbfa">
      <strong>${esc(r.rationale)}</strong>
      <ul class="reason-list">${r.explanation.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${contrib ? `<p class="muted">Score breakdown: ${Object.entries(contrib).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')} = <b>${asg.score}</b></p>` : ''}
      ${r.rejected.length ? `<p class="muted">Not eligible: ${r.rejected.map((x) => `${esc(String(x.driverId))} (${x.disqualifiers.join(', ')})`).join('; ')}</p>` : ''}
    </td></tr>`;
}

function addToNetworkCard(): string {
  const creds = created.length ? `
    <div class="cred-box">
      <div class="card-head"><h3 style="font-size:13px;margin:0">New sign-in accounts</h3><button class="btn sm ghost" data-act="clear-created">Clear</button></div>
      <table><thead><tr><th>Role</th><th>Name</th><th>Email</th><th>Password</th></tr></thead>
      <tbody>${created.map((c) => `<tr><td>${esc(c.kind)}</td><td>${esc(c.name)}</td><td><code>${esc(c.email)}</code></td><td><code>${esc(c.password)}</code></td></tr>`).join('')}</tbody></table>
      <p class="muted">Shown once — copy the password now and hand it over.</p>
    </div>` : '';
  return `
    <div class="card">
      <div class="card-head"><h2>Add to network</h2><span class="muted">Each one gets a sign-in account</span></div>
      ${creds}
      <div class="grid3">
        <form class="inline-form" id="add-merchant">
          <h3 style="font-size:13px;margin:0">Merchant</h3>
          <label>Business name<input name="businessName" required></label>
          <label>Store name<input name="storeName" required></label>
          <label>Store X<input name="storeLat" type="number" min="0" max="20" step="1" value="10" required></label>
          <label>Store Y<input name="storeLng" type="number" min="0" max="20" step="1" value="10" required></label>
          <label>Contact name<input name="contactName" required></label>
          <label>Login email<input name="email" type="email" required></label>
          <button class="btn primary full" type="submit">Add merchant</button>
        </form>
        <form class="inline-form" id="add-driver">
          <h3 style="font-size:13px;margin:0">Driver</h3>
          <label>Name<input name="name" required></label>
          <label>Vehicle<select name="vehicleType"><option>car</option><option>bike</option><option>van</option><option>truck</option></select></label>
          <label>Capacity<input name="capacity" type="number" min="1" max="20" value="4" required></label>
          <label>Fits<select name="maxPackageSize"><option>large</option><option>medium</option><option>small</option></select></label>
          <label>Start X<input name="lat" type="number" min="0" max="20" step="1" value="10" required></label>
          <label>Start Y<input name="lng" type="number" min="0" max="20" step="1" value="10" required></label>
          <label>Login email<input name="email" type="email" required></label>
          <button class="btn primary full" type="submit">Add driver</button>
        </form>
        <form class="inline-form" id="add-customer">
          <h3 style="font-size:13px;margin:0">Customer</h3>
          <label>Name<input name="name" required></label>
          <label>Login email<input name="email" type="email" required></label>
          <button class="btn primary full" type="submit">Add customer</button>
        </form>
      </div>
    </div>`;
}

function driverRow(d: DriverDto): string {
  return `<tr>
    <td><strong>${esc(d.name)}</strong></td>
    <td>${esc(d.vehicleType)} · ${d.maxPackageSize}</td>
    <td>${statusChip(d.status)}</td>
    <td>${d.currentOrderCount}/${d.capacity}</td>
    <td>${d.location ? `(${d.location.x}, ${d.location.y})` : '—'}</td>
    <td>${d.status !== 'offline' ? `<button class="btn sm" data-offline="${esc(d.id)}">Take offline</button>` : ''}</td>
  </tr>`;
}

function wire(el: HTMLElement, ov: Overview, membership: Membership): void {
  enableMapTooltips(el);
  const repaint = () => renderAdmin(el, null, currentPage);
  el.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.toggle!;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    el.innerHTML = view(ov, membership); wire(el, ov, membership);
  }));
  el.querySelectorAll<HTMLButtonElement>('[data-join]').forEach((b) => b.addEventListener('click', () => act(() => post(`/admin/membership/${b.dataset.join}`, { accept: b.dataset.accept === 'true' }), 'Request updated')));

  el.querySelector('[data-act="clear-created"]')?.addEventListener('click', () => { created = []; repaint(); });
  const addForm = (id: string, path: string, kind: string, body: (fd: FormData) => Record<string, unknown>) => {
    el.querySelector<HTMLFormElement>(`#${id}`)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget as HTMLFormElement;
      const fd = new FormData(form);
      try {
        const res = await post<{ credentials: { email: string; password: string } }>(path, body(fd));
        created.unshift({ kind, name: String(fd.get('name') || fd.get('contactName') || fd.get('businessName') || ''), ...res.credentials });
        toast(`${kind} added`);
        repaint();
      } catch (err) { toast(err instanceof ApiError ? err.message : 'Failed', 'error'); }
    });
  };
  addForm('add-merchant', '/admin/merchants', 'Merchant', (fd) => ({
    businessName: fd.get('businessName'), storeName: fd.get('storeName'),
    storeLat: Number(fd.get('storeLat')), storeLng: Number(fd.get('storeLng')),
    contactName: fd.get('contactName'), email: fd.get('email'),
  }));
  addForm('add-driver', '/admin/drivers', 'Driver', (fd) => ({
    name: fd.get('name'), vehicleType: fd.get('vehicleType'), capacity: Number(fd.get('capacity')),
    maxPackageSize: fd.get('maxPackageSize'), lat: Number(fd.get('lat')), lng: Number(fd.get('lng')), email: fd.get('email'),
  }));
  addForm('add-customer', '/admin/customers', 'Customer', (fd) => ({ name: fd.get('name'), email: fd.get('email') }));
  el.querySelector('[data-act="tick"]')?.addEventListener('click', () => act(() => post('/sim/tick'), 'Advanced simulation one tick'));
  el.querySelector('[data-act="monitor"]')?.addEventListener('click', () => act(() => post('/admin/monitor/tick'), 'Monitoring cycle complete'));
  el.querySelector('[data-act="randomize-roads"]')?.addEventListener('click', async () => {
    await act(() => post('/admin/roads/randomize'), 'Every road segment received a randomized status');
    repaint();
  });
  el.querySelector('[data-act="reset"]')?.addEventListener('click', () => {
    if (confirm('Reset all demo data?')) act(() => post('/sim/reset'), 'Demo reset');
  });
  el.querySelectorAll<HTMLButtonElement>('[data-offline]').forEach((b) => b.addEventListener('click', () =>
    act(() => post(`/sim/driver/${b.dataset.offline}/offline`), 'Driver taken offline — watch the Monitoring Agent')));

  const firstAssigned = ov.orders.find((o) => o.delivery?.driverId
    && ['assigned', 'en_route_pickup', 'picked_up', 'en_route_drop'].includes(o.delivery.status));
  const head = el.querySelector('.page-head .pill-row');
  if (firstAssigned && head && !head.querySelector('[data-act="traffic"]')) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.dataset.act = 'traffic';
    btn.textContent = '⚠ Simulate traffic incident';
    btn.addEventListener('click', () => act(
      () => post('/sim/traffic', { blockRouteOf: firstAssigned.id }),
      'Road closed on the active route — watch the agents recover'));
    head.insertBefore(btn, head.children[1]);
  }
}

async function act(fn: () => Promise<unknown>, okMsg: string): Promise<void> {
  try { await fn(); toast(okMsg); } catch (err) { toast(err instanceof ApiError ? err.message : 'Action failed', 'error'); }
}
