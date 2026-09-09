/**
 * The owner's own wording for each generated page.
 *
 * WHAT THIS DOES AND DOES NOT CONTROL. About, Services, each service page,
 * Location and Contact are entirely auto-written today — a heading and an
 * opening line built from the pharmacy's name, city and services, the same
 * few sentences shape for every pharmacy on the platform. This lets an owner
 * replace that heading and opening line with their own, per page. It does
 * NOT let them rewrite the page's structure, add a new page, or touch a
 * health article — those stay exactly as they were. See
 * services/website/websiteService.js's validatePageCopy for the exact shape
 * this is saved as, and pageContent.js for exactly where a health-article
 * page is refused this channel even if asked.
 *
 * BLANK MEANS "USE THE AUTOMATIC VERSION", NOT "SHOW NOTHING". Clearing a box
 * and saving removes the override rather than publishing an empty heading —
 * the generated default takes over again, silently and safely.
 *
 * SAVED PER PAGE, NOT ALL AT ONCE. Five pages with one Save button is one
 * mistake on page two costing whatever was already typed on page five. Each
 * page keeps its own draft, its own Save button and its own saved/error state.
 *
 * "WRITE WITH AI" FILLS THE BOX; IT DOES NOT SAVE ANYTHING. api.generatePageCopy
 * asks for one specific field (heading / intro / about) for one specific
 * page and returns a DRAFT — exactly the same shape as if the owner had typed
 * it themselves, landing in the same `draft` state, subject to the same Save
 * button and the same "blank means automatic" rule. It is a request to write
 * an SEO-aware first draft grounded in the pharmacy's real facts, not a
 * generic filler generator — see services/ai/pageCopyGenerator.js for
 * exactly what it is and is not allowed to invent.
 *
 * `content` IS REPLACED WHOLESALE BY THE SERVER, so every save here sends the
 * pharmacy's WHOLE content object back — the same pattern HealthTopics.jsx
 * already uses for `content.health` — with only this one page's entry inside
 * `pageCopy` changed.
 */

import { useState } from 'react';
import * as api from './api.js';

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 '
  + 'focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600';

/** Which text fields a page kind offers, and what to call each one. */
function fieldsFor(kind) {
  const base = [
    { key: 'heading', label: 'Heading', kind: 'input', max: 120, placeholder: 'Uses the automatic heading' },
    { key: 'intro', label: 'Introduction', kind: 'textarea', max: 400, placeholder: 'Uses the automatic introduction' },
  ];
  if (kind === 'service') {
    base.push({
      key: 'about', label: 'About this service', kind: 'textarea', max: 600,
      placeholder: 'Uses the automatic description of what this involves',
    });
  }
  // ONLY on the About page, because that is the only page that renders them
  // (pageContent.js's missionVisionSection). Unlike every other box here,
  // these have NO automatic version to fall back on: a mission statement is
  // a claim about what this pharmacy is for, and nothing writes one for you
  // — so the placeholder says so rather than promising a default.
  if (kind === 'about') {
    base.push({
      key: 'mission', label: 'Our mission', kind: 'textarea', max: 600,
      placeholder: 'Nothing is shown until you write this',
    });
    base.push({
      key: 'vision', label: 'Our vision', kind: 'textarea', max: 600,
      placeholder: 'Nothing is shown until you write this',
    });
  }
  return base;
}

