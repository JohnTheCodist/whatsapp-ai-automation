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

export default function UploadCatalogue() {
  const [meta, setMeta] = useState(null);        // field labels + warnings
  const [analysis, setAnalysis] = useState(null); // current proposal
  const [uploadId, setUploadId] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [report, setReport] = useState(null);
  const [products, setProducts] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const loadProducts = useCallback(async () => {
    try { setProducts(await api('/products?limit=25')); } catch { /* counts panel is optional */ }
  }, []);

  useEffect(() => {
    api('/fields').then(setMeta).catch(() => {});
    loadProducts();
  }, [loadProducts]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy('upload'); setError(null); setReport(null); setAnalysis(null); setOverrides({});
    try {
      const form = new FormData();
      form.append('file', file);
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
      loadProducts();
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
        <h2 className="text-lg font-medium">Upload catalogue</h2>
        {products?.counts && (
          <span className="font-mono text-xs text-slate-500 tabular-nums">
            {products.counts.sellable} sellable · {products.counts.total} products
            {products.counts.no_price > 0 && ` · ${products.counts.no_price} without a price`}
          </span>
        )}
      </div>

      {/* ---- pick a file ---- */}
      {!analysis && !report && (
        <div className="mt-4">
          <p className="text-sm text-slate-600">
            Excel or CSV. Nothing is saved until you have checked the columns on the next screen.
          </p>
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

          <p className="text-sm text-slate-600">
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
      {products?.products?.length > 0 && !analysis && (
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
              <ProductRow key={p.id} product={p} naira={naira} />
            ))}
          </div>
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
function ProductRow({ product, naira }) {
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
        <span className="shrink-0 tabular-nums">{naira(product.price)}</span>
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
