/**
 * The tab icon, drawn at runtime so it can report whether anything needs you.
 *
 * WHY CANVAS AND NOT AN ANIMATED FILE
 * There is no file format that animates as a favicon across browsers. An
 * animated GIF animates in Firefox and freezes on frame one in Chrome, Edge
 * and Safari; an SVG with CSS or SMIL animation is rasterised to a single
 * frame everywhere. Repainting a canvas and reassigning the <link> href is
 * the only approach that actually moves in every browser, so that is what
 * this does.
 *
 * WHY IT ONLY MOVES WHEN SOMETHING IS WRONG
 * This dashboard sits open all day. A permanently animating tab icon repaints
 * forever for no information — it costs battery, and an alert that is always
 * on is one you stop seeing within a week. So the mark is STATIC while things
 * are fine, and the dot pulses only while something is genuinely waiting:
 * a customer needing a pharmacist, an order needing approval, or WhatsApp
 * disconnected. That is the same count the header bell shows, so the tab and
 * the bell can never disagree.
 *
 * The payoff is the case the bell cannot cover: the pharmacy is working in
 * another tab entirely. A pulsing favicon is visible from there; a badge
 * inside a page nobody is looking at is not.
 */

import { useEffect } from 'react';

/** 32px, not 16: browsers downscale for the tab and use the larger art elsewhere. */
const SIZE = 32;

/**
 * Painted before the themed colour is applied, so an unparseable custom
 * property leaves a sane brand green rather than whatever fillStyle held
 * last. Assigning an invalid colour to fillStyle is a silent no-op, which
 * is exactly the failure this ordering absorbs.
 */
const FALLBACK_ACCENT = '#10b981';
const ALERT = '#e11d48';

/**
 * Resolve a CSS custom property to something canvas will accept.
 *
 * Read back through getComputedStyle rather than used raw: the token is
 * declared in oklch, and going through the CSS engine means canvas receives
 * whatever that engine already resolved instead of this file re-implementing
 * colour parsing.
 */
function resolveToken(name, fallback) {
  try {
    const probe = document.createElement('span');
    probe.style.cssText = `color: var(${name}); display: none;`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/** The product mark: the R tile, same as the sidebar rail and the sign-in card. */
function drawMark(ctx, accent) {
  ctx.clearRect(0, 0, SIZE, SIZE);

  ctx.fillStyle = FALLBACK_ACCENT;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, 7);
  ctx.fill();

  // A letter, not the sidebar's old speech-bubble glyph: that outline is a
  // 1.6px stroke at 24px, thinner than a device pixel once a browser scales
  // it to a 16px tab, and it renders as grey mush. A bold R survives the
  // downscale, which is the only thing a favicon actually has to do.
  //
  // The stack ends in generic families on purpose — this can paint before
  // Inter has loaded, and a favicon that waits for a webfont is a favicon
  // that is blank exactly when the page is slowest.
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 21px Inter, system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('R', SIZE / 2, SIZE / 2 + 1);
}

/**
 * The alert dot, cut out of the tile before it is filled.
 *
 * The ring of transparent padding is what keeps the dot legible: a red circle
 * sitting directly on the green reads as brown at 16px, and the whole point
 * of this dot is being noticed at 16px.
 */
function drawAlertDot(ctx, scale) {
  const cx = SIZE - 8;
  const cy = 8;
  const radius = 6 * scale;

  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = ALERT;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
}

export default function Favicon({ count = 0 }) {
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    // roundRect is the one modern API here; without it the tile would be a
    // hard-cornered square, which is wrong rather than broken.
    if (!ctx || typeof ctx.roundRect !== 'function') return undefined;

    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }

    const accent = resolveToken('--ui-accent', FALLBACK_ACCENT);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let timer = null;
    let frame = 0;

    const paint = (scale) => {
      drawMark(ctx, accent);
      if (count > 0) drawAlertDot(ctx, scale);
      link.href = canvas.toDataURL('image/png');
    };

    const stop = () => {
      if (timer !== null) { clearInterval(timer); timer = null; }
    };

    const start = () => {
      stop();

      // Nothing waiting, or the user asked for less motion: one paint, no
      // loop at all. Reduced motion still gets the DOT — the fact that
      // something needs attention is information, and only its movement was
      // ever the accessibility problem.
      if (count === 0 || reduced) { paint(1); return; }

      // Repainting a favicon means toDataURL plus a DOM write, so this runs
      // at 10fps rather than on rAF. A pulse is legible at 10fps and costs a
      // sixth of what 60 would, on a tab that may sit open for hours.
      timer = setInterval(() => {
        frame += 1;
        // 1.2s period. Eased so it breathes rather than blinks — a hard
        // on/off at this size reads as a rendering glitch.
        const t = (frame % 12) / 12;
        paint(0.72 + 0.28 * (0.5 - 0.5 * Math.cos(t * Math.PI * 2)));
      }, 100);
    };

    // A hidden tab paints nothing a person can see, so the loop is suspended
    // rather than left running behind a backgrounded window.
    const onVisibility = () => (document.hidden ? stop() : start());

    start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [count]);

  return null;
}
