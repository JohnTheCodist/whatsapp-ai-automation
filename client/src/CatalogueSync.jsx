/**
 * Stock sync — the computers allowed to send this pharmacy's catalogue.
 *
 * WHAT THIS SCREEN IS REALLY FOR
 * Not pairing. Pairing happens once and is forgotten. This screen exists for
 * the other 364 days, to answer one question: IS THE CATALOGUE STILL BEING
 * UPDATED? A sync that has silently stopped is worse than never having had
 * one — the pharmacy believes its prices are current, the assistant quotes
 * last month's figures to real customers with complete confidence, and
 * nothing anywhere looks broken. Nobody learns that from the absence of an
 * event, so this screen has to say it out loud.
 *
 * That is why "last updated" is the largest thing on each row and why a stale
 * device is loud rather than a grey timestamp. The pairing controls are the
 * small part.
 *
 * WHY THE PRIVACY NOTE IS ON SCREEN AND NOT IN A HINT
 * The agent looks at what is installed on that computer in order to work out
 * which stock software it is. Undisclosed, software that inventories a
 * business's server and reports home is indistinguishable from malware.
 * Disclosed, it is ordinary onboarding. The difference is entirely whether
 * the owner was told plainly, before agreeing — so it is in the open here,
 * not folded away behind an information icon.
 */

import { useCallback, useEffect, useState } from 'react';
import FieldHint from './FieldHint.jsx';
import Loading from './Loading.jsx';

