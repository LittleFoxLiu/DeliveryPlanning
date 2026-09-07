import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const webPort = Number(env.VITE_PORT || 5173);
  const apiTarget = env.API_TARGET || 'http://127.0.0.1:8787';
  const apiUrl = new URL(apiTarget);
  if (apiUrl.port && Number(apiUrl.port) === webPort) {
    throw new Error(`API_TARGET (${apiTarget}) must use a different port from VITE_PORT (${webPort})`);
  }

  return {
    build: { outDir: 'dist', emptyOutDir: true },
    server: {
      port: webPort,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
  };
});
