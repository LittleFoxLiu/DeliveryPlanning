import { badRequest } from './util.js';
import { config } from './config.js';

type Obj = Record<string, unknown>;

export function asObject(body: unknown): Obj {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('JSON object body required');
  return body as Obj;
}

export function str(o: Obj, key: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string {
  const v = o[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw badRequest(`Field "${key}" is required`);
  }
  if (typeof v !== 'string') throw badRequest(`Field "${key}" must be a string`);
  const trimmed = v.trim();
  if (opts.min !== undefined && trimmed.length < opts.min) throw badRequest(`Field "${key}" is too short`);
  if (trimmed.length > (opts.max ?? 500)) throw badRequest(`Field "${key}" is too long`);
  return trimmed;
}

export function enumVal<T extends string>(o: Obj, key: string, allowed: readonly T[], fallback?: T): T {
  const v = o[key];
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw badRequest(`Field "${key}" must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

export function int(o: Obj, key: string, opts: { min?: number; max?: number; fallback?: number } = {}): number {
  const v = o[key];
  if ((v === undefined || v === null) && opts.fallback !== undefined) return opts.fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw badRequest(`Field "${key}" must be an integer`);
  if (opts.min !== undefined && n < opts.min) throw badRequest(`Field "${key}" must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw badRequest(`Field "${key}" must be <= ${opts.max}`);
  return n;
}

/** Coordinates are grid coordinates in [0, gridSize]. Never trust client values
 *  without bounds + finiteness validation. */
export function coord(o: Obj, key: string): number {
  const v = o[key];
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw badRequest(`Coordinate "${key}" must be a finite number`);
  const max = config.grid.size;
  if (n < 0 || n > max) throw badRequest(`Coordinate "${key}" out of bounds (0..${max})`);
  return Math.round(n * 1000) / 1000;
}

export function futureTs(o: Obj, key: string, opts: { maxHours?: number } = {}): string {
  const v = o[key];
  if (typeof v !== 'string') throw badRequest(`Field "${key}" must be an ISO timestamp`);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw badRequest(`Field "${key}" is not a valid timestamp`);
  if (t < Date.now() - 60_000) throw badRequest(`Field "${key}" must be in the future`);
  const maxHours = opts.maxHours ?? 24;
  if (t > Date.now() + maxHours * 3_600_000) throw badRequest(`Field "${key}" is too far in the future`);
  return new Date(t).toISOString();
}

const ID_RE = /^[a-z]+_[a-z0-9]{6,40}$/i;
export function idParam(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw badRequest(`Invalid ${label}`);
  return value;
}
