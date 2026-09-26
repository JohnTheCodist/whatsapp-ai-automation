# Design — RxNaija dashboard

A locked design system for the pharmacy-facing app. Every screen reads this
file before changing. Do not regenerate it per screen — extend or amend it
when the system needs to grow.

The marketing site (`client/public/home.html`, `about.html`) is a **separate
family** with its own display type and enrichment. What the two share is the
wordmark, the accent, and the CTA voice — so a pharmacy that signs up from the
website does not feel handed to a different company.

## Why ERPNext

**Amended 2026-09-19, at the owner's request.** The owner rejected the
previous dark-chrome, emerald-tinted look and asked for the dashboard to take
the look and text styles of the ERPNext / Frappe desk (v15–16), from
screenshots of an ERPNext trial they were evaluating alongside this product.
The DNA taken from those screenshots, and applied here:

- a **light grey sidebar** of icon + label rows, the active row a **white pill
  on a hairline shadow**;
- a **white header** carrying a **breadcrumb** (home / section / segment) and
  a grey **"Search  Ctrl+K" pill**;
- **grey filled, borderless fields** that turn white on focus;
- a **near-black primary button** ("Save") and **grey filled secondary
  buttons** ("Create", "Get Items From");
- **soft-tint status pills** in sentence case ("Not Saved", "Draft");
- **underlined tabs** ("Details | Other Info");
- light tables with a grey header row;
- **Inter, sentence case, weights 400/500/600** — calm, not authoritative.

What was deliberately NOT taken: ERPNext's blue. The owner kept the RxNaija
emerald, so the product reads as RxNaija inside an ERPNext-shaped frame. No
pixels, icons or assets were copied — the structure and the token values are
the reference, re-expressed in this codebase's own tokens.

## Genre

**modern-minimal.** A B2B operations tool used under time pressure at a
counter. Function carries the page. No hero, no enrichment, no ornament —
the decoration budget goes into legibility and state.

## Macrostructure family

- **App pages: Workbench.** A persistent left sidebar, a thin header, and one
  work surface. Screens vary by what fills the surface, never by shape — a
  pharmacist should not have to re-learn where things are between tabs.
