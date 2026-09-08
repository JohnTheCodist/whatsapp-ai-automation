/**
 * How the website looks — a small set of approved choices, not a design tool.
 *
 * RxNaija controls the design system; the owner picks from it. Every option
 * rendered here comes from the server's own theme contract
 * (blocks/theme.js's themeOptions(), shipped through GET /api/website/blocks)
 * — six palettes, four type pairings, three corner radii. There is no CSS
 * input, no margin/padding control and no font upload here, and there never
 * should be: that is what keeps every combination looking deliberate.
 *
 * brandColor is the one free value the server accepts, and it is safe
 * precisely because nothing trusts it to be readable — resolveTheme derives
 * the text colour from its luminance server-side. Exposed here as a single
 * colour swatch, not a colour-theory editor.
 */

import { useEffect, useState } from 'react';
import { Panel, PanelHead } from '../DashboardKit.jsx';
import { IconSetup } from '../Icons.jsx';
import * as api from './api.js';

export default function DesignSettings({ theme: initialTheme, onThemeChange }) {
  const [contract, setContract] = useState(null);
  const [theme, setTheme] = useState(initialTheme || {});
  const [status, setStatus] = useState({ state: 'loading' });

  useEffect(() => {
    let live = true;
    api.getBlockContract()
      .then((c) => { if (live) { setContract(c); setStatus({ state: 'idle' }); } })
      .catch((err) => live && setStatus({ state: 'error', message: err.message }));
    return () => { live = false; };
  }, []);

  async function applyTheme(next) {
    const previous = theme;
    setTheme(next);
    try {
      await api.saveTheme(next);
      setStatus({ state: 'idle' });
      onThemeChange?.();
    } catch (err) {
      setTheme(previous); // put it back — a rejected theme must not look applied
      setStatus({ state: 'error', message: err.message });
    }
  }

  if (status.state === 'loading') {
    return (
      <Panel className="p-5 sm:p-6">
        <p className="text-sm text-slate-500">Loading design options…</p>
      </Panel>
    );
  }

  return (
    <Panel className="p-5 sm:p-6">
      <PanelHead Icon={IconSetup}>Design</PanelHead>
      <p className="mt-1 mb-4 text-sm text-slate-600">
        A small set of combinations, all designed to work well together. Your website
        preview updates as you choose.
      </p>

      {status.state === 'error' && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{status.message}</p>
      )}

      <p className="mb-2 text-sm font-medium text-slate-700">Colour</p>
      <div className="mb-5 flex flex-wrap gap-2">
        {(contract?.theme.palettes || []).map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => applyTheme({ ...theme, palette: p.id })}
            aria-label={p.id}
            aria-pressed={theme.palette === p.id}
            className={`h-10 w-10 rounded-full ring-offset-2 transition ${
              theme.palette === p.id ? 'ring-2 ring-slate-900' : 'ring-1 ring-slate-200'
            }`}
            style={{ background: p.primary }}
          />
        ))}
      </div>

      <p className="mb-2 text-sm font-medium text-slate-700">Type</p>
      <div className="mb-5 flex flex-wrap gap-2">
        {(contract?.theme.fonts || []).map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => applyTheme({ ...theme, font: f.id })}
            aria-pressed={theme.font === f.id}
            className={`rounded-lg border px-3 py-2 text-sm transition ${
              theme.font === f.id
                ? 'border-teal-700 bg-teal-50 text-teal-800'
                : 'border-slate-300 text-slate-600 hover:border-slate-400'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <p className="mb-2 text-sm font-medium text-slate-700">Corners</p>
      <div className="mb-5 flex flex-wrap gap-2">
        {(contract?.theme.corners || []).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => applyTheme({ ...theme, corners: c })}
            aria-pressed={theme.corners === c}
            className={`rounded-lg border px-3 py-2 text-sm capitalize transition ${
              theme.corners === c
                ? 'border-teal-700 bg-teal-50 text-teal-800'
                : 'border-slate-300 text-slate-600 hover:border-slate-400'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="border-t border-slate-100 pt-4">
        <p className="mb-2 text-sm font-medium text-slate-700">Brand colour (optional)</p>
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={theme.brandColor || '#0f766e'}
            onChange={(e) => applyTheme({ ...theme, brandColor: e.target.value })}
            aria-label="Custom brand colour"
            className="h-9 w-9 cursor-pointer rounded border border-slate-300 p-0.5"
          />
          <span className="text-xs text-slate-500">
            Overrides the colour above with your own. Text stays readable automatically.
          </span>
          {theme.brandColor && (
            <button
              type="button"
              // Sent as a whole theme object without the key, not as
              // `brandColor: null` — saveContent replaces the column with
              // exactly what it is given, so an absent key is how a setting
              // is cleared. The other keys travel with it for the same
              // reason.
              onClick={() => {
                const next = { ...theme };
                delete next.brandColor;
                applyTheme(next);
              }}
              className="shrink-0 text-xs font-medium text-slate-500 underline hover:text-red-600"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </Panel>
  );
}
