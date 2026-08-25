/**
 * Upload catalogue — the two-step import.
 *
 * The confirmation screen is the point of this component, not the file
 * picker. Detection is good but not certain, and a mapping applied without
 * review produces a catalogue that is quietly wrong — the way anyone finds
 * out is a customer being quoted the pharmacy's cost price.
 *
 * So every proposal shows WHAT it matched, WHY, and how confident it is, and
 * anything below "confident" is surfaced rather than buried.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const TIER_STYLE = {
  auto:    'bg-emerald-50 text-emerald-700 ring-emerald-200',
  review:  'bg-amber-50 text-amber-700 ring-amber-200',
  confirm: 'bg-rose-50 text-rose-700 ring-rose-200',
};

const naira = (n) =>
  n === null || n === undefined ? '—' : `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;

async function api(path, options = {}) {
  const res = await fetch(`/api/catalogue${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

/**
 * @param {object} props
 * @param {'all'|'upload'|'products'} [props.view]
 *   Which half to render. Defaults to 'all' so the original single-screen
 *   usage is unchanged — the Inventory tab passes 'upload' or 'products' to
 *   split the same component across two segments rather than duplicating the
 *   product list (and its inline editing) into a second file that would then
 *   have to be kept in step with this one.
 */
export default function UploadCatalogue({ view = 'all' }) {
  const showUpload = view === 'all' || view === 'upload';
  const showProducts = view === 'all' || view === 'products';
  const [meta, setMeta] = useState(null);        // field labels + warnings
  const [analysis, setAnalysis] = useState(null); // current proposal
  const [uploadId, setUploadId] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [report, setReport] = useState(null);
  const [products, setProducts] = useState(null);
  const [duplicates, setDuplicates] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  // A staged upload waiting on a human — normally one the sync agent sent.
  const [pending, setPending] = useState(null);
  // Which price list the upload being reviewed writes to. Read from the upload
  // itself rather than from the tier switch: the server imports against the
  // tier recorded when the file was staged, and those two can disagree.
  const [reviewTier, setReviewTier] = useState(null);
  // The catalogue list below could not be refreshed, so what is on screen may
  // be older than what is actually stored.
  const [listStale, setListStale] = useState(false);
  // Which price list is being viewed and uploaded to. 'retail' | 'wholesale'.
  //
  // A VIEW, not a mode the pharmacy is left "in". Customers are always priced
  // by their own account type (set by the trade QR code), so nothing a person
  // does on this screen can change what any customer is quoted — which is why
  // it is safe for this to be a switch rather than a setting.
  const [tier, setTier] = useState('retail');
  // The tier the user has ASKED for but not yet confirmed. Switching price
  // lists mid-task is how a trade file gets uploaded into retail prices, so
  // the change is stated before it happens rather than after.
  const [pendingTier, setPendingTier] = useState(null);
  const fileRef = useRef(null);
  const wholesale = tier === 'wholesale';

  /**
   * Refresh the catalogue list.
   *
   * A FAILURE HERE USED TO BE INVISIBLE, and that produced the worst possible
   * reading of a successful import: 300 products written on the server, this
   * refresh times out, the screen shows the old catalogue, and nothing
   * anywhere says why. The import looks like it silently did nothing — so the
   * obvious next move is to import again, which is the one thing that cannot
   * help.
   *
   * The list itself is still optional — the previous rows stay on screen
   * rather than being blanked — but the fact that they are STALE is not
   * optional, because it is the difference between "that did not work" and
   * "that worked and this list is behind".
   */
  const loadProducts = useCallback(async () => {
    try {
      setProducts(await api(`/products?limit=25&tier=${tier}`));
      setListStale(false);
      return true;
    } catch {
      setListStale(true);
      return false;
    }
  }, [tier]);

  const loadDuplicates = useCallback(async () => {
    try { setDuplicates(await api('/duplicates')); } catch { /* advisory only */ }
  }, []);

  /**
   * A file that arrived on its own and is waiting for a person.
   *
   * The sync agent stages an upload and stops when it cannot match the columns
   * to a confirmed mapping. Until this existed there was nowhere to go and
   * finish that: the Stock sync panel said "waiting for someone to check the
   * columns", the dashboard offered no way to check them, and the only screen
   * that can review a mapping only ever knew about files chosen in this
   * browser seconds earlier. The catalogue would simply never update, with
   * every part of the system correctly reporting that it was waiting.
   */
  const loadPending = useCallback(async () => {
    try {
      const j = await api('/uploads');
      setPending((j.uploads || []).find((u) => u.status === 'awaiting_confirmation') || null);
    } catch { /* the rest of the screen still works */ }
  }, []);

  /** Open a staged upload in the same review UI a fresh one uses. */
  async function reviewPending(id) {
    setBusy('pending'); setError(null);
    try {
      const row = await api(`/uploads/${id}`);
      setUploadId(row.id);
      setAnalysis(row.analysis);      // stored publicAnalysis — same shape as an upload response
      setOverrides({});
      setReport(null);
      setPending(null);
      // Show the price list this file actually writes to, not whichever one
      // the switch happened to be left on. The server imports against the
      // tier recorded when the file was staged, so a screen saying "Wholesale"
      // over a retail import would be describing something that is not
      // happening — and the reviewer is the last person who can catch it.
      setReviewTier(row.price_tier || 'retail');
      setTier(row.price_tier || 'retail');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    api('/fields').then(setMeta).catch(() => {});
    loadProducts();
    loadDuplicates();
    loadPending();
  }, [loadProducts, loadDuplicates, loadPending]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // reviewTier cleared: a file picked here is uploaded at whatever tier the
    // switch is on, so the switch is the authority for this one.
    setBusy('upload'); setError(null); setReport(null); setAnalysis(null);
    setOverrides({}); setReviewTier(null);
    try {
      const form = new FormData();
      form.append('file', file);
      // The tier travels with the FILE, not with the confirm step. Whichever
      // list was on screen when the file was chosen is the list it imports
      // into, so switching tabs while a mapping is open cannot redirect it.
      form.append('tier', tier);
      const res = await api('/upload', { method: 'POST', body: form });
      setUploadId(res.uploadId);
      setAnalysis(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function confirm() {
    setBusy('confirm'); setError(null);
    try {
      const res = await api(`/${uploadId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides }),
      });
      setReport(res);
      setAnalysis(null);
      setReviewTier(null);
      loadProducts();
      loadDuplicates();
      // Re-checked rather than assumed cleared: the agent may have sent a
      // second file while this one was being reviewed, and the person who just
      // finished one review is exactly who should be told there is another.
      loadPending();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  // Every column in the file, so a proposal can be reassigned to any of them.
  const allColumns = analysis
    ? [
        ...new Set([
          ...analysis.proposals.map((p) => p.rawHeader),
          ...analysis.unmapped,
          ...analysis.detectedButUnused.map((d) => d.rawHeader),
        ]),
      ]
    : [];

  const effective = (field, proposed) =>
    Object.prototype.hasOwnProperty.call(overrides, field) ? overrides[field] : proposed;

  const nameColumn = analysis
    ? effective('name', analysis.proposals.find((p) => p.field === 'name')?.rawHeader ?? null)
    : null;

  return (
    <section className="rounded-lg border border-slate-200 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">
          {view === 'products'
            ? (wholesale ? 'Your wholesale prices' : 'Your catalogue')
            : (wholesale ? 'Upload wholesale prices' : 'Upload catalogue')}
        </h2>
        {products?.counts && (
          <span className="font-mono text-xs text-slate-500 tabular-nums">
            {products.counts.sellable} {wholesale ? 'priced' : 'sellable'} · {products.counts.total} products
            {products.counts.no_price > 0
              && ` · ${products.counts.no_price} without a ${wholesale ? 'wholesale ' : ''}price`}
          </span>
        )}
      </div>

      <TierSwitch
        tier={tier}
        pending={pendingTier}
        onRequest={(next) => { if (next !== tier) setPendingTier(next); }}
        onCancel={() => setPendingTier(null)}
        onConfirm={() => {
          // A staged upload belongs to the tier it was staged for. Carrying a
          // half-finished retail mapping across into the trade list is exactly
          // the mistake the confirmation exists to prevent, so the switch
          // clears it rather than leaving it on screen looking valid.
          setTier(pendingTier);
          setPendingTier(null);
          setAnalysis(null);
          setReport(null);
          setUploadId(null);
          setOverrides({});
          setError(null);
        }}
      />

      {/* ---- a file that arrived on its own ----
          Shown on BOTH the catalogue and upload views, because whoever opens
          the dashboard next is the person who needs to see it, and which of
          the two tabs they happened to click is not a reason to hide it. */}
      {pending && !analysis && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            A stock file arrived and needs your check before it can be imported
          </p>
          <p className="mt-1 text-sm text-amber-800">
            <span className="font-medium">{pending.filename}</span>
            {pending.rows_total > 0 && ` · ${pending.rows_total} rows`}
            {' · '}
            {new Date(pending.created_at).toLocaleString('en-GB', {
              day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
            })}
            {/* Which prices this will change, and where it came from. Both
                said before it is opened, because "300 rows arrived" is not
                enough to decide whether to import it. */}
            {' · '}
            <span className="font-medium">
              {pending.price_tier === 'wholesale' ? 'wholesale prices' : 'retail prices'}
            </span>
            {pending.sync_device_id && ' · sent by a connected computer'}
          </p>
          <p className="mt-2 text-xs text-amber-800">
            Nothing has been changed yet. Confirm which column is which once, and
            files with the same columns will import by themselves from then on.
          </p>
          <button
            type="button"
            onClick={() => reviewPending(pending.id)}
            disabled={busy === 'pending'}
            className="mt-3 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-40"
          >
            {busy === 'pending' ? 'Opening…' : 'Check the columns'}
          </button>
        </div>
      )}

      {/* ---- pick a file ---- */}
      {showUpload && !analysis && !report && (
        <div className="mt-4">
          <p className="text-sm text-slate-600">
            Excel or CSV. Nothing is saved until you have checked the columns on the next screen.
          </p>
          {wholesale && (
            // Said before the file picker, not after the import. The single
            // most likely mistake here is dropping a full retail catalogue in
            // expecting it to replace everything, so what a trade file does —
            // and does not do — is stated where it can still change the
            // decision.
            <p className="mt-2 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              This file sets <strong>wholesale prices only</strong>. Rows are matched to products you
              already have. Retail prices and stock are left untouched.
            </p>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={onFile}
            disabled={busy === 'upload'}
            className="mt-3 block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white disabled:opacity-40"
          />
          {busy === 'upload' && <p className="mt-2 text-sm text-slate-500">Reading the file…</p>}
        </div>
      )}

      {/* ---- confirm the mapping ---- */}
      {analysis && (
        <div className="mt-5">
          {analysis.looksLikeSalesExport && (
            <div className="mb-4 rounded border border-rose-200 bg-rose-50 p-3">
              <p className="text-sm font-medium text-rose-800">This looks like a sales report, not a catalogue.</p>
              <p className="mt-1 text-sm text-rose-700">
                It contains {analysis.salesFields.join(', ')}. Importing it would turn every sale into a
                separate product. Upload your product or stock list instead.
              </p>
            </div>
          )}

          {analysis.missingRequired.length > 0 && (
            <div className="mb-4 rounded border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-800">
                Still needed: {analysis.missingRequired.map((f) => meta?.fields?.[f]?.label || f).join(' and ')}
              </p>
              <p className="mt-1 text-sm text-amber-700">
                Pick the right column below. Without a price the assistant can say you stock something,
                but never what it costs.
              </p>
            </div>
          )}

          {/* Which prices are about to change, stated on the screen where the
              decision is made. Importing a trade list into retail prices is
              not a mistake anybody notices afterwards — the numbers all look
              like prices, and the only symptom is margin quietly disappearing. */}
          <p className={`rounded border px-3 py-2 text-sm ${
            (reviewTier || tier) === 'wholesale'
              ? 'border-amber-300 bg-amber-50 text-amber-900'
              : 'border-slate-200 bg-slate-50 text-slate-700'}`}
          >
            This will set your{' '}
            <strong>{(reviewTier || tier) === 'wholesale' ? 'wholesale prices' : 'retail prices'}</strong>.
            {(reviewTier || tier) === 'wholesale'
              ? ' Retail prices and stock are not touched.'
              : ' Wholesale prices are not touched.'}
          </p>

          <p className="mt-3 text-sm text-slate-600">
            Read {analysis.rowsOut} rows from <span className="font-medium">{analysis.sheetNames?.[0]}</span>
            {analysis.rowsIn !== analysis.rowsOut && ` (${analysis.rowsIn - analysis.rowsOut} blank rows skipped)`}.
            Check each column, then import.
          </p>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-3">Field</th>
                  <th className="py-2 pr-3">Column in your file</th>
                  <th className="py-2 pr-3">Confidence</th>
                  <th className="py-2">Why</th>
                </tr>
              </thead>
              <tbody>
                {analysis.proposals.map((p) => {
                  const display = meta?.fields?.[p.field];
                  return (
                    <tr key={p.field} className="border-b border-slate-100 align-top">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{display?.label || p.field}</div>
                        {display?.warning && (
                          <div className="mt-0.5 max-w-[22rem] text-xs text-slate-500">{display.warning}</div>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <select
                          value={effective(p.field, p.rawHeader) ?? ''}
                          onChange={(e) =>
                            setOverrides((o) => ({ ...o, [p.field]: e.target.value || null }))
                          }
                          className="w-48 rounded border border-slate-300 px-2 py-1 text-sm"
                        >
                          <option value="">— not in this file —</option>
                          {allColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${TIER_STYLE[p.tier] || TIER_STYLE.review}`}>
                          {meta?.tiers?.[p.tier]?.label || p.tier}
                        </span>
                        {p.reinterpreted && (
                          <div className="mt-1 text-xs text-amber-700">read as stock, not sales</div>
                        )}
                      </td>
                      <td className="py-2 text-xs text-slate-500">{p.source}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {analysis.unmapped.length > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              <span className="font-medium">Not imported:</span> {analysis.unmapped.join(', ')}
              {analysis.detectedButUnused.length > 0 && (
                <> — {analysis.detectedButUnused.map((d) => `${d.rawHeader} looks like ${d.canonical}`).join('; ')}</>
              )}
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              onClick={confirm}
              disabled={busy === 'confirm' || !nameColumn}
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy === 'confirm' ? 'Importing…' : `Import ${analysis.rowsOut} rows`}
            </button>
            <button
              onClick={() => { setAnalysis(null); setOverrides({}); }}
              className="rounded border border-slate-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
            {!nameColumn && (
              <p className="w-full text-xs text-rose-700">
                Choose the column holding the product name before importing.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ---- import report ---- */}
      {report && (
        <div className="mt-5">
          <div className="rounded border border-emerald-200 bg-emerald-50 p-4">
            <p className="font-medium text-emerald-900">
              Imported {report.imported} products
              {report.rejected > 0 && `, skipped ${report.rejected}`}
            </p>
            {/* The import SUCCEEDED — this is only about the list below being
                behind. Said here, next to the success, because the alternative
                is someone reading an unchanged catalogue as a failed import
                and running it again. */}
            {listStale && (
              <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-2.5 py-2 text-sm text-amber-900">
                <strong>Saved.</strong> The list below could not be refreshed just now, so it
                may still show the old catalogue — that is this page being behind, not the
                import failing.{' '}
                <button
                  type="button"
                  onClick={() => loadProducts()}
                  className="font-medium underline underline-offset-2"
                >
                  Try again
                </button>
                , or reload the page.
              </p>
            )}
            <ul className="mt-2 space-y-0.5 text-sm text-emerald-800">
              {report.flagged.noPrice > 0 && (
                <li>{report.flagged.noPrice} have no price — the assistant will not quote them.</li>
              )}
              {report.flagged.expired > 0 && (
                <li>{report.flagged.expired} are past their expiry date and are hidden from customers.</li>
              )}
              {report.flagged.strengthFromFile > 0 && (
                <li>{report.flagged.strengthFromFile} had a strength differing from our reference data — yours was kept.</li>
              )}
              {report.duplicatesCollapsed > 0 && (
                <li>{report.duplicatesCollapsed} duplicate rows were collapsed; the last one won.</li>
              )}
            </ul>
          </div>

          {report.issues.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Rows worth checking ({report.issueCount})
              </h3>
              <div className="mt-2 max-h-56 overflow-y-auto rounded border border-slate-200">
                {report.issues.map((i, idx) => (
                  <div key={idx} className="flex gap-3 border-b border-slate-100 p-2 text-xs last:border-b-0">
                    <span className="w-16 shrink-0 font-mono text-slate-400 tabular-nums">
                      {i.row ? `row ${i.row}` : '—'}
                    </span>
                    <span className="w-24 shrink-0 text-slate-500">{i.field}</span>
                    <span className="min-w-0 flex-1 text-slate-800">
                      {i.detail || i.reason}{i.value ? ` (${i.value})` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={() => { setReport(null); loadProducts(); }}
            className="mt-4 rounded border border-slate-300 px-4 py-2 text-sm"
          >
            Upload another file
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>
      )}

      {/* ---- what the assistant will see ---- */}
      {showProducts && products?.products?.length > 0 && !analysis && (
        <div className="mt-6 border-t border-slate-100 pt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">
            In the catalogue
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Add a line about a product and the assistant will use your words when a customer asks
            what you have. Star the ones you want it to recommend first.
          </p>
          <div className="mt-2 max-h-80 overflow-y-auto rounded border border-slate-200">
            {products.products.map((p) => (
              <ProductRow key={p.id} product={p} naira={naira} wholesale={wholesale} />
            ))}
          </div>
        </div>
      )}

      {/* ---- names that look alike but can't be confirmed either way ----
          Two different findings, deliberately shown differently. The pairs
          are a QUESTION only a person can answer, so they are listed. The
          re-upload count is an ANSWER nobody has to think about, so it is one
          sentence — listing those too would bury the handful that matter
          under a pile that resolves itself. */}
      {showProducts && !analysis
        && (duplicates?.pairs?.length > 0 || duplicates?.willMergeOnReimport > 0) && (
        <div className="mt-6 border-t border-slate-100 pt-4">
          {duplicates.pairs.length > 0 && (
            <>
              <h3 className="text-xs font-medium uppercase tracking-wide text-amber-700">
                Worth a second look ({duplicates.pairs.length})
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                These names are close enough to be the same product misspelled — but the NAFDAC
                drug registry cannot name at least one of them, and it does not list every drug on
                the Nigerian market, so nothing here can tell them apart for you. Check by hand: if
                it is a typo, fix the name in your source file and re-upload; if they really are two
                different products, nothing needs to change.
              </p>
              <div className="mt-2 space-y-2">
                {duplicates.pairs.map((pair) => (
                  <div
                    key={`${pair.a.id}-${pair.b.id}`}
                    className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        {pair.a.name}
                        {pair.a.strength && <span className="text-amber-700"> · {pair.a.strength}</span>}
                      </span>
                      <span className="shrink-0 text-amber-500">vs</span>
                      <span className="min-w-0 truncate text-right">
                        {pair.b.name}
                        {pair.b.strength && <span className="text-amber-700"> · {pair.b.strength}</span>}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {duplicates.willMergeOnReimport > 0 && (
            <p className={`text-xs text-slate-500 ${duplicates.pairs.length > 0 ? 'mt-3' : ''}`}>
              {duplicates.willMergeOnReimport === 1
                ? 'One other pair of near-identical names is'
                : `${duplicates.willMergeOnReimport} other pairs of near-identical names are`}{' '}
              already recognised in the drug registry and will be merged into a single product the
              next time you upload this file. Nothing to decide.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One catalogue row, with the two fields the pharmacy owns.
 *
 * Price and stock are shown but NOT editable here: they come from the
 * spreadsheet and are replaced on every re-import, so an edit made here
 * would be silently undone by the next upload. Only the two fields that
 * survive an import are editable.
 */
/**
 * Retail ⇄ Wholesale price list.
 *
 * WHY A SEGMENTED CONTROL AND NOT A TOGGLE
 * A toggle labelled "wholesale" reads as ON/OFF — as though wholesale were a
 * mode the shop could be left switched into overnight. It cannot: customers
 * are priced by their own account type, set once by the wholesale QR code,
 * and nothing here changes that. Two named segments say what this actually
 * is — two price lists, one of which you are looking at.
 *
 * WHY THE SWITCH IS CONFIRMED
 * The two lists look identical: same products, same table, same upload box.
 * The only difference is a column of numbers, which is exactly the kind of
 * difference someone does not notice before dropping a file in.
 *
 * Kept to two short lines. An explanation longer than the decision it
 * supports stops being read at all, and this one is asking about a view.
 */
function TierSwitch({ tier, pending, onRequest, onCancel, onConfirm }) {
  // The segment says the whole thing. A label plus a second explanatory line
  // ("Retail — counter prices") is one idea written twice, and the second
  // half is what makes a control look busier than the choice it offers.
  const OPTIONS = [
    { id: 'retail', label: 'Retail price' },
    { id: 'wholesale', label: 'Wholesale price' },
  ];

  return (
    <div className="mt-4">
      <div
        role="group"
        aria-label="Price list"
        className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1"
      >
        {OPTIONS.map((o) => {
          const active = o.id === tier;
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={active}
              onClick={() => onRequest(o.id)}
              className={`rounded-md px-3 py-1.5 text-left text-sm transition ${
                active
                  ? 'bg-white font-medium text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>

      {pending && (
        // Amber, not red: this is a change worth reading, not a destructive
        // act. Nothing is written until a file is actually imported.
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            {pending === 'wholesale'
              ? 'Switch to wholesale prices?'
              : 'Switch to retail prices?'}
          </p>
          <p className="mt-1 text-sm text-amber-800">
            You will be viewing and uploading {pending} prices. The other price list and your
            stock are not affected.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onConfirm}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
            >
              Switch
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// `wholesale` defaults to false rather than being required: this row is
// rendered from two places and a missing prop should degrade to the retail
// view, not throw. Leaving it out of the signature entirely is what shipped a
// ReferenceError — the identifier resolved to nothing at all rather than to
// undefined, so the whole dashboard failed to mount the moment a product
// existed to render.
function ProductRow({ product, naira, wholesale = false }) {
  const [description, setDescription] = useState(product.description || '');
  const [featured, setFeatured] = useState(Boolean(product.is_featured));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(next = {}) {
    setSaving(true);
    try {
      const r = await fetch(`/api/catalogue/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, isFeatured: featured, ...next }),
      });
      if (r.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        setEditing(false);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-b border-slate-100 p-2 text-sm last:border-b-0">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => { const v = !featured; setFeatured(v); save({ isFeatured: v }); }}
          title={featured ? 'The assistant offers this first' : 'Mark as one you recommend'}
          className={`shrink-0 text-base leading-none ${featured ? 'text-amber-500' : 'text-slate-300 hover:text-slate-400'}`}
        >
          {featured ? '★' : '☆'}
        </button>
        <span className="min-w-0 flex-1 truncate">
          {product.name}
          {product.strength && <span className="text-slate-400"> · {product.strength}</span>}
        </span>
        {/* A missing wholesale price is not "unpriced" — it is "not sold
            wholesale", a different fact with a different fix, and an em-dash
            shared with the retail view would hide the distinction. The retail
            figure rides alongside as context: judging a wholesale price
            without seeing the retail one beside it is the one thing this
            screen exists to make easy. */}
        {wholesale && product.price === null ? (
          <span className="shrink-0 text-xs italic text-slate-400">no wholesale price</span>
        ) : (
          <span className="shrink-0 tabular-nums">
            {naira(product.price)}
            {wholesale && product.retailPrice !== null && (
              <span className="ml-2 text-xs font-normal text-slate-400">
                retail {naira(product.retailPrice)}
              </span>
            )}
          </span>
        )}
        <span className="w-20 shrink-0 text-right text-xs text-slate-500 tabular-nums">
          {product.stock_tracked ? `${product.stock_qty ?? '?'} in stock` : 'not tracked'}
        </span>
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          className="shrink-0 text-xs text-slate-500 underline hover:text-slate-800"
        >
          {description ? 'edit note' : 'add note'}
        </button>
      </div>

      {description && !editing && (
        <p className="mt-1 pl-7 text-xs italic text-slate-600">“{description}”</p>
      )}

      {editing && (
        <div className="mt-2 pl-7">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 300))}
            placeholder="e.g. Full 3-day course, one pack treats one adult"
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Sent to customers in your words. The assistant will not rewrite it or add claims of its own.
          </p>
          <div className="mt-1 flex gap-2">
            <button
              onClick={() => save()}
              disabled={saving}
              className="rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setDescription(product.description || ''); setEditing(false); }}
              className="px-1 text-xs text-slate-500">
              Cancel
            </button>
            {saved && <span className="self-center text-xs text-teal-700">Saved</span>}
          </div>
        </div>
      )}
    </div>
  );
}