function relTime(iso) {
  if (!iso) return null;
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function minsUntil(iso) {
  if (!iso) return 0;
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
}

export default function CatalogueSync() {
  const [devices, setDevices] = useState(null);
  const [pairing, setPairing] = useState(null);   // the live code, once issued
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  // A freshly issued email address, highlighted until the page is reloaded.
  // The pharmacist has to carry this to another system, and it should not look
  // like just another row the moment it appears.
  const [newAddress, setNewAddress] = useState(null);
  const [copied, setCopied] = useState(null);
  const [emailDomain, setEmailDomain] = useState(null);
  // Absolute, not the bare "/download/..." path. This string is copied and
  // sent to another machine — a relative link pasted into WhatsApp is not a
  // link at all, and origin is exactly what makes it work over there.
  const downloadUrl = `${window.location.origin}/download/rxnaija-sync.exe`;

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/sync/devices', { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load connected computers.');
      setDevices(j.devices || []);
      // Null when the server has no inbound-email provider configured — the
      // address is then hidden rather than shown with a guessed domain.
      setEmailDomain(j.emailDomain || null);
      setError(null);
      return j.devices || [];
    } catch (e) {
      setError(e.message);
      return [];
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Polls ONLY while an unredeemed code is on screen, so the row turns
  // "connected" by itself while the owner is still standing at the other
  // computer. Deliberately not a standing poll: every other screen in this app
  // that polled without a reason helped exhaust the database pooler (see
  // Inbox/Orders POLL_MS). This one has an end condition and reaches it.
  useEffect(() => {
    if (!pairing) return undefined;
    const t = setInterval(async () => {
      const list = await load();
      const mine = list.find((d) => d.id === pairing.deviceId);
      if (mine && mine.status === 'active') setPairing(null);   // it paired
      else if (minsUntil(pairing.expiresAt) <= 0) setPairing(null); // it expired
    }, 5000);
    return () => clearInterval(t);
  }, [pairing, load]);

  async function startPairing() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/sync/devices/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not start pairing.');
      setPairing({ deviceId: j.deviceId, code: j.code, expiresAt: j.expiresAt });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Issue this pharmacy an address their cloud POS can mail its report to.
   *
   * Not a "pairing" and deliberately not presented as one: there is nothing to
   * install, nothing to type back, and no code that expires. The address is
   * live the moment it exists, so the only thing the pharmacist has to do is
   * copy it into their POS — which is why the copy button is the primary
   * action on the row rather than an afterthought.
   */
  async function createEmailInbox() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/sync/email-inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      if (!r.ok) {
        throw new Error(j.code === 'EMAIL_NOT_CONFIGURED'
          ? 'Emailed stock reports are not switched on for this server yet. Ask RxNaija support to enable it.'
          : (j.error || 'Could not create an email address.'));
      }
      setNewAddress(j.address);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/sync/devices/${id}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Could not disconnect that computer.');
      }
      if (pairing?.deviceId === id) setPairing(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setConfirmRevoke(null);
    }
  }

  if (devices === null && !error) {
    return <section className="rounded-lg border border-slate-200 p-5 text-sm text-slate-500"><Loading /></section>;
  }

  const active = (devices || []).filter((d) => d.status === 'active');
  const stale = active.filter((d) => d.is_stale);
  // "Has stopped updating" and "has never started" are different facts and
  // need different sentences. Telling an owner the assistant is "still
  // quoting the last successful sync" when there has never BEEN one is a
  // false statement about their prices, which is the one thing this panel
  // exists to avoid.
  const everSynced = stale.some((d) => d.last_sync_at);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-800">
        Stock sync
        <FieldHint label="Stock sync">
          A small program on the computer that runs your stock software. It
          sends your product list here on a schedule, so prices and stock stay
          current without anyone re-uploading a file.
        </FieldHint>
      </h2>

      {/* The loudest thing on the screen when it is true, because it is the
          failure this whole feature has to be honest about. */}
      {stale.length > 0 && (
        <p className="mt-3 rounded border border-red-300 bg-red-50 px-2.5 py-2 text-xs text-red-800">
          {everSynced ? (
            <>
              <strong>Your catalogue is not being updated.</strong> The assistant is
              still quoting the prices and stock from the last successful sync — to
              real customers, as fact. Check that the computer below is switched on and
              that your stock software is still exporting to it.
            </>
          ) : (
            <>
              <strong>This computer has not sent a catalogue yet.</strong> Nothing here
              is updating your prices or stock — the assistant is working from whatever
              was last uploaded by hand. Check that your stock software is exporting to
              the folder the program is watching.
            </>
          )}
        </p>
      )}

      {error && (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-700">{error}</p>
      )}

      {/* ---- the live pairing code ---- */}
      {pairing && (
        <div className="mt-4 rounded-lg border border-teal-300 bg-teal-50 p-4">
          <p className="text-xs font-medium text-teal-900">
            On the computer that runs your stock software, install RxNaija Sync and type this code:
          </p>
          <p className="mt-2 font-mono text-3xl font-semibold tracking-[0.2em] text-teal-950">
            {pairing.code}
          </p>

          {/* The download, on the screen that just told them to install it.
              Two ways to reach it on purpose: the button is for whoever is
              sitting at the POS computer right now, and the copyable link is
              for the far more common case where they are NOT — the dashboard
              is open on a phone or an office laptop, and the address has to
              travel to the back office by WhatsApp. A download button alone
              silently assumes the wrong machine. */}
          <div className="mt-3 rounded border border-teal-200 bg-white p-2.5">
            <p className="text-xs font-medium text-teal-900">Don&apos;t have the program yet?</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <a
                href="/download/rxnaija-sync.exe"
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
              >
                Download for Windows
              </a>
              <span className="text-[11px] text-slate-500">or send this link to that computer:</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
              <span className="min-w-0 break-all font-mono text-[11px] text-slate-700">
                {downloadUrl}
              </span>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(downloadUrl).catch(() => {});
                  setCopied(downloadUrl);
                  setTimeout(() => setCopied(null), 4000);
                }}
                className="ml-auto shrink-0 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] hover:bg-slate-50"
              >
                {copied === downloadUrl ? 'Copied' : 'Copy'}
              </button>
            </div>
            {/* Told before they meet it, not after. An unexpected security
                warning from software a pharmacy has just been handed is where
                trust dies; an expected one is a formality. */}
            <p className="mt-2 text-[11px] text-slate-500">
              Windows will say <em>&quot;Windows protected your PC&quot;</em> because this program
              is new. Click <strong>More info</strong>, then <strong>Run anyway</strong>.
            </p>
          </div>
          <p className="mt-2 text-xs text-teal-800">
            Valid for {minsUntil(pairing.expiresAt)} more minutes, and can only be used once.
            This page will update by itself once that computer connects.
          </p>
          <button
            type="button"
            onClick={() => revoke(pairing.deviceId)}
            disabled={busy}
            className="mt-3 rounded-lg border border-teal-400 bg-white px-3 py-1.5 text-xs text-teal-900 hover:bg-teal-50 disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ---- a freshly issued email address ----
          Shown once, prominently, because it has to be carried to another
          system. Everything else on this screen can be found again by
          scrolling; this is the one thing somebody is mid-task with. */}
      {newAddress && (
        <div className="mt-4 rounded-lg border border-teal-300 bg-teal-50 p-4">
          <p className="text-xs font-medium text-teal-900">
            In your stock software, set its scheduled stock report to be emailed to:
          </p>
          <p className="mt-2 break-all font-mono text-base font-semibold text-teal-950">
            {newAddress}
          </p>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(newAddress).catch(() => {});
              setCopied(newAddress);
              setTimeout(() => setCopied(null), 4000);
            }}
            className="mt-3 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            {copied === newAddress ? 'Copied' : 'Copy address'}
          </button>
          {/* The failure that would otherwise be discovered a week later, when
              a catalogue that never updated is finally noticed. Said before
              they walk away to configure it, not after. */}
          <p className="mt-3 border-t border-teal-200 pt-2.5 text-xs text-teal-900">
            <strong>Send it as Excel or CSV, not PDF.</strong> Many systems email reports as
            a PDF by default — that is a picture of a table, and prices cannot be read from
            it. If yours only sends PDF, tell us and we will find another way.
          </p>
        </div>
      )}

      {/* ---- nothing connected yet ---- */}
      {active.length === 0 && !pairing && !newAddress && (
        <div className="mt-4">
          <p className="text-sm text-slate-600">
            Nothing is connected, so your catalogue only changes when someone uploads
            a file by hand.
          </p>
          {/* Two routes, because the right one depends on something the
              pharmacy knows and this screen cannot: where their stock data
              actually lives. Asking that question directly is clearer than
              offering one option and hiding the other behind it. */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-800">
                My stock software runs on a computer here
              </p>
              <p className="mt-1 text-xs text-slate-500">
                A small program on that computer sends your product list automatically.
              </p>
              <button
                type="button"
                onClick={startPairing}
                disabled={busy}
                className="mt-3 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-40"
              >
                {busy ? 'Starting…' : 'Connect a computer'}
              </button>
            </div>

            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-800">
                My stock software is online
              </p>
              <p className="mt-1 text-xs text-slate-500">
                We give you an email address. Point your system&apos;s scheduled report at
                it — nothing to install.
              </p>
              <button
                type="button"
                onClick={createEmailInbox}
                disabled={busy}
                className="mt-3 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-40"
              >
                {busy ? 'Creating…' : 'Get an email address'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- the connected computers ---- */}
      {active.length > 0 && (
        <ul className="mt-4 space-y-2">
          {active.map((d) => (
            <li
              key={d.id}
              className={`rounded-lg border p-3 ${d.is_stale ? 'border-red-300 bg-red-50' : 'border-slate-200'}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 font-medium text-slate-900">
                  {d.label || (d.kind === 'email' ? 'Emailed stock report' : 'Unnamed computer')}
                  {d.pos_confirmed && (
                    <span className="ml-2 text-xs font-normal text-slate-500">{d.pos_confirmed}</span>
                  )}
                </p>
                <span className={`rounded px-2 py-0.5 text-xs ${
                  d.is_stale ? 'bg-red-100 text-red-800' : 'bg-teal-50 text-teal-700'}`}
                >
                  {d.is_stale ? 'Not updating' : 'Up to date'}
                </span>
              </div>

              {/* The headline fact on this row, deliberately: everything else
                  here is context for it. */}
              <p className={`mt-1 text-sm ${d.is_stale ? 'text-red-800' : 'text-slate-700'}`}>
                {d.last_sync_at
                  ? <>Catalogue last updated <strong>{relTime(d.last_sync_at)}</strong></>
                  : <>Connected, but <strong>has never sent a catalogue yet</strong></>}
              </p>

              <p className="mt-0.5 text-xs text-slate-500">
                {/* Last SEEN and last SYNCED are different facts and are shown
                    as such: an agent that is running but finding no export is
                    a folder problem, and one that has not been seen at all is
                    a switched-off computer. Collapsing them would send the
                    pharmacist looking in the wrong place.

                    For an inbox there is no program to check in, so the same
                    timestamp means "mail last arrived" — a different sentence
                    for a different fact. */}
                {d.kind === 'email'
                  ? (d.last_seen_at ? `Email last arrived ${relTime(d.last_seen_at)}` : 'No email received yet')
                  : (d.last_seen_at ? `Program last checked in ${relTime(d.last_seen_at)}` : 'Never checked in')}
                {d.last_sync_status === 'needs_review' && ' · waiting for someone to check the columns'}
                {d.last_sync_status === 'failed' && d.last_sync_detail && ` · last attempt failed: ${d.last_sync_detail}`}
              </p>

              {/* The address, on the row that uses it. A pharmacist coming back
                  a week later to re-enter it in their POS should not have to
                  issue a second one to find out what the first was. */}
              {d.kind === 'email' && d.email_token && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
                  <span className="min-w-0 break-all font-mono text-[11px] text-slate-700">
                    stock-{d.email_token}@{emailDomain || '…'}
                  </span>
                  {emailDomain && (
                    <button
                      type="button"
                      onClick={() => {
                        const addr = `stock-${d.email_token}@${emailDomain}`;
                        navigator.clipboard?.writeText(addr).catch(() => {});
                        setCopied(addr);
                        setTimeout(() => setCopied(null), 4000);
                      }}
                      className="ml-auto shrink-0 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] hover:bg-slate-50"
                    >
                      {copied === `stock-${d.email_token}@${emailDomain}` ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </div>
              )}
              {d.kind === 'email' && !d.allowed_sender && d.last_seen_at && (
                <p className="mt-1 text-[11px] text-slate-500">
                  Waiting for the first report. The address it arrives from is remembered,
                  and anything sent from elsewhere is ignored after that.
                </p>
              )}

              {confirmRevoke === d.id ? (
                <div className="mt-2 rounded border border-red-300 bg-white p-2.5">
                  <p className="text-xs text-red-800">
                    {d.kind === 'email' ? (
                      <>
                        <strong>Stop using this email address?</strong> Any report sent to
                        it after this is ignored, and your prices and stock stay frozen at
                        whatever was last received until someone uploads a file by hand.
                        A new address would have to be entered in your stock software again.
                      </>
                    ) : (
                      <>
                        <strong>Disconnect this computer?</strong> It stops sending your
                        catalogue immediately, and your prices and stock stay frozen at
                        whatever was last sent until someone uploads a file by hand.
                        Reconnecting means installing and pairing it again.
                      </>
                    )}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => revoke(d.id)}
                      disabled={busy}
                      className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-40"
                    >
                      Yes, disconnect
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRevoke(null)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50"
                    >
                      Keep it connected
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRevoke(d.id)}
                  className="mt-2 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                >
                  Disconnect
                </button>
              )}
            </li>
          ))}

          {!pairing && (
            <li>
              <button
                type="button"
                onClick={startPairing}
                disabled={busy}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                Connect another computer
              </button>
              <button
                type="button"
                onClick={createEmailInbox}
                disabled={busy}
                className="ml-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                Add an email address
              </button>
            </li>
          )}
        </ul>
      )}

      {/* Stated plainly, before anyone installs anything. See this file's header.
          Scoped to the installed program on purpose: an email inbox reads
          nothing on anybody's computer, and a disclosure that described
          capabilities a source does not have would be its own kind of untrue. */}
      {active.some((d) => d.kind !== 'email') || active.length === 0 ? (
        <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
          <strong className="text-slate-700">What the installed program can see.</strong> To
          work out which stock software you use, it reads the <em>names</em> of the programs
          installed on that computer and shows you the list before sending anything. It never
          reads your files, your patient records, or anything inside your stock database —
          only the product list you export. You can disconnect it here at any time, without
          touching that computer.
        </p>
      ) : null}

      {active.some((d) => d.kind === 'email') && (
        <p className="mt-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
          <strong className="text-slate-700">About the email address.</strong> It only
          accepts reports from the address your stock software first sent from — anything
          else is ignored. Nothing is installed anywhere, and we never ask for your stock
          software&apos;s password. Stop it here at any time.
        </p>
      )}
    </section>
  );
}
