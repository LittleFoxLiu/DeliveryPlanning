import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { rateLimit } from '../src/http.js';

function mockRes() {
  return { setHeader: vi.fn() } as unknown as Response;
}

describe('rate limit middleware', () => {
  it('allows requests under the limit and blocks the rest with 429 + Retry-After', () => {
    const mw = rateLimit(3);
    const req = { ip: '10.0.0.99' } as Request;
    const res = mockRes();
    const errors: unknown[] = [];
    const next = (e?: unknown) => { if (e) errors.push(e); };

    for (let i = 0; i < 3; i++) mw(req, res, next);
    expect(errors).toHaveLength(0);

    mw(req, res, next);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { status: number }).status).toBe(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('tracks buckets per client independently', () => {
    const mw = rateLimit(1);
    const res = mockRes();
    const errA: unknown[] = [];
    const errB: unknown[] = [];
    mw({ ip: '1.1.1.1' } as Request, res, (e?: unknown) => { if (e) errA.push(e); });
    mw({ ip: '2.2.2.2' } as Request, res, (e?: unknown) => { if (e) errB.push(e); });
    expect(errA).toHaveLength(0);
    expect(errB).toHaveLength(0);
  });
});
