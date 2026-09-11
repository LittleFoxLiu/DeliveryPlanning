import './app.css';
import type { User } from './types';
import { getUser, getToken, setSession, clearSession, post, get, ApiError } from './api';
import { esc, toast } from './ui';
import { renderAdmin } from './views/admin';
import { renderMerchant } from './views/merchant';
import { renderDriver } from './views/driver';
import { renderCustomer } from './views/customer';
import { searchNominatim } from './geoMap';

const app = document.querySelector<HTMLDivElement>('#app')!;
let pollTimer: number | undefined;

export function stopPolling(): void {
  if (pollTimer !== undefined) { window.clearInterval(pollTimer); pollTimer = undefined; }
}
export function poll(fn: () => void, ms: number): void {
  stopPolling();
  pollTimer = window.setInterval(fn, ms);
}

/** Session ended server-side (e.g. API restarted in dev). Return to login
 *  in place — never a full page reload. */
export function handleUnauthed(): void {
  stopPolling();
  clearSession();
  route();
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const fieldKey = (f: Element): string => {
  const form = (f as HTMLElement).closest('form')?.id || '_';
  return `${form}:${f.getAttribute('name') || ''}`;
};

/**
 * Replace a view's content while protecting a form the user is editing:
 *  - never re-renders while a <select> in the view is open/focused;
 *  - carries over the values of named fields the user has changed;
 *  - restores focus and caret position to the field being typed in.
 * Returns false if it declined to render (open <select>).
 */
export function patchView(el: HTMLElement, html: string): boolean {
  const active = document.activeElement as Field | null;
  const focused = active && el.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) ? active : null;
  if (focused && focused.tagName === 'SELECT') return false;

  const caret = focused && 'selectionStart' in focused
    ? { key: fieldKey(focused), start: focused.selectionStart, end: focused.selectionEnd }
    : null;

  const saved = new Map<string, string>();
  el.querySelectorAll<Field>('[name]').forEach((f) => saved.set(fieldKey(f), f.value));
  const feedTop = el.querySelector('.event-feed')?.scrollTop ?? 0;

  el.innerHTML = html;

  el.querySelectorAll<Field>('[name]').forEach((f) => {
    // Form fields here are never server-driven — always carry the user's input
    // across a re-render (including a field they deliberately cleared).
    const prev = saved.get(fieldKey(f));
    if (prev !== undefined) f.value = prev;
  });

  if (caret) {
    let target: Field | null = null;
    el.querySelectorAll<Field>('[name]').forEach((f) => { if (fieldKey(f) === caret.key) target = f; });
    if (target) {
      (target as Field).focus();
      try { (target as HTMLInputElement).setSelectionRange(caret.start, caret.end); } catch { /* number/date inputs */ }
    }
  }

  const feed = el.querySelector<HTMLElement>('.event-feed');
  if (feed) feed.scrollTop = feedTop;
  return true;
}

/** Per-view guard: returns true only when `data` differs from the last render,
 *  so idle polling never re-renders (and never disturbs a form). */
const sigs = new Map<string, string>();
export function changed(viewKey: string, data: unknown): boolean {
  const s = JSON.stringify(data);
  if (sigs.get(viewKey) === s) return false;
  sigs.set(viewKey, s);
  return true;
}
export function resetSig(viewKey: string): void { sigs.delete(viewKey); }

const DEMO_ACCOUNTS = [
  { label: 'Dispatch / Admin', email: 'admin@demo.test' },
  { label: 'Merchant — Harbor Grocery', email: 'harbor@demo.test' },
  { label: 'Merchant — North Bakery', email: 'bakery@demo.test' },
  { label: 'Driver — Jordan Lee', email: 'driver1@demo.test' },
  { label: 'Driver — Priya Shah', email: 'driver2@demo.test' },
  { label: 'Driver — Marco Silva', email: 'driver3@demo.test' },
  { label: 'Driver — Hana Ito', email: 'driver4@demo.test' },
  { label: 'Driver — Diego Torres', email: 'driver5@demo.test' },
  { label: 'Customer — Maya Chen', email: 'maya@demo.test' },
  { label: 'Customer — James Wu', email: 'james@demo.test' },
];

