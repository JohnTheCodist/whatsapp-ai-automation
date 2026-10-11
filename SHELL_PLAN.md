# The app shell, redesigned — plan

**Status: PROPOSED. No code written.** The owner chose "the whole app shell"
after sharing a screenshot of **Rhazes.ai** and saying *"I think this
interface is more intuitive, the layout"*.

This is the largest change anyone has proposed in this repository. It touches
every screen, replaces the design system's genre, and will require amending
tests that currently pin the opposite behaviour. So it gets a plan first, the
way every module here has — `CONSULTATION_PLAN.md`, `MESSAGES_PLAN.md`,
`CARE_PROGRAM_PLAN.md` and the rest were all approved before code.

---

## 1. What is actually in the reference

Read off the screenshot rather than remembered:

| | Rhazes.ai |
|---|---|
| Sidebar | ~250px, **always open**, light. Wordmark, a segmented Chats/Workflows control, a boxed Search, then an icon+label list with generous spacing. A `TODAY` section. Upgrade + account pinned at the foot. |
| Greeting | Large — *"Afternoon, Adetiloye."* / *"One session so far today."* Two lines, the second a live count. |
| Context chips | `Link a patient` · `Add context · Share information without a reply` |
| The command | One large rounded card: *"Ask Rhazes or press +"*, a `+`, a **Transcribe** pill, a mic on the right |
| Scoping | `Sources` · `Choose space` · `Choose sites` as small pill selects |
| Modes | `Ask · Consult · Write · Medical coding · Audit · Automate · Local knowledge · Fill form` |
| Surface | Warm off-white, deep green accent, large radii, a great deal of air |

**The organising idea is COMMAND-FIRST.** You do not navigate to a screen and
fill a form. You say what you want — typed or spoken — and the product routes
it. The nav is for going back to things, not for starting them.

---

## 2. The decision this forces, stated before anything else

**This replaces `design.md`'s genre. It does not amend it.**

`design.md` is explicitly the ERPNext desk, and says so in its own first
section. The two systems disagree on nearly every axis:

```
                    design.md (today)        Rhazes (proposed)
genre               ERPNext desk             command-first AI workspace
density             dense                    airy
surface             white, pure neutral grey warm off-white
radius              8px                      ~12-16px
body / title        14px / 20px              14px / ~34px greeting
elevation           FLAT, one shadow total   soft cards
accent on buttons   FORBIDDEN                the primary button IS green
entry model         navigate to a screen     type or speak what you want
```

The accent rule is the sharpest conflict and is worth quoting, because it was
written deliberately:

> **Primary:** near-black fill… **Deliberately not emerald: keeping the accent
> off buttons is what lets it keep meaning "healthy" in a status pill two
> inches away.**

Rhazes puts deep green on its primary button. Adopting that means **emerald
stops being a clinical signal** in this product. That is not a styling
preference — `design.md` also reserves red for "a person waiting on a human",
and the semantic palette is load-bearing on a screen where a status pill can
mean somebody is deteriorating.

**Three ways through, and this is the first thing to decide:**

| | What it means |
|---|---|
| **A. Full genre swap** | Rewrite `design.md`. Emerald becomes the action colour; a NEW signal has to be chosen for "healthy" and defended. Most faithful to the screenshot, largest risk. |
| **B. Rhazes LAYOUT, house COLOUR** *(recommended)* | Take the shape — command-first, the big input, the airy spacing, the greeting, the always-open sidebar — and keep the near-black primary and the reserved semantic palette. The thing the owner called "intuitive" is the LAYOUT; they said so in those words. |
| **C. Layout on the consultation only** | What I originally recommended. Rejected by the owner. |

**B is recommended** because the owner's own sentence names the layout, and
because the semantic palette protects a clinical meaning that a colour swap
would quietly spend.

---

## 3. What does NOT transfer, and why

Worth fixing in writing now so it is not re-litigated at phase 4.

- **A SOAP note is not a chat.** `pharmacist_consultations` has a
  finalisation gate (§23): a blood-pressure review cannot be signed without an
  objective. A free-text command box cannot replace Subjective / Objective /
  Assessment / Plan — but it can replace the **entry into them**, which is the
  valuable half.
- **Rhazes' mode chips are a different product.** `Medical coding`, `Audit`,
  `Automate`, `Fill form` are its surface, not ours. Copying the row would
  produce controls that lead nowhere — the exact "placeholder tab" problem the
  record screen removed on 2026-09-26.
- **`Choose sites` / `Choose space`** are multi-tenant scoping for a product
  where a user spans organisations. Here, tenancy is the whole safety model
  (GOLDEN-001) and a *user-facing tenant picker is forbidden* — no tool schema
  may let anyone name a pharmacy.
- **The patient comes first here, and must.** Rhazes offers "Link a patient"
  as an optional chip. A clinical record in this product cannot exist without
  a patient, so the chip becomes a required step, not an optional one.

---

## 4. Phases

Each is its own change, its own tests, its own regression run. Nothing after
phase 1 starts before phase 1 is reviewed on screen.

