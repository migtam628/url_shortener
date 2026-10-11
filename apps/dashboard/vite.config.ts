import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Production serves the management UI below the redirect domain's reserved
  // /manage prefix. Local development remains rooted at / by default.
  base: process.env['VITE_BASE_PATH'] ?? '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // The dashboard and API are same-origin in production (nginx routes
      // /api to the API service), so proxy in dev to match. This keeps
      // session cookies first-party and avoids a CORS-only code path that
      // production never exercises.
      '/api': {
        target: process.env['VITE_API_TARGET'] ?? 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
