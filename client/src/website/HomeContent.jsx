/**
 * The owner's own wording for each section of the homepage.
 *
 * ONE LEVEL ABOVE PageText.jsx. That file rewrites the heading/intro on the
 * auto-generated pages (About, Services, each service, Location, Contact).
 * The homepage is different: it is not generated text, it is a composition
 * of BLOCKS the owner chose a template for, and every block already carries
 * its own editorial props — a heading, a subheading, a button's label — in
 * `site.site_data.blocks[i].props`. Until now the ONLY way to change any of
 * that was the drag-and-drop advanced editor. This is the same simple "one
 * box per field" experience PageText already gives the other pages, applied
 * to the fields the block registry says are actually free text an owner may
 * write, in the order the owner's own homepage already has them.
 *
 * THE BLOCK REGISTRY DECIDES WHAT IS EDITABLE HERE, NOT THIS FILE. A field is
 * offered only when the block contract (fetched from the server, the same
 * contract the advanced editor uses) says it is a plain text prop with no
 * `from` binding. A bound prop — the About block's description, inherited
 * from the pharmacy profile — is never offered here: that fact is edited once,
 * in Website content, and offering a second box for it would let the two
 * drift. A list prop (services, reviews, opening hours) is never offered
 * here either; those already have their own editors.
 *
 * BLANK MEANS "USE THIS BLOCK'S OWN DEFAULT WORDING", exactly like PageText —
 * clearing a box and saving removes the override rather than publishing an
 * empty heading, and the block's own default text (or its home-page-through-
 * the-render-path binding) takes over again.
 *
 * SAVED PER SECTION, NOT ALL AT ONCE, for the same reason PageText saves per
 * page: seven sections with one Save button is one mistake in the hero
 * costing whatever was already typed in the footer.
 *
 * SAVING REPLACES site_data WHOLESALE, because that is the shape PUT /site
 * has always taken — the same endpoint the advanced editor calls. Only this
 * one block's props change; every other block, and the order of the list, is
 * carried through untouched.
 */

import { useEffect, useMemo, useState } from 'react';
import * as api from './api.js';

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 '
  + 'focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600';

/** Human labels for the field names that actually appear across the registry. */
const FIELD_LABELS = {
  heading: 'Heading',
  subheading: 'Subheading',
  description: 'Description',
  label: 'Button text',
  buttonLabel: 'Button text',
  primaryCtaLabel: 'Primary button text',
  secondaryCtaLabel: 'Secondary button text',
  directionsLabel: 'Button text',
  message: 'Pre-filled WhatsApp message',
  note: 'Note',
};

/** Falls back to a humanised version of the prop name for anything not listed above. */
function fieldLabel(name) {
  if (FIELD_LABELS[name]) return FIELD_LABELS[name];
  return name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/** A title (heading, a button's own text) is one line; everything else can run on. */
function isShortField(name) {
  return name === 'heading' || name === 'label' || /Label$/.test(name);
}

/**
 * The fields THIS block instance may have written for it: every prop the
 * block contract lists as plain text with no `from` binding — a stored fact
 * this block inherits and must not be offered a second, divergent box for.
 */
function editableFieldsFor(definition) {
  if (!definition) return [];
  // `traits` is an ARRAY of {name, kind, inherited, max, ...} — see
  // editorManifest.js's traitsFor, which is the same list the advanced
  // editor's properties panel reads.
  return (definition.traits || [])
    .filter((t) => t.kind === 'text' && !t.inherited)
    .map((t) => ({ name: t.name, max: t.max || 200 }));
}

function SectionRow({ index, title, description, definition, initialProps, onSaved }) {
  const fields = useMemo(() => editableFieldsFor(definition), [definition]);
  const [draft, setDraft] = useState(() => ({ ...initialProps }));
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(null);
  const [genError, setGenError] = useState(null); // { field, message }

  const dirty = fields.some((f) => (draft[f.name] || '') !== (initialProps[f.name] || ''));

  async function writeWithAi(fieldName) {
    setGenerating(fieldName);
    setGenError(null);
    try {
      const { text } = await api.generateHomeCopy(index, fieldName);
      setDraft((d) => ({ ...d, [fieldName]: text }));
    } catch (err) {
      setGenError({ field: fieldName, message: err.message });
    } finally {
      setGenerating(null);
    }
  }

  async function save() {
    setStatus('saving');
    setError(null);
    try {
      await onSaved(index, draft);
      setStatus('saved');
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2500);
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }

  if (!fields.length) return null;

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="mb-3">
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        {description && <p className="text-xs text-slate-500">{description}</p>}
      </div>

      <div className="space-y-3">
        {fields.map((f) => (
          <div key={f.name}>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">{fieldLabel(f.name)}</span>
              {isShortField(f.name) ? (
                <input
                  className={`${inputClass} mt-1`}
                  value={draft[f.name] || ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value.slice(0, f.max) }))}
                  placeholder="Uses this section's own default wording"
                />
              ) : (
                <textarea
                  className={`${inputClass} mt-1 min-h-20`}
                  value={draft[f.name] || ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value.slice(0, f.max) }))}
                  placeholder="Uses this section's own default wording"
                />
              )}
            </label>

            <div className="mt-1 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => writeWithAi(f.name)}
                disabled={generating === f.name}
                className="text-xs font-medium text-teal-700 transition hover:underline disabled:cursor-wait disabled:opacity-50"
              >
                {generating === f.name ? 'Writing…' : '✨ Write with AI'}
              </button>
            </div>
            {genError?.field === f.name && (
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
            {fields.some((f) => initialProps[f.name]) ? 'Your own wording is live here.' : 'Using the default wording.'}
          </span>
        )}
      </div>
    </div>
  );
}

