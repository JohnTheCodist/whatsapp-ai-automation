/**
 * What the assistant does on a pharmacy's behalf, made visible.
 *
 * WHY THIS EXISTS
 * There is a governed clinical engine in this product — versioned protocols,
 * a red-flag evaluator, a safety gate, a router whose own header says routing
 * is "only ever a NARROWING" of what the model may say. Four protocol files
 * ship with it and three of them run against real patients' WhatsApp
 * messages.
 *
 * Until this route there was NO WAY TO SEE ANY OF IT. No endpoint, no screen.
 * A pharmacy could not answer "what is the assistant asking my patients?",
 * "which version is running?", or "what will it never say?" — about software
 * acting in their name, under their licence.
 *
 * THE DRIFT THAT PROVES THE POINT. With the engine invisible, the dashboard's
 * own service list fell out of step with it: `client/src/modules.js` lists
 * "Malaria assessment" as `status: 'active'` while
 * nigeriaMalariaAssessmentV1.js says, in capitals on line 2, "DRAFT. NOT
 * ACTIVE. NOT PATIENT-FACING." Nobody lied; nobody could see.
 *
 * READ-ONLY, AND NOT BY ACCIDENT
 * There is no POST here and no enable/disable. Protocol content is clinical
 * governance — clinicalProtocolService.js's header is explicit that
 * interpreting a protocol is "a later stage's job, under clinical governance
 * this module has no part in" — and a web form that edits question sets is
 * that change wearing a UI. Showing is not editing.
 *
 * THE SOURCE OF TRUTH IS THE PROTOCOL MODULE ITSELF. This file restates
 * nothing. It loads the same modules clinicalRouter loads, from the same
 * paths, and reports their own DEFINITION. A protocol that changes its
 * questions changes this screen on the next request, and a protocol this
 * route cannot see is one the router cannot route to either.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * Every protocol that SHIPS, and whether it is reachable.
 *
 * The routable list is read from clinicalRouter, not copied: it is the thing
 * that actually decides whether a patient's message reaches a protocol, and a
 * second list here would be free to disagree with it. That disagreement is
 * precisely the bug this screen exists to surface, so reproducing it inside
 * the fix would be absurd.
 *
 * The draft ones are listed too, and loudly. A protocol deliberately held in
 * draft is a decision somebody made for a clinical reason, and hiding it
 * would leave the screen implying the shelf is bare where it is in fact
 * stocked and switched off on purpose.
 */
const SHIPPED = Object.freeze([
  { module: '../services/clinical/protocols/feverAssessmentV2', file: 'feverAssessmentV2.js' },
  { module: '../services/clinical/protocols/coughAssessmentV1', file: 'coughAssessmentV1.js' },
  { module: '../services/clinical/protocols/soreThroatAssessmentV1', file: 'soreThroatAssessmentV1.js' },
  { module: '../services/clinical/protocols/nigeriaMalariaAssessmentV1', file: 'nigeriaMalariaAssessmentV1.js' },
  { module: '../services/clinical/protocols/feverAssessmentV1', file: 'feverAssessmentV1.js' },
]);

/** The slugs the router will actually send a patient message to. */
function routableSlugs() {
  const { listRoutableProtocols } = require('../services/clinical/clinicalRouter');
  return new Set(listRoutableProtocols().map((c) => `${c.slug}@${c.version}`));
}

/**
 * One protocol, as a screen needs it.
 *
 * COUNTS RATHER THAN CONTENTS for the clinical lists. A pharmacist reading
 * this screen is answering "what does this thing do, and is it on?" — not
 * reviewing eight red-flag rules in a sidebar. The questions ARE listed,
 * because "what will my patients be asked?" is the question most worth
 * answering here, and it is the part a patient experiences directly.
 *
 * `boundaries` is carried verbatim. It is the protocol's own statement of
 * what it will never do, and paraphrasing a safety boundary to fit a card is
 * how one stops being true.
 */
function shape(mod, routable) {
  const d = mod.DEFINITION;
  const key = `${d.slug}@${d.version}`;
  return {
    slug: d.slug,
    version: d.version,
    name: d.name,
    description: d.description,
    conditionDomain: d.conditionDomain || null,
    population: d.population || null,
    source: d.source || null,
    // TWO DIFFERENT FACTS, deliberately not collapsed into one boolean.
    //
    //   wiredUp  the router would consider this protocol at all (code)
    //   live     THIS pharmacy has it active (database, per tenant)
    //
    // Collapsing them is the confusion that let the sidebar advertise a
    // draft protocol as an active service: a file existing, a router
    // knowing about it, and a pharmacy having it switched on are three
    // things, and only the last one means a patient will be asked these
    // questions tonight.
    wiredUp: routable.has(key),
    counts: {
      triggers: (d.presentingComplaints || []).length,
      questions: (d.questions || []).length,
      redFlags: (d.redFlags || []).length,
      escalationRules: (d.escalationRules || []).length,
      transitions: (d.protocolTransitions || []).length,
    },
    questions: (d.questions || []).map((q) => ({
      key: q.questionKey,
      text: q.text,
      answerType: q.answerType,
      required: Boolean(q.required),
    })),
    boundaries: d.recommendationBoundaries || null,
  };
}

/**
 * GET /api/protocols — every protocol that ships, and whether it can run.
 *
 * Not tenant-scoped in the data sense: protocols are code, identical for
 * every pharmacy on this deployment. `requireAuth` still applies, because
 * what the assistant asks patients is not public.
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const routable = routableSlugs();
    const { isProtocolLive } = require('../services/clinical/clinicalRouter');

    const protocols = await Promise.all(SHIPPED.map(async ({ module: m, file }) => {
      const mod = require(m);
      const base = { ...shape(mod, routable), file };

      /* Per-tenant liveness, asked of the one function that decides it.

         THREE STATES, not two. `isProtocolLive` fails CLOSED on an
         unreadable configuration — its own comment: "An unreadable
         configuration is not permission to start a clinical workflow" — so
         false can mean "off" OR "we could not read it". Reporting those as
         the same thing would tell a pharmacy a protocol is switched off
         when the truth is nobody could tell, which is the mistake the
         WhatsApp chip made yesterday in the other direction. */
      if (!base.wiredUp) return { ...base, live: false, liveKnown: true };
      try {
        return { ...base, live: await isProtocolLive(req.pharmacyId, base.slug), liveKnown: true };
      } catch {
        return { ...base, live: false, liveKnown: false };
      }
    }));

    res.json({
      protocols,
      // Said plainly rather than left to the screen to infer. A screen that
      // derived these could derive them differently from each other.
      wiredUpCount: protocols.filter((p) => p.wiredUp).length,
      liveCount: protocols.filter((p) => p.live).length,
      total: protocols.length,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
