import type { Request, Response, NextFunction } from 'express';
import { HttpError } from './util.js';
import { config } from './config.js';

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(max: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${max}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + config.rateLimit.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return next(new HttpError(429, 'rate_limited', 'Too many requests'));
    }
    next();
  };
}

// Reap stale buckets so the map cannot grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
}, 60_000).unref();

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, 'not_found', 'Route not found'));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    if (err.status >= 500) console.error('[api]', req.method, req.path, err);
    return res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
  }
  // repo compare-and-set failures surface as plain Error — treat as conflict
  const message = err instanceof Error ? err.message : 'Unknown error';
  if (/^Supabase /.test(message) || /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed out/i.test(message)) {
    console.error('[api] database unavailable', req.method, req.path, err);
    return res.status(503).json({
      error: 'database_unavailable',
      message: 'Database unavailable. Check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and that the Supabase schema has been applied.',
    });
  }
  if (/expected .* but was |Illegal .* transition|vanished|became |already /.test(message)) {
    return res.status(409).json({ error: 'conflict', message });
  }
  console.error('[api] unhandled', req.method, req.path, err);
  res.status(500).json({ error: 'internal', message: 'Internal server error' });
}

/** Wrap async handlers so rejections reach errorHandler on Express 4 & 5. */
export function h(fn: (req: Request, res: Response) => Promise<unknown> | unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}
