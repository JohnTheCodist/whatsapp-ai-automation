/**
 * Choosing a design.
 *
 * TWO CALLERS, ONE COMPONENT. `mode="create"` is the first screen of the
 * guided flow, for a pharmacy with no website yet — unchanged from how it
 * has always worked. `mode="switch"` is "Change design" on an existing
 * website: the same template list, the same cards, plus a marker for the
 * design already in use, a live preview of each alternative rendered
 * through the real pharmacy's own data, and an action that updates the
 * draft instead of creating a new site. One template list, in one place,
 * used both ways — not two competing pickers that could drift apart.
 *
 * WHAT THE OWNER SEES IS A DESIGN, NOT A CONFIGURATION.
 *
 * Each card is drawn in its own template's colours and lists the sections the
 * page will contain in plain words — "Opening hours", not
 * `pharmacy.openingHours@1`. The block ids are an implementation detail and
 * appear nowhere on this screen; the human labels come from the server's own
 * block contract, so they cannot drift from what actually renders.
 *
 * There is no blank option. Every path from here produces a complete page,
 * because the promise is "your pharmacy online in ten minutes" and a blank
 * canvas is how that becomes an afternoon.
 */

import { useEffect, useState } from 'react';
import { Panel } from '../DashboardKit.jsx';
import * as api from './api.js';

/** Swatch drawn from the template's own palette, so cards differ at a glance. */
function Swatch({ theme }) {
  const primary = theme?.primary || '#0f766e';
  const soft = theme?.soft || '#f0fdfa';
  return (
    <div className="flex h-24 items-end gap-1.5 rounded-t-xl p-4" style={{ background: soft }}>
      <span className="h-2.5 w-16 rounded-full" style={{ background: primary }} />
      <span className="h-2.5 w-8 rounded-full opacity-40" style={{ background: primary }} />
    </div>
  );
}