function PageRow({ page, initial, onSaved }) {
  const [draft, setDraft] = useState(() => ({ ...initial }));
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const [error, setError] = useState(null);
  // Which field is currently being drafted by AI, if any — per field rather
  // than per page, so writing the heading does not disable the button beside
  // the introduction.
  const [generating, setGenerating] = useState(null);
  const [genError, setGenError] = useState(null); // { field, message }

  const fields = fieldsFor(page.kind);
  const dirty = fields.some((f) => (draft[f.key] || '') !== (initial[f.key] || ''));

  /**
   * Fill one box with an AI-written draft — never saves anything on its own.
   * The result lands in `draft` exactly as if the owner had typed it, so the
   * existing Save button, the dirty check and the "leave blank for the
   * automatic version" rule all apply to it unchanged.
   */
  async function writeWithAi(fieldKey) {
    setGenerating(fieldKey);
    setGenError(null);
    try {
      const { text } = await api.generatePageCopy(page.path, fieldKey);
      setDraft((d) => ({ ...d, [fieldKey]: text }));
    } catch (err) {
      setGenError({ field: fieldKey, message: err.message });
    } finally {
      setGenerating(null);
    }
  }

  async function save() {
    setStatus('saving');
    setError(null);
    try {
      const updated = await onSaved(page.path, draft);
      setStatus('saved');
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2500);
      return updated;
    } catch (err) {
      setError(err.message);
      setStatus('error');
      return undefined;
    }
  }

  function preview() {
    // The last SAVED wording, same as the main preview pane always shows the
    // last saved draft rather than live keystrokes — opening a fresh tab
    // rather than an iframe here because this can be reached from deep
    // inside an accordion row, where a large embedded preview would be the
    // least visible thing on the screen.
    api.previewHtml(Date.now(), null, page.path)
      .then((html) => {
        const win = window.open('', '_blank');
        if (!win) return; // popup blocked — nothing left to do politely
        win.document.write(html);
        win.document.close();
      })
      .catch((err) => setError(err.message));
  }

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{page.label}</p>
          <p className="text-xs text-slate-500">{page.path}</p>
        </div>
        <button type="button" onClick={preview} className="shrink-0 text-xs font-medium text-teal-700 hover:underline">
          Preview this page →
        </button>
      </div>

      <div className="space-y-3">
        {fields.map((f) => (
          <div key={f.key}>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">{f.label}</span>
              {f.kind === 'textarea' ? (
                <textarea
                  className={`${inputClass} mt-1 min-h-20`}
                  value={draft[f.key] || ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value.slice(0, f.max) }))}
                  placeholder={f.placeholder}
                />
              ) : (
                <input
                  className={`${inputClass} mt-1`}
                  value={draft[f.key] || ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value.slice(0, f.max) }))}
                  placeholder={f.placeholder}
                />
              )}
            </label>

            <div className="mt-1 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => writeWithAi(f.key)}
                disabled={generating === f.key}
                className="text-xs font-medium text-teal-700 transition hover:underline disabled:cursor-wait disabled:opacity-50"
              >
                {generating === f.key ? 'Writing…' : '✨ Write with AI'}
              </button>
            </div>
            {genError?.field === f.key && (
              <p className="mt-1 text-xs text-red-700">{genError.message}</p>
            )}
          </div>
        ))}
      </div>

      {status === 'error' && <p className="mt-2 text-xs text-red-700">{error}</p>}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || status === 'saving'}
          className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-teal-800 disabled:opacity-40"
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {status === 'saved' && <span className="text-xs text-teal-700">Saved.</span>}
        {!dirty && status === 'idle' && (
          <span className="text-xs text-slate-400">
            {Object.values(initial).some(Boolean) ? 'Your own wording is live here.' : 'Using the automatic wording.'}
          </span>
        )}
      </div>
    </div>
  );
}

export default function PageText({ site, pages, onSaved }) {
  const [error, setError] = useState(null);

  async function saveOne(path, fields) {
    const current = (site?.content && typeof site.content === 'object') ? site.content : {};
    const pageCopy = { ...(current.pageCopy || {}) };
    // An entry with nothing typed in any field is the same as no override —
    // dropped, so Preview and the live site both fall back to the generated
    // default rather than an override object that happens to be empty.
    const meaningful = Object.fromEntries(Object.entries(fields).filter(([, v]) => (v || '').trim()));
    if (Object.keys(meaningful).length) pageCopy[path] = meaningful; else delete pageCopy[path];

    try {
      const updated = await api.saveContent({ ...current, pageCopy });
      onSaved?.(updated.site);
      return updated.site;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }

  if (!pages?.length) {
    return (
      <p className="text-sm text-slate-500">
        There is nothing to edit yet — add an address or a service first, and its page will
        appear here.
      </p>
    );
  }

  return (
    <div>
      <p className="mb-3 text-xs text-slate-500">
        About, Services, Location, Contact and each service page are written for you
        automatically. Replace the heading or opening line on any of them below — leave a box
        empty to keep the automatic version.
      </p>

      {error && (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}

      <div className="space-y-3">
        {pages.map((page) => (
          <PageRow
            key={page.path}
            page={page}
            initial={site?.content?.pageCopy?.[page.path] || {}}
            onSaved={saveOne}
          />
        ))}
      </div>
    </div>
  );
}
