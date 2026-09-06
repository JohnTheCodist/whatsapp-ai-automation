/**
 * The Website section.
 *
 * Two states, and which one you are in is decided by whether a website record
 * exists — not by a wizard step stored somewhere that could disagree with the
 * database:
 *
 *   no site  →  choose a design
 *   a site   →  confirm details, choose how it looks, watch the preview
 *
 * WHY THE STEP IS NOT STATE. A "which step am I on" value has to be persisted
 * or it resets on reload, and once persisted it can drift from reality — an
 * owner who has clearly already chosen a template being shown the picker
 * again, or worse, being offered it after they have a page. Deriving it from
 * the record means reload, refresh and returning tomorrow all land in the
 * right place with nothing to keep in step.
 *
 * THE ORDER OF THIS SCREEN IS THE ORDER OF AN OWNER'S QUESTIONS. Publishing
 * first — "is it live, and where?" — then what it did, then the advanced
 * editor, then the details form. The form is last despite being the largest
 * thing here: it is filled in once and confirmed occasionally, while the two
 * panels above it are what somebody comes back to check.
 */

import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Panel } from '../DashboardKit.jsx';
import TemplatePicker from './TemplatePicker.jsx';
import GuidedSetup from './GuidedSetup.jsx';
import PreviewPane from './PreviewPane.jsx';
import PublishBar from './PublishBar.jsx';
import AnalyticsPanel from './AnalyticsPanel.jsx';
import * as api from './api.js';

/**
 * The advanced editor, in its own chunk.
 *
 * GrapesJS is ~1.15 MB plus a 60 kB stylesheet — larger than the entire
 * dashboard. `lazy` means it is fetched only when a pharmacy actually opens
 * "Customise design", which most never will: the guided form publishes a
 * complete site without it. Importing Editor.jsx normally would put all of
 * that into the initial download for every user of every section of the app.
 */
const Editor = lazy(() => import('./Editor.jsx'));

export default function WebsitePanel({ onNavigate }) {
  const [site, setSite] = useState(undefined); // undefined = loading, null = none yet
  const [error, setError] = useState(null);
  // Bumped whenever something the preview renders has changed. See PreviewPane.
  const [nonce, setNonce] = useState(() => Date.now());
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let live = true;
    api.getWebsite()
      .then((res) => live && setSite(res.site))
      .catch((err) => live && setError(err.message));
    return () => { live = false; };
  }, []);

  const refreshPreview = useCallback(() => setNonce(Date.now()), []);

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

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div>
        <div className="mb-5 max-w-2xl">
          <h2 className="font-display text-2xl font-semibold text-slate-900">
            Your pharmacy website
          </h2>
          <p className="mt-1 text-slate-600">
            Built from the <strong>{site.template_id}</strong> design. Check your details
            below — everything you see in the preview comes from your pharmacy profile,
            so it stays correct on its own.
          </p>
        </div>

        <div className="mb-5">
          <PublishBar
            site={site}
            onChanged={(updated) => { setSite(updated); refreshPreview(); }}
          />
        </div>

        {site.status === 'published' && (
          <div className="mb-5">
            <AnalyticsPanel site={site} />
          </div>
        )}

        {/* The advanced layer, and it reads like one. Most pharmacies publish
            a complete site without ever pressing this, which is why it sits
            below publishing rather than above it — the guided form is the
            product, and this is for the minority who want to rearrange. */}
        <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
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

        <GuidedSetup
          site={site}
          onSaved={refreshPreview}
          onThemeChange={refreshPreview}
          onNavigate={onNavigate}
        />
      </div>

      {/* Sticky on wide screens so the preview stays beside the field being
          edited rather than scrolling away from it. */}
      <div className="xl:sticky xl:top-4 xl:h-[calc(100vh-6rem)]">
        <PreviewPane nonce={nonce} />
      </div>
    </div>
  );
}
