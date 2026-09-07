import { defineConfig } from 'vite';

const apiTarget = process.env.API_TARGET || 'http://localhost:8787';

export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
});
