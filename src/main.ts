import './app.css';
import type { User } from './types';
import { getUser, getToken, setSession, clearSession, post, ApiError } from './api';
import { esc, toast } from './ui';
import { renderAdmin } from './views/admin';
import { renderMerchant } from './views/merchant';
import { renderDriver } from './views/driver';
import { renderCustomer } from './views/customer';

const app = document.querySelector<HTMLDivElement>('#app')!;
let pollTimer: number | undefined;

export function stopPolling(): void {
  if (pollTimer !== undefined) { window.clearInterval(pollTimer); pollTimer = undefined; }
}
export function poll(fn: () => void, ms: number): void {
  stopPolling();
  pollTimer = window.setInterval(fn, ms);
}

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
        <form id="login-form">
          <label>Email<input name="email" type="email" value="admin@demo.test" autocomplete="username" required></label>
          <label>Password<input name="password" type="password" value="demo1234" autocomplete="current-password" required></label>
          <button class="btn primary" type="submit">Sign in</button>
        </form>
        <div class="demo-accounts">
          <p>Quick demo sign-in <small>(password <code>demo1234</code>)</small></p>
          ${DEMO_ACCOUNTS.map((a) => `<button class="chip-btn" data-email="${esc(a.email)}">${esc(a.label)}</button>`).join('')}
        </div>
      </div>
    </div>`;

  const form = app.querySelector<HTMLFormElement>('#login-form')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    await doLogin(String(fd.get('email')), String(fd.get('password')));
  });
  app.querySelectorAll<HTMLButtonElement>('.chip-btn').forEach((b) => {
    b.addEventListener('click', () => doLogin(b.dataset.email!, 'demo1234'));
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

function shell(user: User): HTMLElement {
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><span class="dot"></span><b>Delivery Planner</b><span class="role-tag">${esc(roleTitle(user.role))}</span></div>
        <div class="topbar-right">
          <span class="who">${esc(user.name)}</span>
          <button id="logout" class="btn ghost">Sign out</button>
        </div>
      </header>
      <main id="view"></main>
    </div>`;
  app.querySelector('#logout')!.addEventListener('click', () => { clearSession(); stopPolling(); route(); });
  return app.querySelector<HTMLElement>('#view')!;
}

function roleTitle(role: string): string {
  return { admin: 'Dispatch Control', merchant: 'Merchant', driver: 'Driver', customer: 'Customer' }[role] || role;
}

function route(): void {
  stopPolling();
  const user = getUser();
  if (!user || !getToken()) { loginView(); return; }
  const view = shell(user);
  const renderers: Record<string, (el: HTMLElement, user: User) => void> = {
    admin: renderAdmin, merchant: renderMerchant, driver: renderDriver, customer: renderCustomer,
  };
  (renderers[user.role] ?? (() => { view.innerHTML = '<p>Unknown role</p>'; }))(view, user);
}

route();
