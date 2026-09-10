/**
 * The Website section.
 *
 * WHAT THIS SCREEN SAYS, IN ONE LINE: your website is already built — here
 * it is, and here is how to change it. Not "here is a builder".
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
 * THE ORDER, AND WHY IT CHANGED. This page used to claim its order was "the
 * order of an owner's questions" and then contradict itself: publishing was
 * the very last control, so the state an owner most needs — am I live, and is
 * there a button I have not pressed — was the one thing they had to scroll
 * for. "Change design" appeared twice within two hundred pixels, on either
 * side of a preview that already showed them their design. And one list of
 * seven rows mixed the pharmacy's facts with the website's wording, which are
 * two different things that write to two different places.
 *
 * The order now is:
 *
 *   header      what it is, whether it is live, and the three actions
 *   preview     the thing itself
 *   performance did it do anything
 *   business    the facts (profile — shared with the assistant)
 *   content     how those facts are worded (the site's own content column)
 *   design      one choice, with the rest folded behind it
 *   publishing  the address, and taking it down
 *
 * Read at a glance from the top; set-once decisions at the bottom.
 *
 * PUBLISHING IS ONE STATE MACHINE, CREATED HERE. usePublishing is built once
 * and handed to both the header and PublishBar, so the Publish button at the
 * top and the one at the bottom are the same button in two places rather than
 * two that could disagree about whether a request is in flight.
 */

import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Panel } from '../DashboardKit.jsx';
import TemplatePicker from './TemplatePicker.jsx';
import WebsiteHeader from './WebsiteHeader.jsx';
import BusinessInfo from './BusinessInfo.jsx';
import WebsiteContent from './WebsiteContent.jsx';
import DesignSection from './DesignSection.jsx';
import PreviewPane from './PreviewPane.jsx';
import PublishBar from './PublishBar.jsx';
import AnalyticsPanel from './AnalyticsPanel.jsx';
import usePublishing from './usePublishing.js';
import * as api from './api.js';

/**
 * The advanced editor, in its own chunk.
 *
 * GrapesJS is ~1.15 MB plus a 60 kB stylesheet — larger than the entire
 * dashboard. `lazy` means it is fetched only when a pharmacy actually opens
 * the section editor, which most never will: choosing a design and confirming
 * their details publishes a complete site without it.
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
  const [pharmacy, setPharmacy] = useState(null);
  // The domain pharmacy sites hang off, or null when only the path form is
  // live. Comes from the server because the browser cannot tell — see
  // api.publicUrl.
  const [publicDomain, setPublicDomain] = useState(null);
  // The generated pages this site currently has (About, Services, one per
  // service, Location, Contact) — computed server-side by the exact same
  // function the renderer and the sitemap use, so this list can never name a
  // page that does not actually exist.
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

  // The pharmacy's name, for the header. Its own request rather than a field
  // threaded out of BusinessInfo: that panel is below the fold and may not
  // have loaded, and a header that pops its own title in late reads worse
  // than one that is briefly generic.
  useEffect(() => {
    let live = true;
    api.getPharmacy().then((p) => live && setPharmacy(p)).catch(() => {});
    return () => { live = false; };
  }, []);

  const refreshPreview = useCallback(() => setNonce(Date.now()), []);

  // Adding or removing a service changes which generated pages exist.
  // Re-fetching keeps the "Website pages" editor's list in step with reality
  // rather than whatever it was when the tab opened.
  const refreshPages = useCallback(() => {
    api.getWebsite().then((res) => setPages(Array.isArray(res.pages) ? res.pages : [])).catch(() => {});
  }, []);

  const onContentSaved = useCallback(() => {
    refreshPreview();
    refreshPages();
  }, [refreshPreview, refreshPages]);

  const onPublishChanged = useCallback((updated) => {
    setSite(updated);
    refreshPreview();
  }, [refreshPreview]);

  // Created unconditionally: hooks cannot live behind the early returns
  // below, and it costs nothing on the branches that never render a button.
  const publishing = usePublishing(onPublishChanged);

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
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Website</p>

      <WebsiteHeader
        site={site}
        pharmacy={pharmacy}
        publicDomain={publicDomain}
        publishing={publishing}
        onEdit={() => setEditing(true)}
      />

      {/* The focal point. Everything below is a way of changing something you
          can see here. */}
      <PreviewPane nonce={nonce} />

      {/* AnalyticsPanel returns null unless the site is published — a panel of
          zeroes above an unpublished site reads as a broken feature rather
          than an empty one. The label is inside the same condition so it does
          not sit above nothing. */}
      {site.status === 'published' && (
        <div>
          <SectionLabel>Performance</SectionLabel>
          <AnalyticsPanel site={site} />
        </div>
      )}

      {/* The facts, then the wording. Two panels rather than one list of
          seven rows, because they write to two different places and only the
          first of them also changes what the assistant tells customers. */}
      <BusinessInfo onSaved={onContentSaved} onNavigate={onNavigate} />

      <WebsiteContent site={site} pages={pages} onSaved={onContentSaved} />

      <DesignSection
        templateId={site.template_id}
        theme={site.theme}
        onThemeChange={refreshPreview}
        onChangeDesign={() => setChangingDesign(true)}
        onOpenEditor={() => setEditing(true)}
      />

      <div>
        <SectionLabel>Publishing</SectionLabel>
        <PublishBar
          site={site}
          publicDomain={publicDomain}
          publishing={publishing}
        />
      </div>
    </div>
  );
}
