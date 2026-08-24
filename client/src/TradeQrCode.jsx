/**
 * The OTHER QR code — the one that puts a buyer on trade prices.
 *
 * WHY THIS IS A SEPARATE PANEL FROM THE COUNTER CODE
 * Both codes point at the same WhatsApp line. The only difference is the
 * prefilled message: the counter code sends a greeting, this one sends the
 * pharmacy's trade code, and arriving through it sets customer_type to
 * 'wholesale' once, automatically (migration 0040). That single difference
 * decides which price list the assistant is allowed to quote for the rest of
 * that customer's life, so the two must never be mistaken for each other in
 * a hurry. Separate panels, separate language, one loud warning.
 *
 * THE FAILURE THIS IS BUILT TO PREVENT
 * Printing this code on a public flyer. Every scan would upgrade a walk-in to
 * wholesale pricing, and nothing would look broken — the pharmacy would just
 * quietly sell at trade rates to everybody until someone read a margin
 * report. The counter code is the one for public material; this one belongs
 * on invoices and delivery notes handed to buyers the pharmacy already deals
 * with.
 *
 * WHY THERE IS NO "FIRST MESSAGE" FIELD
 * isTradeCode is deliberately an EXACT match on the whole message, so that
 * someone who saw the code on another buyer's invoice cannot type "is WS-4821
 * still good?" and upgrade themselves. That means the link may carry the code
 * and nothing else — a greeting appended here would silently produce a QR
 * that scans, sends, and does not work.
 *
 * WHY MINTING IS A BUTTON AND NOT AUTOMATIC
 * Issuing this is a commercial decision, not a settings tweak — the server
 * gates the route to owners for the same reason. A pharmacy that does no
 * wholesale should not have a code sitting there waiting to be guessed at.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import FieldHint from './FieldHint.jsx';
import Loading from './Loading.jsx';

/** Digits only, no leading + — wa.me rejects punctuation. Mirrors the counter code. */
function normalise(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return `234${digits.slice(1)}`;
  return digits;
}

