import express from 'express';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getDb } from './db.js';
import { api } from './api.js';
import { rateLimit, notFoundHandler, errorHandler } from './http.js';
import { coordinator } from './agents/coordinator.js';
import { seed } from './seed.js';

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

// `process.argv[1]` is a Windows filesystem path, while import.meta.url is a
// file URL. Comparing the raw strings makes the server silently skip startup
// on Windows.
const entryPath = process.argv[1];
const isMain = !!entryPath && fileURLToPath(import.meta.url) === resolve(entryPath);
if (isMain) {
  await getDb();
  await seed({ reset: process.env.SEED_RESET === '1' });
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`[delivery-planner] API on http://${config.host}:${config.port}  (llm advisory: ${config.llm.enabled ? 'on' : 'off'})`);
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
}
