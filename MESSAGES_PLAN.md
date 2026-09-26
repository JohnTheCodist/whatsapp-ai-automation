# Messages — architecture plan

**Status: phases 1–3 built (§12, §13, §14). Outreach (§15) not built — it needs its own decision.**
Brief: the owner's 39-section Messages brief, 2026-09-25.
House rules: `AGENTS.md`, `design.md`, GOLDEN-001. Built in the pattern of
Allergies (0058), Conditions (0059), Tests (0060), Care programmes (0061) and
Follow-ups (0062).

**This module is different from the five above in one way that changes
everything: the thing the brief asks for already exists, and it is the oldest
and most load-bearing part of this product.** The other modules started from an
empty tab. This one starts from a live WhatsApp system carrying real patients'
messages, with five migrations of incident history defending its invariants.

So the risk here is not "will the feature work". It is **"will building the
screen break the thing the screen is about"** — and §36 of the brief says
exactly that: do not create a second copy of the messages.

---

## 1. What already exists

| Thing | Where | Matters because |
|---|---|---|
| **`conversations`** | `0001_init` + 0023/0024/0025/0027 | `status` (open/closed), `mode` (bot/human), `workflow_state` (6 values incl. **`archived`**), `assigned_to`, `summary`, `context`, `last_message_at`, `window_expires_at`. §19's archive and §20's states are **already built** |
| **`messages`** | `0001_init` | `direction`, **`author` (customer / assistant / staff / system)**, `body`, `media_url`, `provider_message_id`, `delivery_status` (queued/sent/delivered/read/failed/undelivered), `intent`. §8 and §11 are already modelled |
| **One open conversation per customer** | `idx_conversations_one_open ... where status = 'open'` (0025) | **The central conflict. See §2.** |
| **A full staff inbox API** | `routes/conversations.js` — list, get, takeover, reply, release, resolve, **archive**, differential, clinical-brief | §4–§7, §19 and §20 are largely a patient-scoped view of this, not new work |
| **The staff inbox screen** | `client/src/Inbox.jsx` (404 lines, **no tests**) | The transcript, the conversation list and the composer all exist. §32's "do not build a social chat app" is already the house style |
| **One send path** | `outboundMessage.sendAndRecordOutbound` | Takes `author`, `category`, records the message. Nothing else may send |
| **A send policy** | `whatsapp/communicationPolicy.js` — TRANSACTIONAL / ORDER_NOTIFICATION / MEDICATION_RELATED / MARKETING / staff alert | §15's "New Message" must route through this. **See §3** |
| **A 24-hour reply window** | `REPLY_WINDOW_HOURS = 24`, `conversations.window_expires_at` | Free-form sends outside it are restricted by the provider |
| **Message + conversation event types** | `patientEventTypes.js` — `MESSAGE_RECEIVED`, `MESSAGE_SENT`, `CONVERSATION_STARTED`, `CONVERSATION_RESOLVED`, `CONVERSATION_STATE_CHANGED` | §31's audit vocabulary exists. The file is a tripwire — 20 modules import it |
| **A record-pointer helper** | `clinical/clinicalRefs.js` — `assertRecord` / `describeRecord`, kinds: vitals, test, medication, condition, medication_review, care_program, consultation | §13 is this, plus `followup`. Built for exactly this shape in 0062 |
| **A link-table precedent** | `care_program_links` (0061), `patient_tasks.source_type/source_id` (0062) | §13 and §35's `relatedResourceType/Id` have a house pattern already |
| **The Messages tab is a placeholder** | `patientRecordTabs.js:45` — `built: false` | Building it **replaces no behaviour** — the same clean position as Clinic→Care program and Encounters→Follow-up |
| **A Messages card on the summary** | `patientSummaryModel.js` — counts conversations, flags open ones | §28 already half-exists; it needs unread, which does not exist |
| **No read/unread state anywhere** | — | §17 is genuinely new. See §5 |
| **No topic column** | — | §12 is genuinely new |
| **No internal staff↔staff messaging** | — | §14 is genuinely new, and is the part with the sharpest safety edge |
| **No appointments table** | — | §24 and §39's "view related Appointment" have nothing to point at |
| **No private file store** | only the **public** `pharmacy-assets` bucket | §21's attachments. Tests (0060) hit this exact wall and deferred |

