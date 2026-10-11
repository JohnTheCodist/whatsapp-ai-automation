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

---

## 9. Phase 3 shipped, 2026-10-11

**The consultation entry is one box, not a choice.**

Two cards asking *"how do you want to write this up?"* became a textarea with
**Record** on it. The reason the reference reads as intuitive is that it asks
nothing — it puts the thing you would use right there, with the microphone on
it.

**The box IS the Subjective field**, promoted to the top of the note, and the
editable Subjective section below it is gone. Two boxes for one value is how
a pharmacist loses a sentence: both read `note.subjective`, both agree, and
somebody still has to work out which one to type in.

A **finalised** note keeps a Subjective section as a read-back. The box only
renders while the note is open, and a disabled textarea looks like something
you could still type in.

Verified on the running screen: typing writes `note.subjective`, focus opens
all twelve sections, and there is no Subjective heading in the list.

**Two tests from that same morning were amended.** They pinned that choosing
to type rendered something different from the chooser — written after the
owner reported that pressing "Type it" did nothing, which it did. There is no
chooser now, so that bug cannot recur. What is pinned instead is that the
chooser never comes back, that the box is a real textarea rather than a
button dressed as one, and that Record still routes through consent.

### Still to come

| | |
|---|---|
| phase 5 | Orders, Inbox, Inventory, Requests, Billing, Setup, Website |

---

## 10. Phase 4 shipped, 2026-10-11

**It was not the phase that was planned, and the plan was wrong rather than
the work.**

Section 4 said phase 4 would be *"mechanical and wide"* — seven screens
taking the new surface and spacing without changing structure. Opened on the
new shell and measured, they already had it: the warm page is a global token
they inherited in phase 1, the record nav is already 12px, and the Meds
section already has two rounded containers on it. Restyling seven screens
against no named defect would have been a wide diff that fixed nothing.

**What was actually wrong was the chrome, and it was wrong about the
patient.** Standing in Ngozi Okafor’s medication record:

```
breadcrumb   Patients / All patients
heading      Patients
subtitle     View all your customers’ details
```

All three describe the screen you left. On a clinical record the name at the
top is the thing a pharmacist checks before acting, and this named the wrong
subject in three places at once.

**Shipped in two parts, and the second one exists because the first was not
finished.** `a932d33` fixed the heading and the breadcrumb and left the
subtitle — the same lie, one line lower, on all nine sections of the record.
It also shipped with **no test**, which AGENTS.md forbids, so the second
commit carries the tests for both.

**The subtitle is ABSENT on a record, not replaced.** Everything a subtitle
could honestly say there is already on the screen and said better: the
record nav highlights the section, the identity card carries age, sex and
number, and the allergy banner carries the one fact worth reading before
acting. A fourth copy would be noise. The element is not rendered rather
than rendered empty, because an empty line reads as something that failed
to load.

**The guard that makes that safe is its own test.** `pageSubtitle` is
nullable now, so a screen that lost its `SUBTITLE` entry would quietly
render nothing and look deliberate. Every screen the sidebar can open is
asserted to have one, against `modules.js` rather than a fixture — so the
only thing the condition can suppress is the case it was written for.

**Verified on the running screen**, both directions: the record shows
"Ngozi Okafor" in the heading and the breadcrumb with no subtitle beneath
it, across all nine sections; going back to the list restores "Patients" and
"All patients" with its own subtitle, which is true. The first commit said
plainly that it had not been seen, and it had not.

**Nine mutations, nine of the right tests red.**

---

## 11. Phase 5 shipped, 2026-10-11

**Opened before being planned, which phase 4 argued for.** Every screen in
this phase was measured first. The plan again said "mechanical and wide —
tables and forms taking the new surface and spacing"; again that was not
what was wrong.

### What the sweep found

Thirteen screens, read for what their chrome and their empty states claim:

```
screen        page title      first card heading        verdict
-------------------------------------------------------------------
Orders        Orders          Orders                    says its name twice
Inbox         Inbox           Inbox                     says its name twice
Stock sync    Stock sync      Stock sync                says its name twice
Catalogue     Catalogue       Your catalogue            NO EMPTY STATE
Requests      Requests        Customers waiting on you  fine
Overview      Overview        At a glance               fine
Billing       Billing         Pilot — monthly           fine
Setup         (its own)       Assistant identity        excluded already
```

**Two things the sweep ruled OUT, which is half its value.**

- **The Inbox has no phase-4 defect.** It is a two-pane layout: opening a
  conversation leaves the list on screen, so the chrome never has a second
  subject to name. Applying phase 4’s fix there would have been a change
  with no defect behind it.
- **Stock sync must KEEP its repeated heading.** `CatalogueSync.jsx` has two
  importers — the Stock sync tab AND `Settings.jsx`, where the page is
  titled something else entirely and that heading is the only thing naming
  the panel. Removing it would have fixed one screen and orphaned another.

### The defect that was worth the change

**The Catalogue had no empty state at all.** The product list rendered
behind `products?.products?.length > 0` with no `else`, so a pharmacy with
nothing in its catalogue opened the screen and found a price switch in an
empty box: no sentence, no next step.

That is **every pharmacy on its first day**, on the one screen this product
cannot work without — the assistant sells out of the catalogue and out of
nowhere else. The dev pharmacy used to measure this is `status:
"onboarding"` with 0 products, which is exactly the state being described.

**Its three siblings all do it correctly**, which is what made the Catalogue
an outlier rather than a house style: Orders says *"No orders yet"* AND
*"Nothing waiting"* and means different things by them; the Inbox says *"No
conversations yet"* AND *"Nothing in this view"*; Requests says *"Nothing
waiting"*.

