/**
 * Which design this website is built from, in plain words.
 *
 * NAME AND DESCRIPTION COME FROM templates.js, NOT FROM A COPY HELD HERE.
 * This component fetches the same manifest TemplatePicker does
 * (api.listTemplates()) and looks up the one entry whose id matches
 * site.template_id. That is the only source of truth for what a template is
 * called and how it is described — hardcoding either here would drift the
 * moment templates.js changed a description, and would say nothing at all
 * about a template that does not exist (this component would rather show
 * nothing than a name it made up).
 */

import { useEffect, useState } from 'react';
import { Panel, PanelHead } from '../DashboardKit.jsx';
import { IconWebsite } from '../Icons.jsx';
import * as api from './api.js';

export default function CurrentDesign({ templateId, onChangeDesign }) {
  const [template, setTemplate] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.listTemplates()
      .then((res) => {
        if (!live) return;
        setTemplate((res.templates || []).find((t) => t.id === templateId) || null);
      })
      .catch((err) => live && setError(err.message));
    return () => { live = false; };
  }, [templateId]);

  return (
    <Panel className="p-5 sm:p-6">
      <PanelHead Icon={IconWebsite}>Current design</PanelHead>

      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}

      {!error && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-display text-lg font-semibold text-slate-900">
              {template ? template.name : templateId}
            </p>
            {template?.description && (
              <p className="mt-0.5 text-sm text-slate-600">{template.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onChangeDesign}
            className="shrink-0 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
          >
            Change design
          </button>
        </div>
      )}
    </Panel>
  );
}
