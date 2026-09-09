/**
 * The Website section.
 *
 * WHAT THIS SCREEN SAYS, IN ONE LINE: your website is already built — here
 * it is, and here is how to change how it looks. Not "here is a builder".
 * The pharmacy gave us their details during onboarding; the site exists as a
 * consequence of that, and everything on this page is either a view of it or
 * a small, bounded choice about it.
 *
 * WHICH STATE YOU ARE IN IS DERIVED, NEVER STORED. A "which step am I on"
 * value has to be persisted or it resets on reload, and once persisted it can
 * drift from reality — an owner who has clearly already chosen a template
 * being shown the picker again, or worse, being offered it after they have a
 * page. So:
 *
 *   no site       →  choose a design            (TemplatePicker, create mode)
 *   changing      →  compare and switch designs (TemplatePicker, switch mode)
 *   editing       →  the advanced editor        (lazy GrapesJS)
 *   otherwise     →  the website, top to bottom
 *
 * THE ORDER OF THE MAIN VIEW IS THE ORDER OF AN OWNER'S QUESTIONS.
 * Is it live and where (status) → what does it look like (preview) → what
 * design is that (current design) → did it do anything (performance) → what
 * is on it (content) → how does it look (design) → the address and the
 * publish button (settings). The two things somebody comes back to check are
 * at the top; the things they set once are at the bottom.
 *
 * PUBLISHING IS NOT REIMPLEMENTED HERE. PublishBar owns the address form and
 * the publish/unpublish calls exactly as it always has — this file only
 * decides where on the page it sits.
 */

import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Panel } from '../DashboardKit.jsx';
import TemplatePicker from './TemplatePicker.jsx';
import WebsiteStatus from './WebsiteStatus.jsx';
import CurrentDesign from './CurrentDesign.jsx';
import WebsiteContent from './WebsiteContent.jsx';
import DesignSettings from './DesignSettings.jsx';
import PreviewPane from './PreviewPane.jsx';
import PublishBar from './PublishBar.jsx';
import AnalyticsPanel from './AnalyticsPanel.jsx';
import * as api from './api.js';

/**
 * The advanced editor, in its own chunk.
 *
 * GrapesJS is ~1.15 MB plus a 60 kB stylesheet — larger than the entire
 * dashboard. `lazy` means it is fetched only when a pharmacy actually opens
 * "Customise design", which most never will: choosing a design and confirming
 * their details publishes a complete site without it. Importing Editor.jsx
 * normally would put all of that into the initial download for every user of
 * every section of the app.
 */
const Editor = lazy(() => import('./Editor.jsx'));

/** A section label above a card, so the page reads as a sequence of answers. */
function SectionLabel({ children }) {
  return (
    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{children}</p>
  );
}

