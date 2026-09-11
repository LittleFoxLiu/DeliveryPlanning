import { initDb } from '../server/src/db.js';
import { seed } from '../server/src/seed.js';
import { createApp } from '../server/src/index.js';
import { config } from '../server/src/config.js';

// Vercel does not run server/src/index.ts as a long-lived process. The Express
// API is served from this single catch-all function; shared state is set up
// once per warm instance.
const app = createApp();
let ready: Promise<void> | null = null;

function initialise(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await initDb();
      // Non-destructive: creates the schema + demo accounts on an empty DB,
      // never resets an existing one.
      await seed({ reset: false }).catch((err) => {
        console.error('[vercel] seed skipped:', (err as Error).message);
      });
    })().catch((err) => {
      // Don't cache a rejected promise — let the next request retry.
      ready = null;
      throw err;
    });
  }
  return ready;
}

export default async function handler(req: any, res: any): Promise<void> {
  // Normalise the path: some Vercel adapters strip the leading `/api`.
  if (typeof req.url === 'string' && !/^\/api(?:\/|\?|$)/.test(req.url)) {
    req.url = `/api${req.url.startsWith('/') ? req.url : `/${req.url}`}`;
  }

  if (!config.databaseUrl) {
    res.status(503).json({
      error: 'not_configured',
      message: 'DATABASE_URL is not set for this deployment. Add a Postgres/Supabase '
        + 'connection string (Direct or Session pooler, port 5432) in the project environment.',
    });
    return;
  }

  try {
    await initialise();
  } catch (error) {
    console.error('[vercel] API initialisation failed', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'init_failed', message: (error as Error).message });
    }
    return;
  }

  app(req, res);
}
