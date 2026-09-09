import { initDb } from '../server/src/db.js';
import { seed } from '../server/src/seed.js';
import { createApp } from '../server/src/index.js';
import { config } from '../server/src/config.js';

// Vercel does not execute server/src/index.ts as a long-running process. Keep
// the Express API behind one catch-all function and initialise shared state
// once per warm function instance.
const app = createApp();
let ready: Promise<void> | null = null;

function initialise(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      if (process.env.NODE_ENV === 'production' && !config.databaseUrl) {
        throw new Error('DATABASE_URL must be configured for the Vercel deployment');
      }
      await initDb();
      // seed() is non-destructive when the database already contains users.
      // This makes the sample login usable on a newly provisioned demo DB
      // without resetting an existing production database on cold starts.
      await seed({ reset: false });
    })();
  }
  return ready;
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    await initialise();
    // Some Vercel adapters pass a catch-all function the path with `/api`
    // removed. The Express app is mounted at `/api`, so normalize both forms.
    if (typeof req.url === 'string' && !/^\/api(?:\/|\?|$)/.test(req.url)) {
      req.url = `/api${req.url.startsWith('/') ? req.url : `/${req.url}`}`;
    }
    app(req, res);
  } catch (error) {
    console.error('[vercel] API initialisation failed', error);
    if (!res.headersSent) res.status(500).json({ error: 'internal', message: 'API initialisation failed' });
  }
}
