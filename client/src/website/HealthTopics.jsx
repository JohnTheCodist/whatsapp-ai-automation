/**
 * Health guides a pharmacy can put on its website.
 *
 * OPT-IN, AND ONLY FROM A REVIEWED LIBRARY. The articles are written once for
 * the platform and read by a pharmacist before anyone can publish them. This
 * screen offers whatever the server says is approved and nothing else, so a
 * toggle can never switch on an article that would then refuse to render.
 *
 * WHY THE EMPTY STATE IS THE NORMAL STATE, AT LEAST AT FIRST
 * Every article ships awaiting review, because "Medically reviewed by" is a
 * claim about a real person and no software should be able to make it. Until
 * a pharmacist has read them, this list is empty — and it says so plainly
 * rather than showing toggles that do nothing. An owner who ticks a box and
 * sees no page appear concludes the product is broken; an owner told there is
 * nothing to publish yet has been told the truth.
 *
 * THE REVIEWER IS SHOWN. A pharmacist is putting their own business's name on
 * this content, and "who checked it?" is the first fair question. It is
 * answered here rather than buried.
 */

import { useEffect, useState } from 'react';
import * as api from './api.js';

export default function HealthTopics({ site, onSaved }) {
  const [articles, setArticles] = useState(null); // null = loading
  const [enabled, setEnabled] = useState(() => {
    const current = site?.content?.health;
    return Array.isArray(current) ? current : [];
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    api.getHealthArticles()
      .then((res) => live && setArticles(res.articles || []))
      .catch((err) => live && setError(err.message));
    return () => { live = false; };
  }, []);

  async function toggle(slug) {
    const next = enabled.includes(slug)
      ? enabled.filter((s) => s !== slug)
      : [...enabled, slug];

    setEnabled(next);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // content is REPLACED, not merged, so everything else the guided flow
      // stored has to travel with it. Sending only { health } would silently
      // discard the rest.
      const updated = await api.saveContent({ ...(site?.content || {}), health: next });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved?.(updated.site);
    } catch (err) {
      setError(err.message);
      setEnabled(enabled); // put it back rather than showing a state that did not save
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-slate-800">Health guides</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Written and checked by pharmacists, not by us and not automatically. Add any that
        are useful to your customers — each becomes a page on your website.
      </p>

      {error && (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {articles === null && (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      )}

      {articles?.length === 0 && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm text-slate-700">No health guides are available yet.</p>
          <p className="mt-1 text-xs text-slate-500">
            Guides are only offered here once a pharmacist has reviewed them. Nothing about
            your website is missing — this section simply will not appear until there is
            something checked to put in it.
          </p>
        </div>
      )}

      {articles?.length > 0 && (
        <ul className="mt-3 space-y-2">
          {articles.map((article) => {
            const on = enabled.includes(article.slug);
            return (
              <li key={article.slug}>
                <button
                  type="button"
                  onClick={() => toggle(article.slug)}
                  disabled={busy}
                  aria-pressed={on}
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition disabled:opacity-50 ${
                    on
                      ? 'border-teal-400 bg-teal-50'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <span className="flex items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                        on ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300'
                      }`}
                    >
                      {on ? '✓' : ''}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800">
                        {article.title}
                      </span>
                      <span className="block text-xs text-slate-500">{article.summary}</span>
                      {article.reviewer && (
                        <span className="mt-1 block text-[11px] text-slate-400">
                          Reviewed by {article.reviewer}
                          {article.reviewerTitle ? `, ${article.reviewerTitle}` : ''}
                          {article.reviewedAt ? ` · ${article.reviewedAt}` : ''}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {articles?.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          {enabled.length === 0
            ? 'None added. Your website will not have a health section.'
            : `${enabled.length} guide${enabled.length === 1 ? '' : 's'} on your website.`}
          {saved && <span className="ml-2 text-teal-700">Saved.</span>}
        </p>
      )}
    </section>
  );
}
