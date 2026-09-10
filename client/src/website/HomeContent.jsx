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
 * drift.
 *
 * SHORT LISTS GET A SECOND KIND OF ROW: a prop whose items have one or two
 * text fields — About's `highlights` ("Bilingual Staff"), its `whyUs` (a
 * reason and a line about it), the FAQ's question-and-answer pairs. NOT
 * `services` or `reviews`, which have three or more fields per item and
 * already have dedicated editors elsewhere in this app: offering a generic
 * repeater for those would either re-build those editors worse or let the
 * same list be edited two different ways. The one- and two-field lists have
 * no such editor anywhere, so without this they could only be reached
 * through the drag-and-drop advanced editor most pharmacies never open.
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
  headingAccent: 'Highlighted words in the heading',
  subheading: 'Subheading',
  eyebrow: 'Small label above the heading',
  description: 'Description',
  label: 'Button text',
  buttonLabel: 'Button text',
  primaryCtaLabel: 'Primary button text',
  secondaryCtaLabel: 'Secondary button text',
  directionsLabel: 'Button text',
  phoneCtaLabel: 'Call button text',
  whatsappLabel: 'WhatsApp button text',
  copyright: 'Copyright line',
  // Both CTA blocks call this `message`, and it is NOT the text on the
  // button — it is what gets typed into the customer's own WhatsApp when
  // they tap it. Named plainly here because "Message" alone reads as the
  // former and would be edited as such.
  message: 'Pre-filled WhatsApp message',
  primaryCtaMessage: 'Pre-filled WhatsApp message',
  note: 'Note',
  // Lists.
  highlights: 'Trust points',
  whyUs: 'Reasons to choose you',
  faqs: 'Questions and answers',
  reviews: 'Customer reviews',
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

/**
 * The lists this block instance may have written for it in a plain form —
 * see the file header for where the line is drawn. One or two fields per
 * item ("Bilingual Staff"; "Free Delivery" + a line about it; a question
 * and its answer) is a form; `services` and `reviews` have three or more
 * and already have editors of their own.
 *
 * `max` here is the list's own item-count ceiling (editorManifest reuses the
 * same `max` key for a repeater's item cap that a text prop uses for its
 * character cap); each item field carries its own `max` and `required`.
 */
function simpleListFieldsFor(definition) {
  if (!definition) return [];
  return (definition.traits || [])
    .filter((t) => t.kind === 'repeater' && !t.inherited
      && Array.isArray(t.itemFields) && t.itemFields.length > 0 && t.itemFields.length <= 2
      // EVERY sub-field must be plain text. The header's navigation is a
      // label and an HREF: offering that as two plain boxes would invite an
      // owner to hand-write a URL with nothing checking it and quietly
      // break their own menu — which otherwise builds itself from the pages
      // they actually have. A list with a URL, a number or a toggle in it
      // belongs in the advanced editor, which has a real control per type.
      && t.itemFields.every((f) => f.kind === 'text'))
    .map((t) => ({ name: t.name, itemFields: t.itemFields, max: t.max || 12 }));
}

/** An empty row for a list — every sub-field present and blank. */
function blankRow(listField) {
  return Object.fromEntries(listField.itemFields.map((f) => [f.name, '']));
}

/** initialProps[name] as rows this form can edit: every sub-field, blank where unset. */
function listAsRows(initialProps, listField) {
  const arr = Array.isArray(initialProps[listField.name]) ? initialProps[listField.name] : [];
  return arr.map((item) => Object.fromEntries(
    listField.itemFields.map((f) => [f.name, item?.[f.name] || '']),
  ));
}

function SectionRow({ index, title, description, definition, initialProps, onSaved }) {
  const fields = useMemo(() => editableFieldsFor(definition), [definition]);
  const listFields = useMemo(() => simpleListFieldsFor(definition), [definition]);
  const [draft, setDraft] = useState(() => {
    const base = { ...initialProps };
    for (const lf of listFields) base[lf.name] = listAsRows(initialProps, lf);
    return base;
  });
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(null);
  const [genError, setGenError] = useState(null); // { field, message }

  const dirty = fields.some((f) => (draft[f.name] || '') !== (initialProps[f.name] || ''))
    || listFields.some((lf) => JSON.stringify(draft[lf.name] || []) !== JSON.stringify(listAsRows(initialProps, lf)));

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
      // Every value trimmed, and a row dropped entirely unless each of its
      // REQUIRED sub-fields has something in it — so a half-typed row (a
      // question with no answer) is quietly discarded here rather than sent
      // on to be rejected by the block contract with an error the owner did
      // not do anything to deserve. Optional sub-fields left blank are
      // simply omitted from the stored item.
      const toSend = { ...draft };
      for (const lf of listFields) {
        toSend[lf.name] = (draft[lf.name] || [])
          .map((row) => Object.fromEntries(
            lf.itemFields
              .map((f) => [f.name, (row?.[f.name] || '').trim()])
              .filter(([, v]) => v),
          ))
          .filter((row) => lf.itemFields.every((f) => !f.required || row[f.name]));
      }
      await onSaved(index, toSend);
      setStatus('saved');
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2500);
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }

  if (!fields.length && !listFields.length) return null;

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

        {listFields.map((lf) => {
          const items = draft[lf.name] || [];
          return (
            <div key={lf.name}>
              <span className="text-xs font-medium text-slate-600">{fieldLabel(lf.name)}</span>
              {!items.length && (
                <p className="mt-1 text-xs text-slate-400">Nothing shown until you add one — never guessed for you.</p>
              )}
              <div className="mt-1 space-y-2">
                {items.map((row, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      {lf.itemFields.map((f) => (
                        <input
                          key={f.name}
                          className={inputClass}
                          value={row?.[f.name] || ''}
                          onChange={(e) => setDraft((d) => {
                            const next = [...(d[lf.name] || [])];
                            next[i] = { ...next[i], [f.name]: e.target.value.slice(0, f.max || 160) };
                            return { ...d, [lf.name]: next };
                          })}
                          placeholder={lf.itemFields.length > 1 ? fieldLabel(f.name) : 'e.g. Bilingual Staff'}
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setDraft((d) => ({ ...d, [lf.name]: (d[lf.name] || []).filter((_, j) => j !== i) }))}
                      className="shrink-0 text-xs font-medium text-slate-400 hover:text-red-700"
                      aria-label={`Remove ${fieldLabel(lf.name)} item ${i + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              {items.length < lf.max && (
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, [lf.name]: [...(d[lf.name] || []), blankRow(lf)] }))}
                  className="mt-1.5 text-xs font-medium text-teal-700 hover:underline"
                >
                  + Add
                </button>
              )}
            </div>
          );
        })}
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
            {fields.some((f) => initialProps[f.name]) || listFields.some((lf) => listAsRows(initialProps, lf).length)
              ? 'Your own wording is live here.'
              : 'Using the default wording.'}
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
      // rather than an override that happens to be an empty string. A list
      // field arrives here already converted to its stored shape (see
      // SectionRow's save()), so an empty array is this same rule applied to
      // a list instead of a string.
      for (const [key, value] of Object.entries(fields)) {
        if (Array.isArray(value)) {
          if (value.length) props[key] = value; else delete props[key];
          continue;
        }
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
    .filter(({ definition }) => editableFieldsFor(definition).length > 0 || simpleListFieldsFor(definition).length > 0);

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-xs text-slate-500">
          Your homepage is built from the sections your template chose. Replace the heading,
          subheading or button text on any of them below, or add your own list items where a
          section has one — leave a box empty to keep the section's own default wording.
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
