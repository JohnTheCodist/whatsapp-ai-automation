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
used to be dark. The active sidebar row is a **white pill lifted by
`--ui-shadow-pill`** — a shape, not only a tint, so "you are here" survives
for anyone who cannot separate two greys. There is no coloured left bar.

Scoped by redefining `--ui-surface` / `--ui-sunk` on
`nav[aria-label="Sections"]` in `index.css` — every descendant utility that
reads those tokens repaints for free.

The top of the sidebar is the workspace row, in the shape of the desk's
"Stock / ERPNext" header: the emerald R tile, the pharmacy's name, and
"RxNaija" beneath it.

### The sidebar collapses

Like the desk, the sidebar has two shapes, switched by a **Collapse** button
at its foot:

- **Expanded (214px):** icon + label rows, group labels, the WhatsApp panel
  in full, count pills at the end of each row.
- **Collapsed (56px):** the icon strip — the R tile alone, 36px icon tiles,
  groups separated by a hairline rule instead of a label, the active item on
  the same white tile, counts riding each icon's corner (9+ past nine), and
  the WhatsApp state as a dot on its icon.

Collapsed, every item keeps its name: as `sr-only` text for screen readers
and as a `title` on hover, which is the only way to learn an icon strip.
Every row renders through one `RailButton` in `App.jsx`, so the two shapes
cannot drift apart.

The choice is **per device** (`client/src/sidebarPreference.js`,
localStorage), like the alert-sound setting — the counter tablet and the
back-office laptop want different things. With no saved choice, a screen
under 1024px starts collapsed; the choice is saved only when someone
actually toggles it, so that automatic default is never mistaken for a
preference. Storage that is missing or throws never breaks the page. No
width animation: the switch is instant, per the motion stance.

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
float panels. The one shadow in the app is `--ui-shadow-pill`, on the active
sidebar row.

## Motion

Motion-cut project — no animation library, and none is warranted.

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
  --ui-shadow-pill:    0 1px 2px oklch(20.5% 0 0 / 0.10), 0 0 0 1px oklch(20.5% 0 0 / 0.04);

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
