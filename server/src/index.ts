import express from 'express';
import { config } from './config.js';
import { getDb } from './db.js';
import { api } from './api.js';
import { rateLimit, notFoundHandler, errorHandler } from './http.js';
import { coordinator } from './agents/coordinator.js';
import { seed } from './seed.js';

export function createApp() {
  getDb();
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

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  seed({ reset: process.env.SEED_RESET === '1' });
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[delivery-planner] API on http://localhost:${config.port}  (llm advisory: ${config.llm.enabled ? 'on' : 'off'})`);
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