function loginView(): void {
  stopPolling();
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="brand"><span class="dot"></span><b>Delivery Planner</b></div>
        <p class="auth-sub">Autonomous multi-agent dispatch</p>
        <div class="auth-tabs"><button class="btn primary" type="button" data-auth-tab="login">Sign in</button><button class="btn ghost" type="button" data-auth-tab="signup">Create account</button></div>
        <form id="login-form">
          <label>Email<input name="email" type="email" value="admin@demo.test" autocomplete="username" required></label>
          <label>Password<input name="password" type="password" value="demo1234" autocomplete="current-password" required></label>
          <button class="btn primary" type="submit">Sign in</button>
        </form>
        <form id="signup-form" style="display:none">
          <label>Name<input name="name" type="text" autocomplete="name" required></label>
          <label>Email<input name="email" type="email" autocomplete="email" required></label>
          <label>Password<input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
          <button class="btn primary" type="submit">Create account</button>
        </form>
        <div class="oauth-divider">or</div>
        <a class="btn google-btn" href="/api/auth/google">Continue with Google / Gmail</a>
        <div class="demo-accounts">
          <p>Quick demo sign-in <small>(password <code>demo1234</code>)</small></p>
          ${DEMO_ACCOUNTS.map((a) => `<button class="chip-btn" data-email="${esc(a.email)}">${esc(a.label)}</button>`).join('')}
        </div>
      </div>
    </div>`;

  const form = app.querySelector<HTMLFormElement>('#login-form')!;
  app.querySelectorAll<HTMLButtonElement>('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => {
    const signup = b.dataset.authTab === 'signup';
    app.querySelector('#login-form')!.setAttribute('style', signup ? 'display:none' : '');
    app.querySelector('#signup-form')!.setAttribute('style', signup ? '' : 'display:none');
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    await doLogin(String(fd.get('email')), String(fd.get('password')));
  });
  app.querySelector<HTMLFormElement>('#signup-form')!.addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget as HTMLFormElement; const fd = new FormData(f);
    try {
      const result = await post<{ token: string; user: User; needsOnboarding: boolean }>('/auth/signup', { name: fd.get('name'), email: fd.get('email'), password: fd.get('password') });
      setSession(result.token, result.user); onboardingView();
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Account creation failed', 'error'); }
  });
  app.querySelectorAll<HTMLButtonElement>('.chip-btn').forEach((b) => {
    b.addEventListener('click', () => doLogin(b.dataset.email!, 'demo1234'));
  });
}

function onboardingView(): void {
  stopPolling();
  app.innerHTML = `<div class="auth-screen"><div class="auth-card"><div class="brand"><span class="dot"></span><b>Set up your workspace</b></div><p class="auth-sub">Choose how you will use Delivery Planner.</p><form id="onboarding-form"><label>Account type<select name="role"><option value="customer">Customer</option><option value="merchant">Merchant</option><option value="driver">Driver</option><option value="admin">Admin</option></select></label><div id="role-fields"></div><button class="btn primary" type="submit">Continue</button></form></div></div>`;
  const form = app.querySelector<HTMLFormElement>('#onboarding-form')!; const fields = app.querySelector('#role-fields')!;
  const draw = () => { const role = (form.elements.namedItem('role') as HTMLSelectElement).value; fields.innerHTML = role === 'merchant' ? '<label>Business name<input name="businessName" required></label><label>Store name<input name="storeName" required></label><label>Store address<input name="storeAddress" data-address-search required placeholder="Search with Nominatim"></label><input name="storeLat" type="hidden"><input name="storeLng" type="hidden">' : role === 'driver' ? '<label>Vehicle<select name="vehicleType"><option>car</option><option>bike</option><option>van</option><option>truck</option></select></label><label>Capacity<input name="capacity" type="number" min="1" max="20" value="4" required></label><label>Starting address<input name="address" data-address-search required placeholder="Search with Nominatim"></label><input name="lat" type="hidden"><input name="lng" type="hidden">' : '<p class="muted">You can join organizations later from your workspace.</p>'; wireAddressFields(fields); };
  (form.elements.namedItem('role') as HTMLSelectElement).addEventListener('change', draw); draw();
  form.addEventListener('submit', async (e) => { e.preventDefault(); const fd = new FormData(form); const body: Record<string, unknown> = {}; fd.forEach((v, k) => { body[k] = v; }); body.capacity = Number(body.capacity); ['lat','lng','storeLat','storeLng'].forEach((k) => { if (body[k] !== undefined) body[k] = Number(body[k]); }); try { const r = await post<{ token: string; user: User }>('/onboarding/role', body); setSession(r.token, r.user); route(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Setup failed', 'error'); } });
}

function wireAddressFields(container: Element): void {
  container.querySelectorAll<HTMLInputElement>('[data-address-search]').forEach((input) => {
    const clearPoint = () => {
      if (!input.form) return;
      const prefix = input.name === 'storeAddress' ? 'store' : '';
      (input.form.elements.namedItem(`${prefix}Lat`) as HTMLInputElement).value = '';
      (input.form.elements.namedItem(`${prefix}Lng`) as HTMLInputElement).value = '';
    };
    input.addEventListener('input', clearPoint);
    input.addEventListener('change', async () => {
      const point = (await searchNominatim(input.value).catch(() => []))[0];
      if (!point || !input.form) return;
      input.value = point.address || point.name || '';
      const prefix = input.name === 'storeAddress' ? 'store' : '';
      (input.form.elements.namedItem(`${prefix}Lat`) as HTMLInputElement).value = String(point.lat);
      (input.form.elements.namedItem(`${prefix}Lng`) as HTMLInputElement).value = String(point.lon);
    });
  });
}

async function doLogin(email: string, password: string): Promise<void> {
  try {
    const { token, user } = await post<{ token: string; user: User }>('/auth/login', { email, password });
    setSession(token, user);
    route();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Login failed', 'error');
  }
}

/** Per-role page navigation. Pages are hash routes: #/<role>/<page>. */
export const NAV: Record<string, { id: string; label: string }[]> = {
  customer: [{ id: 'order', label: 'Order' }, { id: 'orders', label: 'My orders' }],
  merchant: [{ id: 'orders', label: 'Orders' }, { id: 'new', label: 'New order' }, { id: 'catalogue', label: 'Catalogue' }, { id: 'account', label: 'Account' }],
  driver: [{ id: 'deliveries', label: 'Deliveries' }, { id: 'account', label: 'Account' }],
  admin: [
    { id: 'overview', label: 'Overview' },
    { id: 'ops', label: 'Autonomous Ops' },
    { id: 'orders', label: 'Orders' },
    { id: 'fleet', label: 'Fleet' },
    { id: 'evaluation', label: 'Evaluation' },
    { id: 'network', label: 'Network' },
  ],
};

function currentPage(role: string): string {
  const pages = NAV[role] || [];
  const m = location.hash.match(/^#\/([a-z]+)\/([a-z]+)/i);
  if (m && m[1] === role && pages.some((p) => p.id === m[2])) return m[2];
  return pages[0]?.id ?? '';
}

/** Navigate to a page of the current role (updates the hash → triggers route). */
export function goto(page: string): void {
  const user = getUser();
  if (user) location.hash = `#/${user.role}/${page}`;
}

