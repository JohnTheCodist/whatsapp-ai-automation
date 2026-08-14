/**
 * Internal notes and tags on the customer profile.
 *
 * THE BANNER IS PART OF THE FEATURE, NOT DECORATION
 * Everything else a pharmacist types in this product eventually reaches a
 * customer — a reply, an alternative suggestion, an order confirmation. This
 * box is the first one that does not, and someone who assumes otherwise will
 * write something here they would never send. So the privacy boundary is
 * stated on the control itself, not in documentation nobody opens.
 */

import { useCallback, useEffect, useState } from 'react';

function relTime(ts) {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function CustomerCrm({ customerId }) {
  const [notes, setNotes] = useState([]);
  const [tags, setTags] = useState([]);
  const [allTags, setAllTags] = useState([]);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [n, t, a] = await Promise.all([
        fetch(`/api/customers/${customerId}/notes`).then((r) => r.json()),
        fetch(`/api/customers/${customerId}/tags`).then((r) => r.json()),
        fetch('/api/customers/tags/all').then((r) => r.json()),
      ]);
      setNotes(n.notes || []);
      setTags(t.tags || []);
      setAllTags(a.tags || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  async function saveNote() {
    const content = draft.trim();
    if (!content) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/customers/${customerId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not save the note.');
      setDraft('');
      setAdding(false);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeNote(id) {
    setBusy(true);
    try {
      await fetch(`/api/customers/${customerId}/notes/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function toggleTag(tag, attached) {
    setBusy(true);
    try {
      if (attached) {
        await fetch(`/api/customers/${customerId}/tags/${tag.id}`, { method: 'DELETE' });
      } else {
        await fetch(`/api/customers/${customerId}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tagId: tag.id }),
        });
      }
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const attachedIds = new Set(tags.map((t) => t.id));

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Internal notes &amp; tags
        </h3>
        {/* Stated once, at the top, covering both halves of the section. */}
        <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
          Staff only — the customer never sees this
        </span>
      </div>

      {error && (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {/* ---- tags ---- */}
      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          {tags.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
            >
              {t.name}
              <button
                type="button"
                onClick={() => toggleTag(t, true)}
                disabled={busy}
                aria-label={`Remove tag ${t.name}`}
                className="rounded text-slate-400 hover:text-red-600 focus:outline-2 focus:outline-offset-1 focus:outline-teal-600 disabled:opacity-40"
              >
                ×
              </button>
            </span>
          ))}
          {tags.length === 0 && <span className="text-sm text-slate-400">No tags</span>}
          <button
            type="button"
            onClick={() => setPicking((v) => !v)}
            className="rounded border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 focus:outline-2 focus:outline-offset-1 focus:outline-teal-600"
          >
            + Add tag
          </button>
        </div>

        {picking && (
          <div className="mt-2 flex flex-wrap gap-2 rounded border border-slate-200 bg-slate-50 p-3">
            {allTags.map((t) => {
              const attached = attachedIds.has(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleTag(t, attached)}
                  disabled={busy}
                  className={`rounded-full px-2.5 py-1 text-xs transition focus:outline-2 focus:outline-offset-1 focus:outline-teal-600 disabled:opacity-40 ${
                    attached
                      ? 'bg-teal-100 text-teal-800'
                      : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                  }`}
                >
                  {attached ? '✓ ' : ''}{t.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- notes ---- */}
      <div className="mt-5 space-y-2">
        {notes.map((n) => (
          <article key={n.id} className="group rounded border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="whitespace-pre-wrap text-sm text-slate-800">{n.content}</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-500">
                {n.author_email ? `${n.author_email} · ` : ''}{relTime(n.created_at)}
                {n.updated_at !== n.created_at ? ' · edited' : ''}
              </span>
              <button
                type="button"
                onClick={() => removeNote(n.id)}
                disabled={busy}
                className="rounded text-xs text-slate-400 hover:text-red-600 focus:outline-2 focus:outline-offset-1 focus:outline-teal-600 disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </article>
        ))}
        {notes.length === 0 && !adding && (
          <p className="text-sm text-slate-400">No internal notes yet.</p>
        )}

        {adding ? (
          <div className="rounded border border-amber-300 bg-amber-50/50 p-3">
            <label className="block">
              <span className="text-xs font-medium text-amber-900">
                Internal note — the customer will not see this
              </span>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, 2000))}
                rows={3}
                autoFocus
                placeholder="Prefers pickup. Usually orders monthly."
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-2 focus:outline-offset-0 focus:outline-teal-600"
              />
            </label>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-slate-500">{draft.length}/2000</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setAdding(false); setDraft(''); }}
                  className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-white"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveNote}
                  disabled={busy || !draft.trim()}
                  className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
                >
                  {busy ? 'Saving…' : 'Save note'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 focus:outline-2 focus:outline-offset-1 focus:outline-teal-600"
          >
            + Add internal note
          </button>
        )}
      </div>
    </section>
  );
}
