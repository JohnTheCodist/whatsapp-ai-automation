import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Ports are 5273/4100 rather than the usual 5173/4000 so this project can run
// alongside rxnaija-analytics without either fighting for a port.
const API_PORT = process.env.API_PORT || 4100;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    proxy: {
      // Only /api is proxied. /webhooks is deliberately NOT — provider
      // webhooks hit the deployed server directly, never the dev server,
      // and proxying them here would only produce confusing local failures.
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
        // The connection-status stream is SSE. Without this the proxy buffers
        // it and every event arrives at once when the request finally ends,
        // which looks exactly like the session never connecting.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
});
