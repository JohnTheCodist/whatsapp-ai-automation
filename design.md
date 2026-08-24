# Design — RxNaija dashboard

A locked design system for the pharmacy-facing app. Every screen reads this
file before changing. Do not regenerate it per screen — extend or amend it
when the system needs to grow.

The marketing site (`client/public/home.html`, `about.html`) is a **separate
family** with its own display type and enrichment. What the two share is the
wordmark, the accent, and the CTA voice — so a pharmacy that signs up from the
website does not feel handed to a different company.

## Genre

**modern-minimal.** This is a B2B operations tool used under time pressure at
a counter. Function carries the page. No hero, no enrichment, no ornament —
the decoration budget goes into legibility and state.

## Macrostructure family

- **App pages: Workbench.** A persistent left rail, a thin context header, and
  one work surface. Screens vary by what fills the surface, never by shape —
  a pharmacist should not have to re-learn where things are between tabs.
- **Marketing pages: Marquee Hero / Split Studio** (already built; out of scope
  here, listed so a future run does not "unify" them into the app's shape).

## Theme

Warm neutrals carrying a trace of the accent's hue, so the greys read as
chosen rather than as a default install. Emerald is the brand; it is used for
*identity and health*, never for "this is a button".

`--ui-paper` used to sit a shade off `--ui-surface`, and `.ui-canvas` painted
a dotted radial-gradient texture over it — the idea being a canvas you
arrange things on should look like one. In practice the texture competed
with whatever sat on top of it rather than receding behind it, and reported
as distracting. Both are gone: `--ui-paper` is now flat white, same as
`--ui-surface`, and the dot pattern is deleted rather than tuned quieter.
Cards still separate from the page on border + shadow alone (`.ui-card`) —
that mechanism never depended on the page having its own tone, so removing
one changes nothing about how the other reads.

- `--ui-paper`       oklch(100% 0 0)
- `--ui-surface`     oklch(100% 0 0)
- `--ui-sunk`        oklch(96.6% 0.004 106)
- `--ui-ink`         oklch(24% 0.014 165)
- `--ui-ink-soft`    oklch(47% 0.014 165)
- `--ui-ink-faint`   oklch(62% 0.012 165)
- `--ui-line`        oklch(92.4% 0.005 150)
- `--ui-accent`      oklch(70% 0.135 165)
- `--ui-accent-ink`  oklch(46% 0.105 165)

### Chrome is dark; the canvas is not

The rail and the header stopped being the same surface as the work area. A
light rail sitting at the same weight as the content it frames read as
"nothing decided this is chrome" — the single biggest gap against a real
product, reported directly. Everything a pharmacist reads and edits stays on
the light paper above; the frame around it is dark, same 165° anchor hue as
`--ui-accent`, so it reads as this product's chrome and not a bolted-on
dark-mode toggle sitting next to a light app.

Scoped by redefining the `--ui-*` tokens on `nav[aria-label="Sections"]` and
`header` in `index.css` — nothing else. Both elements already read
`--ui-surface` / `--ui-ink` / `--ui-line` etc through Tailwind
arbitrary-value classes (`bg-[var(--ui-surface)]`, `text-[var(--ui-ink-soft)]`),
the same mechanism the palette retarget above relies on, so every existing
utility on every descendant repaints for free. No `!important`, no component
touched — nothing is fought, the utilities are handed a different value for
the token they already resolve through.

- `--ui-rail-bg`          oklch(16% 0.012 165) — the chrome surface, never `#000`
- `--ui-rail-bg-raised`   oklch(21% 0.016 165) — hover/active rows, the search field. Lighter, not darker: the dark-mode elevation rule
- `--ui-rail-ink`         oklch(94% 0.006 165) — primary label on chrome
- `--ui-rail-ink-soft`    oklch(74% 0.010 165) — default nav label
- `--ui-rail-ink-faint`   oklch(55% 0.010 165) — eyebrow ("Workspace", "Connection")
- `--ui-rail-line`        oklch(28% 0.010 165) — hairline on chrome
- `--ui-rail-accent-wash` oklch(22% 0.020 165) — active item background — a lift in tone, not a colour fill
- `--ui-rail-accent-ink`  oklch(78% 0.110 165) — active item label/icon — lightened + desaturated per the dark-mode recipe

The brand mark (the solid emerald square at the top of the rail) needed no
change — a saturated fill sitting directly on dark chrome is exactly the
"mark pops against the frame" move a real product makes.

### Icon-chip, and a ban on emoji as icons

A card or section heading that anchors on an icon uses a small tinted
rounded-square (`.ui-icon-chip` in `index.css`) — `background:
var(--ui-accent-wash)`, `color: var(--ui-accent-ink)`, 24px, 6px radius, icon
at 13px inside. Never a bare glyph floating next to the text.

**Emoji are banned as icons** — 🤖, 👥, ❤️, 🛒, 👤, 💬, 🔕, 📈 and their kind.
Several screens used them as a shortcut ("put something next to this label")
before this pass; a 🤖 stood in for "AI-assisted sales" on the screen a
pharmacy owner opens first. Colourful pictographic emoji are one of the
fastest ways a screen reads as generated rather than designed — they carry a
platform's own illustration style, not this product's, and render
differently release to release and device to device. Every spot that used
one now draws from `Icons.jsx` instead.

This is narrower than "no emoji anywhere." A conventional monochrome status
glyph — ✓, ✗, ★, →, ✨ for an AI-generate action — rendered in the theme's
own ink colour is normal UI chrome, not this problem, and stays allowed.

### Semantic colour is NOT the accent

Red, amber and green mean things, and bending them toward the brand is how an
alert stops looking like an alert.

- **red** — a person is waiting on a human. Only Consultations earns it.
- **amber** — queued work, nobody at risk.
- **emerald** — healthy / connected / within target.

Accent coverage stays under ~5% of any viewport.

## Typography

**Inter**, superseding the system-stack decision this section used to make.
The original reasoning — a dashboard opened fifty times a day must paint
instantly, and a webfont on the critical path costs more than a distinctive
face is worth — is still true as a tradeoff, just no longer the one this
product is making: the plain system face read as generic and undifferentiated
against how considered the rest of the surface is, closely enough to
"unfinished" that it undercut everything else here. Loaded with `font-display:
swap` and a `ui-sans-serif, system-ui` fallback in the token itself, so a
slow or blocked font request costs a moment of the second-choice face, never
an unreadable screen.

- Body / UI: `'Inter', ui-sans-serif, system-ui, sans-serif` (`--font-sans`)
- Numerals: **always** `tabular-nums` wherever figures stack or update in
  place — counts that shift width as they change read as flicker.
- Section label: 10–11px, `uppercase`, `0.12em` tracking, `--ui-ink-faint`
- Screen title: 15px/700 · Card figure: 24–30px/700

### Weight

`font-semibold` resolved to Tailwind's stock 600 everywhere — legible, but
next to a considered surface it reads as merely adequate rather than
authoritative. Retargeted the same way colour and radius already are:
Tailwind v4 exposes `--font-weight-*` as theme tokens the same way it
exposes `--color-*`, so bumping two lines in the `@theme` block reweights
every screen title, card figure and section heading in the app at once — no
`.jsx` touched.

- `--font-weight-semibold: 700` (was 600)
- `--font-weight-bold: 800` (was 700)
- `font-medium` is deliberately untouched — bumping it too would blur the
  distinction between a label and a heading, which is the thing weight
  exists to signal.

## Controls

Inputs are white — the same white as the page and the card holding them —
bordered in `--ui-line`, ringed in `--ui-accent-wash` on focus. They used to
sink into a slightly darker fill to read as "a field, not a button"; once the
page itself stopped carrying its own tone (see Theme), a plain border already
does that job, and the sunk fill was just a second white competing with the
first one on a screen meant to read as one surface.

## Spacing

Tailwind's 4-point scale via utilities. Cards are `p-4` (dense lists) or `p-5`
(headline figures). Section gap is `space-y-6`. Never mix a raw pixel value
into a layout a token already covers.

## Motion

Motion-cut project — no animation library, and none is warranted.

- Durations ≤ 160ms; easing `ease` on colour, `--ease-out` on transform.
- Animate `transform` and `opacity` only.
- **The focus ring never animates.** A ring that fades in is a ring that is
  missed.
- `prefers-reduced-motion` removes transitions entirely; nothing in the app
  depends on animation to become visible.

## Microinteractions stance

- **Silent success.** A saved change shows its result, not a toast.
- **Optimistic + Undo** over confirmation dialogs, except where the action
  messages a customer — those confirm, because they cannot be undone.
- Hover tooltips delay 800ms; focus tooltips 0ms.

## CTA voice

- **Primary:** near-black fill (`--ui-ink`), 10px radius, 13px/500. Deliberately
  not emerald — keeping the accent off buttons is what lets it keep meaning
  "healthy" in a status pill two inches away.
- **Secondary:** hairline border on surface, same radius and rhythm.
- **Destructive:** red border, red text, filled only on confirm.
- Labels say what happens: "Confirm & mark ready", never "Submit".

## Navigation

The rail holds **six** items, not eight. Inbox, Orders and Requests are one
job — a customer asked for something — so they live under **Deals** and are
switched by a segmented control inside the screen, with per-tab counts.

The rail's job is "where is the work"; the segmented control's job is "which
kind". Splitting them that way is what keeps the rail short enough to scan
without reading.

Tab ids (`inbox` / `orders` / `requests`) are unchanged underneath, so every
existing `onNavigate('orders')` deep-link keeps working.

## Per-page allowances

- App pages **must not** use enrichment — no illustration, no hero art.
- Empty states are a sentence, not a graphic.
- Every screen states its own freshness or its own emptiness. A screen that
  can be empty must say why it is empty.

## What every screen MUST share

- The rail, the header, and the wordmark.
- One card voice: `--ui-surface`, 1px `--ui-line`, 12px radius, the shared
  soft elevation.
- Section labels in the 10–11px uppercase style.
- Semantic colour meanings above.
- `tabular-nums` on every figure.

## What screens MAY differ on

- What fills the work surface (table, list, split pane, form).
- Density — a queue may be denser than a settings form.
- Whether a segmented control is present.

## Exports

### tokens.css
```css
:root {
  --ui-paper:       oklch(100% 0 0);
  --ui-surface:     oklch(100% 0 0);
  --ui-sunk:        oklch(96.6% 0.004 106);
  --font-sans:      'Inter', ui-sans-serif, system-ui, sans-serif;
  --ui-ink:         oklch(24% 0.014 165);
  --ui-ink-soft:    oklch(47% 0.014 165);
  --ui-ink-faint:   oklch(62% 0.012 165);
  --ui-line:        oklch(92.4% 0.005 150);
  --ui-line-soft:   oklch(95.2% 0.004 150);
  --ui-accent:      oklch(70% 0.135 165);
  --ui-accent-ink:  oklch(46% 0.105 165);
  --ui-accent-wash: oklch(96.5% 0.032 165);

  /* Dark chrome — rail + header only, applied by redefining the tokens
     above scoped to those two elements. See Theme § Chrome is dark. */
  --ui-rail-bg:          oklch(16% 0.012 165);
  --ui-rail-bg-raised:   oklch(21% 0.016 165);
  --ui-rail-ink:         oklch(94% 0.006 165);
  --ui-rail-ink-soft:    oklch(74% 0.010 165);
  --ui-rail-ink-faint:   oklch(55% 0.010 165);
  --ui-rail-line:        oklch(28% 0.010 165);
  --ui-rail-accent-wash: oklch(22% 0.020 165);
  --ui-rail-accent-ink:  oklch(78% 0.110 165);

  --font-weight-semibold: 700; --font-weight-bold: 800;
  --radius-md: 10px; --radius-lg: 12px; --radius-xl: 16px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-fast: 140ms;
}
```

### Tailwind v4 `@theme`
Defined in `client/src/index.css`. Tailwind's `slate-*` is retargeted to the
warm neutral and `teal-*` to the brand emerald, so existing utility classes
across every screen resolve to this system without a rewrite.
