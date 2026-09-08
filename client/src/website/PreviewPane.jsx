/**
 * The live preview.
 *
 * THE REAL RENDERER, not a React re-implementation of the blocks. What
 * appears here came out of the same server code that will publish the page,
 * through the same stylesheet, from the same stored data — so "it looked
 * different once it was live" is not a failure mode this design has.
 *
 * SRCDOC, NOT SRC, AND THAT IS NOT A DETAIL. An `<iframe src="/api/...">` is
 * a browser navigation: it never passes through the patched fetch that
 * attaches the bearer token, so the route answered 401 and the pane was
 * blank. It looked fine on every developer machine, where DEV_AUTH_BYPASS
 * serves requests unauthenticated, and was empty on the live site. So the
 * document is FETCHED on the authenticated path (see api.previewHtml) and
 * handed to the iframe as a string.
 *
 * WHAT THAT CHANGES, STATED HONESTLY: a srcdoc document is governed by the
 * DASHBOARD's Content-Security-Policy rather than by the one the preview
 * route sets on itself. Checked against the live policy rather than assumed —
 * it allows inline styles, fonts.googleapis.com, fonts.gstatic.com and the
 * Supabase storage origin, which is everything a published page uses, and
 * `script-src 'self'` is moot because these pages contain no script at all.
 * The bytes are identical to what publishing produces, so the preview still
 * cannot lie about the result.
 *
 * A blob: URL would have kept the route's own headers and is the obvious
 * alternative — the dashboard CSP is `default-src 'self'`, so frame-src
 * falls back to 'self' and a blob: frame is refused. srcdoc is what is left,
 * and it is also the one that keeps working if that policy tightens.
 *
 * `nonce` changes on every save, which is what re-fetches the document.
 *
 * FAILURE IS VISIBLE HERE, deliberately. The bug above hid behind an empty
 * grey box for as long as it did because nothing on screen said anything had
 * gone wrong.
 */

import { useEffect, useState } from 'react';
import * as api from './api.js';

const WIDTHS = {
  phone: { label: 'Phone', width: 390 },
  desktop: { label: 'Desktop', width: null },
};

export default function PreviewPane({ nonce }) {
  const [device, setDevice] = useState('desktop');
  const [html, setHtml] = useState(null);
  const [error, setError] = useState(null);
  const active = WIDTHS[device];

  useEffect(() => {
    let live = true;
    setError(null);
    api.previewHtml(nonce)
      .then((doc) => { if (live) setHtml(doc); })
      .catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [nonce]);

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
        {error && (
          <div className="flex max-w-md flex-col justify-center px-6 text-center">
            <p className="text-sm font-medium text-red-700">{error}</p>
            <p className="mt-1 text-sm text-slate-500">
              Your website itself is unaffected — this is only the preview on this screen.
            </p>
          </div>
        )}

        {!error && !html && (
          <div className="flex items-center justify-center">
            <p className="text-sm text-slate-500">Loading your preview…</p>
          </div>
        )}

        {!error && html && (
          <iframe
            key={device}
            title="Your website preview"
            srcDoc={html}
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
            // Without allow-same-origin the document also gets an opaque
            // origin, so it cannot read the dashboard's storage either.
            sandbox="allow-popups allow-popups-to-escape-sandbox"
          />
        )}
      </div>
    </div>
  );
}