function shell(user: User, page: string): HTMLElement {
  const pages = NAV[user.role] || [];
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><span class="dot"></span><b>Delivery Planner</b><span class="role-tag">${esc(roleTitle(user.role))}</span></div>
        <div class="topbar-right">
          <span class="who">${esc(user.name)}</span>
          <button id="logout" class="btn ghost">Sign out</button>
        </div>
      </header>
      ${pages.length > 1 ? `<nav class="subnav">${pages.map((p) => `<a class="subnav-link${p.id === page ? ' active' : ''}" href="#/${user.role}/${p.id}">${esc(p.label)}</a>`).join('')}</nav>` : ''}
      <main id="view"></main>
    </div>`;
  app.querySelector('#logout')!.addEventListener('click', () => { clearSession(); stopPolling(); location.hash = ''; route(); });
  return app.querySelector<HTMLElement>('#view')!;
}

function roleTitle(role: string): string {
  return { admin: 'Dispatch Control', merchant: 'Merchant', driver: 'Driver', customer: 'Customer' }[role] || role;
}

function route(): void {
  stopPolling();
  const user = getUser();
  if (!user || !getToken()) { loginView(); return; }
  const page = currentPage(user.role);
  const want = `#/${user.role}/${page}`;
  if (location.hash !== want) { history.replaceState(null, '', location.pathname + location.search + want); }
  const view = shell(user, page);
  const renderers: Record<string, (el: HTMLElement, user: User, page: string) => void> = {
    admin: renderAdmin, merchant: renderMerchant, driver: renderDriver, customer: renderCustomer,
  };
  (renderers[user.role] ?? (() => { view.innerHTML = '<p>Unknown role</p>'; }))(view, user, page);
}

window.addEventListener('hashchange', () => {
  if (/^#(auth_token|auth_error)/.test(location.hash)) return;
  route();
});

const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
const oauthToken = hash.get('auth_token');
const oauthNew = hash.get('new') === '1';
if (oauthToken) {
  history.replaceState(null, '', location.pathname + location.search);
  setSession(oauthToken, { id: '', email: '', role: 'customer', name: 'Google user', refId: null });
  get<{ user: User }>('/auth/me').then(({ user }) => { setSession(oauthToken, user); oauthNew ? onboardingView() : route(); }).catch(() => { clearSession(); loginView(); });
} else if (hash.get('auth_error')) { history.replaceState(null, '', location.pathname + location.search); loginView(); toast(hash.get('auth_error')!, 'error'); }
else route();
