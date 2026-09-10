/**
 * The design, as one choice with the rest folded away behind it.
 *
 * WHAT THIS REPLACES. The tab used to show CurrentDesign (a card naming the
 * template, with a "Change design" button that WebsiteStatus already had
 * directly above it), then DesignSettings with its palette, type pairing,
 * brand colour and corner radius all expanded, then a separate card for the
 * advanced editor. Four surfaces for one decision, on a screen whose owner is
 * a pharmacist rather than a designer.
 *
 * THE ONE CHOICE IS THE TEMPLATE. "Choose your style" is a thing a pharmacy
 * owner can answer by looking. "Sharp, Soft or Round" is not — it is a
 * question about corner radii, and asking it at the same volume as the
 * template implies the two matter equally.
 *
 * SO: template and its tagline at the top, and everything else behind a
 * disclosure. Progressive disclosure is not a way of hiding features here; it
 * is a statement about which decisions the product has already made on the
 * owner's behalf, which is the whole pitch — your website is already built.
 *
 * THE TEMPLATE'S NAME COMES FROM templates.js, never from a copy held here.
 * This fetches the same manifest TemplatePicker does and looks up the entry
 * matching site.template_id — hardcoding a name or a description would drift
 * the moment templates.js changed one, and would say nothing at all about a
 * template that no longer exists. It would rather show the raw id than a name
 * it made up.
 *
 * THE DISCLOSURE IS UNCONTROLLED BY DESIGN. `<details>` keeps its own open
 * state in the DOM, so nothing here has to hold a boolean that survives a
 * re-render, and a keyboard user gets the toggle behaviour for free.
 */

import { useEffect, useState } from 'react';
import { Panel } from '../DashboardKit.jsx';
import * as api from './api.js';
import SectionTitle from './SectionTitle.jsx';
import DesignSettings from './DesignSettings.jsx';

export default function DesignSection({
  templateId, theme, onThemeChange, onChangeDesign, onOpenEditor,
}) {
  const [template, setTemplate] = useState(null);

  useEffect(() => {
    let live = true;
    api.listTemplates()
      // A failed lookup leaves template null and the id shows instead. The
      // design section is not worth an error banner: everything it controls
      // still works without knowing what the template is called.
      .then((res) => live && setTemplate((res.templates || []).find((t) => t.id === templateId) || null))
      .catch(() => {});
    return () => { live = false; };
  }, [templateId]);

  return (
    <Panel className="p-5 sm:p-6">
      <SectionTitle
        title="Design"
        info="Every design here is complete and ready to publish. Colours, fonts and corners are a small set of approved combinations — there is no wrong one to pick."
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-display text-lg font-semibold text-slate-900">
            {template?.name || templateId}
          </p>
          {template?.description && (
            <p className="mt-0.5 text-sm text-slate-600">{template.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onChangeDesign}
          className="shrink-0 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
        >
          Change design
        </button>
      </div>

      <details className="group mt-5 border-t border-slate-100 pt-4">
        <summary className="cursor-pointer list-none text-sm font-medium text-teal-700 hover:underline">
          <span className="group-open:hidden">Customise colours &amp; fonts</span>
          <span className="hidden group-open:inline">Hide colours &amp; fonts</span>
        </summary>

        <div className="mt-4">
          <DesignSettings theme={theme} onThemeChange={onThemeChange} />
        </div>

        {/* The advanced layer, and it reads like one — inside the disclosure
            rather than beside it. Most pharmacies publish a complete site
            without ever pressing this: choosing a design is the product, and
            this is for the minority who want to rearrange sections. */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">Rearrange sections</p>
            <p className="mt-0.5 text-sm text-slate-600">
              Add, remove and reorder the parts of your homepage. Your details stay where they are.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenEditor}
            className="shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400"
          >
            Open editor
          </button>
        </div>
      </details>
    </Panel>
  );
}
