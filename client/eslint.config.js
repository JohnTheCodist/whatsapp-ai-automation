/**
 * Lint config for the dashboard.
 *
 * WHY THIS EXISTS
 * A `ReferenceError: wholesale is not defined` reached production and took
 * the whole dashboard down the moment a product row rendered. Nothing could
 * have caught it: Vite does no scope analysis, so an identifier that was
 * never declared bundled and shipped exactly like a correct one.
 *
 * `no-undef` is therefore the rule this file is FOR. Everything else here is
 * either supporting it or paying for itself in the same currency — bugs that
 * are invisible until a specific screen renders for a specific user.
 *
 * DELIBERATELY NARROW
 * No stylistic rules, no formatting opinions, no import ordering. A lint run
 * that reports 200 spacing complaints is a lint run people start passing
 * `--quiet` to, and then the one real error scrolls past. Everything set to
 * "error" below can break the app at runtime; everything advisory is a
 * warning and does not fail the build.
 */

import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    // dist is build output; public holds the marketing pages, which are
    // standalone documents rather than part of this app's module graph.
    ignores: ['dist/**', 'node_modules/**', 'public/**'],
  },
  {
    // Build-time config files run in Node, not the browser. Linting them
    // against browser globals reports `process` as undefined — a false
    // positive, and the fastest way to teach someone that a no-undef error
    // is probably nothing.
    files: ['*.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { ...js.configs.recommended.rules },
  },
  {
    files: ['**/*.{js,jsx}'],
    ignores: ['*.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,

      // ---- the reason this file exists ----
      'no-undef': 'error',

      // Without this, no-unused-vars cannot see that a component is used —
      // <TierSwitch /> is a JSX element, not an identifier reference, so
      // every component in the file gets reported as dead code. That is the
      // noise that teaches people to ignore the output, which would cost us
      // the rule above.
      'react/jsx-uses-vars': 'error',

      // ---- off, because they are not this project's problems ----
      //
      // The JSX transform has not needed React in scope since 17, and this
      // codebase documents component contracts in prose rather than
      // propTypes — turning either on would produce noise in every file and
      // change nothing about correctness.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',

      // ---- advisory ----
      //
      // Warnings, not errors, on purpose. An unused variable is usually a
      // leftover rather than a fault, and a missing effect dependency is
      // sometimes deliberate (see AuthGate's auth-state effect, which must
      // NOT re-run on every token refresh). Both are worth seeing; neither is
      // worth refusing to deploy over.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
