/**
 * The published stylesheet, generated from a resolved theme.
 *
 * WHY GENERATED AND NOT A STATIC FILE
 * The published page's CSP is `default-src 'none'` with `style-src 'self'
 * 'unsafe-inline'`, and the page must be self-contained — one document, no
 * external stylesheet to fetch on a slow mobile connection, nothing to 404 if
 * an asset path ever changes. So the CSS is inlined into the document, and
 * since it carries the pharmacy's theme it has to be produced per site.
 *
 * WHY THE OWNER CANNOT WRITE ANY OF IT
 * Every value below comes from theme.js's resolved output, which is six
 * palettes, four type pairings and three radii. There is no path from owner
 * input to a CSS declaration except through those enums and the single
 * validated hex — so no amount of editing can produce a broken layout, an
 * unreadable button, or a `}` that escapes into the rest of the sheet.
 *
 * MOBILE FIRST, and not as a slogan. The base rules are the phone layout,
 * because that is what a customer in Lagos opens a pharmacy's website on. The
 * media queries add the desktop arrangement on top, so a narrow screen runs
 * the fewest rules and never has to undo a desktop assumption.
 */

const { resolveTheme } = require('./theme');

/**
 * A modest, fixed spacing scale.
 *
 * Fixed rather than themeable on purpose: rhythm is the difference between a
 * page that looks designed and one that looks assembled, and it is not a
 * decision a pharmacy owner has any reason to want to make.
 */
const SPACE = { xs: '.5rem', sm: '.75rem', md: '1.25rem', lg: '2rem', xl: '3.5rem' };

