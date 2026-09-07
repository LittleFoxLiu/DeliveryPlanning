import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { seed } from '../src/seed.js';
import { resetDb } from '../src/db.js';

export interface TestCtx {
  base: string;
  server: Server;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestCtx> {
  resetDb();
  seed({ reset: true });
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/api`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function reseed(): void {
  resetDb();
  seed({ reset: true });
}

export function client(base: string) {
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await fetch(base + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: (json ?? {}) as Record<string, any>, headers: res.headers };
  };
  return {
    get: (p: string, token?: string) => call('GET', p, { token }),
    post: (p: string, body?: unknown, token?: string, headers?: Record<string, string>) => call('POST', p, { body, token, headers }),
  };
}

export async function login(base: string, email: string, password = 'demo1234'): Promise<string> {
  const res = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json() as { token?: string };
  if (!json.token) throw new Error(`login failed for ${email}: ${JSON.stringify(json)}`);
  return json.token;
}