export default function TradeQrCode() {
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [publicNumber, setPublicNumber] = useState('');
  const [pharmacyName, setPharmacyName] = useState('');
  const [role, setRole] = useState('');
  const [svg, setSvg] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // Two-step, because rotating kills every code already printed. See rotate().
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/pharmacies/me', { signal: AbortSignal.timeout(20000) });
        if (cancelled) return;
        if (r.ok) {
          const j = await r.json();
          const ph = j.pharmacy || j;
          setCode(ph.wholesale_code || '');
          setPublicNumber(ph.public_whatsapp_number || '');
          setPharmacyName(ph.name || '');
          setRole(j.role || '');
        }
      } catch {
        /* the panel reports its own state below; nothing here is fatal */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const msisdn = normalise(publicNumber);
  // Exactly the code, nothing appended — see this file's header.
  const link = msisdn && code ? `https://wa.me/${msisdn}?text=${encodeURIComponent(code)}` : '';

  useEffect(() => {
    let cancelled = false;
    if (!link) { setSvg(''); return undefined; }
    (async () => {
      try {
        const out = await QRCode.toString(link, {
          type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 320,
          // Deliberately NOT the counter code's colour. Two black-on-white
          // squares in the same drawer are indistinguishable once printed,
          // and the whole risk here is picking up the wrong one.
          color: { dark: '#7c2d12', light: '#ffffff' },
        });
        if (!cancelled) setSvg(out);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [link]);

  const mint = async (rotateIt) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/pharmacies/me/trade-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rotateIt ? { rotate: true } : {}),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(
          j.code === 'FORBIDDEN_ROLE'
            ? 'Only an owner can issue the trade code.'
            : (j.error || 'Could not issue the trade code.'),
        );
      }
      setCode(j.pharmacy?.wholesale_code || '');
      setNotice(rotateIt
        ? 'New code issued. Every previously printed trade code is now dead — reprint before sending more invoices.'
        : 'Trade code issued. Put it on invoices and delivery notes, never on public material.');
      setTimeout(() => setNotice(null), 8000);
    } catch (e) {
      setError(e.name === 'TimeoutError' ? 'The server did not respond — nothing was changed.' : e.message);
    } finally {
      setBusy(false);
      setConfirmingRotate(false);
    }
  };

  const fileBase = `${(pharmacyName || 'pharmacy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-trade-qr`;

  const download = useCallback((blob, ext) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileBase}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [fileBase]);

  const downloadPng = async () => {
    try {
      // 1024, not the on-screen 320: a QR scaled UP after export is the usual
      // reason a printed one will not scan.
      const canvas = canvasRef.current;
      await QRCode.toCanvas(canvas, link, {
        errorCorrectionLevel: 'M', margin: 2, width: 1024,
        color: { dark: '#7c2d12', light: '#ffffff' },
      });
      canvas.toBlob((b) => b && download(b, 'png'));
    } catch (e) {
      setError(e.message);
    }
  };

  if (loading) {
    return <section className="rounded-lg border border-slate-200 p-5 text-sm text-slate-500"><Loading /></section>;
  }

  const isOwner = role === 'owner';

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-800">
        Your trade QR code
        <FieldHint label="Your trade QR code">
          For buyers you already deal with. Scanning it puts that account on
          your wholesale price list from their first message — automatically,
          and for good.
        </FieldHint>
      </h2>

      {/* Said before anything can be downloaded, because the mistake it
          prevents is silent and expensive. Kept in the open, not behind the
          hint above — this is the warning, not the background reading. */}
      <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
        <strong>Never put this on a flyer, a poster or social media.</strong> Anyone
        who scans it is quoted trade prices from then on. It belongs on invoices and
        delivery notes. The counter code on the previous tab is the public one.
      </p>

      {!msisdn && (
        <p className="mt-3 rounded border border-slate-300 bg-slate-50 px-2.5 py-2 text-xs text-slate-600">
          Set the number customers message first, on the <strong>Public number</strong>{' '}
          tab. Both codes point at that same line.
        </p>
      )}

      {msisdn && !code && (
        <div className="mt-4">
          {isOwner ? (
            <>
              <button
                type="button"
                onClick={() => mint(false)}
                disabled={busy}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-40"
              >
                {busy ? 'Issuing…' : 'Issue a trade code'}
              </button>
              <p className="mt-1.5 text-xs text-slate-500">
                You do not have one yet, so no customer can reach trade pricing.
              </p>
            </>
          ) : (
            <p className="rounded border border-slate-300 bg-slate-50 px-2.5 py-2 text-xs text-slate-600">
              No trade code has been issued. Only an owner can issue one — who a
              pharmacy sells to at trade prices is a commercial decision.
            </p>
          )}
        </div>
      )}

      {code && (
        <div className="mt-4 grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0 space-y-3">
            <div>
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
                Your trade code
                <FieldHint label="Your trade code">
                  A buyer can also just type this to the pharmacy — the QR only
                  saves them doing it. It has to be sent on its own, exactly as
                  written.
                </FieldHint>
              </span>
              <p className="mt-1 font-mono text-base tracking-wide text-slate-900">{code}</p>
            </div>

            {link && (
              <div className="rounded border border-slate-200 bg-slate-50 p-2">
                <p className="break-all font-mono text-[11px] text-slate-600">{link}</p>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(link).catch(() => {})}
                  className="mt-1.5 rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50"
                >
                  Copy link
                </button>
              </div>
            )}

            {/* Rotation is two-step and spells out the cost, because the
                server deliberately does NOT rotate on a plain click — a
                mis-click here would kill every code already on paper. */}
            {isOwner && (
              confirmingRotate ? (
                <div className="rounded border border-red-300 bg-red-50 p-2.5">
                  <p className="text-xs text-red-800">
                    <strong>Issue a new code?</strong> Every invoice and delivery note
                    already carrying the old one stops working immediately, and the
                    buyers holding them land in an ordinary retail chat with no sign
                    anything changed. Only do this if the code has leaked.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => mint(true)}
                      disabled={busy}
                      className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-40"
                    >
                      {busy ? 'Issuing…' : 'Yes, replace it'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingRotate(false)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50"
                    >
                      Keep the current code
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingRotate(true)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                >
                  Replace this code
                </button>
              )
            )}

            {notice && <p className="text-xs text-teal-700">{notice}</p>}
            {error && (
              <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</p>
            )}
          </div>

          <div className="flex flex-col items-center gap-2">
            {svg && (
              <>
                {/* Self-contained SVG generated here from a link built here —
                    no remote or user-authored markup reaches this. */}
                <div
                  className="w-[190px] rounded-lg border border-amber-300 p-2 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
                <p className="text-[10px] font-medium uppercase tracking-wide text-amber-800">Trade — not for public use</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => download(new Blob([svg], { type: 'image/svg+xml' }), 'svg')}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    SVG
                  </button>
                  <button
                    type="button"
                    onClick={downloadPng}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50"
                  >
                    PNG
                  </button>
                </div>
              </>
            )}
            <canvas ref={canvasRef} className="hidden" />
          </div>
        </div>
      )}
    </section>
  );
}
