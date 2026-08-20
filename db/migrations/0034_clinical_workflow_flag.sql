-- 0034 — the switch that lets a pharmacy run the clinical workflow.
--
-- DEFAULT FALSE, DELIBERATELY.
-- Stage 1 and Stage 2 built a protocol engine that nothing in worker.js
-- calls. Part 3 adds the integration (clinicalWorkflow.js), and this column
-- decides whether a given pharmacy's live conversations actually go through
-- it.
--
-- Off by default because switching it on changes nothing useful yet and
-- risks something real. With no approved evidence loaded — which is every
-- pharmacy today, by design — the workflow's own safety gate sends every
-- case to REVIEW, which is exactly what the current clinicalFilter path
-- already does. So the upside of defaulting to true is zero and the
-- downside is a live pharmacy service behaving differently than it did
-- yesterday.
--
-- A pharmacy turns this on when it has loaded and approved real evidence
-- and a pharmacist has reviewed the protocol. That is a clinical decision,
-- not a deployment default.

alter table pharmacy_profile
  add column if not exists clinical_workflow_enabled boolean not null default false;

comment on column pharmacy_profile.clinical_workflow_enabled is
  'Whether inbound clinical messages are driven through the Stage 1/2 protocol engine (clinicalWorkflow.handleTurn). Default false — see 0034. Turning this on is a clinical decision made after approved evidence has been loaded and reviewed, not a deployment setting.';
