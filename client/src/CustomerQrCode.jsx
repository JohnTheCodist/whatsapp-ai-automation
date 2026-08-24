/**
 * The QR a pharmacy puts on the counter.
 *
 * WHAT IT ENCODES
 * A `wa.me` deep link, not a phone number. Scanning it opens WhatsApp with
 * the pharmacy's chat already open and the first message pre-typed, so the
 * customer's very first act is sending — not copying a number, switching
 * apps, and typing it in. That gap is where walk-past traffic is lost.
 *
 * TWO NUMBERS, AND WHY THEY ARE SEPARATED SO LOUDLY
 * This screen holds the number CUSTOMERS message. The alert number below it
 * is a staff member's personal phone. Confusing them fails in both
 * directions and neither failure announces itself:
 *
 *   - customer number set to a staff phone -> customers message a person who
 *     has no assistant behind them, and the pharmacy looks broken
 *   - alert number set to the bot's own line -> the assistant messages
 *     itself, which is a loop
 *
 * So the two live in visually distinct blocks with their consequences
 * spelled out, and this one is prefilled from the CONNECTED account rather
 * than typed from memory.
 *
 * EXPORT IS SVG FIRST
 * A counter QR ends up on a printed flyer or a laminated card. SVG stays
 * sharp at any size; the PNG is there for WhatsApp status and social posts,
 * which reject SVG.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import FieldHint from './FieldHint.jsx';

/** Digits only, and never a leading +: wa.me rejects punctuation outright. */
function normalise(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  // A Nigerian number typed the local way (0803…) is the common input; wa.me
  // needs it in international form, and silently building a dead link from
  // the local form is worse than correcting it here.
  if (digits.startsWith('0')) return `234${digits.slice(1)}`;
  return digits;
}

function isPlausible(msisdn) {
  // Deliberately loose: this is a sanity check, not a validator. Blocking a
  // legitimate international number because a regex was too strict costs
  // more than letting an odd one through — the QR is visibly testable.
  return msisdn.length >= 10 && msisdn.length <= 15;
}

