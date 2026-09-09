import type { User } from './types';

const TOKEN_KEY = 'dp-token';
const USER_KEY = 'dp-user';

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function getUser(): User | null {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}
export function setSession(token: string, user: User): void {
  try { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* ignore */ }
}
export function clearSession(): void {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function api<T = unknown>(
  method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, `Unable to reach the API server. Start it with "npm run dev". (${detail})`);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { message: text }; }
  if (!res.ok) {
    if (res.status === 401) { clearSession(); }
    const msg = (json as { message?: string })?.message || `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return json as T;
}

export const get = <T = unknown>(p: string) => api<T>('GET', p);
export const post = <T = unknown>(p: string, body?: unknown, headers?: Record<string, string>) => api<T>('POST', p, body, headers);
export const patch = <T = unknown>(p: string, body?: unknown, headers?: Record<string, string>) => api<T>('PATCH', p, body, headers);
export const del = <T = unknown>(p: string, body?: unknown, headers?: Record<string, string>) => api<T>('DELETE', p, body, headers);
