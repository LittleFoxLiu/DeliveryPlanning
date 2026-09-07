import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      AUTH_SECRET: 'test-secret-0123456789abcdef',
      MONITOR_INTERVAL_MS: '0',
      DEMO_PASSWORD: 'demo1234',
      RATE_LIMIT_MAX: '5000',
      RATE_LIMIT_AUTH_MAX: '5000',
    },
    pool: 'forks',
    fileParallelism: true,
  },
});
