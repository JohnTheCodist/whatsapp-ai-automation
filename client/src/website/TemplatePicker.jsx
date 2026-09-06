/**
 * Choosing a design — the first screen of the guided flow.
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

export default function TemplatePicker({ onChosen }) {
  const [templates, setTemplates] = useState(null);
  const [labels, setLabels] = useState({});
  const [palettes, setPalettes] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

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
      const { site } = await api.createWebsite(templateId);
      onChosen(site);
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }

  if (error && !templates) {
    return <Panel className="p-6"><p className="text-red-700">{error}</p></Panel>;
  }
  if (!templates) {
    return <Panel className="p-6"><p className="text-slate-500">Loading designs…</p></Panel>;
  }

  return (
    <div>
      <div className="mb-6 max-w-2xl">
        <h2 className="font-display text-2xl font-semibold text-slate-900">
          Create your pharmacy website
        </h2>
        <p className="mt-1 text-slate-600">
          Choose a design to start from. Your pharmacy name, address, opening hours and
          WhatsApp number are filled in from your existing details — you can change the
          design later without losing them.
        </p>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {templates.map((t) => (
          <div
            key={t.id}
            className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md"
          >
            <Swatch theme={palettes[t.theme?.palette]} />
            <div className="flex flex-1 flex-col p-5">
              <h3 className="font-display text-lg font-semibold text-slate-900">{t.name}</h3>
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

              <button
                type="button"
                onClick={() => choose(t.id)}
                disabled={Boolean(busy)}
                className="mt-5 rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50"
              >
                {busy === t.id ? 'Setting up…' : 'Use this design'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
