/**
 * The live preview.
 *
 * AN IFRAME POINTED AT THE REAL RENDERER, not a React re-implementation of
 * the blocks. Whatever appears here came out of the same server code that
 * will publish the page, through the same stylesheet, from the same stored
 * data — so "it looked different once it was live" is not a failure mode this
 * design has.
 *
 * THE IFRAME ONLY WORKS BECAUSE THE ROUTE SETS ITS OWN CSP. The dashboard
 * sends `frame-ancestors 'none'`, which blocks framing by every origin
 * including its own; /api/website/preview.html sends `frame-ancestors 'self'`
 * instead. Without that this pane is a blank box and a console warning, with
 * nothing on screen to suggest a policy caused it.
 *
 * `nonce` changes on every save. The iframe src changes with it, which is
 * what makes the preview re-fetch — the route also sends no-store, but a
 * changing URL is what actually forces the element to reload.
 */

import { useState } from 'react';
import * as api from './api.js';

const WIDTHS = {
  phone: { label: 'Phone', width: 390 },
  desktop: { label: 'Desktop', width: null },
};

export default function PreviewPane({ nonce }) {
  const [device, setDevice] = useState('desktop');
  const active = WIDTHS[device];

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-sm font-semibold uppercase tracking-wide text-slate-500">
          Preview
        </h3>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {Object.entries(WIDTHS).map(([key, { label }]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDevice(key)}
              aria-pressed={device === key}
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                device === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-1 justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-100 p-3">
        <iframe
          key={`${device}-${nonce}`}
          title="Your website preview"
          src={api.previewUrl(nonce)}
          // Height climbs with the screen rather than being fixed. A single
          // tall value makes this the focal point on a desktop — which is the
          // point — but on a 812px-high phone the same number is taller than
          // the whole viewport, so the page becomes one long empty scroll
          // before anything else is reachable. Found on a 375px screen.
          className="h-[60vh] min-h-[380px] rounded-lg border border-slate-200 bg-white shadow-sm sm:h-[620px] sm:min-h-0 xl:h-[820px]"
          style={{ width: active.width ? `${active.width}px` : '100%' }}
          // The preview renders the pharmacy's own content through our own
          // renderer, and the page contains no JavaScript at all — but the
          // sandbox costs nothing and means a future block that somehow
          // emitted script still could not reach the dashboard around it.
          sandbox="allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
    </div>
  );
}
