import { randomBytes } from 'node:crypto';

function readSecret(): string {
  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET must be set (>=16 chars) in production');
  }
  // Dev/demo only: stable-enough per-process secret. Tokens do not survive restart.
  return 'dev-secret-' + randomBytes(24).toString('hex');
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dbFile: process.env.DB_FILE?.trim() || 'server/data/delivery.db',
  authSecret: readSecret(),
  tokenTtlSeconds: 60 * 60 * 12,
  // Monitoring loop cadence. 0 disables the background loop (tests / manual mode).
  monitorIntervalMs: Number(process.env.MONITOR_INTERVAL_MS ?? 0),
  // Optional LLM advisory layer. Disabled unless a key is present.
  llm: {
    enabled: !!process.env.ANTHROPIC_API_KEY,
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.AGENT_MODEL?.trim() || 'claude-sonnet-5',
    baseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com',
  },
  grid: { size: 20, segmentBaseMinutes: 2, kmPerSegment: 0.5 },
  rateLimit: {
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_MAX ?? 120),
    authMax: Number(process.env.RATE_LIMIT_AUTH_MAX ?? 20),
  },
};

export type Role = 'admin' | 'merchant' | 'driver' | 'customer';