function stylesheet(storedTheme) {
  const t = resolveTheme(storedTheme);

  return `
:root{
  --rx-primary:${t.primary};
  --rx-on-primary:${t.onPrimary};
  --rx-ink:${t.ink};
  --rx-muted:${t.muted};
  --rx-surface:${t.surface};
  --rx-soft:${t.soft};
  --rx-radius:${t.radius};
  --rx-display:${t.fontDisplay};
  --rx-text:${t.fontText};
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  background:var(--rx-surface);
  color:var(--rx-ink);
  font-family:var(--rx-text);
  /* 1.0625rem rather than 1rem: this is read on phones, often in daylight,
     often by people who are unwell. Slightly larger body text is the single
     cheapest accessibility win available here. */
  font-size:1.0625rem;
  line-height:1.6;
}
img{max-width:100%;height:auto;display:block}
a{color:var(--rx-primary)}

h1,h2,h3{font-family:var(--rx-display);line-height:1.2;margin:0 0 ${SPACE.sm}}
h1{font-size:clamp(1.9rem,5vw,3rem);letter-spacing:-.02em}
h2{font-size:clamp(1.4rem,3.5vw,2rem);letter-spacing:-.01em}
h3{font-size:1.125rem}
p{margin:0 0 ${SPACE.sm}}

/* Every section shares one gutter and one max width, so the page has a spine
   regardless of which blocks a pharmacy chose or what order they are in. */
.rx-block{padding:${SPACE.lg} ${SPACE.md}}
.rx-block>*{max-width:70rem;margin-inline:auto}
.rx-narrow,.rx-prose{max-width:44rem;margin-inline:auto}

/* Screen-reader-only text. Used for the rating equivalent in reviews — the
   stars are aria-hidden and this carries the actual value. */
.rx-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* ---- buttons ---- */
.rx-btn{
  display:inline-block;
  padding:.75rem 1.35rem;
  border-radius:var(--rx-radius);
  font-family:var(--rx-display);
  font-weight:600;
  text-decoration:none;
  /* 44px is the smallest reliably tappable target; a CTA that is hard to hit
     on a phone is a CTA that does not get hit. */
  min-height:44px;
  line-height:1.5;
}
.rx-btn-wa{background:var(--rx-primary);color:var(--rx-on-primary)}
.rx-btn-ghost{background:transparent;color:var(--rx-primary);box-shadow:inset 0 0 0 2px currentColor}
.rx-btn-outline{background:transparent;color:var(--rx-primary);box-shadow:inset 0 0 0 2px currentColor}
.rx-btn-band{background:var(--rx-primary);color:var(--rx-on-primary)}
.rx-cta-row{display:flex;flex-wrap:wrap;gap:${SPACE.sm};margin-top:${SPACE.md}}

/* ---- header ---- */
.rx-pharmacy-header{background:var(--rx-surface);border-bottom:1px solid var(--rx-soft);padding-block:${SPACE.md}}
.rx-header-inner{display:flex;flex-direction:column;align-items:flex-start;gap:${SPACE.sm}}
.rx-brand-name{font-family:var(--rx-display);font-weight:700;font-size:1.25rem}
.rx-logo{max-height:52px;width:auto}
.rx-nav{display:flex;flex-wrap:wrap;gap:${SPACE.md}}
.rx-nav a{text-decoration:none;color:var(--rx-muted);font-weight:500}

/* ---- hero ---- */
.rx-pharmacy-hero{background:var(--rx-soft)}
.rx-hero-inner{display:flex;flex-direction:column;gap:${SPACE.lg}}
.rx-lede{font-size:1.15rem;color:var(--rx-muted);max-width:38rem}
.rx-hero-media img{border-radius:var(--rx-radius);width:100%;object-fit:cover}

/* ---- photographs ----
   One column here, columns in the media query below, like every other grid in
   this file: a phone must never have to undo a desktop assumption.
   aspect-ratio with object-fit is what stops a portrait phone snap and a
   landscape one from making a ragged row — every tile is the same shape and
   the image is cropped to it rather than distorted. */
.rx-photo-grid{display:grid;gap:${SPACE.sm}}
.rx-photo{width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;border-radius:var(--rx-radius);display:block;background:var(--rx-soft)}

/* ---- grids: services, reviews ---- */
.rx-grid{display:grid;gap:${SPACE.md};padding:0;margin:${SPACE.md} 0 0;list-style:none}
.rx-service h3{margin-bottom:.25rem}
.rx-service p{color:var(--rx-muted);margin:0}
/* Not an icon set. A small primary-coloured dot that marks the item without
   pretending to be a glyph library the page does not ship. */
.rx-icon{display:block;width:12px;height:12px;border-radius:999px;background:var(--rx-primary);margin-bottom:${SPACE.xs}}

.rx-review{margin:0;padding:${SPACE.md};background:var(--rx-soft);border-radius:var(--rx-radius)}
.rx-review blockquote{margin:0}
.rx-review figcaption{color:var(--rx-muted);font-weight:600;margin-top:${SPACE.xs}}
.rx-rating{margin:0 0 ${SPACE.xs};color:var(--rx-primary);letter-spacing:.1em}

/* ---- hours ---- */
.rx-hours{margin:${SPACE.md} 0 0;max-width:32rem}
.rx-hours-row{display:flex;justify-content:space-between;gap:${SPACE.md};padding:.6rem 0;border-bottom:1px solid var(--rx-soft)}
.rx-hours dt{font-weight:600}
.rx-hours dd{margin:0;color:var(--rx-muted);text-align:right}
.rx-hours-note{margin-top:${SPACE.sm};color:var(--rx-muted)}

/* ---- location & contact ---- */
.rx-address{font-style:normal;margin-bottom:${SPACE.md}}
.rx-landmark{color:var(--rx-muted)}
.rx-contact{list-style:none;padding:0;margin:${SPACE.md} 0 0;display:grid;gap:${SPACE.sm};max-width:32rem}
.rx-contact li{display:flex;gap:${SPACE.sm};flex-wrap:wrap}
.rx-label{font-weight:600;min-width:6.5rem}

/* ---- footer ----
   The secondary text here is a TRANSLUCENT WHITE, not var(--rx-muted).
   --rx-muted is tuned for the light page body; on the dark footer it was
   #475569 on #0f172a, about 2:1, which fails WCAG AA badly and was visibly
   unreadable in review. Deriving it from the foreground instead means it
   stays correct for every palette, including any added later — a fixed grey
   would have to be re-checked against each one. */
.rx-pharmacy-footer{background:var(--rx-ink);color:var(--rx-surface);padding-block:${SPACE.lg}}
.rx-pharmacy-footer a{color:var(--rx-surface)}
.rx-footer-name{font-family:var(--rx-display);font-weight:700;font-size:1.1rem}
.rx-footer-address{color:rgba(255,255,255,.8)}
.rx-footer-legal{color:rgba(255,255,255,.66);margin-top:${SPACE.md};font-size:.9375rem}

/* ---- the responsive step ----
   These two class names are declared by the blocks themselves, in their
   "responsive" metadata, and emitted by their renderers. Adding a block that
   stacks at a new breakpoint means adding one rule here, not restructuring
   anything.
   (Straight quotes, not backticks: this comment lives inside a JS template
   literal, and a backtick here closes the string.) */
@media (min-width:640px){
  .rx-block{padding:${SPACE.xl} ${SPACE.lg}}
  .rx-stack-640{flex-direction:row;align-items:center;justify-content:space-between;width:100%}
  .rx-grid-2{grid-template-columns:repeat(2,1fr)}
  .rx-grid-3{grid-template-columns:repeat(2,1fr)}
  /* auto-fit, so one photo fills the width and four become a grid without the
     page having to know how many there are. */
  .rx-photo-grid{grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))}
}
@media (min-width:768px){
  .rx-stack-768{flex-direction:row;align-items:center}
  .rx-stack-768>*{flex:1 1 0}
}
@media (min-width:1024px){
  .rx-grid-3{grid-template-columns:repeat(3,1fr)}
}

/* Respect a reader who has asked for less motion. There is no animation here
   today, but the published page is generated and this costs one line. */
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}
`.trim();
}

module.exports = { stylesheet, SPACE };
