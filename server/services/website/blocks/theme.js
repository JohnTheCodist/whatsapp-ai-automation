/**
 * The theme contract — how a pharmacy is allowed to change how its site looks.
 *
 * DELIBERATELY A SHORT LIST OF CHOICES, NOT A DESIGN TOOL.
 *
 * The locked decision is that the owner picks from a set rather than from a
 * colour wheel, because the product promise is "get your pharmacy online in
 * ten minutes" and not "here is a design surface, good luck". Every
 * combination expressible here has to look deliberate, which is only
 * achievable if the number of combinations is small and each one was chosen
 * by someone.
 *
 * So: six palettes, four type pairings, three corner radii. Seventy-two
 * combinations, all of which work. There is no free-form CSS, no font upload,
 * no spacing control and no colour picker for surfaces.
 *
 * THE ONE FREE VALUE, AND WHY IT IS SAFE
 * `brandColor` accepts a hex, because a pharmacy with a real brand colour
 * asking to use it is a reasonable request that a fixed palette cannot serve.
 * It is safe because nothing downstream trusts it to be readable: the
 * foreground colour paired with it is DERIVED from its luminance, so a
 * pharmacy that picks a pale yellow gets dark text on it automatically and
 * cannot produce the unreadable button that a naive implementation would.
 */

/**
 * Curated palettes.
 *
 * `primary` is the action colour — buttons, links. `ink` is body text,
 * `surface` the page, `muted` the secondary text and rules. Each set was
 * picked so that ink-on-surface and the derived foreground-on-primary both
 * clear WCAG AA at body size.
 *
 * Teal is first and is the default: it is the accent the dashboard itself
 * uses, so a pharmacy that changes nothing gets a site that looks related to
 * the product it came from.
 */
const PALETTES = Object.freeze({
  teal: { primary: '#0f766e', ink: '#0f172a', surface: '#ffffff', muted: '#475569', soft: '#f0fdfa' },
  green: { primary: '#15803d', ink: '#14532d', surface: '#ffffff', muted: '#4b5563', soft: '#f0fdf4' },
  blue: { primary: '#1d4ed8', ink: '#0f172a', surface: '#ffffff', muted: '#475569', soft: '#eff6ff' },
  slate: { primary: '#334155', ink: '#0f172a', surface: '#ffffff', muted: '#475569', soft: '#f8fafc' },
  plum: { primary: '#7e22ce', ink: '#2e1065', surface: '#ffffff', muted: '#52525b', soft: '#faf5ff' },
  clay: { primary: '#b45309', ink: '#431407', surface: '#fffbf5', muted: '#57534e', soft: '#fff7ed' },
});

/**
 * Type pairings. Display face for headings, text face for body.
 *
 * All four are Google Fonts, which the published page's CSP already permits
 * (fonts.googleapis.com for the stylesheet, fonts.gstatic.com for the files
 * — see the header CSP in server/index.js, which allows exactly those two and
 * nothing else). Every stack ends in a real system fallback, because a font
 * that fails to load must degrade to something readable rather than to the
 * browser's default serif at the wrong size.
 */
const FONTS = Object.freeze({
  humanist: {
    label: 'Warm and approachable',
    display: "'Manrope', system-ui, -apple-system, 'Segoe UI', sans-serif",
    text: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    google: 'Manrope:wght@600;700|Inter:wght@400;500;600',
  },
  clinical: {
    label: 'Clean and clinical',
    display: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    text: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    google: 'Inter:wght@400;500;600;700',
  },
  classic: {
    label: 'Established and traditional',
    display: "'Source Serif 4', Georgia, 'Times New Roman', serif",
    text: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    google: 'Source+Serif+4:wght@600;700|Inter:wght@400;500;600',
  },
  bold: {
    label: 'Confident and modern',
    display: "'Space Grotesk', system-ui, -apple-system, sans-serif",
    text: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    google: 'Space+Grotesk:wght@600;700|Inter:wght@400;500;600',
  },
});

const CORNERS = Object.freeze({
  sharp: '2px',
  soft: '10px',
  round: '999px',
});