### Phase 1 — the shell: sidebar, surface, spacing
The nav becomes always-open at ~250px with the Rhazes rhythm; the warm
surface, radii and spacing scale land as tokens. **No screen content changes
yet** — every existing screen simply sits on the new shell, which is what
makes this reviewable: one diff, one visual change, every screen comparable
before and after.

Touches `App.jsx`, `index.css`, `design.md`. **Amends** `sidebarRail.test.js`
(hover-to-open and the pinning both go — an always-open sidebar has no hover
state) and `patientRecordNav.test.js`.

### Phase 2 — Home as a command surface
The greeting with a live line, and the big input. Typing routes to the right
screen; the mic starts a consultation. Replaces `Launcher.jsx`'s module tiles.

### Phase 3 — the Consultation screen
The scribe entry becomes the single input (what I originally proposed), the
patient banner reworked, the SOAP sections kept exactly as they are.

### Phase 4 — the record-heavy screens
Patients, Medications, Conditions, Tests, Care programmes, Follow-ups,
Messages. These are tables and forms; they take the new surface and spacing
but keep their structure.

### Phase 5 — the rest
Orders, Inbox, Inventory, Requests, Billing, Setup, Website.

---

## 5. What this will cost

**24 client test files** exist and several pin the CURRENT design as an
invariant — `sidebarRail` (hover-to-open, the pin, the resting tile),
`patientRecordNav` (that the second sidebar never opens on hover),
`consultationLayout` (tones on pills, classes defined), `architecture`. These
were written deliberately and each names the failure it defends.

**They will be amended, never deleted**, and each amendment states what the
intended behaviour now is — AGENTS.md rule 2. An always-open sidebar genuinely
has no hover-open rule to pin; that is a product change, not a weakened test.

**38 screen components** exist. Phases 4 and 5 are mechanical but wide.

**Risk worth naming:** a redesign that stalls half-finished leaves the product
looking like two products. If this is started it should be finished, and the
phase order is chosen so that stopping after any phase still leaves something
coherent.

---

## 6. What I need from the owner before writing code

1. **A, B or C in §2** — the colour question. B recommended.
2. **Confirmation that the always-open sidebar replaces hover-to-open.** The
   hover behaviour and the pin were both built to the owner's own request
   (2026-10-04); the Rhazes layout has neither.
3. **Whether Home's module tiles survive.** Phase 2 replaces them with a
   command input. They were designed as the launcher and `design.md` §"Home:
   the module launcher" describes them.

---

## 7. Decided, 2026-10-11

| Question | Answer |
|---|---|
| §2 colour | **B — Rhazes LAYOUT, house COLOUR.** The near-black primary stays; emerald keeps meaning "healthy" and red keeps meaning a person is waiting on a human. The shape is what changes. |
| Sidebar | **Always open, hover-to-open and the pin both removed.** |
| Home | **Module tiles replaced** by the greeting and the command input (phase 2). |

The colour answer settles the sharpest conflict in §2: the semantic palette is
**not** spent. `design.md`'s "Semantic colour is NOT the accent" section
survives intact, and so does the CTA rule. What is being replaced is the
genre's SHAPE — density, surface, radius, type scale and the entry model.

**That makes phase 1 smaller and safer than §5 feared.** No clinical screen
changes meaning; the tones a pharmacist has learned keep their colours. The
risk concentrates in layout, which is reviewable on screen.

---

## 8. Phase 2 shipped, 2026-10-11

Home is a greeting, the one line that needs a person, and one input.

**What typing does, which is the decision that matters.** It searches this
pharmacy's **patients** and this app's **screens**, and nothing else. It is
not an assistant prompt. A large box on a clinical product invites a clinical
question, and one that implies it will answer and then does not is worse than
one that never implied it — so the placeholder says what it searches, and a
test pins it against `ask` / `anything` / `assistant` / `chat`.

**No microphone on Home**, though the reference has one. A recording needs a
consultation to belong to and a consent recorded against it (0071), neither
of which exists until a patient is chosen — so a mic here could only ask for
a patient first, which is what the input already does. It would be a second
route to the same place dressed as a shortcut.

**Removing the tiles did not remove the figures.** Every live line they
carried is in one quiet row under the input, except the clinic one, which is
the headline above it. The tiles gave all five equal weight, so "no orders
waiting" sat at the same size as somebody waiting for a pharmacist; now the
second line is reserved for the thing with a cost.

`launcher.test.jsx` (10 tests) became `homeCommand.test.jsx` (8), keeping the
two rules worth keeping: no figure claimed before it is known, and a waiting
patient is the only red line. `Launcher.jsx` was deleted rather than left as
a file that renders what it replaced.

**A correction worth recording.** Earlier in this work it was stated that
this project has no React render-testing infrastructure. **It does** —
`launcher.test.jsx` rendered components with `react-dom/server`'s
`renderToStaticMarkup`, which needs no jsdom and runs in the node
environment the config sets. The new tests use the same technique.

### Still to come

| | |
|---|---|
| phase 3 | the Consultation screen — the scribe entry becomes one input |
| phase 4 | Patients, Medications, Conditions, Tests, Care programmes, Follow-ups, Messages |
| phase 5 | Orders, Inbox, Inventory, Requests, Billing, Setup, Website |
