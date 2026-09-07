import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// Load .env files for the server (tsx/node don't do this automatically).
// Skipped under tests, which inject their own env and must never touch a real DB.
if (process.env.NODE_ENV !== 'test') {
  for (const file of ['.env', '.env.local']) {
    if (existsSync(file)) {
      try { (process as NodeJS.Process & { loadEnvFile: (p: string) => void }).loadEnvFile(file); } catch { /* older node / bad file */ }
    }
  }
}

function resolveDatabaseUrl(): string {
  const raw = (process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim();
  if (!raw) return '';
  // Ignore unfilled placeholders so a template .env.local doesn't break local dev.
  if (!/^postgres(ql)?:\/\//i.test(raw) || /YOUR_DB_PASSWORD|\[YOUR-?PASSWORD\]|<password>|:password@/i.test(raw)) {
    console.warn('[config] DATABASE_URL looks like a placeholder — using local PGlite. Fill in your real Supabase connection string to share data.');
    return '';
  }
  return raw;
}

function readSecret(): string {
  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET must be set (>=16 chars) in production');
  }
  if (process.env.NODE_ENV === 'test') return 'test-secret-0123456789abcdef';
  // Dev/demo: persist a secret to disk so tokens survive `tsx watch` restarts
  // (otherwise every server reload silently logs everyone out).
  const file = 'server/data/.dev-auth-secret';
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch { /* not created yet */ }
  const generated = 'dev-secret-' + randomBytes(24).toString('hex');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, generated, { mode: 0o600 });
  } catch { /* fall back to ephemeral */ }
  return generated;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  // When set, the app uses this Postgres (e.g. Supabase) as the shared database.
  // Otherwise it runs an in-process Postgres (PGlite) persisted to `dbFile`.
  databaseUrl: resolveDatabaseUrl(),
  dbFile: process.env.DB_FILE?.trim() || 'server/data/pgdata',
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
