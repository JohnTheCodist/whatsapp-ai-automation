# Chats and Workflows: the agentic layer

**Status: PROPOSED, not approved. No code written.**

The owner, pointing at the Rhazes sidebar: *"my goal is to have chat and
workflow at the side bar. we are trying to build agentic software. and
upgrade to what we have."*

The last three words are the brief. This is not a new product beside the
one that exists — it is a surface for machinery that is already here, plus
exactly one genuinely new thing.

---

## 1. What we already have, measured today

Not recalled, not assumed — read out of the tree on 2026-10-12.

### A governed clinical engine, running headless

```
services/clinical/clinicalWorkflow.js    ONE doorway, FOUR outcomes:
                                         CONTINUE / RECOMMENDATION / REVIEW / URGENT
services/clinical/clinicalProtocolService.js
                                         protocols as DATA, identity is
                                         (pharmacy_id, slug, version)
services/clinical/clinicalRouter.js      decides what reaches the engine
services/clinical/safetyGate.js          approves what may be said
services/clinical/redFlagEvaluator.js    emergency detection
services/clinical/protocolExecutionService.js
                                         question order
```

The protocols themselves are code under
`services/clinical/protocols/`, and the directory listing is the best
evidence that the versioning is real rather than aspirational:

```
feverAssessmentV1.js          <- kept
feverAssessmentV2.js          <- and superseded by this one
coughAssessmentV1.js
nigeriaMalariaAssessmentV1.js
soreThroatAssessmentV1.js
```

`clinicalWorkflow.js`'s own header is the important part: **"IT ADDS NO
CLINICAL INTELLIGENCE."** Every judgement is delegated — protocol selection
to the registry, question order to the execution service, approval to the
safety gate. And `clinicalRouter.js`: routing to the engine is **only ever a
NARROWING** of what the old path would have done.

Four protocols are live: **fever, malaria, cough, sore throat**.

**None of this has a route or a screen.** `server/routes/` has no protocols
endpoint; the client has no protocol UI. A pharmacy cannot see which
protocols run, what they ask, what version they are on, or switch one off.
It runs entirely inside the WhatsApp assistant, invisibly.

### A patient-facing assistant, tightly fenced

`services/ai/assistant.js` — the four-step order (filter → tools → validate
→ send) that AGENTS.md calls a safety guarantee rather than a code layout.
`clinicalFilter.js` runs *before* the model and is, in AGENTS.md's words,
**the specification of what the assistant may answer without a pharmacist.**

### One non-patient-facing model feature, as precedent

The AI scribe. It does **not** go through `clinicalFilter`. It has its own
contract — `scribeContract.js` — with named refusals (`unsupportedNegative`,
`hardenedACertainty`, `withinTranscript`), each validated against the words
of the person who owns that section.

**That is the pattern a pharmacist-facing feature follows here: its own
contract, not a reuse of the patient filter.**

### What does not exist at all

**Nothing pharmacist-facing to chat with.** `clinicalFilter.screenMessage`
is called from exactly two places — `assistant.js` and `worker.js`, both the
patient path. The other model callers (scribe, the website copy generators,
`clinicalDifferentialService`) are each governed by their own rules.

---

## 2. What the two words mean HERE

Rhazes is a clinician's assistant: ask it, consult, write, medical coding.
Ours is a pharmacy's operating system whose AI currently talks to **patients**.
Copying the sidebar without that distinction would be the worst possible
outcome — a clinical chatbot wearing our chrome.

```
Rhazes "Workflows"   automations the clinician composes
OURS                 the clinical protocols the assistant ALREADY runs,
                     finally visible and controllable

Rhazes "Chats"       a clinician asking a model clinical questions
OURS                 a pharmacist asking about THIS pharmacy — its stock,
                     its patients, its conversations, its protocols
```

**Workflows is an upgrade of what we have.** Chats is new, and is where all
the risk lives.

---

## 3. The decision this forces, before any code

**What governs a pharmacist-facing assistant?**

`clinicalFilter` is the wrong instrument. It exists to refuse things *a
patient* must not be answered without a pharmacist — and the user here IS
the pharmacist. Applying it would make the feature refuse its own audience.
Removing it and calling the model directly is the other failure: an
ungrounded clinical chatbot is a different product with a different
liability, in a country where this system serves five real pharmacies.

**The proposal: Chats is GROUNDED, not consulted.**

It answers from this pharmacy's own records and says where each answer came
from. It is a better way to ask the database a question, not a second
opinion on a patient.