---

## 2. The central decision: one open conversation, or several

**§5 of the brief shows three ACTIVE conversations for one patient** —
Medication Review, Blood Pressure Follow-up, Appointment — at the same time.

This product forbids that, on purpose, in an index:

```sql
create unique index idx_conversations_one_open
  on conversations (customer_id) where status = 'open';
```

It is not an accident and it is not stale. It has been fixed *toward* this
meaning twice (0023 segmented conversations into sessions; 0025 repointed the
index at `status` after `mode` stopped carrying closure), and 0025's own
comment says plainly: *"The invariant itself is worth keeping: without it, two
messages arriving together can still create two conversations for one
customer."*

**And the last time something asked for a second open thread, it dropped a
live patient's messages for three days.** From `AGENTS.md`:

> Every inbound WhatsApp message from one live patient had been dropped for
> three days — 16 of them — by a deadlock between the one-open-conversation
> index, the sweep's correct refusal to close a thread awaiting a pharmacist,
> and a policy branch that asked for a second open thread anyway.

So §5 cannot be built as drawn without re-opening that incident. Three ways
out:

**(a) A conversation is a session; the Messages list shows sessions.**
0023 already segments a patient's history into threads. At most one is open;
the rest are closed and are the archive. The brief's "3 active conversations"
becomes "1 active, N in history" — honest, and no index changes.
*Topic becomes a label on a session, not a reason to have several.*

**(b) Allow several open threads per patient.**
Requires dropping or re-scoping the index, and teaching the WhatsApp ingest
which of several open threads an inbound message belongs to. **There is no
signal to decide that with** — a WhatsApp message arrives with a phone number,
not a topic. This is the option that reproduces the incident.

**(c) (a) for WhatsApp, plus separate INTERNAL threads.**
Internal threads never touch WhatsApp, so they cannot confuse the ingest. The
index is re-scoped to patient-facing threads only, which is a *narrowing* of
where it applies, not a removal.

**Recommendation: (c) — which is (a) plus §14.** One patient-facing thread at a
time, its history segmented into sessions with topics; internal threads
alongside, unlimited, and physically unable to reach a patient.

> **This is question 1 for the owner.** It changes what the screen looks like:
> under (c) the "Active" list usually has exactly one patient conversation in
> it, and the brief's mock has three.

---

## 3. The second decision: may staff start a conversation?

§4 and §15 put a **`+ New Message`** button at the top and a channel picker
under it. Two things in this system say "not like that":

1. **The product is reactive by design.** `staffAlert.js`, the one place that
   initiates contact, says so in its header: *"Everything else here is
   strictly reactive — every message ever sent is a reply to someone who wrote
   first, and that fact is what the whole channel risk argument rests on."*
   That is a WhatsApp-ban argument, not a style preference.
2. **The 24-hour window.** Outside `window_expires_at`, a free-form message is
   restricted by the provider. A composer that lets staff type and press Send
   will produce failures that look like the product is broken.

But §9 and `communicationPolicy` already describe the legitimate version: a
proactive message that **declares a category** (transactional / order /
medication-related / marketing), is checked against the patient's own
preferences and opt-outs, and is refused with a reason when it may not go.

**Recommendation.** Build `+ New Message`, but as the policy already defines
it, not as a blank box:

- it declares a category (default **medication-related**, the clinical one);
- it is checked by `communicationPolicy` before anything is sent;
- **outside the 24h window, the button says so before you type** — "Jane last
  wrote 3 days ago; a new WhatsApp message may not be delivered" — rather than
  failing after;
- if WhatsApp is not connected it is disabled with the existing
  `NOT_CONNECTED` wording;
- **internal** messages bypass all of this, because they never leave RxMax.

> **Question 2 for the owner:** is patient-facing outreach in scope at all for
> this pass, or is v1 "reply to what the patient started, plus internal
> threads"? The second is smaller, safer, and covers most of §39.

---

## 4. The third decision: internal conversations

§14 is the sharpest section in the brief — *"Internal messages must never
become visible to the patient"* — and it is the one thing here with no
existing implementation at all.

The danger is concrete: every send path in this repo ends at
`sendAndRecordOutbound`, and a conversation row is a conversation row. If an
internal thread is just `conversations` with a flag, then one missing `where`
clause sends a pharmacist's private note about a patient **to that patient**.

