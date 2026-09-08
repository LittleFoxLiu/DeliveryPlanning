import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Vite does not automatically copy .env values into process.env while the
  // config file is being evaluated. Load all keys here so API_TARGET works
  // from .env/.env.local as documented, while shell variables still win.
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const apiTarget = process.env.API_TARGET
    || process.env.VITE_API_TARGET
    || fileEnv.API_TARGET
    || fileEnv.VITE_API_TARGET
    || 'http://localhost:8787';

  return {
    build: { outDir: 'dist', emptyOutDir: true },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
  };
});
