import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Only /api is proxied. /webhooks is deliberately NOT — provider
      // webhooks hit the deployed server directly, never the dev server,
      // and proxying them here would only produce confusing local failures.
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