**The guarantee must be structural, not a flag that someone remembers to
check.** Proposed:

- `conversations.channel` (`whatsapp` | `internal`, default `whatsapp`).
- **A CHECK that an internal conversation has no provider identity**, and the
  send path refuses `channel <> 'whatsapp'` *before* it looks at anything
  else — the same shape as GOLDEN-001's "guard before you query".
- A golden test asserting the invariant structurally: **no code path can pass
  an internal conversation to a WhatsApp send**, in the way GOLDEN-001 asserts
  no tool schema lets the model name a tenant.

That golden entry is the single most valuable test in this module.

---

## 5. What is new, and what is only a view

| Brief section | Verdict |
|---|---|
| §5 conversation list, §6 transcript, §7 composer, §19 archive, §20 states | **A patient-scoped view** of `routes/conversations.js`. New screen, no new concepts |
| §8 delivery states, §11 AI vs pharmacist, §36 one message store | **Already true.** `author` and `delivery_status` carry both |
| §12 topics | **New column** `conversations.topic` |
| §13 clinical links | **New table** `conversation_links`, modelled on `care_program_links`, resolved by `clinicalRefs` (+ a `followup` kind) |
| §14 internal | **New**, see §4 |
| §17 unread | **New.** Proposed: a per-user, per-conversation `last_read_at` marker rather than a flag on every message — cheap, and honest, because "unread" is *unread by you*, not a property of the message |
| §18 search | `ILIKE` scoped to one patient's messages. **No full-text index** — §18 says not to build one before the scale needs it, and the scale does not |
| §23 create follow-up from a conversation | **Explicit action, prefilled**, exactly the pattern follow-ups phase 2 built for the medication review: *the system offers, a pharmacist presses* |
| §28 overview card | Extend the existing Messages card with unread |
| §30 permissions | Roles are `owner` / `pharmacist` / `staff`. Proposed: everyone may see patient-facing threads (they already see the inbox); **internal threads are owner/pharmacist** |

---

## 6. What this change will NOT build, and why

Declared here rather than discovered later:

- **Appointments (§24, §39).** There is no appointments table and the brief
  (§37) forbids inventing clinical modules sideways. "View related
  Appointment" has nothing to point at. *Out of scope, stated on screen as
  nothing rather than as an empty section.*
- **Attachments (§21).** The only file store is the **public**
  `pharmacy-assets` bucket. A patient's message attachment cannot live at a
  guessable public URL. Tests (0060) hit this same wall and deferred it to a
  private-bucket pass; this does the same. *Inbound `media_url` that WhatsApp
  already gave us is displayed — that is existing data, not new storage.*
- **SMS / Email / Patient Portal (§9).** Modelled in the `channel` column,
  **not built** — §9 says use the channels RxMax actually supports, and §15
  says never offer a channel that is not available for that patient.
- **A second notification service (§29).** Reuse what exists.
- **Editing messages (§31).** Nothing in this product edits a sent message and
  nothing should start; §31's "do not silently rewrite historical messages" is
  satisfied by not having the feature.

---

## 7. Risks

1. **The ingest path is live.** Any change to `conversations` touches the code
   that receives real patients' WhatsApp messages. Mitigation: the migration is
   additive only (new nullable columns, a new table); no existing column
   changes meaning; the ingest is not edited in phase 1.
