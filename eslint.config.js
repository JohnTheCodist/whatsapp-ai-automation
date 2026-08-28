/**
 * Lint config for the server.
 *
 * WHY THIS EXISTS, AND WHY IT MATTERS MORE HERE THAN IN THE CLIENT
 * Removing a rule from orderService.js left `shelfHasMore` referenced but no
 * longer declared. Every order would have thrown ReferenceError at the moment
 * a customer asked for more than the shelf had — a branch nobody walks
 * through by hand, on a path that only runs when something is already going
 * wrong.
 *
 * The dashboard has a build step, so Vite would at least have processed the
 * file. This has none. A server module is read at require time and an
 * undefined identifier costs nothing until the line executes — which, for a
 * refusal path or an error handler, can be weeks. Then it fails in front of a
 * customer, in the code that was supposed to handle failure.
 *
 * `no-undef` finds that in milliseconds without running anything, which is
 * the entire argument for this file.
 *
 * DELIBERATELY NARROW — same reasoning as the client config. No stylistic
 * rules. A run that reports 200 spacing complaints is a run people start
 * ignoring, and then the one real error scrolls past with the rest.
 */

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      // Has its own config, its own globals, and its own build.
      'client/**',
      // Ships to a pharmacy's PC and is bundled separately.
      'agent/**',
      'desktop/**',
      'downloads/**',
      'db/**',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        // node:test injects these into test files.
        ...globals.jest,
      },
    },
    rules: {
      ...js.configs.recommended.rules,

      // ---- the reason this file exists ----
      //
      // The rule that would have caught shelfHasMore before it was committed,
      // let alone deployed.
      'no-undef': 'error',

      // A promise rejection nobody catches takes the process down, and this
      // server deliberately lets uncaughtException kill it so systemd can
      // restart — meaning one of these is an outage for every pharmacy at
      // once, not just the request that caused it.
      'no-unsafe-finally': 'error',
      // `if (x = 1)` in a policy check would silently rewrite the thing it
      // was meant to test, and every one of those here decides whether a
      // customer is answered.
      //
      // Default severity, NOT 'always': the deliberate form —
      // `while ((m = re.exec(s)))`, wrapped in its own parentheses to say "I
      // meant this" — is a normal way to walk a global regex and appears in
      // this codebase. 'always' flags it too, which would mean three errors
      // that are all correct code and teach people the rule is wrong.
      'no-cond-assign': 'error',

      // An invisible character in a string literal is the exact bug this
      // codebase has already had once: tradeCode.js's alphabet contained a
      // full-width ９ that a defensive filter silently stripped, leaving the
      // character set quietly one shorter than it read. Nothing looks wrong
      // on screen, which is the whole problem.
      //
      // Comments and regexes are exempt because in this codebase they are
      // where such characters legitimately BELONG. clinicalFilter.js strips
      // zero-width characters — they are a cheap way to break a word-boundary
      // match, so "over<zwsp>dose" slips past a safety pattern — and to strip
      // them the class must contain them literally, with an example in the
      // comment above it. Flagging that would be reporting the defence as the
      // flaw, and the only ways to silence it are to disable the rule or
      // damage working safety code.
      'no-irregular-whitespace': ['error', {
        skipComments: true,
        skipRegExps: true,
        skipStrings: false,
        skipTemplates: false,
      }],
      // Two functions with the same name in one module: the second silently
      // wins, and the first is dead code that reads as live.
      'no-dupe-keys': 'error',
      'no-func-assign': 'error',

      // ---- advisory ----
      //
      // A leftover variable is untidy, not broken. Kept visible, kept
      // non-fatal — the moment lint can refuse a deploy over tidiness is the
      // moment somebody adds --quiet and loses no-undef with it.
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // A catch that deliberately ignores its error is a pattern this
        // codebase uses on purpose — see the many `catch { /* ... */ }`
        // blocks that must not fail a working operation.
        caughtErrors: 'none',
      }],
      // console IS the logging interface here; the server logs structured
      // JSON through it and journald collects it.
      'no-console': 'off',

      // ---- off, because they are noise, not correctness ----
      //
      // 116 of these on first run, every one a redundant backslash inside a
      // regex. Not one of them can change what the pattern matches. Left as
      // errors they would be 94% of the output — and a lint run that is
      // mostly noise is one somebody adds --quiet to, taking no-undef with
      // it. That trade is the whole reason this rule is off rather than
      // "fixed" in a 116-file commit nobody can review.
      'no-useless-escape': 'off',
      // A catch that only rethrows is redundant, never wrong.
      'no-useless-catch': 'warn',
    },
  },
];
