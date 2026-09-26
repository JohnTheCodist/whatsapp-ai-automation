/**
 * The patient figure on the record's summary.
 *
 * WHAT IT IS: a drawn anatomical figure, male or female, whose regions can
 * be pointed at. Where the pharmacy has recorded something about a region —
 * today, a confirmed condition or a danger sign from a consultation — the
 * region carries a marker, and choosing it opens the section of the record
 * that holds it.
 *
 * WHY IT IS DRAWN AND NOT A 3D MODEL. The owner's reference was a rendered
 * anatomical mesh. A real one means a licensed model plus a WebGL runtime —
 * three.js is ~600KB before the mesh — and this dashboard's main bundle is
 * what every member of staff waits for on every shift (see the lazy import
 * in App.jsx). This is inline SVG: a few kilobytes, no request, no licence,
 * it prints, it scales, and it is the same drawing at any zoom. If rotation
 * is ever wanted, the region model below is what a 3D version would bind to,
 * so nothing here is thrown away.
 *
 * WHAT IT MUST NEVER DO: imply a finding. A region is marked only where
 * there is a record to point at, the marker names its source, and a region
 * with nothing recorded says exactly that. An anatomy diagram is read as
 * clinical fact, and this one is drawn from purchase history and consultation
 * notes — so the wording carries that every time it speaks.
 *
 * NOT A DIAGNOSIS ANYWHERE: the figure shows WHERE something is recorded,
 * never what is wrong with someone.
 */

import { useId, useState } from 'react';

/**
 * The regions, front view, top to bottom. `d` is the outline; `marker` is
 * where a dot sits when that region has something recorded.
 *
 * Two silhouettes, because the owner asked the figure to match the patient:
 * male shoulders are wider than the hips, female hips wider than the
 * shoulders with the waist drawn in. Everything else — arms, legs, head —
 * is shared, and `sex: null` (not recorded) draws the neutral figure rather
 * than guessing, because guessing is what puts the wrong body on a record.
 */
const TORSO = {
  // Shoulders wider than the hips, waist barely drawn in.
  male: 'M62,96 Q62,84 76,80 L124,80 Q138,84 138,96 L134,146 Q130,186 127,212 Q125,238 122,252 L78,252 Q75,238 73,212 Q70,186 66,146 Z',
  // Hips wider than the shoulders, and the waist pulled in at the middle.
  female: 'M70,96 Q70,84 81,80 L119,80 Q130,84 130,96 L127,136 Q122,166 118,180 Q125,204 128,224 Q129,242 126,252 L74,252 Q71,242 72,224 Q75,204 82,180 Q78,166 73,136 Z',
  // Not recorded: neither silhouette, because guessing is what puts the
  // wrong body on somebody's record.
  neutral: 'M66,96 Q66,84 78,80 L122,80 Q134,84 134,96 L131,146 Q127,186 124,212 Q123,238 120,252 L80,252 Q77,238 76,212 Q73,186 69,146 Z',
};

const REGIONS = [
  {
    id: 'head',
    label: 'Head and neck',
    d: 'M100,16 C114,16 124,28 124,44 C124,60 114,72 100,72 C86,72 76,60 76,44 C76,28 86,16 100,16 Z M92,70 L108,70 L108,82 L92,82 Z',
    marker: [100, 44],
  },
  {
    id: 'chest',
    label: 'Chest',
    // Heart and lungs. The one region drawn with its organs, because it is
    // the one most conditions in this pharmacy's register belong to.
    d: 'M68,92 L132,92 L128,156 L72,156 Z',
    marker: [100, 120],
    organs: [
      'M78,100 Q70,116 74,140 Q86,142 92,134 L92,100 Z',
      'M122,100 Q130,116 126,140 Q114,142 108,134 L108,100 Z',
    ],
    heart: 'M100,124 C96,116 86,118 86,127 C86,136 97,142 100,146 C103,142 114,136 114,127 C114,118 104,116 100,124 Z',
  },
  {
    id: 'abdomen',
    label: 'Abdomen',
    d: 'M72,158 L128,158 Q126,206 122,252 L78,252 Q74,206 72,158 Z',
    marker: [100, 198],
  },
  // The arms start INSIDE the torso's outline. Drawn to its edge they read
  // as two pieces laid beside a body rather than one body, which is what the
  // first version of this figure looked like.
  {
    id: 'arm-left',
    label: 'Left arm',
    d: 'M72,84 Q56,88 52,112 L45,176 Q41,206 45,236 Q50,239 57,236 Q60,206 61,180 L70,130 Z',
    marker: [52, 172],
  },
  {
    id: 'arm-right',
    label: 'Right arm',
    d: 'M128,84 Q144,88 148,112 L155,176 Q159,206 155,236 Q150,239 143,236 Q140,206 139,180 L130,130 Z',
    marker: [148, 172],
  },
  // Legs overlap the torso at the hip for the same reason, and end in a
  // foot: a leg stopped flat at the ankle reads as an unfinished drawing.
  {
    id: 'leg-left',
    label: 'Left leg',
    d: 'M78,240 L76,304 Q74,354 77,396 L76,410 Q75,418 82,418 L93,418 Q96,418 96,410 L95,396 Q97,354 98,304 L99,240 Z',
    marker: [86, 322],
  },
  {
    id: 'leg-right',
    label: 'Right leg',
    d: 'M122,240 L124,304 Q126,354 123,396 L124,410 Q125,418 118,418 L107,418 Q104,418 104,410 L105,396 Q103,354 102,304 L101,240 Z',
    marker: [114, 322],
  },
];

