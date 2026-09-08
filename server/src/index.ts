import express from 'express';
import { config } from './config.js';
import { initDb, dbKind } from './db.js';
import { api } from './api.js';
import { rateLimit, notFoundHandler, errorHandler } from './http.js';
import { coordinator } from './agents/coordinator.js';
import { seed } from './seed.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '128kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use('/api', rateLimit(config.rateLimit.max), api);
  app.use('/api', notFoundHandler);
  app.use('/api', errorHandler);
  return app;
}

// Compare normalized filesystem paths. Comparing import.meta.url directly to
// `file://${process.argv[1]}` fails on Windows because the URL is formatted as
// file:///C:/..., so the API startup block would never execute there.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  (async () => {
    await initDb();
    await seed({ reset: process.env.SEED_RESET === '1' });
    const app = createApp();
    const server = app.listen(config.port, () => {
      console.log(`[delivery-planner] API on http://localhost:${config.port}`);
      console.log(`[delivery-planner] database: ${dbKind() === 'postgres' ? 'Supabase/Postgres (shared)' : `PGlite (local: ${config.dbFile})`}`);
      console.log(`[delivery-planner] llm reasoning: ${config.llm.enabled ? `on (${config.llm.provider}, ${config.llm.model})` : 'off — deterministic only'}`);
    });

    if (config.monitorIntervalMs > 0) {
      const loop = setInterval(() => {
        coordinator.runMonitoringCycle().catch((e) => console.error('[monitor]', e));
      }, config.monitorIntervalMs);
      loop.unref();
      console.log(`[delivery-planner] background monitoring every ${config.monitorIntervalMs}ms`);
    }

    process.on('SIGINT', () => { server.close(); process.exit(0); });
    process.on('SIGTERM', () => { server.close(); process.exit(0); });
  })().catch((e) => { console.error('[delivery-planner] failed to start:', e); process.exit(1); });
}
