/**
 * How the pharmacy's facts are worded on the website.
 *
 * WHAT MOVED OUT, AND WHY. This used to be one list of seven rows covering
 * both the pharmacy's details and the site's wording. Those are two different
 * things and the data already knew it: pharmacy information, opening hours,
 * services and photos all write to `pharmacy_profile`/`pharmacies` and are
 * inherited by the site at render time, so they now live in BusinessInfo.
 * Everything left here writes to the website's own `content` column and
 * changes nothing outside the website.
 *
 * That is the distinction an owner needs and never had a name for:
 * business information is the facts, website content is the presentation.
 *
 * "WEBSITE PAGES", NOT "WEBSITE PAGE TEXT". The old label read like a
 * database column. Nobody thinks "I must edit my website page text"; they
 * think "I want to change what customers see on my About page".
 *
 * NOTHING HERE IS REQUIRED. Every row is an override of copy the site already
 * writes for itself — a pharmacy that never opens this panel still has a
 * complete website, which is the entire promise of the product.
 */

import { useState } from 'react';
import { Panel, PanelHead } from '../DashboardKit.jsx';
import { IconWebsite } from '../Icons.jsx';
import Row from './Row.jsx';
import HealthTopics from './HealthTopics.jsx';
import PageText from './PageText.jsx';
import HomeContent from './HomeContent.jsx';

export default function WebsiteContent({ site, pages, onSaved }) {
  const [open, setOpen] = useState(null);
  const toggle = (key) => setOpen((current) => (current === key ? null : key));

  // The generated pages, named the way they are in the site's own navigation.
  // Listed in the summary so the row says what is inside it before it is
  // opened — "About, Services, Contact" is a far better answer to "what is
  // this?" than a count is.
  const pageNames = (pages || []).map((p) => p.nav).filter(Boolean);
  const pagesSummary = pageNames.length
    ? pageNames.slice(0, 4).join(', ') + (pageNames.length > 4 ? `, +${pageNames.length - 4} more` : '')
    : 'Nothing to edit yet — add an address or a service first';

  const healthCount = Array.isArray(site?.content?.health) ? site.content.health.length : 0;

  return (
    <Panel className="p-5 sm:p-6">
      <PanelHead Icon={IconWebsite}>Website content</PanelHead>
      <p className="mt-1 text-sm text-slate-600">
        Your website writes itself from your pharmacy details. Change the wording here if
        you would rather say it your own way.
      </p>

      <div className="mt-2">
        <Row
          label="Homepage"
          summary="The heading, subheading and button text customers see first"
          actionLabel="Edit →"
          expanded={open === 'homeContent'}
          onToggle={() => toggle('homeContent')}
        >
          <HomeContent site={site} onSaved={() => onSaved?.()} />
        </Row>

        <Row
          label="Website pages"
          summary={pagesSummary}
          actionLabel="Edit →"
          expanded={open === 'pageText'}
          onToggle={() => toggle('pageText')}
        >
          <PageText site={site} pages={pages} onSaved={() => onSaved?.()} />
        </Row>

        <Row
          label="Health guides"
          summary={healthCount
            ? `${healthCount} guide${healthCount === 1 ? '' : 's'} on your website`
            : 'Reviewed articles you can add to your website'}
          actionLabel="Manage →"
          expanded={open === 'health'}
          onToggle={() => toggle('health')}
        >
          <HealthTopics site={site} onSaved={() => onSaved?.()} />
        </Row>
      </div>
    </Panel>
  );
}
