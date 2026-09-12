/**
 * Client test runner.
 *
 * WHY VITEST 3 AND NOT THE LATEST
 * vitest 4 and 5 depend on vite ^6 || ^7 || ^8; this app is on vite 5.4.
 * Installing the latest fails with ERESOLVE, and forcing it past that with
 * --legacy-peer-deps would run the test runner against a Vite it does not
 * support — in the tool whose entire job is telling you whether things work.
 * vitest 3 declares `vite: ^5.0.0 || ^6.0.0 || ^7.0.0-0`, so it is the newest
 * line that supports the Vite this app actually builds with. Revisit when
 * Vite itself is upgraded, which is its own change with its own build risk.
 *
 * WHY A SEPARATE CONFIG FILE
 * vite.config.js imports defineConfig from 'vite', which has no `test` key.
 * Adding one there means importing from 'vitest/config' instead, so the
 * production build config would stop working the moment vitest is not
 * installed. The build must never depend on the test runner.
 *
 * ENVIRONMENT: node, deliberately, for now.
 * Phase 1 has no component tests — the first client logic arrives with the
 * guided flow in Phase 3, and that is when jsdom and @testing-library/react
 * get added. Installing a DOM environment before anything renders in it
 * would be three dependencies on Render's build for nothing.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The React 17+ JSX runtime, matching what @vitejs/plugin-react gives the
  // real build. Without it esbuild emits React.createElement and a .jsx
  // component — which, like every component here, never imports React —
  // fails under test with "React is not defined".
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'src/**/*.test.jsx'],
  },
});