- **Marketing pages: Marquee Hero / Split Studio** (already built; out of scope
  here, listed so a future run does not "unify" them into the app's shape).

## Theme

Pure neutral greys — zero chroma, the Frappe desk's ramp — on a white work
surface. The calm of the reference comes from its colourlessness; greys
tinted toward the accent (the previous system's choice) read as a different
product. Emerald is the brand; it is used for *identity and health*, never
for "this is a button".

Tailwind's `slate-*` ramp is retargeted onto these greys and `teal-*` onto
the emerald in `client/src/index.css`'s `@theme`, so every existing utility
class in every screen resolves to this system without a className changing.

- `--ui-paper`        oklch(100% 0 0)     white
- `--ui-surface`      oklch(100% 0 0)
- `--ui-sunk`         oklch(96.4% 0 0)    #F3F3F3 — field fill, grey button
- `--ui-sunk-hover`   oklch(94.6% 0 0)    #EDEDED
- `--ui-ink`          oklch(20.5% 0 0)    #171717
- `--ui-ink-soft`     oklch(43.9% 0 0)    #525252 — labels, inactive nav
- `--ui-ink-faint`    oklch(55.5% 0 0)    ~#707070 — meta, placeholders
- `--ui-line`         oklch(94.6% 0 0)    #EDEDED hairline
- `--ui-line-strong`  oklch(83.0% 0 0)    #C7C7C7
- `--ui-accent`       oklch(70% 0.135 165)
- `--ui-accent-ink`   oklch(46% 0.105 165)
- `--ui-focus`        oklch(52% 0.112 165)

`--ui-ink-faint` is deliberately a shade darker than ERPNext's #7C7C7C, which
sits at 4.2:1 on white — under the 4.5:1 floor for the small text it is used
on. `--ui-focus` exists because the accent itself is ~2.3:1 on white, too
faint to be the only sign of where keyboard focus is.

### Chrome is light

The sidebar is the desk's light grey column (`--ui-sidebar`, #F8F8F8) with a
hairline right edge; the header is white with a hairline bottom edge. Both
used to be dark. The active sidebar item is a **white tile / pill with an
inset hairline** (`.ui-rail-pill`) — a shape, not only a tint, so "you are
here" survives for anyone who cannot separate two greys. There is no
coloured left bar. The lift is drawn inside the pill because the sidebar is
revealed through a clip-path, which would cut an outer shadow off.

Scoped by redefining `--ui-surface` / `--ui-sunk` on
`nav[aria-label="Sections"]` in `index.css` — every descendant utility that
reads those tokens repaints for free.

The top of the sidebar is the workspace row, in the shape of the desk's
"Stock / ERPNext" header: the emerald R tile, the pharmacy's name, and
"RxNaija" beneath it.

### The sidebar opens on hover

At rest the sidebar is the desk's **56px icon strip**: the R tile alone,
36px icon tiles, groups separated by a hairline rule, the active item on a
white tile, counts riding each icon's corner (9+ past nine), the WhatsApp
state as a dot on its icon. **Point at it and the full 214px panel opens;
move away and it closes.** There is no toggle.

- **It opens OVER the page.** The strip is the only thing in the page's
  flow, so content never moves; a table that jumped sideways every time the
  cursor crossed the sidebar would be worse than no sidebar. The open panel
  carries a soft shadow on its right edge to read as a layer.
- **Hover intent.** 70ms before opening, so a cursor on its way to the page
  does not flash it open; a 140ms grace period before closing, so slipping
  off by a few pixels does not snap it shut.
- **Keyboard.** Focus inside the sidebar (`:focus-visible`) opens it too, so
  tabbing through the navigation shows the labels being read. `:focus-visible`
  rather than `:focus`: a mouse click leaves focus on the button it clicked,
  and plain `:focus-within` would then hold the panel open after the pointer
  had left.
- **Touch.** Hover-open applies only under `(hover: hover) and (pointer:
  fine)` — on a touch screen a tap would leave `:hover` stuck and the panel
  open over the page with no way to shut it. Touch users get the strip, and
  every label is still read by screen readers.
- **Labels are hidden by opacity only,** never `display`/`visibility`, so
  the accessibility tree is the same in both states.

Every row renders through one `RailButton` in `App.jsx`, laid out once at
full width with its icon centred on the strip's midline (x = 28px), so the
icon does not move by a pixel as the panel opens. The motion itself is
specified under Motion, below. `client/src/sidebarRail.test.js` pins the
keyboard, touch, reduced-motion, clip-path and screen-reader rules.

### Home: the module launcher

**Added 2026-09-19, at the owner's request.** Signing in lands on Home, the
desk's app launcher in this product's terms: no sidebar, the R logo at the
left of the header, the search centred, and a grid of five module tiles —
**Stock, Clinics, Patients, Marketing, Branding**, in that order. One click
opens a module; the sidebar returns inside it, and the breadcrumb's house
(or the R logo) comes back here. `client/src/Launcher.jsx`; the routing is
the pure `moduleTarget`, pinned by `launcher.test.js`.

| Tile | Opens |
|---|---|
| Stock | Inventory — the catalogue and its upload |
| Clinics | Consultations — the pharmacist's clinical queue (clinic *bookings* are not built) |
| Patients | Patients, with the refill call list |
| Marketing | Not built: a "Soon" pill on the tile, and a one-sentence page saying so |
| Branding | The website builder when the server has it on; otherwise Setup (pharmacy and assistant identity) |

**The tile.** A 60px emerald tile (17px radius) in a two-stop gradient, a
hairline of light along its top and a darker one along its bottom, and a
soft emerald shadow — an object catching light from above. White line icons
from `Icons.jsx` (`IconModule*`) at 28px, stroke 1.75. The lighter gradient
stop keeps white icons at ~3.8:1, over the 3:1 floor for graphics; a
brighter green fails it. Labels 14px / 600 ink beneath.

**Motion.** On load the tiles rise 8px and fade in, 50ms apart. Hover lifts
a tile 3px and fades in a deeper shadow drawn on a pseudo-element (opacity
and transform only); press settles it back in by 3%. Reduced motion: none of
it.

**Layout.** Five in one row from tablet width up; three across on a phone
(3 + 2) — never a lone tile on a row of its own.

### Data bars are ink, never the accent

Anything whose LENGTH is the number — funnel steps, breakdown bars, the
reply-cap meter — is drawn in `--ui-bar` (which resolves to `--ui-ink`) on a
`--ui-bar-track` ground. Not emerald, and not amber. A reader who has learned
that amber means something cannot unlearn it for one chart; semantic colour
is reserved below, and a bar is not a status.

`--ui-radius-bar` is **2px**, not a pill: a near-square end reads as a
printed financial chart, which is the register these screens are in.

Colour returns only where it means something: the amber/teal insight cards
keep their tint, and the reply-cap meter turns amber past 80% because that IS
a status.

### Icon-chip, and a ban on emoji as icons

A card or section heading that anchors on an icon uses a small tinted
rounded-square (`.ui-icon-chip` in `index.css`) — `background:
var(--ui-accent-wash)`, `color: var(--ui-accent-ink)`, 24px, 6px radius, icon
at 13px inside. Never a bare glyph floating next to the text.

**Emoji are banned as icons** — 🤖, 👥, ❤️, 🛒, 👤, 💬, 🔕, 📈 and their kind.
They carry a platform's own illustration style, not this product's, and are
one of the fastest ways a screen reads as generated rather than designed.
Every icon draws from `Icons.jsx`.

This is narrower than "no emoji anywhere." A conventional monochrome status
glyph — ✓, ✗, ★, →, ✨ for an AI-generate action — rendered in the theme's
own ink colour is normal UI chrome and stays allowed.

### Semantic colour is NOT the accent

Red, amber and green mean things, and bending them toward the brand is how an
alert stops looking like an alert.

- **red** — a person is waiting on a human. Only Consultations earns it.
- **amber** — queued work, nobody at risk.
- **emerald** — healthy / connected / within target.
- **orange** (`.ui-pill-unsaved`) — unsaved changes, the desk's "Not Saved".

Accent coverage stays under ~5% of any viewport.

## Typography

**Inter** — the face the Frappe desk itself uses — loaded with `font-display:
swap` and a `ui-sans-serif, system-ui` fallback in the token, so a slow or
blocked font request costs a moment of second-choice face, never an
unreadable screen.

- Body / UI: `'Inter', ui-sans-serif, system-ui, sans-serif` (`--font-sans`), 14px
- Sidebar rows: 14px / 500
- Breadcrumb: 15px, earlier steps `--ui-ink-soft`, the current one `--ui-ink` / 500
- Page title: 20px / 600 · Card figure: 24–30px / 600
- Card / section heading: 14px / 600 `--ui-ink` — the desk's "Items"
- Field label and small meta: 12–13px / 500
- Numerals: **always** `tabular-nums` wherever figures stack or update in
  place — counts that shift width as they change read as flicker.

### Sentence case

ERPNext labels things the way you would say them — "Customer since",
"Medications followed" — never in spaced capitals. Every `uppercase` label in
the app is written in sentence case in the source and was uppercased by CSS,
so one rule in `index.css` (`.uppercase { text-transform: none; … }`) resets
all of them: small labels land at 12px / 500, and an h2–h4 that was an
uppercase eyebrow becomes a 14px / 600 section heading. **New code should not
use `uppercase` at all.**

### Weight

Stock Tailwind weights: `--font-weight-semibold: 600`, `--font-weight-bold:
700`. The previous system raised them to 700/800 for an "authoritative"
register; the desk's register is calm, and that is the look asked for.
`font-medium` (500) is for labels and nav; `font-semibold` (600) for titles
and headings.

## Controls

**The desk's field: grey, borderless, 8px.** A `--ui-sunk` (#F3F3F3) fill
with a transparent border, one step darker on hover; on focus it turns white
with a `--ui-ink-faint` edge and a soft `--ui-sunk-hover` halo. Applied by one
unlayered rule in `index.css` to every text-like input, select and textarea,
so screens need no classes for it. Checkboxes, radios, sliders, colour and
file pickers stay native; checkboxes and radios take `--ui-ink` as their
`accent-color`. `.ui-field-plain` opts a field out.

**Why the skin rules are unlayered:** Tailwind v4 puts utilities in
`@layer utilities`, and an unlayered declaration outranks any layered one
regardless of specificity. That is what lets one rule restyle every field,
tab strip and table without `!important` and without touching a component —
and it is also why those rules must stay narrow (see the button rule below).

## Spacing

Tailwind's 4-point scale via utilities. Cards are `p-4` (dense lists) or `p-5`
(headline figures). Section gap is `space-y-6`. Never mix a raw pixel value
into a layout a token already covers.

## Radius

8px on anything you click or type into (`--radius-lg`, and the field rule);
6px for `rounded-sm` / `rounded-md` and the ready-made pills (`.ui-chip`,
`.ui-pill-unsaved`); 12px on large containers (`--radius-xl`, `.ui-card`).
Plain `rounded` is Tailwind's fixed 4px — it compiles to `.25rem` and does
not read a token (checked in the built CSS, 2026-09-19) — which is what the
existing inline status pills use; that is close enough to the desk's pill
that it is left alone.

## Elevation

**Flat.** Cards are a hairline border on white, no shadow — the desk does not
float panels. The one shadow in the app is the open sidebar's, on its right
edge (`--rail-shadow`), so it reads as a layer over the page.

**One shadow, still.** A patients toolbar carrying a soft shadow was drawn
on 2026-09-20 and removed the same day: the owner asked for the controls to
sit on the page as three separate items — an outlined search box, the funnel,
the switch — rather than inside a floating card, and with no card there was
nothing left to lift. Recorded because the reasoning is worth keeping: a card
around a toolbar makes it a THING on the page, and this one is chrome for the
list below it. The exception was never needed.

## Motion

Motion-cut project — no animation library, and none is warranted.

**The one choreographed moment is the sidebar**, and it is CSS only (`.ui-rail`
in `index.css`, every timing in its `--rail-*` variables):

- **Opening:** after 70ms of hover intent, the panel is revealed by a
  clip-path mask sweeping open over 320ms on `--ui-ease-out`
  (cubic-bezier(0.22, 1, 0.36, 1)), its shadow growing with it. Labels fade
  in and slide 6px into place over 240ms, cascading 16ms apart from top to
  bottom. The active item's white tile stretches into the full-width pill on
  the panel's own timing; corner badges hand over to the row-end count pills.
- **Closing:** after a 140ms grace period the mask closes over 220ms on
  `--ui-ease-in-out` (cubic-bezier(0.65, 0, 0.35, 1)); labels leave together
  in 110ms, and the strip's own marks return once it has closed.
- **Why clip-path, not width:** the panel is always laid out at full width
  and only its mask moves, so nothing re-measures or reflows while it
  animates. clip-path, opacity and transform are the only properties that
  move.
- **Reduced motion:** the panel switches instantly; labels cross-fade in
  120ms with no slide and no cascade.

- Durations ≤ 160ms; easing `ease` on colour, `--ease-out` on transform.
- Animate `transform` and `opacity` only (plus colour transitions on hover).
- **The focus ring never animates.** A ring that fades in is a ring that is
  missed.
- `prefers-reduced-motion` removes transitions entirely; nothing in the app
  depends on animation to become visible.

## Microinteractions stance

- **Silent success.** A saved change shows its result, not a toast.
- **Optimistic + Undo** over confirmation dialogs, except where the action
  messages a customer — those confirm, because they cannot be undone.
- Hover tooltips delay 800ms; focus tooltips 0ms.
- **Ctrl+K / Cmd+K focuses the header search**, as on the desk. The hint is
  printed inside the field, so the shortcut must always work.

## CTA voice

- **Primary:** near-black fill (`bg-slate-900` → #171717), white text, 8px
  radius, 13px / 500 — the desk's "Save". Deliberately not emerald: keeping
  the accent off buttons is what lets it keep meaning "healthy" in a status
  pill two inches away.
- **Secondary:** grey fill (`--ui-sunk`), no border, ink text; one step
  darker on hover. In markup this is still written as the codebase's
  `border border-slate-300` outline button — `index.css` restyles exactly
  `button` and `a` elements carrying that class into the desk's grey
  button. A bordered `div` or `blockquote` is a container, not an action, and
  keeps its line. New secondary buttons may use either form.
- **Destructive:** red border, red text, filled only on confirm.
- Labels say what happens: "Confirm & mark ready", never "Submit".

## Navigation

The sidebar holds **six** work items, not eight. Inbox, Orders and Requests
are one job — a customer asked for something — so they live under **Manage
Deals** and are switched by the screen's underlined tabs, with per-tab counts.
Setup and Billing sit at the foot of the sidebar with the connection status.

The header's breadcrumb says where you are: home (the Overview icon) /
section / segment. Each step before the last navigates; the last is marked
`aria-current="page"`. It is a second `<nav>` (`aria-label="Breadcrumb"`),
which is why sidebar styling is scoped to `nav[aria-label="Sections"]` and
never to `nav` alone.

Tab ids (`inbox` / `orders` / `requests`) are unchanged underneath, so every
existing `onNavigate('orders')` deep-link keeps working.

## Per-page allowances

- App pages **must not** use enrichment — no illustration, no hero art.
- Empty states are a sentence, not a graphic.
- Every screen states its own freshness or its own emptiness. A screen that
  can be empty must say why it is empty.

## What every screen MUST share

- The sidebar, the header, and the wordmark.
- One card voice: `--ui-surface`, 1px `--ui-line`, 8–12px radius, flat.
- Sentence-case labels, and 14px / 600 section headings.
- Semantic colour meanings above.
- `tabular-nums` on every figure.
- Any "ranked narrative" screen (a story told in a few large sections rather
  than a grid of same-size KPI cards — Overview, AI Performance) builds from
  `client/src/DashboardKit.jsx`: `Panel`, `PanelHead`, `Bar`, `Trend`,
  `Headline`, `Spark`, `naira`, `pct`. A third such screen extends that
  file; it does not start its own.
- A length-encoded bar (a ranking, a funnel, a loss breakdown — one number
  per row, where the bar's WIDTH is the only thing carrying meaning) is
  always `DashboardKit`'s `Bar`: ink on a faint track, never the brand colour
  or a semantic one. A genuine multi-series chart (Overview's
  revenue/new/returning line chart) keeps real colour, because each series
  needs to stay visually distinct.

## What screens MAY differ on

- What fills the work surface (table, list, split pane, form).
- Density — a queue may be denser than a settings form.
- Whether a tab strip is present.

## Tab strips inside a screen

**One tab idiom in this app: the desk's underline.** A row of 14px / 500
labels on a hairline rule; the selected tab is `--ui-ink` with a 2px ink
underline, the rest `--ui-ink-soft`. Every strip is a real `role="tablist"`
with roving `tabIndex` (only the selected tab is a tab stop), arrow keys that
wrap, and Home/End — and `index.css` styles them through those ARIA roles, so
the semantics that make the keyboard work are the same hook that makes them
look like one idiom. The old raised-tab (Settings, AI Performance) and
segmented-control (Manage Deals) looks both give way to it.

Split tabs by the **question each answers**, never by data source. AI
Performance is Performance / Opportunity / Operations — "how did the week
go", "where is money leaking", "is the machine running" — which is why
catalogue readiness sits under Opportunity: an unpriced product is a
blocked sale, not plumbing.

## A patient's record

**Added 2026-09-20.** A record is a navigation column of its twelve sections
(`.ui-precord`), and the open section beside it. Two rules about the column,
both pinned by `patientRecordNav.test.js`:

- **It collapses by hand, never on hover.** The app's main sidebar opens when
  pointed at; this one must not. A record is worked inside for minutes with
  the cursor crossing the column on the way to everything else, and a panel
  that opened each time is movement nobody asked for. The state is the
  user's, and is remembered per browser.
- **It animates its width**, which the main rail deliberately does not. There
  the re-layout is the problem; here it is the point — collapsing is how a
  wide table gets the room.

A section with no screen yet is still in the column, carrying a **Soon** pill,
and its page says plainly that it is not built. The alternative — hiding it —
means a pharmacist cannot see that allergies *will* live here.

### The summary is a list, not a grid of cards

The summary is two columns: **the patient on the left, their body on the
right**. The left column is ONE vertical list (`.ui-pprofile`) — who they
are, then a row per section of the record, separated by hairlines with
nothing framing them. An earlier version gave each section its own bordered
card; eight boxes make eight things of equal weight out of what is really one
list about one person, and a record is read top to bottom.

Each section shows its **name, a count, and its items** — and nothing else.
No sentence counting what is listed beneath it, no tag repeating where each
row came from, no link that explains itself. An earlier version printed
"1 condition confirmed from purchase history", then "Hypertension", then
"From purchases" under it: the same fact three times, eight times down the
column. **The count is the summary.** Where one thing needs acting on, it is
an amber chip of two or three words — "1 refill due", "Danger sign".

**Nothing is only on the summary**, and two rules survive the trim because
they are not decoration: a section with no data says **"Not recorded"**,
never "none" (those are different claims, and only one is true in a product
that has never asked); and the source of a claim still travels with it as the
item's tooltip and in the section it opens, because a condition here is
confirmed by purchase history, not by a doctor.

### The body

`BodyViewer3D.jsx`, and `AnatomicalAvatar.jsx` when WebGL is unavailable.
Three layers the pharmacist switches — body surface, skeleton, organs — with
the surface translucent so what is under it stays visible. Drag to turn.

- **It is a reference body, and the panel says so** — on itself rather than
  under itself. An anatomical figure beside somebody's name is read as a
  picture *of them*, so "reference body, not this patient" and the CC BY
  credit are the panel's own tooltip and accessible name (the printed lines
  were removed 2026-09-20 at the owner's request), with the full credit in
  `client/public/models/ATTRIBUTION.md`, which ships with the app.
- **No standing instructions.** The caption appears only while a part of the
  body is being pointed at. A body that drifts and a cursor that becomes a
  grab handle already say it can be turned; a permanent line of instruction
  is read once and then becomes furniture.
- **A marker means something is RECORDED there**, never that something is
  wrong. Amber, the queued-work colour, never the red kept for a person
  waiting. A region with nothing recorded says exactly that when pointed at.
- **Where the anatomy is not known, nothing is drawn.** A condition whose code
  this product cannot place on a body gets no marker at all: a dot in the
  wrong place is worse than no dot.
- **It costs nothing to anyone who does not open a record.** three.js and the
  viewer are a lazy chunk (152KB gzipped); the model is ~2.2MB, fetched on
  demand and left to the browser cache. The weight is the design: a body that
  takes thirty seconds to arrive is a body nobody waits for, and a pharmacist
  and a patient are standing in front of this screen.

Source: Human Reference Atlas (HuBMAP), CC BY 4.0, built by
`scripts/build-body-model.mjs` from a 230MB original. Full credit and every
adaptation are in `client/public/models/ATTRIBUTION.md`, which ships with the
app because CC BY requires it.

## Vitals, and charting a measurement

**Added 2026-09-20** (`Vitals.jsx`, `VitalsChart.jsx`), replicating the
OpenMRS 3 flow the owner asked for: a table of readings, a chart of one sign
over time, and a panel that records a set.

**One sign at a time, one axis.** Two measurements of different units on one
pair of axes is the commonest chart mistake there is; a temperature and a
pulse share no scale. Blood pressure is not an exception — systolic and
diastolic are two numbers in the same unit.

**The axis never starts at zero** unless the data does. A temperature axis
from zero is a flat line at the top of the frame.

**A gap is not a zero.** A visit that recorded no temperature is absent from
the temperature line, not plotted at the floor, which would draw a collapse
that never happened.

**The usual range is shaded behind the line**, grey at 4.5% ink — it marks
ORDINARY, so it must carry no alarm of its own. This is the single change
that makes the chart readable: "is this patient where they should be" stops
being arithmetic and becomes a glance. The bounds come from the SERVER with
the readings, and are absent for a child or an unknown age, so no band is
ever drawn against one. The dashboard holds no clinical range of its own:
two copies is two answers to "is this normal", and the one a pharmacist
believes would be whichever they happened to look at.

**Colour is validated, not chosen.** The two series hues are checked with the
palette validator for colour-vision deficiency (deutan ΔE 19.7) and are
direct-labelled at the end of each line, so identity never rests on colour
alone. A single series takes one hue and no legend — the title names it, and
carries the latest value beside it.

**Red in a table means "look at this one"**, never a severity and never a
diagnosis. Nothing is ever marked normal, and the cell says in words which
way it fell and against what.

### Motion here

Four moments, each doing a job, all dropped under `prefers-reduced-motion`:

- **The line draws itself in**, 700ms left to right, normalised with
  `pathLength` so a four-point chart and a forty-point one take the same
  time. It shows where to start reading and which way time runs.
- **Points land as the line reaches them** — a cascade computed from the
  point count, not a fixed delay that would outlast a short series.
- **A page of readings is dealt**, rows 24ms apart, so eleven rows cost a
  quarter of a second and a page reads as a page rather than appearing.
- **The record panel comes in from the edge it lives on**, 280ms, with the
  page darkening behind it on the same beat — two durations would make the
  backdrop and the panel look like separate events.

Switching view or tab is a **cross-fade**, not a slide: it is a change of
subject rather than a move, and sliding it in from a direction it never came
from would be a lie about where it was.

## Data tables

**One idiom, set by the patients table** (`.ui-ptable` in `index.css`,
`PatientSearch.jsx`). Amended 2026-09-21: the first version read as generated,
and the owner said so. The five rules that fixed it are the idiom.

1. **One primary column.** Exactly one thing on a row is at ink weight — on
   Patients, the person's name, with their phone directly beneath it as part
   of the same identity block. Everything else is `--ui-ink-soft` or quieter.
   Nine columns at one size in one grey is the state a table drifts into, and
   it leaves the eye nowhere to land.
2. **Every row the same height.** `table-layout: fixed`, declared widths in a
   `<colgroup>`, one line per cell, and lists folded to their first item plus
   a `+N` count with the whole list as the tooltip. A three-medicine cell
   that wraps while its neighbour does not is what "scattered" means. Fixed
   widths also stop the columns shuffling sideways when a page of results
   changes.
3. **No compound columns.** "Age · Gender" was a number and a category joined
   by a decorative middot. Split them: figures get their own narrow column,
   right-aligned on `tabular-nums` so there is an edge to read down; a
   category gets its own. If two things need a separator to share a cell,
   they are two cells.
4. **Absence is quiet.** Nothing recorded is an en-dash at `--ui-line-strong`
   — it holds the column's rhythm without competing. A full-weight em-dash in
   six cells a row makes absence as loud as data. It carries
   `aria-label="not recorded"`, because quiet is a visual decision, not an
   accessibility one.
5. **Smaller than body text, not bigger.** 13px rows, 11.5px head, 11px
   secondary line. A table is read by scanning down a column, not by reading
   a sentence, and the app's 14px default is too large for that job. 44px
   rows: dense enough to compare, open enough to read.

**Chips on a dense row are marks, not buttons** — 11px, 5px radius, flat, and
never heavier than the patient's name. The head is a label strip on
`--ui-sidebar` with a `--ui-line-strong` rule under it; rows are separated by
hairlines only, never by fills or zebra striping.

The row is the control: it carries `role="button"`, a tab stop, Enter/Space,
a hover tint, a pressed tint, and a `-2px` focus ring. Actions live in a last
right-aligned column and stay hidden until the row is hovered or focused
(`.ui-row-actions`).

## Searching and filtering a list

**One idiom, first built for Patients (`.ui-searchbox` / `.ui-toolbar-filters`
in `index.css`, `PatientSearch.jsx`).** Any screen that searches a list reuses
it rather than inventing a second filter style.

**A row of separate controls, not a toolbar card.** Left to right: the search
box, the funnel, then the screen's one switch if it has one. They sit directly
on the page — no card, no shadow, no divider between them. (Amended
2026-09-20, from the owner's Docker Desktop reference. The first version put
all three inside one raised card, which made the controls read as a single
compound widget and cost the screen a band of chrome above every list.)

1. **The search box** (`.ui-searchbox`), a **fixed-width outlined field**, not
   a bar spanning the page. Most visits to a list screen start by filtering
   rather than typing, and a full-width bar says the opposite. Its
   placeholder is the single word "Search": the heading above already says
   what is being listed. This is the ONE outlined field in the app — every
   other is grey-filled and borderless — and it earns the exception by being
   the control people aim at without looking: an outline is a target, a fill
   is a surface. The input inside carries no fill or border of its own.
2. **The funnel** (`.ui-toolbar-filters`), borderless and 32px square, with
   the count of applied filters as a small ink badge on its corner. No word
   "Filters" beside it and no chevron: the panel opening underneath is the
   state, and the badge is the number that says the list is not everybody.
3. **The switch** (`.ui-switch-row`), for the one state a person works in for
   a whole session rather than sets for a single question — on Patients,
   "Show only chronic patients". It is labelled in words, because an
   unlabelled toggle is a control you have to flip to find out what it was,
   and the label is part of the target. On, its track fills with the brand
   green: the one filled colour on the screen, which is what makes "I am
   looking at a subset" readable from across the counter. It narrows
   ALONGSIDE the panel's filters, never instead of them. At most one per
   screen — a second switch is a filter, and filters live in the panel.
4. **The filter panel**, opened by the funnel, closed by default, in its own
   hairline card below the row. Labelled controls in a grid, 2 columns at
   `sm`, 4 at `lg`, in a fixed order that never reflows as values change. A
   control is a select when the values are a short fixed list, and a **typed
   input with a `datalist`** when they are the pharmacy's own inventory —
   hundreds of medicines in a select is a scroll, not a choice, and the
   server matches any part of the name so a half-typed word is a real search.
   The panel opens by animating `grid-template-rows: 0fr → 1fr` over 240ms on
   `--ui-ease-out`: it opens to exactly its own height with nothing measured
   in JavaScript and no max-height for its contents to outgrow later. Dropped
   under `prefers-reduced-motion`.
5. **Applied filters as chips**, below the panel, one per filter, each naming
   its field and value with an × that removes only that one, then **Clear
   all**. The switch is NOT counted and gets no chip: the badge, the grid and
   the chips all exist to surface what is hidden, and a switch is already
   showing its own state.

**No quick-view pills.** The first version of this toolbar carried a row of
saved filter combinations under the search. They were removed: three pills
that each silently *replaced* the filter set sat directly above a panel that
*added* to it, which is two different rules for the same-looking control, and
the row cost a line of vertical space on every screen to save one click on
some of them.

**Row actions** (`.ui-row-actions`) belong in a last, right-aligned column,
and stay at `opacity: 0` until the row is hovered or holds focus — 80
patients should read as 80 names, not 160 buttons — with `@media (hover:
none)` making them permanent on touch. Each one does exactly what its tooltip
says using data already on the row. A destructive action does not go here: an
irreversible act one stray click from a list is a design error, not a
convenience.

**The rule underneath it:** at rest the screen shows the whole list and one
input. Everything else is one click away and, once used, is visible as a chip,
a lit switch or a count rather than hidden behind a closed panel. A filtered
list that does not say it is filtered is how someone concludes a patient is
not in the system.

## Exports

### tokens.css
```css
:root {
  --ui-paper:          oklch(100% 0 0);
  --ui-surface:        oklch(100% 0 0);
  --ui-sunk:           oklch(96.4% 0 0);
  --ui-sunk-hover:     oklch(94.6% 0 0);
  --font-sans:         'Inter', ui-sans-serif, system-ui, sans-serif;
  --ui-ink:            oklch(20.5% 0 0);
  --ui-ink-soft:       oklch(43.9% 0 0);
  --ui-ink-faint:      oklch(55.5% 0 0);
  --ui-line:           oklch(94.6% 0 0);
  --ui-line-soft:      oklch(96.4% 0 0);
  --ui-line-strong:    oklch(83.0% 0 0);
  --ui-accent:         oklch(70% 0.135 165);
  --ui-accent-ink:     oklch(46% 0.105 165);
  --ui-accent-wash:    oklch(96.5% 0.032 165);
  --ui-focus:          oklch(52% 0.112 165);

  /* Light chrome — see Theme § Chrome is light. */
  --ui-sidebar:        oklch(97.9% 0 0);
  --ui-sidebar-hover:  oklch(94.6% 0 0);
  --ui-sidebar-active: oklch(100% 0 0);

  /* Data bars — see Theme § Data bars are ink. */
  --ui-bar:        var(--ui-ink);
  --ui-bar-track:  oklch(96.4% 0 0);
  --ui-radius-bar: 2px;

  /* Status pill — unsaved changes. */
  --ui-pill-orange-bg: oklch(96.5% 0.030 55);
  --ui-pill-orange-fg: oklch(56% 0.160 50);

  --font-weight-semibold: 600; --font-weight-bold: 700;
  --radius-sm: 6px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px; --radius-2xl: 16px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-fast: 140ms;
}
```

### Tailwind v4 `@theme`
Defined in `client/src/index.css`. Tailwind's `slate-*` is retargeted to the
desk's neutral grey ramp (#F8F8F8 → #171717, zero chroma) and `teal-*` to the
brand emerald, so existing utility classes across every screen resolve to
this system without a rewrite.
