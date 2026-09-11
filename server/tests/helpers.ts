import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { seed } from '../src/seed.js';
import { initDb, resetDb } from '../src/db.js';

export interface TestCtx {
  base: string;
  server: Server;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestCtx> {
  await initDb();
  await resetDb();
  await seed({ reset: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const routeMarker = '/route/v1/driving/';
    const routeStart = inputUrl.indexOf(routeMarker);
    if (routeStart >= 0) {
      const coordinateText = inputUrl.slice(routeStart + routeMarker.length).split('?')[0];
      const coordinates = coordinateText.split(';').map((value) => value.split(',').map(Number));
      const [fromLon, fromLat] = coordinates[0] ?? [];
      const [toLon, toLat] = coordinates[coordinates.length - 1] ?? [];
      return new Response(JSON.stringify({
        code: 'Ok',
        routes: [{
          distance: 8000,
          duration: 600,
          geometry: { coordinates: [[fromLon, fromLat], [(fromLon + toLon) / 2, (fromLat + toLat) / 2], [toLon, toLat]] },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/api`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => { globalThis.fetch = realFetch; resolve(); })),
  };
}

export async function reseed(): Promise<void> {
  await resetDb();
  await seed({ reset: true });
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