export default function HomeContent({ site, onSaved }) {
  const [manifest, setManifest] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | idle | error
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.getBlockContract()
      .then((res) => { if (live) { setManifest(res); setStatus('idle'); } })
      .catch((err) => { if (live) { setError(err.message); setStatus('error'); } });
    return () => { live = false; };
  }, []);

  function preview() {
    api.previewHtml(Date.now())
      .then((html) => {
        const win = window.open('', '_blank');
        if (!win) return;
        win.document.write(html);
        win.document.close();
      })
      .catch((err) => setError(err.message));
  }

  async function saveBlock(index, fields) {
    const current = (site?.site_data && Array.isArray(site.site_data.blocks)) ? site.site_data : { blocks: [] };
    const blocks = current.blocks.map((block, i) => {
      if (i !== index) return block;
      const props = { ...(block.props || {}) };
      // An entry with nothing typed is the same as no override — dropped, so
      // the block falls back to its own default (or its `from` binding)
      // rather than an override that happens to be an empty string.
      for (const [key, value] of Object.entries(fields)) {
        const trimmed = (value || '').trim();
        if (trimmed) props[key] = trimmed; else delete props[key];
      }
      return { ...block, props };
    });

    try {
      const updated = await api.saveSiteData({ ...current, blocks });
      onSaved?.(updated.site);
      return updated.site;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }

  if (status === 'loading') {
    return <p className="text-sm text-slate-500">Loading your homepage sections…</p>;
  }

  const blocks = Array.isArray(site?.site_data?.blocks) ? site.site_data.blocks : [];
  const byKey = new Map((manifest?.blocks || []).map((b) => [`${b.id}@${b.version}`, b]));

  const rows = blocks
    .map((block, index) => {
      const definition = byKey.get(`${block.type}@${block.version}`);
      return { index, block, definition };
    })
    .filter(({ definition }) => editableFieldsFor(definition).length > 0);

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-xs text-slate-500">
          Your homepage is built from the sections your template chose. Replace the heading,
          subheading or button text on any of them below — leave a box empty to keep the
          section's own default wording.
        </p>
        <button type="button" onClick={preview} className="shrink-0 text-xs font-medium text-teal-700 hover:underline">
          Preview homepage →
        </button>
      </div>

      {(status === 'error' || error) && (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}

      {!rows.length ? (
        <p className="text-sm text-slate-500">None of your homepage sections have editable text yet.</p>
      ) : (
        <div className="space-y-3">
          {rows.map(({ index, block, definition }) => (
            <SectionRow
              key={index}
              index={index}
              title={definition.label}
              description={definition.description}
              definition={definition}
              initialProps={block.props || {}}
              onSaved={saveBlock}
            />
          ))}
        </div>
      )}
    </div>
  );
}