/** The contour lines that give the drawing its depth, purely decorative. */
const CONTOURS = [
  'M100,20 L100,240', 'M86,418 L86,246', 'M114,418 L114,246',
  'M84,86 Q82,170 78,250', 'M116,86 Q118,170 122,250',
  'M68,122 Q100,130 132,122', 'M74,172 Q100,180 126,172', 'M74,214 Q100,222 126,214',
  'M88,34 Q100,40 112,34', 'M92,72 Q100,76 108,72',
];

export default function AnatomicalAvatar({
  sex = null, markers = [], onSelect, height = 300,
}) {
  const [hovered, setHovered] = useState(null);
  const gid = useId().replace(/:/g, '');
  const torso = TORSO[sex] || TORSO.neutral;
  const byRegion = new Map(markers.map((m) => [m.region, m]));
  const shown = hovered && (byRegion.get(hovered) || { region: hovered, note: 'Nothing recorded here' });
  const regionLabel = (id) => REGIONS.find((r) => r.id === id)?.label || id;

  return (
    <div className="ui-avatar">
      <svg
        viewBox="0 0 200 430"
        style={{ height, width: 'auto' }}
        role="img"
        aria-label={
          markers.length
            ? `Body map. ${markers.length} region${markers.length === 1 ? '' : 's'} with something recorded.`
            : 'Body map. Nothing recorded against any region yet.'
        }
      >
        <defs>
          {/* Light from the top left, the way an illustration plate is lit. */}
          <linearGradient id={`${gid}-skin`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="oklch(88% 0.045 62)" />
            <stop offset="55%" stopColor="oklch(80% 0.055 58)" />
            <stop offset="100%" stopColor="oklch(68% 0.055 48)" />
          </linearGradient>
          <linearGradient id={`${gid}-organ`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="oklch(72% 0.105 235 / 0.55)" />
            <stop offset="100%" stopColor="oklch(55% 0.115 245 / 0.65)" />
          </linearGradient>
          <radialGradient id={`${gid}-glow`}>
            <stop offset="0%" stopColor="var(--ui-accent)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--ui-accent)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* ---- the body ---- */}
        <g className="ui-avatar-body">
          {REGIONS.filter((r) => r.id !== 'chest' && r.id !== 'abdomen').map((r) => (
            <path key={r.id} d={r.d} fill={`url(#${gid}-skin)`} />
          ))}
          <path d={torso} fill={`url(#${gid}-skin)`} />
          {/* The chest's contents, as the reference draws them. */}
          {REGIONS.find((r) => r.id === 'chest').organs.map((d, i) => (
            <path key={d} d={d} fill={`url(#${gid}-organ)`} opacity={0.9 - i * 0.05} />
          ))}
          <path d={REGIONS.find((r) => r.id === 'chest').heart} fill="oklch(62% 0.13 25 / 0.55)" />
          <g className="ui-avatar-contours">
            {CONTOURS.map((d) => <path key={d} d={d} />)}
          </g>
        </g>

        {/* ---- the regions you can point at ---- */}
        {REGIONS.map((r) => {
          const mark = byRegion.get(r.id);
          const on = hovered === r.id;
          return (
            <g
              key={r.id}
              role="button"
              tabIndex={0}
              aria-label={mark ? `${r.label}: ${mark.note}` : `${r.label}: nothing recorded`}
              className={`ui-avatar-region ${on ? 'is-on' : ''} ${mark ? 'has-mark' : ''}`}
              onMouseEnter={() => setHovered(r.id)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(r.id)}
              onBlur={() => setHovered(null)}
              onClick={() => onSelect?.(mark ? mark.tab : null, r.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect?.(mark ? mark.tab : null, r.id);
                }
              }}
            >
              <path d={r.d} className="ui-avatar-hit" />
              {mark && (
                <>
                  <circle cx={r.marker[0]} cy={r.marker[1]} r="16" fill={`url(#${gid}-glow)`} />
                  <circle cx={r.marker[0]} cy={r.marker[1]} r="5" className="ui-avatar-dot" />
                </>
              )}
            </g>
          );
        })}
      </svg>

      {/* One line under the figure, so what a region holds is readable
          without a tooltip that a touch screen cannot show. */}
      <p className="ui-avatar-caption" aria-live="polite">
        {shown
          ? <><span className="font-medium text-[var(--ui-ink)]">{regionLabel(shown.region)}</span> · {shown.note}</>
          : <span className="text-[var(--ui-ink-faint)]">Point at a part of the body to see what is recorded</span>}
      </p>
    </div>
  );
}
