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
 *
 * NO JAVASCRIPT EXISTS ON THESE PAGES, and that governs the whole design.
 * The mobile menu is a <details> element, the reveals are CSS scroll-driven
 * animations that degrade to "already visible" where unsupported, and nothing
 * here waits on a script to become usable. A pharmacy website that needs
 * JavaScript to show its opening hours is a pharmacy website that fails on
 * the connection most of its customers actually have.
 *
 * (Straight quotes in comments, never backticks: this file is one JS template
 * literal and a backtick would close the string.)
 */

const { resolveTheme } = require('./theme');

/**
 * A modest, fixed spacing scale.
 *
 * Fixed rather than themeable on purpose: rhythm is the difference between a
 * page that looks designed and one that looks assembled, and it is not a
 * decision a pharmacy owner has any reason to want to make. Exported because
 * it is the page's rhythm, and anything that lays out around this sheet needs
 * the same numbers rather than its own.
 */
const SPACE = {
  xs: '.5rem',
  sm: '.75rem',
  md: '1.25rem',
  lg: '2rem',
  xl: '3.5rem',
};

function stylesheet(storedTheme) {
  const t = resolveTheme(storedTheme);

  return `
/* Hallmark · macrostructure: Split Studio · genre: editorial
 * theme: RxNaija theme contract (locked — 6 palettes, 4 pairings, 3 radii)
 * nav: N1b brand-links-CTA · footer: Ft5 statement · enrichment: pharmacy photography
 * pre-emit critique: P5 H5 E4 S5 R4 V4
 */
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

  /* Derived, never chosen. A hairline and a wash that belong to whichever
     palette is active — a fixed grey would be wrong on five of the six.
     The flat value first is the fallback for a browser without color-mix. */
  --rx-line:#e5e7eb;
  --rx-line:color-mix(in oklab, var(--rx-ink) 14%, transparent);
  --rx-line-strong:#cbd5e1;
  --rx-line-strong:color-mix(in oklab, var(--rx-ink) 26%, transparent);
  --rx-tint:var(--rx-soft);

  /* Type scale. Fluid between a 320px phone and a desktop, so nothing has to
     be re-declared per breakpoint and nothing overshoots on a small screen. */
  --rx-size-xs:.8125rem;
  --rx-size-sm:.9375rem;
  --rx-size-base:1.0625rem;
  --rx-size-lg:clamp(1.125rem,.98rem + .55vw,1.3125rem);
  --rx-size-xl:clamp(1.3rem,1.1rem + .9vw,1.6rem);
  --rx-size-h2:clamp(1.65rem,1.3rem + 1.7vw,2.4rem);
  --rx-size-h1:clamp(2.1rem,1.55rem + 2.7vw,3.6rem);

  /* 4pt rhythm. The two large steps are what separate SECTIONS; everything
     smaller is inside one. */
  --rx-2xs:.25rem;
  --rx-xs:${SPACE.xs};
  --rx-sm:${SPACE.sm};
  --rx-md:${SPACE.md};
  --rx-lg:${SPACE.lg};
  --rx-xl:${SPACE.xl};
  --rx-2xl:clamp(3.5rem,2.2rem + 6vw,6rem);

  --rx-shell:72rem;
  --rx-measure:38rem;

  --rx-ease:cubic-bezier(.16,1,.3,1);
  --rx-dur:220ms;

  /* Shadows are barely there on purpose. A pharmacy website that leans on
     drop shadows to separate its sections is a website with no other idea. */
  --rx-shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px -12px rgba(15,23,42,.14);
}

*,*::before,*::after{box-sizing:border-box}
/* clip, never hidden: hidden on the root creates a scroll container and
   breaks position:sticky on the header. */
html,body{overflow-x:clip}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}

body{
  margin:0;
  background:var(--rx-surface);
  color:var(--rx-ink);
  font-family:var(--rx-text);
  /* 1.0625rem rather than 1rem: this is read on phones, often in daylight,
     often by people who are unwell. Slightly larger body text is the single
     cheapest accessibility win available here. */
  font-size:var(--rx-size-base);
  line-height:1.65;
  -webkit-font-smoothing:antialiased;
}
img{max-width:100%;height:auto;display:block}

a{color:var(--rx-primary);text-underline-offset:.2em;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
/* Never animated, and always visible: a focus ring that fades in is a focus
   ring that is not there when the key is pressed. */
:focus-visible{outline:2px solid var(--rx-primary);outline-offset:3px;border-radius:2px}

h1,h2,h3{
  font-family:var(--rx-display);
  font-style:normal;
  line-height:1.1;
  margin:0 0 var(--rx-sm);
  /* A long pharmacy name is one unbreakable word on a 320px screen unless
     this says otherwise. */
  overflow-wrap:anywhere;
  min-width:0;
}
h1{font-size:var(--rx-size-h1);letter-spacing:-.025em;font-weight:700}
h2{font-size:var(--rx-size-h2);letter-spacing:-.015em;font-weight:700}
h3{font-size:var(--rx-size-lg);letter-spacing:-.005em;font-weight:600}
p{margin:0 0 var(--rx-sm)}
p:last-child{margin-bottom:0}

/* The small contextual label above a heading. STACKED, never set beside the
   heading in its own column — the label-left/heading-right arrangement is the
   most reliable templated-editorial tell there is. */
.rx-eyebrow{
  display:block;
  font-family:var(--rx-display);
  font-size:var(--rx-size-xs);
  font-weight:600;
  letter-spacing:.12em;
  text-transform:uppercase;
  color:var(--rx-primary);
  margin:0 0 var(--rx-xs);
}

/* ---- the page spine ----
   Every section shares one gutter and one max width, so the page reads as one
   site regardless of which blocks a pharmacy chose or what order they are in.
   The vertical step is the large one: section separation is carried by SPACE,
   not by a border on every band. */
.rx-block{padding:var(--rx-xl) var(--rx-md)}
.rx-block>*{max-width:var(--rx-shell);margin-inline:auto}
.rx-narrow,.rx-prose{max-width:44rem;margin-inline:auto}

/* A READING COLUMN THAT STILL STARTS WHERE THE PAGE STARTS.
   The generated pages declare .rx-narrow on the SECTION, which made the whole
   band 44rem and centred it — so their text began at a different left edge
   from the header, the cards and the footer, and a page of them read as
   unstructured because the eye had to find the margin again at every section.
   Full-bleed section, padded in to exactly where a centred shell's left edge
   falls, children capped and left-aligned. max() keeps the ordinary gutter on
   a phone, where the shell is narrower than the viewport anyway. */
.rx-block.rx-narrow{
  max-width:none;
  margin-inline:0;
  padding-inline:max(var(--rx-md), calc((100% - var(--rx-shell)) / 2));
}
.rx-block.rx-narrow>*{max-width:44rem;margin-inline:0}

/* The page head on a generated page: eyebrow, h1, lede — same left edge. */
.rx-page-head .rx-lede{max-width:44rem}
.rx-page-head h1{margin-bottom:var(--rx-xs)}
.rx-prose p{color:var(--rx-muted);font-size:var(--rx-size-lg)}
.rx-lede{font-size:var(--rx-size-lg);color:var(--rx-muted);max-width:var(--rx-measure)}

.rx-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* ---- the diptych ----
   The page's structural signature: text on one side, proof on the other,
   alternating direction down the page. One column on a phone, always. */
.rx-split{display:grid;gap:var(--rx-lg);align-items:center}
/* For pairs where the two halves are different lengths — a heading against a
   seven-row table — centring them looks like a mistake. */
.rx-split--top{align-items:start}
.rx-split--top .rx-hours{margin-top:0}
.rx-split-media img{
  width:100%;
  border-radius:var(--rx-radius);
  /* A pharmacy sends portrait phone snaps and landscape ones. Cropping to a
     fixed shape is what stops a page of ragged, differently-proportioned
     boxes; object-fit is what stops the crop becoming a stretch. */
  aspect-ratio:4/5;
  object-fit:cover;
  background:var(--rx-tint);
}

/* ---- buttons ----
   Eight states are overkill for a link; these have the four a link can be in,
   and the tap target is sized for a thumb on a phone. */
.rx-btn{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:.5rem;
  padding:.8rem 1.4rem;
  border-radius:var(--rx-radius);
  font-family:var(--rx-display);
  font-weight:600;
  font-size:var(--rx-size-sm);
  text-decoration:none;
  /* 44px is the smallest reliably tappable target; a CTA that is hard to hit
     on a phone is a CTA that does not get hit. */
  min-height:44px;
  line-height:1.3;
  /* A CTA that wraps to two lines stops reading as a button. */
  white-space:nowrap;
  transition:transform var(--rx-dur) var(--rx-ease),
             box-shadow var(--rx-dur) var(--rx-ease),
             background-color var(--rx-dur) var(--rx-ease);
}
.rx-btn:hover{transform:translateY(-1px)}
.rx-btn:active{transform:translateY(0)}
.rx-btn-wa,.rx-btn-band,.rx-btn-solid{
  background:var(--rx-primary);
  color:var(--rx-on-primary);
  box-shadow:var(--rx-shadow);
}
.rx-btn-wa:hover,.rx-btn-band:hover,.rx-btn-solid:hover{
  box-shadow:0 2px 4px rgba(15,23,42,.06),0 14px 30px -14px rgba(15,23,42,.3);
}
.rx-btn-ghost,.rx-btn-outline{
  background:transparent;
  color:var(--rx-ink);
  box-shadow:inset 0 0 0 1px var(--rx-line-strong);
}
.rx-btn-ghost:hover,.rx-btn-outline:hover{
  background:var(--rx-tint);
  box-shadow:inset 0 0 0 1px var(--rx-primary);
  color:var(--rx-primary);
}
.rx-cta-row{display:flex;flex-wrap:wrap;gap:var(--rx-sm);margin-top:var(--rx-md)}

/* ---- header ----
   Sticky, because the WhatsApp button is the page's one job and it should
   never be more than a thumb away. Lightweight, because it is chrome. */
/* .rx-block.<name>, not .<name>: every block also carries .rx-block, and the
   section padding is raised inside a later media query. A single-class rule
   here loses to it and the sticky header renders 220px tall with six rems of
   air above a 56px row — measured at 768px, not theorised. */
.rx-block.rx-pharmacy-header{
  position:sticky;
  top:0;
  z-index:50;
  background:var(--rx-surface);
  border-bottom:1px solid var(--rx-line);
  padding:var(--rx-sm) var(--rx-md);
}
@supports (backdrop-filter:blur(8px)){
  .rx-pharmacy-header{
    background:color-mix(in oklab, var(--rx-surface) 88%, transparent);
    backdrop-filter:blur(10px);
  }
}
.rx-header-inner{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:var(--rx-md);
  width:100%;
  max-width:var(--rx-shell);
  margin-inline:auto;
}
.rx-brand{display:flex;align-items:center;gap:.6rem;text-decoration:none;color:inherit;min-width:0}
.rx-brand-name{
  font-family:var(--rx-display);
  font-weight:700;
  font-size:1.0625rem;
  letter-spacing:-.01em;
  color:var(--rx-ink);
  text-decoration:none;
  /* Two lines of pharmacy name is fine; three pushes the header over. */
  overflow-wrap:anywhere;
}
.rx-logo{max-height:40px;width:auto}

/* Desktop nav is hidden until there is room for it; the disclosure below
   carries the same links on a phone. */
.rx-nav{display:none;gap:var(--rx-lg);align-items:center}
/* inline-flex + min-height, not padding: the nav bar first appears at 768px,
   which is a TABLET — a touch device — and a 25px link is a mouse target, not
   a thumb one. Measured, not assumed. */
.rx-nav a{
  display:inline-flex;
  align-items:center;
  min-height:44px;
  text-decoration:none;
  color:var(--rx-muted);
  font-weight:500;
  font-size:var(--rx-size-sm);
  white-space:nowrap;
}
.rx-nav a:hover{color:var(--rx-ink)}
.rx-nav a[aria-current="page"]{color:var(--rx-ink);font-weight:600}
.rx-header-cta{display:none}

/* The mobile menu: a <details>, because there is no JavaScript on this page
   and a disclosure widget is what the platform already provides. */
.rx-menu{position:relative}
.rx-menu>summary{
  list-style:none;
  display:inline-flex;
  align-items:center;
  gap:.5rem;
  min-height:44px;
  padding:0 .5rem;
  cursor:pointer;
  font-family:var(--rx-display);
  font-weight:600;
  font-size:var(--rx-size-sm);
  color:var(--rx-ink);
}
.rx-menu>summary::-webkit-details-marker{display:none}
.rx-menu-bars{display:block;width:18px;height:2px;background:currentColor;position:relative}
.rx-menu-bars::before,.rx-menu-bars::after{content:"";position:absolute;left:0;width:18px;height:2px;background:currentColor}
.rx-menu-bars::before{top:-6px}
.rx-menu-bars::after{top:6px}
.rx-menu[open] .rx-menu-bars{background:transparent}
.rx-menu[open] .rx-menu-bars::before{top:0;transform:rotate(45deg)}
.rx-menu[open] .rx-menu-bars::after{top:0;transform:rotate(-45deg)}
.rx-menu-panel{
  position:absolute;
  right:0;
  top:calc(100% + .6rem);
  min-width:min(16rem,calc(100vw - 2rem));
  padding:var(--rx-sm);
  background:var(--rx-surface);
  border:1px solid var(--rx-line);
  border-radius:var(--rx-radius);
  box-shadow:var(--rx-shadow);
  display:grid;
  gap:.125rem;
}
.rx-menu-panel a{
  display:block;
  padding:.7rem .75rem;
  min-height:44px;
  line-height:1.6;
  text-decoration:none;
  color:var(--rx-ink);
  font-weight:500;
  border-radius:calc(var(--rx-radius) / 1.5);
}
.rx-menu-panel a:hover{background:var(--rx-tint);color:var(--rx-primary)}
.rx-menu-panel .rx-btn{margin-top:var(--rx-xs);width:100%}

/* ---- hero ----
   The strongest section on the page, and the only one that gets the tint as a
   full-bleed ground. Text left, the pharmacy's own photograph right. */
.rx-pharmacy-hero{background:var(--rx-tint);border-bottom:1px solid var(--rx-line)}
.rx-hero-inner{display:grid;gap:var(--rx-lg);align-items:center}
.rx-hero-copy{min-width:0}

/* The typographic hero — no photograph uploaded. Centred, with the measure
   pulled in so the lede breaks in a considered place rather than running the
   full width of a desktop. */
.rx-hero--type{justify-items:center;text-align:center}
.rx-hero--type .rx-hero-copy{max-width:46rem}
.rx-hero--type .rx-lede{margin-inline:auto}
.rx-hero--type .rx-cta-row{justify-content:center}
.rx-hero--type h1{font-size:clamp(2.3rem,1.6rem + 3.4vw,4.2rem)}
.rx-hero-media img{
  width:100%;
  border-radius:var(--rx-radius);
  aspect-ratio:4/3;
  object-fit:cover;
  box-shadow:var(--rx-shadow);
  background:var(--rx-surface);
}

/* ---- section heads ---- */
.rx-head{margin-bottom:var(--rx-lg);max-width:var(--rx-measure)}
.rx-head p{color:var(--rx-muted)}

/* ---- services ----
   NOT a row of identical shadowed cards. A hairline-ruled list that reads as
   one considered set, and that looks deliberate whether a pharmacy offers
   three services or nine. */
.rx-grid{display:grid;gap:0;padding:0;margin:var(--rx-md) 0 0;list-style:none;border-top:1px solid var(--rx-line)}
.rx-service{
  padding:var(--rx-md) 0;
  border-bottom:1px solid var(--rx-line);
  display:flex;
  gap:var(--rx-md);
  align-items:flex-start;
  text-decoration:none;
  color:inherit;
  transition:padding-inline-start var(--rx-dur) var(--rx-ease),
             background-color var(--rx-dur) var(--rx-ease);
}
a.rx-service:hover{padding-inline-start:var(--rx-sm);background:var(--rx-tint)}
.rx-service-body{min-width:0}
.rx-service h3{margin-bottom:.25rem;color:var(--rx-ink)}
.rx-service p{color:var(--rx-muted);margin:0;font-size:var(--rx-size-sm)}

/* The drawn mark beside a service. A tinted square rather than a bare glyph:
   at 24px a single-stroke icon floating in text is a smudge, and the square
   gives it a size and a footing so a row of them reads as a set. */
.rx-service-mark{
  flex:0 0 auto;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:44px;
  height:44px;
  border-radius:calc(var(--rx-radius) / 1.4);
  background:var(--rx-tint);
  color:var(--rx-primary);
  transition:background-color var(--rx-dur) var(--rx-ease),
             color var(--rx-dur) var(--rx-ease),
             transform var(--rx-dur) var(--rx-ease);
}
.rx-service:hover .rx-service-mark{
  background:var(--rx-primary);
  color:var(--rx-on-primary);
  transform:translateY(-1px);
}
.rx-svg{display:block}

/* The old marker, kept because a site published before the icon set exists
   still has blocks that emit it. */
.rx-icon{display:block;width:26px;height:3px;border-radius:2px;background:var(--rx-primary);margin-bottom:var(--rx-sm)}

/* ---- cards ----
   For INDEX pages only — /services/ and /health/ — where the list is the
   whole page and has to carry it. The home page keeps hairline rows: a wall
   of boxes inside a longer page is noise, and the same list in both places
   would make neither look considered. */
.rx-cards{display:grid;gap:var(--rx-sm)}
.rx-card{
  display:flex;
  align-items:center;
  gap:var(--rx-md);
  padding:var(--rx-md);
  border:1px solid var(--rx-line);
  border-radius:var(--rx-radius);
  background:var(--rx-surface);
  text-decoration:none;
  color:inherit;
  transition:border-color var(--rx-dur) var(--rx-ease),
             transform var(--rx-dur) var(--rx-ease),
             box-shadow var(--rx-dur) var(--rx-ease);
}
.rx-card:hover{border-color:var(--rx-primary);transform:translateY(-2px);box-shadow:var(--rx-shadow)}
.rx-card-mark{
  flex:0 0 auto;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:44px;height:44px;
  border-radius:calc(var(--rx-radius) / 1.4);
  background:var(--rx-tint);
  color:var(--rx-primary);
  transition:background-color var(--rx-dur) var(--rx-ease),color var(--rx-dur) var(--rx-ease);
}
.rx-card:hover .rx-card-mark{background:var(--rx-primary);color:var(--rx-on-primary)}
.rx-card-body{min-width:0;flex:1 1 auto}
.rx-card-title{display:block;font-family:var(--rx-display);font-weight:600;font-size:var(--rx-size-lg);color:var(--rx-ink)}
.rx-card p{margin:.15rem 0 0;color:var(--rx-muted);font-size:var(--rx-size-sm)}
/* The arrow moves, not the card's contents — a whole card that slides on
   hover drags the text under the reader's eye. */
.rx-card-go{flex:0 0 auto;color:var(--rx-muted);transition:transform var(--rx-dur) var(--rx-ease),color var(--rx-dur) var(--rx-ease)}
.rx-card:hover .rx-card-go{transform:translateX(3px);color:var(--rx-primary)}

/* ---- the generated pages ----
   A dozen short sections rather than the home page's five large ones, so the
   section rhythm steps down: the home page's 6rem between blocks is its
   composition, and the same gap here put a screen and a half of empty paper
   between an address and a list of opening hours. */
.rx-page .rx-block{padding-block:var(--rx-lg)}
/* Consecutive sections share one gap rather than stacking two paddings. */
.rx-page .rx-block + .rx-block{padding-top:0}
.rx-page .rx-block:has(>.rx-split){padding-block:var(--rx-lg)}

/* ---- split ---- the diptych this design is built on: two things that
   answer one question, side by side rather than a screen apart. */
.rx-split{display:grid;gap:var(--rx-lg)}
.rx-split>*{min-width:0}
.rx-split h2{margin-top:0}

/* ---- chips ---- a short list of cross-links with a shape and a tap target.
   A bulleted column of underlined links reads as a directory index; these are
   four services, and they should look like part of the page. */
.rx-chips{display:flex;flex-wrap:wrap;gap:var(--rx-xs);margin-top:var(--rx-md)}
.rx-chip{
  display:inline-flex;align-items:center;min-height:44px;
  padding:.55rem 1rem;
  border:1px solid var(--rx-line);
  border-radius:999px;
  background:var(--rx-surface);
  color:var(--rx-ink);
  font-size:var(--rx-size-sm);
  font-weight:500;
  text-decoration:none;
  transition:border-color var(--rx-dur) var(--rx-ease),
             background-color var(--rx-dur) var(--rx-ease),
             color var(--rx-dur) var(--rx-ease);
}
.rx-chip:hover{border-color:var(--rx-primary);background:var(--rx-tint);color:var(--rx-primary)}

/* ---- panels ---- a bounded answer, for FAQs and anything read one at a time. */
.rx-panels{display:grid;gap:var(--rx-sm);margin-top:var(--rx-md)}
.rx-panel{padding:var(--rx-md);border:1px solid var(--rx-line);border-radius:var(--rx-radius);background:var(--rx-surface)}
.rx-panel h3{margin-bottom:.35rem}
.rx-panel p{margin:0;color:var(--rx-muted)}

.rx-review{margin:0;padding:var(--rx-md);background:var(--rx-tint);border-radius:var(--rx-radius)}
.rx-review blockquote{margin:0;font-size:var(--rx-size-lg);font-family:var(--rx-display);line-height:1.4}
.rx-review figcaption{color:var(--rx-muted);font-weight:600;margin-top:var(--rx-xs);font-size:var(--rx-size-sm)}
.rx-rating{margin:0 0 var(--rx-xs);color:var(--rx-primary);letter-spacing:.1em}

/* ---- photographs ----
   A feature image with supporting ones beside it, not four identical tiles.
   Falls back to a plain even grid when there is only one photo, so a pharmacy
   with a single shopfront picture still looks composed. */
.rx-photo-grid{display:grid;gap:var(--rx-sm)}
.rx-photo{
  width:100%;
  height:auto;
  aspect-ratio:4/3;
  object-fit:cover;
  border-radius:var(--rx-radius);
  display:block;
  background:var(--rx-tint);
}

/* ---- hours ---- */
.rx-hours{margin:var(--rx-md) 0 0;max-width:32rem}
.rx-hours-row{
  display:flex;
  justify-content:space-between;
  gap:var(--rx-md);
  padding:.7rem 0;
  border-bottom:1px solid var(--rx-line);
}
.rx-hours-row:last-child{border-bottom:0}
.rx-hours dt,.rx-hours-row span:first-child{font-weight:600}
.rx-hours dd,.rx-hours-row span:last-child{margin:0;color:var(--rx-muted);text-align:right;font-variant-numeric:tabular-nums}
.rx-hours-note{margin-top:var(--rx-sm);color:var(--rx-muted);font-size:var(--rx-size-sm)}

/* ---- location & contact ---- */
.rx-address{font-style:normal;margin-bottom:var(--rx-md);font-size:var(--rx-size-lg)}
.rx-landmark{color:var(--rx-muted)}
.rx-contact{list-style:none;padding:0;margin:var(--rx-md) 0 0;display:grid;gap:0;max-width:32rem;border-top:1px solid var(--rx-line)}
.rx-contact li{
  display:flex;
  gap:var(--rx-sm);
  flex-wrap:wrap;
  align-items:baseline;
  padding:.8rem 0;
  border-bottom:1px solid var(--rx-line);
}
.rx-label{font-weight:600;min-width:6.5rem;color:var(--rx-muted);font-size:var(--rx-size-sm)}

/* ---- the closing WhatsApp band ----
   The page's last word. Inverted, so it reads as an ending rather than as one
   more section. */
.rx-pharmacy-whatsappCta{background:var(--rx-primary);color:var(--rx-on-primary);text-align:center}
.rx-pharmacy-whatsappCta h2{color:var(--rx-on-primary)}
.rx-pharmacy-whatsappCta p{color:var(--rx-on-primary);opacity:.86;max-width:34rem;margin-inline:auto}
.rx-pharmacy-whatsappCta .rx-btn-wa,
.rx-pharmacy-whatsappCta .rx-btn-band{
  background:var(--rx-on-primary);
  color:var(--rx-primary);
  margin-top:var(--rx-md);
}

/* ---- breadcrumbs ----
   Furniture, not a section: it carries .rx-block for the shell and the gutter,
   so without this it also took a full section's worth of vertical padding and
   opened a 56px hole between the header and the page's own heading. */
.rx-block:has(>.rx-crumbs){padding-block:var(--rx-md) 0}
.rx-crumbs{display:flex;flex-wrap:wrap;gap:.4rem;padding:0;margin:0;list-style:none;font-size:var(--rx-size-sm);color:var(--rx-muted)}
.rx-crumbs li+li::before{content:"/";margin-right:.4rem;color:var(--rx-line-strong)}
.rx-crumbs a{color:var(--rx-muted);text-decoration:none}
.rx-crumbs a:hover{color:var(--rx-primary);text-decoration:underline}

/* ---- health-article furniture ---- */
.rx-seek-care{
  border-inline-start:3px solid var(--rx-primary);
  background:var(--rx-tint);
  border-radius:var(--rx-radius);
  padding:var(--rx-md) var(--rx-md) var(--rx-md) var(--rx-lg);
}
.rx-seek-care h2{font-size:var(--rx-size-xl)}
.rx-byline{color:var(--rx-muted);font-size:var(--rx-size-sm)}
.rx-byline p{margin:0}
.rx-disclaimer{color:var(--rx-muted);font-size:var(--rx-size-sm);border-top:1px solid var(--rx-line);padding-top:var(--rx-md)}

/* ---- footer ----
   A statement, not four columns of links. The secondary text is a TRANSLUCENT
   WHITE rather than var(--rx-muted): --rx-muted is tuned for the light page
   body, and on the dark footer it was about 2:1, which fails WCAG AA badly and
   was visibly unreadable in review. Deriving it from the foreground keeps it
   correct for every palette, including any added later. */
.rx-block.rx-pharmacy-footer{background:var(--rx-ink);color:var(--rx-surface);padding:var(--rx-xl) var(--rx-md)}
.rx-pharmacy-footer{background:var(--rx-ink);color:var(--rx-surface)}
.rx-pharmacy-footer a{color:var(--rx-surface);text-decoration:none}
.rx-pharmacy-footer a:hover{text-decoration:underline}
.rx-footer-inner{max-width:var(--rx-shell);margin-inline:auto;display:grid;gap:var(--rx-md)}
.rx-footer-name{
  font-family:var(--rx-display);
  font-weight:700;
  font-size:var(--rx-size-xl);
  letter-spacing:-.015em;
  margin:0;
}
.rx-footer-address{color:rgba(255,255,255,.82);margin:0}
.rx-footer-contact{display:flex;flex-wrap:wrap;gap:0 var(--rx-md);margin:0;padding:0;list-style:none}
.rx-footer-nav{display:flex;flex-wrap:wrap;gap:0 var(--rx-md);margin:0;padding:0;list-style:none}
.rx-footer-nav a{color:rgba(255,255,255,.82);font-size:var(--rx-size-sm)}
/* 44px, because these are the only links in the footer and a phone number
   that is hard to hit is a phone call that does not happen. Measured at
   320px: they were 19px tall, which is a line of text, not a target. */
.rx-footer-nav a,.rx-footer-contact a{display:inline-flex;align-items:center;min-height:44px}
.rx-footer-legal{
  color:rgba(255,255,255,.62);
  margin:0;
  padding-top:var(--rx-md);
  border-top:1px solid rgba(255,255,255,.16);
  font-size:var(--rx-size-sm);
}

/* ---- the responsive step ----
   rx-stack-640 and rx-stack-768 are declared by the blocks themselves, in
   their "responsive" metadata, and emitted by their renderers. Adding a block
   that stacks at a new breakpoint means adding one rule here, not
   restructuring anything.
   minmax(0,1fr) rather than 1fr on every image-bearing track: a bare 1fr is
   min-content-floored, and an image inside one pushes the grid wider than the
   viewport. */
@media (min-width:640px){
  .rx-block{padding:var(--rx-2xl) var(--rx-lg)}
  .rx-photo-grid{grid-template-columns:repeat(auto-fit,minmax(15rem,minmax(0,1fr)))}
  /* Three or more photos get a composition rather than a row: one large, the
     rest stacked beside it. */
  .rx-photo-grid:has(:nth-child(3)){grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}
  .rx-photo-grid:has(:nth-child(3))>:first-child{grid-row:span 2;aspect-ratio:4/5}
  .rx-footer-inner{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);align-items:start}
  .rx-footer-legal{grid-column:1 / -1}
}
@media (min-width:768px){
  .rx-stack-640{display:flex;flex-direction:row;align-items:center;justify-content:space-between;width:100%}
  .rx-nav{display:flex}
  .rx-header-cta{display:inline-flex}
  .rx-menu{display:none}
  .rx-stack-768,.rx-split{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
  .rx-hero-inner{grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:var(--rx-xl)}
  /* One column, whatever the width: there is no second thing to put in it. */
  .rx-hero-inner.rx-hero--type{grid-template-columns:minmax(0,1fr)}
  .rx-block.rx-pharmacy-hero:has(.rx-hero--type){padding-block:calc(var(--rx-2xl) * 1.15)}
  /* The alternation that makes this a Split Studio rather than a stack of
     rows: the flipped block puts its media first on desktop and keeps the
     copy first in the DOM, so the reading order on a phone is unchanged. */
  .rx-split--flip .rx-split-media{order:-1}
  .rx-grid-2{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--rx-md);border-top:0}
  .rx-grid-2 .rx-review{border-bottom:0}
  .rx-cards{grid-template-columns:repeat(2,minmax(0,1fr))}
  .rx-split{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--rx-xl)}
}
@media (min-width:1024px){
  /* Services become two columns of ruled rows — still a list, still hairlines,
     never a card wall. */
  .rx-grid-3{grid-template-columns:repeat(2,minmax(0,1fr));column-gap:var(--rx-xl)}
  .rx-grid-3 .rx-service:nth-last-child(-n+2){border-bottom:0}
}

/* ---- the floating WhatsApp button ----
   The one control that follows the reader down every page, including the
   generated ones. Clear of the safe-area inset on a phone with a home bar,
   where bottom:1rem alone puts it under the gesture strip. */
.rx-fab{
  position:fixed;
  z-index:50;
  right:max(var(--rx-md), env(safe-area-inset-right));
  bottom:calc(var(--rx-md) + env(safe-area-inset-bottom));
  display:inline-flex;
  align-items:center;
  gap:.6rem;
  min-height:56px;
  padding:0 1.15rem;
  border-radius:999px;
  background:var(--rx-primary);
  color:var(--rx-on-primary);
  font-family:var(--rx-display);
  font-weight:600;
  font-size:var(--rx-size-sm);
  text-decoration:none;
  box-shadow:0 6px 20px -4px color-mix(in oklab, var(--rx-ink) 42%, transparent);
  transition:transform var(--rx-dur) var(--rx-ease),box-shadow var(--rx-dur) var(--rx-ease);
}
.rx-fab:hover{transform:translateY(-2px);box-shadow:0 12px 28px -4px color-mix(in oklab, var(--rx-ink) 52%, transparent)}
.rx-fab:active{transform:translateY(0)}
.rx-fab-glyph{flex:0 0 auto}

/* A ring that pulses twice, a moment after the page settles — enough to be
   noticed by somebody who has finished reading, not a beacon that blinks for
   the whole visit. On a pseudo-element, so it can never affect layout. */
.rx-fab::before{
  content:"";position:absolute;inset:0;border-radius:inherit;
  border:2px solid var(--rx-primary);opacity:0;pointer-events:none;
  animation:rx-fab-ring 2.4s var(--rx-ease) 1.4s 2;
}
@keyframes rx-fab-ring{
  0%{opacity:.5;transform:scale(1)}
  70%,100%{opacity:0;transform:scale(1.35)}
}

/* The label is a desktop affordance: on a phone the button sits over what
   somebody is reading, and a disc covers less of it than a pill. */
.rx-fab-label{display:none}
@media (min-width:640px){.rx-fab-label{display:inline}}
@media (max-width:639px){
  .rx-fab{padding:0;width:56px;justify-content:center}
  /* So the last line of the footer is never trapped under the button. */
  body:has(.rx-fab){padding-bottom:calc(56px + var(--rx-md))}
}

/* ---- motion ----
   Scroll-driven, declarative, and entirely optional: browsers without
   animation-timeline never run it and see the finished page, which is the
   correct fallback and the reason this needs no script. */
@media (prefers-reduced-motion:no-preference){
  @supports (animation-timeline:view()){
    .rx-block{
      animation:rx-rise linear both;
      animation-timeline:view();
      animation-range:entry 0% entry 55%;
    }
    /* The header is sticky and the hero is the first thing seen — neither
       should animate in. */
    .rx-pharmacy-header,.rx-pharmacy-hero{animation:none}

    /* One step finer inside the sections that are a set of things rather than
       one thing. The stagger is positional, not timed: each card animates
       against its own position in the scroll, so they arrive in order without
       a delay chain that would still be running if the reader scrolled fast. */
    .rx-cards>*,.rx-photo-grid>*,.rx-chips>*{
      animation:rx-rise linear both;
      animation-timeline:view();
      animation-range:entry 0% entry 35%;
    }
    /* The children animate; the section around them must not, or the two
       compound into a double fade. */
    .rx-page .rx-block:has(>.rx-cards),
    .rx-block:has(>.rx-photo-grid){animation:none}
  }
  .rx-photo,.rx-hero-media img,.rx-split-media img{
    transition:transform 420ms var(--rx-ease);
  }
  .rx-photo:hover,.rx-hero-media img:hover,.rx-split-media img:hover{transform:scale(1.015)}
}
@keyframes rx-rise{
  from{opacity:0;transform:translateY(12px)}
  to{opacity:1;transform:none}
}

/* Respect a reader who has asked for less motion. */
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}

/* ---- print ----
   A pharmacy prints its own page to check it, and a customer prints the
   address. Neither wants a dark footer slab using half a cartridge. */
@media print{
  .rx-pharmacy-header,.rx-menu,.rx-cta-row{display:none}
  .rx-pharmacy-footer{background:none;color:#000;border-top:1px solid #000}
  .rx-pharmacy-footer a,.rx-footer-address,.rx-footer-legal{color:#000}
  .rx-block{padding:1rem 0;break-inside:avoid}
}
`.trim();
}

module.exports = { stylesheet, SPACE };