const DEFAULT_THEME = Object.freeze({ palette: 'teal', font: 'humanist', corners: 'soft' });

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Relative luminance, per WCAG's definition.
 *
 * Used to decide whether text on a colour should be white or near-black. This
 * is the mechanism that lets brandColor be free-form without letting a
 * pharmacy publish an unreadable button — the contrast decision is taken from
 * the colour rather than left to the person choosing it.
 */
function luminance(hex) {
  const channel = (c) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(hex.slice(1, 3));
  const g = channel(hex.slice(3, 5));
  const b = channel(hex.slice(5, 7));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Text colour for a given background.
 *
 * The 0.45 threshold rather than the more usual 0.5: at exactly a half the
 * mid-tone greens and teals a pharmacy is most likely to pick land on white
 * text that is only just legible. Biasing towards dark text on mid tones is
 * the safer error.
 */
function readableOn(hex) {
  return luminance(hex) > 0.45 ? '#0f172a' : '#ffffff';
}

/**
 * Validate a stored theme.
 *
 * Unknown keys are rejected for the same reason block props are: a misspelled
 * `pallete` that silently did nothing would be a support conversation about
 * why the colour will not change.
 *
 * @returns {{ok:true, value:object} | {ok:false, code:string, error:string}}
 */
function validateTheme(input) {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_THEME', error: 'theme must be an object' };
  }

  const allowed = new Set(['palette', 'font', 'corners', 'brandColor']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      return { ok: false, code: 'INVALID_THEME', error: `theme.${key} is not a known setting` };
    }
  }

  const out = {};
  if (input.palette !== undefined) {
    if (!PALETTES[input.palette]) {
      return { ok: false, code: 'INVALID_THEME', error: `theme.palette must be one of: ${Object.keys(PALETTES).join(', ')}` };
    }
    out.palette = input.palette;
  }
  if (input.font !== undefined) {
    if (!FONTS[input.font]) {
      return { ok: false, code: 'INVALID_THEME', error: `theme.font must be one of: ${Object.keys(FONTS).join(', ')}` };
    }
    out.font = input.font;
  }
  if (input.corners !== undefined) {
    if (!CORNERS[input.corners]) {
      return { ok: false, code: 'INVALID_THEME', error: `theme.corners must be one of: ${Object.keys(CORNERS).join(', ')}` };
    }
    out.corners = input.corners;
  }
  if (input.brandColor !== undefined && input.brandColor !== null && input.brandColor !== '') {
    if (typeof input.brandColor !== 'string' || !HEX.test(input.brandColor)) {
      return { ok: false, code: 'INVALID_THEME', error: 'theme.brandColor must be a hex colour like #0f766e' };
    }
    out.brandColor = input.brandColor.toLowerCase();
  }
  return { ok: true, value: out };
}

/**
 * Turn a stored theme into the concrete values the stylesheet needs.
 *
 * Every field is resolved here, so the stylesheet generator never has to know
 * about defaults or about brandColor overriding a palette. A theme of `{}` —
 * which is what every new site has — resolves to a complete, deliberate look
 * rather than to an unstyled page.
 */
function resolveTheme(stored) {
  const theme = { ...DEFAULT_THEME, ...(stored || {}) };
  const palette = PALETTES[theme.palette] || PALETTES[DEFAULT_THEME.palette];
  const font = FONTS[theme.font] || FONTS[DEFAULT_THEME.font];
  const radius = CORNERS[theme.corners] || CORNERS[DEFAULT_THEME.corners];

  const primary = theme.brandColor && HEX.test(theme.brandColor) ? theme.brandColor : palette.primary;

  return {
    ...palette,
    primary,
    // Derived, never chosen. See readableOn.
    onPrimary: readableOn(primary),
    radius,
    fontDisplay: font.display,
    fontText: font.text,
    googleFonts: font.google,
  };
}

module.exports = {
  PALETTES,
  FONTS,
  CORNERS,
  DEFAULT_THEME,
  validateTheme,
  resolveTheme,
  readableOn,
  luminance,
  /** What the branding step offers the owner. Labels, never raw hex lists. */
  themeOptions: () => ({
    palettes: Object.entries(PALETTES).map(([id, p]) => ({ id, primary: p.primary, soft: p.soft })),
    fonts: Object.entries(FONTS).map(([id, f]) => ({ id, label: f.label })),
    corners: Object.keys(CORNERS),
  }),
};
