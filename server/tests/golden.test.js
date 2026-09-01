/**
 * THE GOLDEN SUITE — one test per lesson that cost something.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER 80 TEST FILES
 * The rest of the suite is organised by module: orderLimits.test.js tests
 * orderLimits.js. This file is organised by INCIDENT. Each entry exists
 * because something went wrong — in production, in a review, or in a near
 * miss — and the entry is the thing that stops it going wrong the same way
 * twice.
 *
 * THE RULES FOR THIS FILE
 *
 *   1. Every test names the incident it came from, and the date.
 *   2. Nothing here may require a database, a network, or a model. This file
 *      must run everywhere, always. A golden test that skips is not
 *      protection — it is a comment with extra steps, and 386 tests in this
 *      repo currently skip and prove nothing.
 *   3. Entries are only ever ADDED. Removing one is saying the lesson no
 *      longer applies, which needs to be argued in the commit message, not
 *      done quietly to get a green run.
 *   4. When one of these fails, the code is wrong. Not the test. See
 *      AGENTS.md rule 2.
 *
 * HOW TO ADD ONE — after fixing any bug worth remembering:
 *
 *   GOLDEN-0NN — <one line: what the user experienced>
 *   Date:       <when it was found>
 *   Symptom:    <what was actually observed, in the user's words if possible>
 *   Cause:      <the mechanism, not the blame>
 *   Protection: <what this test would have caught>
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ===========================================================================
// GOLDEN-001 — "Pharmacy A received Pharmacy B's inventory."
//
// Date:       2026-08-29 (raised for review)
// Symptom:    A customer of one pharmacy being shown another pharmacy's
//             stock. The single worst failure this system can have: it is a
//             data breach, a wrong price, and a promise about goods that do
//             not exist, all at once.
// Cause:      Not reproduced in the code as it stands — every products query
//             carries a tenant filter and pharmacyId is bound server-side.
//             But the CLASS of bug is one line away at all times: a tool that
//             takes a tenant id as an argument, or one that queries before it
//             guards, and the model is choosing the arguments.
// Protection: The three structural invariants below. They do not test that
//             today's queries are right — isolation.test.js does that against
//             a real database. They test that the SHAPE which makes the leak
//             possible cannot be introduced.
// ===========================================================================

const { TOOLS, toolSchemas, runTool } = require('../services/ai/catalogueTools');

test('GOLDEN-001a: no tool lets the model name a tenant', () => {
  // The model chooses tool arguments. If a tenant identifier were ever an
  // argument, then "show me pharmacy X's stock" becomes a thing the model can
  // be talked into by a customer — and prompt injection is not hypothetical
  // here, it is a category in clinicalFilter's corpus.
  //
  // pharmacyId is bound server-side in runTool and never read from args. This
  // asserts the other half: that it is not even OFFERED.
  const forbidden = /pharmacy[_-]?id|tenant|pharmacyid/i;

  for (const schema of toolSchemas()) {
    const params = schema.function.parameters || {};
    const names = Object.keys(params.properties || {});

    for (const name of names) {
      assert.ok(
        !forbidden.test(name),
        `tool "${schema.function.name}" exposes parameter "${name}" — a model must never be able to name a tenant`,
      );
    }

    // Also catch it hiding in the prose. A description that mentions a
    // pharmacy id invites the model to invent one.
    assert.ok(
      !forbidden.test(JSON.stringify(params)),
      `tool "${schema.function.name}" mentions a tenant identifier in its parameter schema`,
    );
  }
});

test('GOLDEN-001b: every tool guards the tenant BEFORE it queries', () => {
  // Ordering is the whole protection. A tool that queries first and validates
  // second has already sent an unscoped statement to Postgres — and the API
  // connects with the service_role key, which bypasses row-level security, so
  // there is no second line of defence underneath it.
  //
  // Checked structurally rather than behaviourally because the behavioural
  // version (001c) is only SAFE while this holds: if a tool queried before
  // guarding, calling it with a bad tenant id would open a connection to
  // whatever DATABASE_URL points at.
  for (const tool of TOOLS) {
    const src = tool.run.toString();

    const guardAt = src.indexOf('assertPharmacyId');
    assert.ok(guardAt >= 0, `tool "${tool.name}" never calls assertPharmacyId`);

    const dbAt = ['getSql', 'db`', 'sql`']
      .map((needle) => src.indexOf(needle))
      .filter((i) => i >= 0)
      .reduce((a, b) => Math.min(a, b), Infinity);

    if (dbAt !== Infinity) {
      assert.ok(
        guardAt < dbAt,
        `tool "${tool.name}" touches the database at ${dbAt} before guarding at ${guardAt}`,
      );
    }
  }
});

test('GOLDEN-001c: a tool called without a valid tenant returns an error, never data', async () => {
  // The behavioural half. Safe to run because 001b holds — none of these
  // reach a database before throwing.
  //
  // runTool catches and returns { error } rather than throwing, so the failure
  // this guards against is not a crash: it is a tool quietly returning rows.
  const badContexts = [
    {},
    { pharmacyId: undefined },
    { pharmacyId: null },
    { pharmacyId: '' },
    // The shapes a leak actually takes when somebody reaches for a default.
    { pharmacyId: 'all' },
    { pharmacyId: '*' },
    { pharmacyId: 'undefined' },
  ];

  for (const tool of TOOLS) {
    for (const ctx of badContexts) {
      const result = await runTool(ctx, tool.name, {});

      assert.ok(
        result && typeof result.error === 'string',
        `tool "${tool.name}" with ctx ${JSON.stringify(ctx)} did not report an error`,
      );
      assert.match(
        result.error,
        /Tenant guard/,
        `tool "${tool.name}" failed for some reason OTHER than the tenant guard — `
        + 'the guard must be what stops it, not a downstream accident',
      );

      // The assertion that actually matters: nothing came back.
      for (const key of ['products', 'items', 'orders', 'results', 'rows', 'catalogue']) {
        assert.equal(
          result[key], undefined,
          `tool "${tool.name}" returned "${key}" despite an invalid tenant`,
        );
      }
    }
  }
});

// ===========================================================================
// GOLDEN-002 — The test suite was pointed at the production database.
//
// Date:       2026-08-29
// Symptom:    None visible, which is what made it dangerous. `npm test` ran
//             ~87 DELETE statements and `insert into auth.users` against the
//             live database — five real pharmacies, a connected WhatsApp
//             socket, messages from that morning. Nothing was lost; the
//             deletes are scoped by row id and tag prefix. That was luck
//             holding, not a design.
// Cause:      server/.env.example instructed setting TEST_DATABASE_URL to the
//             same value as DATABASE_URL ("ONE PROJECT FOR NOW"), with a note
//             to split them before the first real pharmacy. The pharmacy
//             arrived; the split did not happen. A comment was the only
//             control, and comments are not controls.
// Protection: The guard refuses, and refuses the workaround too. Somebody who
//             hits this error and changes the port has separated nothing.
// ===========================================================================

// ===========================================================================
// GOLDEN-003 — "The AI just went silent, and I don't know why it handed off."
//
// Date:       2026-08-28 07:20, reported 2026-08-29
// Symptom:    A customer amended an order from 3 cards of Claritin to 135.
//             The assistant replied "Sorry, I got a bit tangled there. Could
//             you say that again, in a few words?" — twice — and then handed
//             off with "Let me get one of our team to pick this up with you
//             here." Three exchanges, and the customer was never told what
//             was actually wrong.
// Cause:      135 x ₦33,780.87 = ₦4.56m, over the retail review ceiling, so
//             orderService returned NEEDS_STAFF_REVIEW with needsHandoff:true
//             and a perfectly good sentence to read out. The tool discarded
//             needsHandoff — it was set in orderService and read NOWHERE —
//             and handed the model a bare refusal with no instruction. The
//             model treated it as an obstacle, retried, hit
//             MAX_TOOL_ITERATIONS, and the turn ended as low_confidence.
// Protection: A refusal the model can retry is a refusal the model WILL
//             retry. If a tool result says a person must take over, it has to
//             carry an explicit instruction to say so and stop.
// ===========================================================================

test('GOLDEN-003: a refusal needing a human tells the model to stop, not just that it failed', () => {
  // Structural, not a reproduction: this does not test the ₦500,000 figure or
  // the Claritin price, both of which are configuration and will change. It
  // tests that the handoff signal cannot go missing between the service that
  // raises it and the model that has to act on it — which is the part that
  // was silently broken for the whole life of the feature.
  const orderService = require('../services/orders/orderService');
  const catalogueTools = require('../services/ai/catalogueTools');

  // The producing side still raises the signal.
  const producer = require('node:fs').readFileSync(
    require.resolve('../services/orders/orderService'), 'utf8',
  );
  assert.match(producer, /needsHandoff:\s*true/,
    'orderService must still mark a review-level refusal as needing a person');
  assert.ok(orderService.amendPendingOrder, 'the amend path still exists');

  // The consuming side must not drop it. This is the exact line that was
  // missing: both refusal branches spread a helper that adds the instruction.
  const consumer = require('node:fs').readFileSync(
    require.resolve('../services/ai/catalogueTools'), 'utf8',
  );
  const refusals = consumer.match(/if \(!result\.ok\) \{[\s\S]{0,900}?\n {6}\}/g) || [];
  assert.ok(refusals.length >= 2, 'expected the create_order and change_order_item refusal branches');

  for (const branch of refusals) {
    assert.match(
      branch, /stopRetrying\(result\)/,
      'a tool refusal must pass the handoff signal through — dropping it is what caused the retry loop',
    );
  }

  // And the instruction has to actually forbid retrying, not merely explain.
  assert.ok(
    typeof catalogueTools.TOOLS === 'object',
    'tools are still exported',
  );
  assert.match(consumer, /Do NOT call this tool again/,
    'the note must explicitly forbid another attempt — "that failed" alone invites a retry');
});

const { databaseIdentity } = require('./helpers/testDb');

test('GOLDEN-002a: one database is one identity, however it is addressed', () => {
  // The same Supabase project, reached three ways. A string comparison calls
  // these three different databases; they are one, and treating them as
  // distinct is exactly how the guard gets defeated by a one-character edit.
  const pooler6543 = 'postgresql://postgres.abcdefghijklmnop:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres';
  const pooler5432 = 'postgresql://postgres.abcdefghijklmnop:pw@aws-0-eu-west-3.pooler.supabase.com:5432/postgres';
  const direct = 'postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres';

  assert.equal(databaseIdentity(pooler6543), databaseIdentity(pooler5432),
    'switching pooler mode is not a separation');
  assert.equal(databaseIdentity(pooler6543), databaseIdentity(direct),
    'the direct connection is the same database as the pooler');
});

test('GOLDEN-002b: a genuinely different database is still allowed', () => {
  // A guard that blocks the FIX as well as the hazard gets removed. A second
  // Supabase project, and any other Postgres, must pass cleanly.
  const project = 'postgresql://postgres.abcdefghijklmnop:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres';
  const other = 'postgresql://postgres.zzzzzzzzzzzzzzzz:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres';
  const local = 'postgresql://postgres:pw@localhost:5432/rxnaija_test';

  assert.notEqual(databaseIdentity(project), databaseIdentity(other));
  assert.notEqual(databaseIdentity(project), databaseIdentity(local));
  assert.notEqual(databaseIdentity(other), databaseIdentity(local));
});

test('GOLDEN-002c: an unreadable connection string is not treated as safe', () => {
  // Fails closed. An unparseable URL is not evidence that two databases
  // differ, and the cost of being wrong here is the live database.
  for (const junk of ['', 'not-a-url', 'postgres://', undefined, null]) {
    assert.equal(databaseIdentity(junk), null, `${JSON.stringify(junk)} must not yield an identity`);
  }
});