**THE TWO BLANK SCREENS WERE NOT THE SAME BLANK SCREEN**, and that is why
this is a module rather than a ternary:

```
products: []     nobody has uploaded anything     -> say so, and how
the read FAILED  we do not know what is in there  -> never say "none"
```

Both rendered as nothing. Telling a pharmacy owner "no products" when the
request actually failed sends them to upload a catalogue that is already
there. It is the allergy card’s distinction (0058) and the care-programme
card’s, applied to stock instead of a patient — and `catalogueState` checks
`listStale` BEFORE emptiness so it fails closed, which is GOLDEN-002c’s rule
that "we could not tell" is never "there is nothing there".

**Loading is a third state and says nothing.** A screen that flashes "No
products yet" on its way to showing four hundred of them has told the reader
something false — briefly is still false, and it is the moment somebody
reaches for the Upload button.

**`onNavigate` was not invented for this.** `App.jsx` already passes
`onNavigate={setTab}` to five components; the Catalogue became the sixth. The
empty state offers a button rather than the sentence "see Upload in the
sidebar", because the next step is a screen in this app.

### Verified on the running screen

All four states, live, not inferred:

- **empty** — "No products yet" with a working **Upload a catalogue** button
  that lands on the Upload tab and moves the URL with it;
- **failed** — forced by making `/products` reject: "The catalogue could not
  be loaded / That is this page failing to read it, not the catalogue being
  empty", and the counts line correctly disappears with it;
- **Try again** — recovers to the empty state;
- **no leak** — the panel does not appear on the Upload tab, where
  `showProducts` is false and it would otherwise sit under a file picker
  telling somebody mid-upload that they have no products.

7 client tests, **8 mutations, 8 of the right tests red.**

---

## 12. The Website panel, 2026-10-11

**It could not be reviewed at all until the API was restarted.**
`/api/website` is mounted behind `WEBSITE_BUILDER_ENABLED`, which is unset
in local development, so every call fell through to the catch-all 404 and
the panel showed a red **"Not found — Your website details could not be
loaded"**. That looked exactly like the Catalogue defect and **was not one**:
it was the feature switched off. Worth recording, because the first reading
of that screen was wrong and only a restart settled it.

With the builder mounted, `GET /api/website` answers `{site: null}` with a
**200**, exactly as its own comment says it must — *"a 404 would make the
ordinary path an error path and put a red line in the browser console for a
pharmacy that has done nothing wrong."*

### What is right, and is worth saying

**The panel has the best empty state in the app.** A pharmacy with no
website gets "Create your pharmacy website", a sentence saying their name,
address, hours and WhatsApp number are filled in from details they already
have and that the design can change later without losing them, and three
template cards each listing the sections that template produces. It is the
thing the Catalogue was missing, already built.

### The defect

**Nine call-to-action buttons were filled with the brand accent**, against
design.md’s CTA voice and against the owner’s own recorded answer. Asked
directly whether to take the Rhazes reference’s deep-green primary button,
they chose **"layout yes, colour no"**, and design.md says why:

> Primary: near-black fill (`bg-slate-900`)… **Deliberately not emerald:**
> keeping the accent off buttons is what lets it keep meaning "healthy" in a
> status pill two inches away.

**The collision was not hypothetical.** `WebsiteHeader` renders a
`bg-teal-50 text-teal-800` pill reading **"Live"** in the SAME header as a
`bg-teal-700` **Publish** button — the accent meaning "this site is healthy
and online" an inch from the accent meaning "press me".

```
MetaReviewTest.jsx        the Templates tab AND a Settings panel share one
                          `primaryButton` constant
Requests.jsx              "Send suggestion"
website/BusinessInfo      "Save details"
website/HomeContent       "Save"
website/PageText          "Save"
website/PublishBar        "Publish my website"
website/TemplatePicker    "Use this design"  (x2)
website/WebsiteHeader     "Publish my website"
```

Seven of the nine are in the website module, which was **the one part of
the app that never took the desk’s CTA voice**. Two are not, and fixing
seven while leaving two would have left the rule untestable — so all nine
moved, which is one behaviour rather than a wider scope.

**`teal-600` and lighter were deliberately left alone**, and that is the
point rather than an exemption: the tick inside a chosen service, the
open-state ring on an info toggle, the "Live" pill, the assistant’s message
bubble and the sidebar’s emerald R tile (design.md specifies that tile
explicitly) are identity and status, which is what the accent is FOR. Only
the solid `teal-700` CTA weight is forbidden.

**A test asserts BOTH directions**, because a fix that went too far would
be the same mistake inverted: no CTA carries the accent, and the "Live"
pill still does. Five mutations, five of the right tests red — including
the two that take the colour OFF the status pill.

**A ninth was nearly missed.** The first sweep searched for
`hover:bg-teal-800`, which found eight. `Requests.jsx`’s "Send suggestion"
has no hover class at all, so it only appeared when the search was widened
to the resting fill.

### Noted, not changed

- The website module’s buttons are `text-sm font-semibold` (14px/600) where
  design.md’s CTA voice says 13px/500. The radius already matches. Type is
  a separate behaviour from colour.
- "Saved." confirmations are `text-teal-700` TEXT. The rule is about keeping
  the accent off button FILLS; a success word in the brand colour is the
  accent meaning "healthy", which is allowed.
- On the create screen the panel’s own `h2` ("Create your pharmacy website")
  renders larger than the shell’s `h1` ("Website"), which inverts the
  hierarchy. Cosmetic, and its own change.
- Billing and Setup internals are still unexamined.