```
"Do we have amoxicillin 500?"          -> the catalogue. ANSWERS.
"Which patients are overdue a refill?" -> the refill engine. ANSWERS.
"What did Ngozi say last week?"        -> her conversation. ANSWERS.
"What does the fever protocol ask?"    -> the protocol. ANSWERS.

"What should I give a 3-year-old       -> REFUSES, and says why: that is
 with a fever of 39?"                     a clinical decision, and this
                                          product has no validated rule
                                          behind it.
```

That line is the same one the whole codebase already holds. §17 of the
consultation plan refuses to suggest a referral because no validated rule
exists. The scribe refuses to draft an Assessment from the patient's voice.
Chats refusing clinical advice is consistent, not timid — and it is the only
version I would put in front of a pharmacy.

**This is the decision I need from you, and the one I will not make alone.**

---

## 4. Phases

Each ships with tests and a regression run, per AGENTS.md.

### Phase 1 — Workflows, read-only

A sidebar entry listing the protocols this pharmacy runs: name, version,
on/off, what it asks, what it escalates, what it will never say. Read from
`clinicalProtocolService`, which already stores all of it.

**Why first:** it is the "upgrade what we have" half, it needs no new
clinical logic, and it makes the engine visible to the people responsible
for it. A pharmacy currently cannot answer "what is the assistant doing on
my behalf?" — this answers it.

New: one read-only route. No migration. No model calls.

### Phase 2 — Workflows, control

Enable and disable a protocol per pharmacy, with an audit entry. Versions
are respected exactly as the service already requires: retiring is not
deleting, and an old encounter keeps meaning what it meant.

**Not in scope:** editing protocol content in the dashboard. Writing
clinical question sets through a web form is a governance change, not a UI
feature, and `clinicalProtocolService`'s header is explicit that
interpretation belongs "under clinical governance this module has no part
in".

### Phase 3 — Chats, grounded

The sidebar's Chats surface. A pharmacist asks; the assistant answers from
the pharmacy's own data through the tools that already exist
(`catalogueTools.js`, patient search, the refill engine, the protocol
registry, conversation history).

Its own contract module, in the scribe's shape:
- every answer names its source, or it is not given;
- a question requiring clinical judgement is refused with a reason;
- nothing is written anywhere — this phase only reads.

### Phase 4 — Chats that propose

Actions, always as a draft a person accepts: draft a reply, start a
protocol, raise a follow-up. **It proposes; the pharmacist commits.** The
scribe's rule applies unchanged — the draft returns to the screen and is
accepted through the ordinary endpoint, so every write keeps the one writer
and the one audit trail it has today.

---

## 5. What this does NOT do

- **No second send path.** Anything reaching a patient goes through
  `sendAndRecordOutbound`, which GOLDEN-007 pins.
- **No new clinical intelligence.** Same rule `clinicalWorkflow.js` holds.
- **No protocol authoring in the browser** (phase 2 note above).
- **No agent that acts unattended.** "Agentic" here means it can use the
  tools and propose work, not that it does things while nobody is looking.
  In a pharmacy, unattended action is how somebody gets hurt.

---

## 6. What I need from you before writing code

1. **The Chats line.** Grounded-in-our-data and refusing clinical advice —
   is that the product you want? If you want it to answer clinical
   questions, say so explicitly, because that is a different feature with
   different safety work and I will plan it separately rather than drift
   into it.
2. **Order.** Phase 1 first is my recommendation: it is visible, low-risk,
   and makes the engine you already own inspectable. Chats is the exciting
   half and the one that needs the decision above settled first.
3. **Where Chats lives.** Rhazes puts Chats/Workflows as a toggle above
   everything. Ours has five modules and a command surface on Home. A
   toggle that switches the WHOLE sidebar is a big structural change; two
   entries in the rail is not. I would start with entries.
4. **Whether phase 2 includes disabling a protocol.** Switching off "fever"
   changes what happens to a real patient who messages about a fever
   tonight. I would like that to be your decision, with the audit trail
   saying who made it.

---

## 7. Honest risks

- **Chats is the first feature where a pharmacist could mistake the
  assistant for a colleague.** Grounding and refusals are what keep that
  from happening, and they have to be tested as hard as the scribe's
  absence rule was — which found a real hole on its 23rd mutation.
- **The protocol screen makes the engine look more configurable than it
  is.** Phase 1 is read-only partly for this reason: showing a version
  number invites editing it.
- **Token cost and latency are unmeasured.** This deployment's model reasons
  for seconds (8.3s measured for the scribe's four sections). A chat that
  takes eight seconds to say "we have 4 in stock" is worse than the search
  box that answers instantly, and phase 3 has to measure that before it
  ships rather than after.
