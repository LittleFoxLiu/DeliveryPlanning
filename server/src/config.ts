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

export type LlmConfig =
  | { enabled: false }
  | { enabled: true; provider: 'gateway' | 'anthropic'; url: string; apiKey: string; model: string; timeoutMs: number };

function resolveLlm(): LlmConfig {
  const gwUrl = process.env.LLM_GATEWAY_URL?.trim();
  const gwKey = process.env.LLM_GATEWAY_API_KEY?.trim();
  if (gwUrl && gwKey) {
    return {
      enabled: true, provider: 'gateway',
      url: gwUrl.replace(/\/$/, ''),
      apiKey: gwKey,
      model: process.env.LLM_MODEL?.trim() || 'sonnet4.5:latest',
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 8000),
    };
  }
  const anthKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthKey) {
    return {
      enabled: true, provider: 'anthropic',
      url: (process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com').replace(/\/$/, ''),
      apiKey: anthKey,
      model: process.env.AGENT_MODEL?.trim() || 'claude-sonnet-5',
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 8000),
    };
  }
  return { enabled: false };
}

export const authSecretMissing = { value: false };

function readSecret(): string {
  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === 'test') return 'test-secret-0123456789abcdef';

  if (process.env.NODE_ENV === 'production') {
    // A missing AUTH_SECRET must NOT crash the module at import time — that
    // takes the whole deployment down (Vercel then serves a 404 for /api/*).
    // Degrade instead: run on a generated per-instance secret and warn. Tokens
    // won't survive a redeploy or span instances until AUTH_SECRET is set.
    authSecretMissing.value = true;
    console.error('[config] AUTH_SECRET is not set — using an ephemeral secret. '
      + 'Set AUTH_SECRET (>=16 chars) in the deployment environment for stable sessions.');
    return 'ephemeral-' + randomBytes(24).toString('hex');
  }

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
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI?.trim() || 'http://localhost:8787/api/auth/google/callback',
  },
  tokenTtlSeconds: 60 * 60 * 12,
  // Monitoring loop cadence. 0 disables the background loop (tests / manual mode).
  monitorIntervalMs: Number(process.env.MONITOR_INTERVAL_MS ?? 0),
  // Optional LLM reasoning layer. Provider auto-selected from env; disabled when
  // neither is configured (the app stays fully deterministic).
  llm: resolveLlm(),
  grid: { size: 20, segmentBaseMinutes: 2, kmPerSegment: 0.5 },
  rateLimit: {
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_MAX ?? 120),
    authMax: Number(process.env.RATE_LIMIT_AUTH_MAX ?? 20),
  },
};

export type Role = 'admin' | 'merchant' | 'driver' | 'customer';