2. **`patientEventTypes.js` has 20 dependents.** Additions only.
3. **Re-using `Inbox.jsx`.** Extracting its transcript into a shared component
   is the right call (§1's "do not introduce another messaging framework"), but
   it is a *move*, and AGENTS.md forbids a diff that both moves and changes.
   Mitigation: the extraction is its own step, with no behaviour change, and
   **Inbox.jsx currently has no tests** — so characterisation tests come first.
4. **The one-open index** — §2.
5. **The internal/patient-facing boundary** — §4.

---

## 8. Tests (the brief's §38, mapped)

Database-free wherever possible, per the house preference:

- **`conversationInput`** — topic vocabulary, conversation type, the link
  contract (a kind and an id, never a copy of what the record says), the
  category a new message must declare, and the rule that an internal
  conversation can carry no provider identity.
- **`messages` (database)** — cross-tenant refusal on every read and write;
  a patient's threads scoped to that patient; unread counted per user; archive
  keeping the row; the links resolving through `clinicalRefs` and another
  patient's record refused; the role rule on internal threads.
- **GOLDEN-007** — *an internal conversation cannot reach a WhatsApp send.*
  Structural, no database, never skips.

---

## 9. Phasing

1. **Phase 1 — the patient's communication history.** The Messages section:
   sessions, transcript, topics, archive, reply into an open thread. Read and
   reply only; no new conversations, no internal threads.
2. **Phase 2 — the connections.** Clinical links (§13), "create follow-up from
   a conversation" (§23), the summary card and unread (§17, §28).
3. **Phase 3 — internal threads (§14)** and, if approved, proactive
   `+ New Message` (§15) behind `communicationPolicy`.

Internal messaging is deliberately last: it is the only part that can send a
private note to a patient if it is wrong, and it should be built when the rest
is stable and its golden test is the only thing standing between the two.

---

## 10. Questions for the owner

1. **§2 — one open patient conversation, or several?** Recommendation: one
   (plus internal threads). The brief's three-active mock is the thing at
   stake.
2. **§3 — is staff-initiated outreach in scope now?** Recommendation: not in
   phase 1. Reply-only covers most of §39 and risks nothing.
3. **§30 — who sees internal threads?** Recommendation: owner + pharmacist.
4. **§21 — confirm attachments are deferred** with Tests, pending a private
   bucket.
5. **§17 — is "unread" per user, or per pharmacy?** Recommendation: per user.
   Per pharmacy means one person opening a thread marks it read for everyone.

---

## 11. Decisions — answered by the owner, 2026-09-25

**1. One open patient conversation; history is sessions.** As §2 recommended.
The "Active" list holds at most one patient-facing thread; everything earlier
is a closed session carrying its own topic. `idx_conversations_one_open` is
NOT touched, the WhatsApp ingest is NOT touched, and the brief's three-active
mock becomes one active plus history — which is the true shape of this
patient's communication, not a compromise.

**2. No staff-initiated outreach in phase 1.** As §3 recommended. Staff reply
into threads the patient started. `+ New Message` is not built; the button is
not shown rather than shown-and-disabled, because a button that never works is
worse than no button. Revisit once the rest is stable.

**3. Internal threads are visible to everyone in the pharmacy — owner,
pharmacist AND staff (owner's decision).** This is the one answer that goes
against the brief: §30 says *"A staff member authorized to see patient data
should not automatically see every internal conversation."* The owner chose the
simpler rule, and it is recorded here so the next person reads a decision
rather than an oversight.

**What this does and does not change.** It changes who can READ an internal
thread. It changes nothing about the guarantee in §4 — an internal
conversation still cannot reach a patient, because that is structural, not a
permission. The two are independent, and the safety-critical one is unaffected:
GOLDEN-007 is still the test that matters, and it is still written.

**4. Unread is per user.** As §5 recommended. A `last_read_at` marker per user
per conversation; "unread" means unread by you, and one pharmacist opening a
thread does not clear the badge for the colleague who was about to answer it.

**5. Attachments are deferred**, with Tests (0060), pending a private bucket.
Inbound `media_url` that WhatsApp already stored is displayed; no new file
storage is created. Not contradicted at review.

---

## 12. Phase 1 — built 2026-09-25

**The patient's communication history.** `patientRecordTabs.js`'s Messages
entry was `built: false` and had never had a screen, so giving it one replaced
no behaviour.

**It is a VIEW, and that is the whole design.** `conversations` and `messages`
are from 0001 and carry every live patient's WhatsApp traffic. This section
reads them scoped to one patient and writes exactly one thing: a topic label.

| | |
|---|---|
| `0063_conversation_topics.sql` | `topic` (10 values, **no default**), `topic_set_at`, `topic_set_by`, one index |
| `services/messaging/messageInput.js` | the contract: topics, filters, authors, delivery states, capabilities |
| `services/messaging/patientMessages.js` | list · transcript · set topic · summary. Exports nothing matching `/send\|reply\|create\|start/` |
| `routes/patientMessages.js` | `GET /messages`, `GET /messages/:id`, `PUT /messages/:id/topic`, `GET /messages/options` |
| `client/src/messageFormat.js` | every sentence the screen says |
| `client/src/PatientMessages.jsx` | the list, the transcript, the topic picker, the reply box |

**Replying and archiving are NOT here.** The screen posts to
`/api/conversations/:id/reply`, the one send path, which checks the WhatsApp
connection, declares a category to `communicationPolicy` and resets the handoff
clock. A DB test asserts this module exports no way to send.

**No default topic.** Every conversation predating 0063 arrived before topics
existed; `general` would be this product inventing an answer about thousands of
real threads. The screen says **Not labelled**, and a label can be removed
again.

**Amber, not red.** A thread waiting on a pharmacist IS a person waiting on a
human — which is what design.md gives red to — but the same line says *"Only
Consultations earns it"*. A second screen claiming the strongest colour is how
red stops meaning anything.

### Three bugs this phase surfaced

1. **The shared column list was aliased** (`c.id, c.status, …`) and reused
   inside an `UPDATE … RETURNING`, where no alias exists. Postgres: *"missing
   FROM-clause entry for table c"*. Caught on the first test run.
2. **A test helper wrote a closed conversation with `workflow_state = 'open'`**,
   which 0024's `conversations_workflow_matches_status` CHECK refused — the
   constraint doing exactly its job.
3. **`recordEvent`'s default idempotency key silently discarded a patient's
   second relabel.** The default is `eventType:entityType:entityId`, which is
   right when the entity itself is the uniqueness — a conversation is *started*
   once. A topic is a judgement that can be revised, so the history showed one
   change where two had happened. It now passes an explicit key. **This one
   would have quietly lost part of a patient's record.**

And a fourth, found in the browser: `topic_set_by` is a foreign key to
`auth.users`, and DEV_AUTH_BYPASS's all-zeros id is not a row there, so the
whole write 500'd. `routes/followups.js` had already solved this; the same
`actor(req)` helper is now used here.

### Tests

**23 server — 10 database-free** (`messageInput`) **and 13 needing a database**
(`patientMessages`), plus **12 client** (`messageFormat`). Measured
**2022/1364/651/7** with no test database and **2022/2017/0/5** with one; the
7 and the 5 are the known names. Skipped ceiling 638 → 651.
`patientRecordTabs.test.js`'s built list gains `messages`, with the reason in a
comment — the rule it pins is unchanged.

### Verified in the browser

Against the local demo database, on three states: a patient with an open thread
(counts, the transcript with **Assistant** labelled as itself, the failed
message reading **Not delivered**, the patient's own message carrying no
delivery claim, day headings on the Lagos clock, and a topic that saves and
appears in the list); the **History** filter showing the closed thread with its
label; and a patient with nothing, reading **"No messages"** rather than "No
active conversations".

The demo database had no conversations at all, so a small seed was written to
`local-run/seed-messages.js` — **outside the repo, refusing any host that is not
127.0.0.1/rxnaija_dev**. Demo data in a demo database; nothing was written
anywhere else.

### Phase 2 next

Built — see §13.

---

## 13. Phase 2 — built 2026-09-26

**The connections.** What a conversation was about (§13), unread per person
(§17), a follow-up raised from what a patient said (§23), and the summary card
(§28).

| | |
|---|---|
| `0064_conversation_links_and_reads.sql` | `conversation_links` (kind + id + note, nothing else), `conversation_read_marks` (one row per conversation per user) |
| `0065_followup_from_conversation.sql` | widens `patient_tasks_source_type` to accept `conversation` — a different module's vocabulary, so its own migration |
| `clinical/clinicalRefs.js` | gains `followup` and `conversation` kinds |
| `clinical/followupInput.js` | gains `conversation` as a source that names a record |
| `messaging/messageInput.js` | the link contract |
| `messaging/patientMessages.js` | links, unread, read marks |
| `client/src/patientSummaryModel.js` | `messagesCard` replaces the inline one |

**Nothing was added to `conversations` or `messages`.** Those tables carry live
WhatsApp traffic; 0063 gave them one nullable column and this phase gives them
none.

### The three decisions inside this phase

**A link is a pointer, and the test says so structurally.** The label comes from
the section that owns the record, on every read, so a dose changed in
Medications shows in the conversation next time it is opened. The invariant is
asserted as a COLUMN LIST — the table has nowhere to put a clinical value —
rather than by hunting for a number in a row.

**Unread is per reader.** A flag on the message would let the first pharmacist
to open a thread clear the badge for the colleague who was about to answer it,
and that colleague would never learn the patient was waiting. Counted on read
from each person's own mark; no counter to drift, no backfill, and a reader with
no row has read nothing, which is correct.

**Nothing is marked read by reading.** §17 is explicit. Listing, opening the
transcript and loading the summary all leave the mark alone — a test asserts all
three write no row — and the mark is a POST from a screen that has actually
rendered the transcript.

### Two tests that were wrong, and what replaced them

1. **A test that would have passed on nothing.** To prove no reading had been
   copied into a link row, it searched the serialised row for `148`. A uuid
   contains three-digit runs by chance, so it failed spuriously — and it would
   have proved nothing had it passed. It now asserts `conversation_links`'
   column list.
2. **An exact assertion that had to grow, not relax.** `patientMessages.test.js`'s
   "a patient has at most ONE active thread" pins the counts object with
   `deepEqual`; phase 2 gave it two unread keys, so the expectation gained them
   and stayed exact. The rule it pins is unchanged, with the reason in a comment.

### Tests

**17 server — 5 database-free** (`messageInput`) **and 12 needing a database**
(`patientMessages`), plus **8 client** (5 in `messageFormat.test.js`, 3 in
`patientSummaryModel.test.js`). Measured **2039/1369/663/7** with no test
database and **2039/2034/0/5** with one; the 7 and the 5 are the known names.
Skipped ceiling 651 → 663. Client 266/266.

The per-reader rule was checked by mutation: making the read mark pharmacy-wide
turned "unread is PER READER" red, and restoring it turned it green.

### Verified in the browser

Against the local demo database: the **Related records** panel with all eight
kinds; attaching a vitals reading, whose label came from the Vitals section and
not from anything Messages stored; **Detach** removing the link while the
reading survived in `patient_vitals`; **Create follow-up from this conversation**
producing a real follow-up with `source_type = 'conversation'` pointing back at
the thread; the audit event carrying a kind and an id and no clinical value; and
the summary card reading **"1 waiting for a pharmacist · Nothing unread · Last
25 Sept 2026"** — the waiting flag outranking unread, and "Nothing unread"
rather than "No messages".

**The unread badge could not be seen in the browser, and that is by design.**
`DEV_AUTH_BYPASS` supplies the all-zeros sentinel id, which `readerId` correctly
maps to null, so every unread count is 0 locally. The path was exercised instead
by calling the service against the demo database with a real user: the owner saw
2 unread, marking one thread read left 1, and a second reader still saw 2 —
untouched.

**The date rolled from the 25th to the 26th mid-phase**, which incidentally
confirmed the Lagos-day headings: the seeded messages moved from "Today" to
"Yesterday" and "24 Sept 2026" without a code change.

### Phase 3 next

Built — see §14.

---

## 14. Phase 3 — built 2026-09-26

**Internal threads (§14).** Staff-to-staff discussion about a patient, which
**cannot reach that patient**. Plus GOLDEN-007 — the first entry in the golden
suite written WITH a feature rather than after an incident.

| | |
|---|---|
| `0066_internal_threads.sql` | `conversations.channel`, the internal CHECKs, the narrowed one-open index, `messages.direction = 'internal'`, `messages.author_user_id` |
| `whatsapp/outboundMessage.js` | the guard — reads the channel, refuses before consent and before the transport |
| `tests/golden.test.js` | GOLDEN-007a–d |
| `messaging/patientMessages.js` | `createInternalThread`, `addInternalNote`, `getInternalThread`, channel-scoped reads |

### The guarantee, and why it is built this way

Every outbound message ends at one function, and a conversation row is a
conversation row. An internal thread distinguished only by a flag is one
missing `WHERE` clause away from delivering a pharmacist's private clinical
discussion to the person being discussed. Three things must all fail first:

1. **A different KIND of row** — `conversations.channel`, not a flag.
2. **Nowhere to record it as sent** — an internal message cannot hold a
   provider id, a delivery status or a category; an internal conversation
   cannot hold a reply window or sit in `mode = 'bot'` for the assistant to
   answer. Violations are constraint errors, not messages on a phone.
3. **The guard in the one send path**, asserted by GOLDEN-007 to exist AND to
   run before both the consent check and the transport.

**Checked before building it:** the assistant loads history as
`select direction, body from messages where conversation_id = ...`
(`worker.js`). Scoped BY CONVERSATION — so an internal note, being its own
conversation, is never in the set rather than filtered out of it. That is what
made one message store safe, and a test runs the worker's own query shape
against real rows.

**The one-open index was NARROWED, never weakened.** It now reads
`where status = 'open' and channel = 'whatsapp'`. Every existing row is
`whatsapp`, so it matches exactly the same set as before. A test asserts both
halves: internal threads do not collide, **and** a second open WhatsApp thread
is still refused with 23505 — the invariant whose violation dropped 16 live
messages for three days.

### What GOLDEN-007 found while it was being written

Its first draft asserted `outboundMessage.js` is the **only** caller of the
transport. That is false: `worker.js`, `routes/orders.js`, `routes/whatsapp.js`
and `staffAlert.js` all call `sessionManager.sendText` directly. Each is
legitimate, and for the same reason — they fire only where there is **no
conversation** (the `else` of `if (target.conversation_id)`), or they message
the pharmacy's own number.

So the real invariant is not "one caller" but **every send that NAMES a
conversation goes through the one path**. The test pins that caller list closed
and asserts both branchers still route a conversation-bearing send through the
guard. A fifth caller has to justify itself.

Two of its own drafts were also wrong, both caught by running it: a regex for
the function body stopped at the destructured parameter list's `\n})` and
captured the ARGUMENTS; and `fs` was used without the per-test `require` this
file uses.

**The guard was then mutation-checked twice** — removed entirely (2 golden
tests red) and moved to AFTER the transport (007a red on its ordering
assertion). Both restored.

### Wording, because this section is about not blurring two things

An internal thread borrowed two patient-facing phrases and both were wrong:
the row said **"A person is replying"** (that is about who answers the
*patient*) and the header said **"Last contact"** (an internal thread contacts
nobody). Found by looking at the screen; fixed, with a test that also pins that
the channel decides the words even if the row carries the patient-facing flags.

### Tests

**17 server — 7 database-free** (`messageInput` 3, **GOLDEN-007** 4) **and 10
needing a database** (`patientMessages`), plus **4 client**. Measured
**2056/1376/673/7** with no test database and **2056/2051/0/5** with one.
Skipped ceiling 663 → 673. Client 270/270.

**Three existing tests changed with the product, none relaxed** — and one was
**tightened**: "reading a patient's messages creates nothing and sends nothing"
went from "no export matches `send|reply|create|start`" to "nothing matches
`send|reply`, and the only creator is `createInternalThread`".

### Verified in the browser

Starting a thread, the banner **"Internal — the patient cannot see this"**,
notes in order with their authors, a second note added, and the thread **not**
appearing in the patient-facing view or its counts. Then, against the demo
database, the guard on real rows:

```
internal thread  -> refused: INTERNAL_THREAD
unknown thread   -> refused: INTERNAL_THREAD   (fails closed)
patient thread   -> reached the transport      (so it is not refusing everything)
```

That third line is the one that makes the first two mean something.

**One honest gap:** `POST /api/conversations/:id/reply` with the internal
thread returned `NOT_CONNECTED`, because the route checks the WhatsApp
connection *before* calling the send path, and WhatsApp is not connected
locally. The refusal was real but for the wrong reason, so the guard was
exercised directly instead, as above.

### Not built

**Outreach (§15).** `canStartConversation` is still false and a test pins it.
An internal thread is not outreach — it never leaves the pharmacy. Starting a
conversation with a *patient* remains the one thing this product does not do,
and needs its own decision.

### Also surfaced, and not fixed here

`medications.test.js`'s "an edit changes what it names and leaves the rest of
the record alone" fails ~1 run in 6. `addMedication` lets `updated_at` default
to the database's `now()`; `updateMedication` sets it from Node's `new Date()`.
Two clocks for one column, so a clinical record's last-updated time can move
backwards. Nothing in Messages touches medications — it was exposed by running
the suite. Deliberately absent from `test-baseline.json`, and it has its own
task.