export default function TemplatePicker({ mode = 'create', activeTemplateId = null, onChosen, onCancel }) {
  const [templates, setTemplates] = useState(null);
  const [labels, setLabels] = useState({});
  const [palettes, setPalettes] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  // Which template's large, single-design preview is open — null shows the
  // grid. Only reachable in switch mode: the create flow has no website yet
  // for a candidate to be rendered against, so it keeps its swatch-only
  // cards exactly as they were.
  const [previewing, setPreviewing] = useState(null);
  const [previewHtml, setPreviewHtml] = useState(null);
  const [previewError, setPreviewError] = useState(null);

  // Fetched rather than framed, for the reason in api.previewHtml: an iframe
  // src is a navigation and carries no bearer token, so pointing one at the
  // preview route renders a 401 page.
  useEffect(() => {
    if (!previewing) return undefined;
    let live = true;
    setPreviewHtml(null);
    setPreviewError(null);
    api.previewHtml(Date.now(), previewing)
      .then((doc) => { if (live) setPreviewHtml(doc); })
      .catch((err) => { if (live) setPreviewError(err.message); });
    return () => { live = false; };
  }, [previewing]);

  useEffect(() => {
    let live = true;
    Promise.all([api.listTemplates(), api.getBlockContract()])
      .then(([t, contract]) => {
        if (!live) return;
        setTemplates(t.templates);
        // type -> human label, straight from the contract the renderer uses,
        // so a card can never promise a section the page will not have.
        setLabels(Object.fromEntries(contract.blocks.map((b) => [b.id, b.label])));
        // A template names a palette by id; the actual colours live in the
        // theme contract. Resolving here rather than shipping hex on the
        // template keeps one definition of what "teal" means.
        setPalettes(Object.fromEntries(contract.theme.palettes.map((p) => [p.id, p])));
      })
      .catch((err) => live && setError(err.message));
    return () => { live = false; };
  }, []);

  async function choose(templateId) {
    setBusy(templateId);
    setError(null);
    try {
      // create: a new website, from nothing. switch: the same draft, a
      // different structure — see websiteService.switchTemplate for exactly
      // what does and does not change.
      const { site } = mode === 'switch'
        ? await api.switchTemplate(templateId)
        : await api.createWebsite(templateId);
      onChosen(site);
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }

  function openPreview(templateId) {
    setPreviewing(templateId);
  }

  if (error && !templates) {
    return <Panel className="p-6"><p className="text-red-700">{error}</p></Panel>;
  }
  if (!templates) {
    return <Panel className="p-6"><p className="text-slate-500">Loading designs…</p></Panel>;
  }

  // ---- the large, single-design preview (switch mode only) ----
  if (previewing) {
    const t = templates.find((x) => x.id === previewing);
    const isCurrent = previewing === activeTemplateId;
    return (
      <div>
        <button
          type="button"
          onClick={() => setPreviewing(null)}
          className="text-sm font-medium text-slate-600 transition hover:text-slate-900"
        >
          ← Back
        </button>

        <div className="mb-4 mt-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-900">{t?.name}</h2>
            <p className="mt-0.5 text-sm text-slate-600">{t?.description}</p>
          </div>
          {isCurrent ? (
            <span className="shrink-0 rounded-full bg-teal-50 px-3 py-1.5 text-sm font-medium text-teal-800 ring-1 ring-inset ring-teal-600/20">
              ● Current design
            </span>
          ) : (
            <button
              type="button"
              onClick={() => choose(previewing)}
              disabled={Boolean(busy)}
              className="shrink-0 rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50"
            >
              {busy === previewing ? 'Switching…' : 'Use this design'}
            </button>
          )}
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        )}

        {!isCurrent && (
          <p className="mb-4 text-xs text-slate-500">
            This updates your draft only — your pharmacy details, photos, services and
            colours stay exactly as they are. Nothing changes on your live website until
            you publish.
          </p>
        )}

        <div className="flex justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-100 p-3">
          {previewError && (
            <p className="px-6 py-10 text-center text-sm text-red-700">{previewError}</p>
          )}
          {!previewError && !previewHtml && (
            <p className="px-6 py-10 text-center text-sm text-slate-500">
              Rendering this design with your pharmacy’s details…
            </p>
          )}
          {!previewError && previewHtml && (
            <iframe
              title={`Preview of the ${t?.name || 'selected'} design`}
              srcDoc={previewHtml}
              // Same responsive height as PreviewPane, for the same reason: a
              // fixed 820px is the right focal point on a desktop and taller
              // than the entire viewport on a phone.
              className="h-[60vh] min-h-[380px] w-full max-w-4xl rounded-lg border border-slate-200 bg-white shadow-sm sm:h-[620px] sm:min-h-0 xl:h-[820px]"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
            />
          )}
        </div>
      </div>
    );
  }

  // ---- the grid ----
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="font-display text-2xl font-semibold text-slate-900">
            {mode === 'switch' ? 'Change your design' : 'Create your pharmacy website'}
          </h2>
          <p className="mt-1 text-slate-600">
            {mode === 'switch'
              ? 'Pick another design for your website. Your pharmacy name, details, photos, '
                + 'services and colours stay exactly as they are — only the layout changes, and '
                + 'nothing goes live until you publish.'
              : 'Choose a design to start from. Your pharmacy name, address, opening hours and '
                + 'WhatsApp number are filled in from your existing details — you can change the '
                + 'design later without losing them.'}
          </p>
        </div>
        {mode === 'switch' && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
          >
            Cancel
          </button>
        )}
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {templates.map((t) => {
          const isCurrent = mode === 'switch' && t.id === activeTemplateId;
          return (
            <div
              key={t.id}
              className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md"
            >
              <Swatch theme={palettes[t.theme?.palette]} />
              <div className="flex flex-1 flex-col p-5">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-display text-lg font-semibold text-slate-900">{t.name}</h3>
                  {isCurrent && (
                    <span className="shrink-0 rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-800 ring-1 ring-inset ring-teal-600/20">
                      ● Current
                    </span>
                  )}
                </div>
                <p className="mt-1 flex-1 text-sm text-slate-600">{t.description}</p>

                <p className="mt-4 text-xs font-medium uppercase tracking-wide text-slate-400">
                  Your page will have
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {t.blocks.map((type, i) => (
                    <li
                      key={`${type}-${i}`}
                      className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                    >
                      {labels[type] || type}
                    </li>
                  ))}
                </ul>

                <div className="mt-5 flex flex-col gap-2">
                  {mode === 'switch' && (
                    <button
                      type="button"
                      onClick={() => openPreview(t.id)}
                      className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
                    >
                      View preview
                    </button>
                  )}
                  {isCurrent ? (
                    <span className="rounded-lg px-4 py-2 text-center text-sm font-medium text-teal-800">
                      ● Current design
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => choose(t.id)}
                      disabled={Boolean(busy)}
                      className="rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50"
                    >
                      {busy === t.id ? (mode === 'switch' ? 'Switching…' : 'Setting up…') : 'Use this design'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