export default function WebsitePanel({ onNavigate }) {
  const [site, setSite] = useState(undefined); // undefined = loading, null = none yet
  // The domain pharmacy sites hang off, or null when only the path form is
  // live. Comes from the server because the browser cannot tell — see
  // api.publicUrl.
  const [publicDomain, setPublicDomain] = useState(null);
  // The generated pages this site currently has (About, Services, one per
  // service, Location, Contact) — computed server-side by the exact same
  // function the renderer and the sitemap use, so this list can never name a
  // page that does not actually exist. See WebsiteContent's "Website page
  // text" row, the only consumer.
  const [pages, setPages] = useState([]);
  const [error, setError] = useState(null);
  // Bumped whenever something the preview renders has changed. See PreviewPane.
  const [nonce, setNonce] = useState(() => Date.now());
  const [editing, setEditing] = useState(false);
  const [changingDesign, setChangingDesign] = useState(false);

  useEffect(() => {
    let live = true;
    api.getWebsite()
      .then((res) => {
        if (!live) return;
        // Before setSite, which is what unblocks the render: the publish bar
        // must never paint a frame showing the wrong address shape.
        setPublicDomain(res.publicDomain || null);
        setPages(Array.isArray(res.pages) ? res.pages : []);
        setSite(res.site);
      })
      .catch((err) => live && setError(err.message));
    return () => { live = false; };
  }, []);

  const refreshPreview = useCallback(() => setNonce(Date.now()), []);

  // Adding or removing a service inside WebsiteContent changes which
  // generated pages exist. Re-fetching keeps the "Website page text" editor's
  // list in step with reality rather than whatever it was when the tab
  // opened — simplest correct option, since the page list has no narrower
  // endpoint of its own (see routes/website.js's GET / for why one wasn't
  // added just for this).
  const refreshPages = useCallback(() => {
    api.getWebsite().then((res) => setPages(Array.isArray(res.pages) ? res.pages : [])).catch(() => {});
  }, []);

  const onContentSaved = useCallback(() => {
    refreshPreview();
    refreshPages();
  }, [refreshPreview, refreshPages]);

  if (error) {
    return (
      <Panel className="p-6">
        <p className="text-red-700">{error}</p>
        <p className="mt-2 text-sm text-slate-500">
          Your website details could not be loaded. Nothing has been changed.
        </p>
      </Panel>
    );
  }

  if (site === undefined) {
    return <Panel className="p-6"><p className="text-slate-500">Loading…</p></Panel>;
  }

  if (site === null) {
    return (
      <TemplatePicker
        onChosen={(created) => { setSite(created); refreshPreview(); }}
      />
    );
  }

  // The editor takes the whole canvas: a section-reordering surface squeezed
  // beside a form is neither.
  if (editing) {
    return (
      <Suspense fallback={<Panel className="p-6"><p className="text-slate-500">Loading the editor…</p></Panel>}>
        <Editor
          site={site}
          onSaved={(updated) => { setSite(updated); refreshPreview(); }}
          onClose={() => { setEditing(false); refreshPreview(); }}
        />
      </Suspense>
    );
  }

  // Comparing designs takes the whole canvas too, and for the same reason:
  // the thing being compared is a full-width rendering of the real site.
  // Switching updates the DRAFT only — nothing here publishes.
  if (changingDesign) {
    return (
      <TemplatePicker
        mode="switch"
        activeTemplateId={site.template_id}
        onChosen={(updated) => { setSite(updated); refreshPreview(); setChangingDesign(false); }}
        onCancel={() => setChangingDesign(false)}
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-7">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Website</p>
        <h2 className="font-display text-2xl font-semibold text-slate-900">
          Your pharmacy on the web
        </h2>
      </div>

      <WebsiteStatus
        site={site}
        publicDomain={publicDomain}
        onChangeDesign={() => setChangingDesign(true)}
      />

      {/* The focal point. Everything below is a way of changing something you
          can see here. */}
      <PreviewPane nonce={nonce} />

      <CurrentDesign
        templateId={site.template_id}
        onChangeDesign={() => setChangingDesign(true)}
      />

      {/* AnalyticsPanel returns null unless the site is published — a panel of
          zeroes above an unpublished site reads as a broken feature rather
          than an empty one. The label is inside the same condition so it does
          not sit above nothing. */}
      {site.status === 'published' && (
        <div>
          <SectionLabel>Website performance</SectionLabel>
          <AnalyticsPanel site={site} />
        </div>
      )}

      <WebsiteContent site={site} pages={pages} onSaved={onContentSaved} onNavigate={onNavigate} />

      <div className="flex flex-col gap-4">
        <DesignSettings theme={site.theme} onThemeChange={refreshPreview} />

        {/* The advanced layer, and it reads like one. Most pharmacies publish
            a complete site without ever pressing this, which is why it sits
            below the approved choices rather than above them — choosing a
            design is the product, and this is for the minority who want to
            rearrange. */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">Customise the design</p>
            <p className="mt-0.5 text-sm text-slate-600">
              Add, remove and reorder sections. Your details stay where they are.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="shrink-0 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
          >
            Open editor
          </button>
        </div>
      </div>

      <div>
        <SectionLabel>Website settings</SectionLabel>
        <PublishBar
          site={site}
          publicDomain={publicDomain}
          onChanged={(updated) => { setSite(updated); refreshPreview(); }}
        />
      </div>
    </div>
  );
}
