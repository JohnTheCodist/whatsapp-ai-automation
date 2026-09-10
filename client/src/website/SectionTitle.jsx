/**
 * A panel heading, with its explanation behind an icon.
 *
 * REPLACES DashboardKit's PanelHead ON THIS TAB ONLY, and only because of
 * what the tab needed: an icon in a coloured tile beside every heading, on a
 * page with six panels, is six decorations that say nothing — they were the
 * same tile in the same place carrying no information about which panel you
 * were looking at. The heading is the information.
 *
 * The paragraph that used to sit under each heading moves into InfoTip. It
 * was worth reading once and never again, and stacked across the tab it was
 * most of the words on screen.
 *
 * `info` IS OPTIONAL. A panel whose heading is self-explanatory gets no icon
 * rather than an icon revealing a restatement of the heading.
 */

import InfoTip from './InfoTip.jsx';

export default function SectionTitle({ title, info, aside }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="flex items-center gap-2 font-display text-base font-semibold text-slate-900">
        {title}
        {info && <InfoTip label={`About ${title}`}>{info}</InfoTip>}
      </h3>
      {aside}
    </div>
  );
}