export default function CustomerQrCode() {
  const [number, setNumber] = useState('');
  const [savedNumber, setSavedNumber] = useState('');
  const [connectedNumber, setConnectedNumber] = useState('');
  const [pharmacyName, setPharmacyName] = useState('');
  const [greeting, setGreeting] = useState('Hello');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef(null);

  // Fetched here rather than threaded down from App: this panel is the only
  // thing that needs either value, and putting them in App's state would
  // make an unrelated screen re-render whenever the socket status changed.
  //
  // Prefilling from the PAIRED account matters — that is the line customers
  // actually reach, so re-typing it from memory can only introduce a typo,
  // and a QR with a typo fails silently on a printed flyer.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [w, p] = await Promise.all([
          fetch('/api/whatsapp/status', { signal: AbortSignal.timeout(20000) }),
          fetch('/api/pharmacies/me', { signal: AbortSignal.timeout(20000) }),
        ]);
        if (cancelled) return;

        // The live socket's number is read for COMPARISON only. It is never
        // what the QR is built from — that would tie a printed artefact to
        // runtime state, which is the coupling this whole panel exists to
        // break.
        if (w.ok) {
          const j = await w.json();
          setConnectedNumber(j.phoneNumber || j.account?.phoneNumber || '');
        }
        if (p.ok) {
          const j = await p.json();
          const ph = j.pharmacy || j;
          setPharmacyName(ph.name || '');
          const saved = ph.public_whatsapp_number || '';
          setSavedNumber(saved);
          // Seed the field from the SAVED value. A pharmacy that has never
          // published one gets the connected number as a starting suggestion
          // — but it is only a suggestion until they press Save, and until
          // then the panel says so rather than implying a code exists.
          setNumber((cur) => cur || saved);
        }
      } catch {
        /* the field stays typeable by hand — the QR does not depend on this */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/pharmacies/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicWhatsappNumber: msisdn }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not save the number.');
      setSavedNumber(j.pharmacy?.public_whatsapp_number || msisdn);
      setNotice('Saved. This is now the number on your printed code.');
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      setError(e.name === 'TimeoutError' ? 'The server did not respond — not saved.' : e.message);
    } finally {
      setSaving(false);
    }
  };

  const msisdn = normalise(number);
  const link = msisdn
    ? `https://wa.me/${msisdn}${greeting.trim() ? `?text=${encodeURIComponent(greeting.trim())}` : ''}`
    : '';

  useEffect(() => {
    let cancelled = false;
    if (!msisdn || !isPlausible(msisdn)) { setSvg(''); return undefined; }

    (async () => {
      try {
        const out = await QRCode.toString(link, {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 320,
          color: { dark: '#0e1a14', light: '#ffffff' },
        });
        if (!cancelled) { setSvg(out); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [link, msisdn]);

  const fileBase = `${(pharmacyName || 'pharmacy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-whatsapp-qr`;

  const download = useCallback((blob, ext) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileBase}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on the next tick rather than immediately — Safari cancels an
    // in-flight download if the object URL disappears in the same frame.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [fileBase]);

  const downloadSvg = () => download(new Blob([svg], { type: 'image/svg+xml' }), 'svg');

  const downloadPng = async () => {
    try {
      // Rendered at 1024 rather than the on-screen 320: a QR resized UP after
      // export is the usual reason a printed one will not scan.
      const canvas = canvasRef.current;
      await QRCode.toCanvas(canvas, link, {
        errorCorrectionLevel: 'M', margin: 2, width: 1024,
        color: { dark: '#0e1a14', light: '#ffffff' },
      });
      canvas.toBlob((b) => b && download(b, 'png'));
    } catch (e) {
      setError(e.message);
    }
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(link); } catch { /* clipboard blocked; the link is on screen to copy by hand */ }
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-800">
        Your customer QR code
        <FieldHint label="Your customer QR code">
          Print this for the counter, or post it. Scanning opens WhatsApp with
          your pharmacy already selected and the first message typed.
        </FieldHint>
      </h2>

      <div className="mt-4 grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-3">
          <label className="block">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
              The number customers message
              <FieldHint label="The number customers message">
                Saved once and printed. Reconnecting or re-pairing WhatsApp does
                not change it — a local number starting 0 becomes +234 automatically.
              </FieldHint>
            </span>
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value.slice(0, 20))}
              placeholder="2348012345678"
              inputMode="tel"
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving || !isPlausible(msisdn) || msisdn === savedNumber}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 hover:bg-slate-800"
            >
              {saving ? 'Saving…' : msisdn === savedNumber && savedNumber ? 'Saved' : 'Save this number'}
            </button>
            {notice && <span className="text-xs text-teal-700">{notice}</span>}
          </div>

          {/* Unsaved: the code on screen is a preview of something that does
              not exist yet. Printing it is fine — the link works — but the
              divergence check below has nothing to compare against until it
              is stored, so say so plainly rather than let it look settled. */}
          {isPlausible(msisdn) && msisdn !== savedNumber && (
            <p className="rounded border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
              Not saved yet — save it so this stays your printed number even if
              WhatsApp reconnects.
            </p>
          )}

          {/* THE case that invalidates paper. The saved number is what is on
              the flyer; the connected number is where messages actually land.
              When they differ, every scan of that flyer opens a chat nobody
              is answering — and nothing else in the product would report it,
              because both values are individually valid. */}
          {savedNumber && connectedNumber && savedNumber !== connectedNumber && (
            <p className="rounded border border-red-300 bg-red-50 px-2 py-2 text-xs text-red-800">
              <strong>Your printed code points at a different number.</strong> The
              code says <span className="font-mono">{savedNumber}</span>, but WhatsApp
              is connected as <span className="font-mono">{connectedNumber}</span>.
              Anyone scanning a printed copy reaches a chat the assistant is not
              answering. Either re-pair the original number, or save the new one
              and reprint.
            </p>
          )}

          <label className="block">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
              First message (optional)
              <FieldHint label="First message">
                Pre-typed for the customer so they only have to press send.
              </FieldHint>
            </span>
            <input
              value={greeting}
              onChange={(e) => setGreeting(e.target.value.slice(0, 80))}
              placeholder="Hello"
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          {link && (
            <div className="rounded border border-slate-200 bg-slate-50 p-2">
              <p className="break-all font-mono text-[11px] text-slate-600">{link}</p>
              <button
                type="button"
                onClick={copyLink}
                className="mt-1.5 rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50"
              >
                Copy link
              </button>
            </div>
          )}

          {msisdn && !isPlausible(msisdn) && (
            <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
              That does not look like a full number yet — include the country code.
            </p>
          )}
          {error && (
            <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</p>
          )}
        </div>

        <div className="flex flex-col items-center gap-2">
          {svg ? (
            <>
              {/* The library returns a complete, self-contained <svg>. It is
                  generated in this component from a link built here — no
                  remote or user-authored markup reaches this. */}
              <div
                className="w-[190px] rounded-lg border border-slate-200 p-2 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={downloadSvg}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                >
                  Download SVG
                </button>
                <button
                  type="button"
                  onClick={downloadPng}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
                >
                  PNG
                </button>
              </div>
              <p className="text-center text-[10px] text-slate-400">
                SVG for print · PNG for status and socials
              </p>
            </>
          ) : (
            <div className="flex h-[190px] w-[190px] items-center justify-center rounded-lg border border-dashed border-slate-300 p-3 text-center text-xs text-slate-400">
              Enter the number to generate your code
            </div>
          )}
          {/* Off-screen scratch surface for the PNG export. */}
          <canvas ref={canvasRef} className="hidden" />
        </div>
      </div>
    </section>
  );
}
