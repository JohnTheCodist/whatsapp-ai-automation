-- 0036 — give red-flag rules an evaluable trigger.
--
-- THE BUG THIS FIXES, which was live-affecting
-- protocol_red_flags stored a name, a severity and an action — but nothing
-- that says WHEN the rule applies. The only reader, activeRedFlags(), could
-- therefore do just one thing: return every active rule for the protocol.
-- clinicalWorkflow.handleTurn then escalates when that list is non-empty.
--
-- Composed, those two facts mean: a protocol with ANY active red flag
-- escalates EVERY turn, urgently, before asking a single question. fever
-- v2.0.0 installs eight active flags, so every "I have fever" would have
-- produced an immediate emergency referral. A protocol with NO active flags
-- would instead never escalate on danger signs at all. All-or-nothing, with
-- no way to express the actual rule.
--
-- The protocols always intended the link: every red flag's `key` in
-- feverAssessmentV2 matches a choice value of the danger_signs_screen
-- question exactly (convulsions, neck_stiffness, cannot_drink, ...). That
-- correspondence was simply never persisted — createRedFlagRule dropped the
-- key. These two columns store it, so a rule can finally say "I fire when
-- danger_signs_reported contains 'convulsions'".
--
-- WHY A FACT CONCEPT + VALUE, AND NOT AN EXPRESSION LANGUAGE
-- Every red flag in every protocol written so far fires on exactly one
-- condition: a named danger sign appearing in a multi-choice answer. A
-- general expression evaluator would be more powerful and would also be a
-- new place for clinical logic to hide. Two columns cover every rule that
-- exists, and a rule needing more than that should go to a clinician before
-- it goes into a database column.

alter table protocol_red_flags
  add column if not exists trigger_concept text;

alter table protocol_red_flags
  add column if not exists trigger_value text;

comment on column protocol_red_flags.trigger_concept is
  'The clinical fact concept this rule watches, e.g. danger_signs_reported. NULL means the rule has no evaluable trigger and therefore NEVER fires — see redFlagEvaluator, which treats an untriggered rule as inert rather than as always-on.';

comment on column protocol_red_flags.trigger_value is
  'The value that must be present in trigger_concept for this rule to fire, e.g. convulsions. Matched against multi-value answers by containment.';

create index if not exists protocol_red_flags_trigger_idx
  on protocol_red_flags (protocol_id, trigger_concept) where active = true;
