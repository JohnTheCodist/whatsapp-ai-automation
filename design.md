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

- `--ui-paper`       oklch(98.4% 0.003 106)
- `--ui-surface`     oklch(100% 0 0)
- `--ui-sunk`        oklch(96.6% 0.004 106)
- `--ui-ink`         oklch(24% 0.014 165)
- `--ui-ink-soft`    oklch(47% 0.014 165)
- `--ui-ink-faint`   oklch(62% 0.012 165)
- `--ui-line`        oklch(92.4% 0.005 150)
- `--ui-accent`      oklch(70% 0.135 165)
- `--ui-accent-ink`  oklch(46% 0.105 165)

### Semantic colour is NOT the accent

Red, amber and green mean things, and bending them toward the brand is how an
alert stops looking like an alert.

- **red** — a person is waiting on a human. Only Consultations earns it.
- **amber** — queued work, nobody at risk.
- **emerald** — healthy / connected / within target.

Accent coverage stays under ~5% of any viewport.

## Typography

System stack, deliberately. A dashboard opened fifty times a day must paint
instantly, and a webfont on the critical path costs more than a distinctive
face is worth here. The marketing site carries the personality; this carries
the work.

- Body / UI: `ui-sans-serif, system-ui`
- Numerals: **always** `tabular-nums` wherever figures stack or update in
  place — counts that shift width as they change read as flicker.
- Section label: 10–11px, `uppercase`, `0.12em` tracking, `--ui-ink-faint`
- Screen title: 15px/600 · Card figure: 24–30px/600

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
  --ui-paper:       oklch(98.4% 0.003 106);
  --ui-surface:     oklch(100% 0 0);
  --ui-sunk:        oklch(96.6% 0.004 106);
  --ui-ink:         oklch(24% 0.014 165);
  --ui-ink-soft:    oklch(47% 0.014 165);
  --ui-ink-faint:   oklch(62% 0.012 165);
  --ui-line:        oklch(92.4% 0.005 150);
  --ui-line-soft:   oklch(95.2% 0.004 150);
  --ui-accent:      oklch(70% 0.135 165);
  --ui-accent-ink:  oklch(46% 0.105 165);
  --ui-accent-wash: oklch(96.5% 0.032 165);

  --radius-md: 10px; --radius-lg: 12px; --radius-xl: 16px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-fast: 140ms;
}
```

### Tailwind v4 `@theme`
Defined in `client/src/index.css`. Tailwind's `slate-*` is retargeted to the
warm neutral and `teal-*` to the brand emerald, so existing utility classes
across every screen resolve to this system without a rewrite.
