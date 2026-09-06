/**
 * The advanced editor.
 *
 * THE ONLY MODULE IN THIS APPLICATION THAT MAY IMPORT GRAPESJS.
 * `client/src/architecture.test.js` and `server/tests/websiteService.test.js`
 * both assert it, from the client side and the server side. Two reasons, and
 * both are load-bearing:
 *
 *   BUNDLE. GrapesJS is ~1.15 MB and its stylesheet is another 60 kB. It
 *   stays out of the dashboard's initial download only while every path to it
 *   is a dynamic import from this one lazily-loaded file. A single static
 *   `import 'grapesjs'` anywhere else and every pharmacy pays for it on first
 *   paint, silently, because the app still works — just slower.
 *
 *   REPLACEABILITY. This is one of two user interfaces onto `site_data`; the
 *   guided form is the other, and it is the one most pharmacies will ever
 *   use. Keeping GrapesJS behind this file means swapping it is a rewrite of
 *   one module rather than of a feature.
 *
 * WHAT GRAPESJS IS ACTUALLY FOR HERE: a canvas, drag-to-reorder, a section
 * picker, selection, and a properties panel. It is NOT the source of truth,
 * it does not decide what HTML gets published, and nothing it produces is
 * ever sent to a customer. Publishing renders from stored structured data on
 * the server, as it did before this file existed.
 *
 * NO STYLE MANAGER, deliberately. Theming is the constrained palette/type/
 * corner panel in the guided form — six palettes, four type pairings, three
 * radii, all designed to work. A free CSS surface here would let an owner
 * produce a page that no longer looks like anything anyone chose, which is
 * the failure mode WEBSITE_BUILDER_DECISIONS.md §5 exists to prevent.
 */

import { useEffect, useRef, useState } from 'react';
import grapesjs from 'grapesjs';
import 'grapesjs/dist/css/grapes.min.css';
import * as api from './api.js';
import {
  gjsTypeFor, traitsFor, traitName, propFromTrait,
  blockDefsFromManifest, toComponentDefs, fromComponentModels, siteDataEqual,
} from './grapesAdapter.js';

/** Long enough that dragging a section does not fire a save per pixel. */
const SAVE_DEBOUNCE_MS = 900;

export default function Editor({ site, onSaved, onClose }) {
  const hostRef = useRef(null);
  const blocksRef = useRef(null);
  const traitsRef = useRef(null);
  const layersRef = useRef(null);
  const editorRef = useRef(null);
  const lastSaved = useRef(site.site_data);

  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    let saveTimer = null;

    (async () => {
      let manifest;
      let rendered;
      try {
        manifest = await api.getBlockContract();
        rendered = await api.renderBlocks(site.site_data);
      } catch (err) {
        if (live) { setError(err.message); setStatus('error'); }
        return;
      }
      if (!live || !hostRef.current) return;

      const editor = grapesjs.init({
        container: hostRef.current,
        height: '100%',
        width: 'auto',
        fromElement: false,
        // We own persistence. GrapesJS's storage manager would keep a second,
        // divergent copy of the page in localStorage and race our own saves.
        storageManager: false,
        // Our own chrome, in RxNaija's design rather than GrapesJS's.
        panels: { defaults: [] },
        // Empty, not omitted: omitting it gives the DEFAULT sectors, which is
        // a full CSS editor. See the header.
        styleManager: { sectors: [] },
        blockManager: { appendTo: blocksRef.current },
        traitManager: { appendTo: traitsRef.current },
        layerManager: { appendTo: layersRef.current },
        assetManager: { custom: true },
        canvas: { styles: [], scripts: [] },
        deviceManager: {
          devices: [
            { id: 'desktop', name: 'Desktop', width: '' },
            { id: 'phone', name: 'Phone', width: '390px', widthMedia: '480px' },
          ],
        },
      });
      editorRef.current = editor;

      // ---- component types, one per registered block ----
      for (const entry of manifest.blocks) {
        editor.DomComponents.addType(gjsTypeFor(entry.id), {
          model: {
            defaults: {
              name: entry.label,
              // droppable:false — nothing goes INSIDE a pharmacy block. The
              // page is a list of sections, not a nestable layout.
              droppable: false,
              // editable:false — no contenteditable in the canvas. Props are
              // the truth and the canvas is a picture of them; letting
              // someone type into the picture would produce edits that
              // vanish on the next render.
              editable: false,
              // A singleton cannot be removed or dragged: a page without a
              // header is not a customisation anyone meant to make.
              removable: entry.removable,
              draggable: entry.draggable,
              copyable: false,
              highlightable: true,
              selectable: true,
              traits: traitsFor(entry),
              // Prop values live here, namespaced — see PROP_PREFIX.
              ...Object.fromEntries((entry.traits || []).map((t) => [traitName(t.name), ''])),
            },
          },
        });
      }

      // ---- the section picker ----
      for (const def of blockDefsFromManifest(manifest)) {
        editor.BlockManager.add(def.id, {
          label: def.label,
          category: def.category,
          content: {
            type: def.content.type,
            rxType: def.content.rxType,
            rxVersion: def.content.rxVersion,
          },
        });
      }

      // ---- the page ----
      editor.setComponents(toComponentDefs(site.site_data, rendered.blocks).map((def) => ({
        type: def.type,
        rxType: def.rxType,
        rxVersion: def.rxVersion,
        components: def.content,
        ...Object.fromEntries(Object.entries(def.rxProps).map(([k, v]) => [traitName(k), v])),
      })));

      /**
       * Make a block's rendered HTML inert.
       *
       * GrapesJS parses the `components` string into a real component tree, so
       * every <div>, <p> and <a> inside a rendered section becomes selectable,
       * draggable and layerable in its own right. Observed on the first run:
       * the layer panel listed "Section / Div / Div / Text / Text", and
       * clicking the hero selected an inner Div — which has no traits of ours,
       * so the properties panel showed GrapesJS's default Id and Title fields
       * instead of the block's.
       *
       * That is not a cosmetic problem. The canvas is a PICTURE of what the
       * server rendered; the model beside it is the truth. Letting someone
       * select and drag pieces of the picture offers edits that cannot be
       * saved, because nothing in site_data corresponds to them — they would
       * simply vanish on the next render, which is the builder appearing to
       * eat someone's work.
       *
       * So the children are locked: visible, and nothing else.
       */
      const lockChildren = (component) => {
        component.components().forEach((child) => {
          child.set({
            selectable: false,
            hoverable: false,
            layerable: false,
            draggable: false,
            droppable: false,
            removable: false,
            copyable: false,
            editable: false,
          });
          lockChildren(child);
        });
      };
      if (!live) { editor.destroy(); return; }
      editor.getComponents().forEach(lockChildren);
      // And for sections added later from the picker.
      editor.on('component:add', (component) => lockChildren(component));

      // The published stylesheet, inside the canvas, so what an owner drags
      // around looks like the page and not like unstyled markup.
      //
      // ON `load`, NOT IMMEDIATELY AFTER init(). The canvas is an iframe and
      // its document does not exist synchronously — reading it here would
      // return null often enough to matter and never enough to be obvious,
      // and the failure is silent: the editor works, it is simply unstyled,
      // which reads as "the editor is broken" rather than "a stylesheet did
      // not attach". `load` is GrapesJS's own signal that the canvas document
      // is ready.
      let stylesInjected = false;
      const injectCanvasStyles = () => {
        if (stylesInjected) return;
        const doc = editor.Canvas.getDocument();
        if (!doc) return;
        stylesInjected = true;
        const style = doc.createElement('style');
        style.textContent = `${rendered.css}\n`
          + '.rx-editor-empty{padding:2rem;text-align:center;color:#64748b;'
          + 'background:#f8fafc;border:1px dashed #cbd5e1;font-family:system-ui,sans-serif}';
        doc.head.appendChild(style);
      };
      editor.on('load', injectCanvasStyles);
      // Belt and braces: if `load` already fired between init() and here, the
      // handler above never runs. Cheap to attempt, harmless if it no-ops.
      injectCanvasStyles();

      // ---- persistence ----
      //
      // EVERY ENTRY POINT CHECKS THAT THE EDITOR IS STILL ALIVE.
      //
      // This setup runs after two awaits, and the debounced save runs up to a
      // second after the last edit — so both can be reached after the panel
      // has unmounted and the cleanup below has called editor.destroy(). A
      // destroyed GrapesJS editor still exists as an object but its internals
      // are gone, and calling into it throws
      // "Cannot read properties of undefined". Observed in the browser on a
      // hot reload, which is the same shape as a person clicking Done while
      // the editor is still loading.
      //
      // Returning quietly is right rather than defensive: the component is
      // gone, so there is nothing to save it to and nobody to tell.
      const alive = () => live && editorRef.current === editor;

      const serialize = () => fromComponentModels(
        editor.getComponents().map((component) => {
          const props = {};
          for (const [key, value] of Object.entries(component.attributes || {})) {
            const prop = propFromTrait(key);
            if (prop !== null) props[prop] = value;
          }
          return {
            rxType: component.get('rxType'),
            rxVersion: component.get('rxVersion'),
            rxProps: props,
          };
        }),
      );

      const save = async () => {
        if (!alive()) return;
        const next = serialize();
        // GrapesJS fires change events for selection and hover as well as for
        // edits. Without this the editor writes to the database every time
        // the owner's mouse moves over a section.
        if (siteDataEqual(next, lastSaved.current)) return;
        setStatus('saving');
        try {
          const { site: saved } = await api.saveSiteData(next);
          lastSaved.current = next;
          if (live) { setStatus('saved'); onSaved?.(saved); }
        } catch (err) {
          if (live) { setError(err.message); setStatus('error'); }
        }
      };

      const scheduleSave = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
      };

      // BASELINE BEFORE LISTENING, and the order matters.
      //
      // setComponents() above fires component:add for every block on the page.
      // Attaching the listeners first meant a save was scheduled the instant
      // the editor opened — observed on the first run as "All changes saved"
      // before the owner had touched anything. Harmless to the data (the round
      // trip is lossless, and the stored blocks came back identical) but it
      // writes to the database and re-renders a page for someone who only
      // looked at it.
      //
      // Taking the baseline from the editor's OWN serialisation rather than
      // from site.site_data also means any difference the round trip does
      // introduce shows up on the first real edit, instead of being masked by
      // comparing against the input.
      if (!alive()) return;
      lastSaved.current = serialize();

      editor.on('component:add', scheduleSave);
      editor.on('component:remove', scheduleSave);
      editor.on('component:update', scheduleSave);
      editor.on('sorter:drag:end', scheduleSave);

      if (live) setStatus('ready');
    })();

    return () => {
      live = false;
      clearTimeout(saveTimer);
      // The one thing @grapesjs/react would have done for us, and the reason
      // skipping it cost nothing: without this the canvas iframe, its
      // listeners and its document leak on every unmount, and the Website tab
      // is a place people open and close repeatedly.
      editorRef.current?.destroy();
      editorRef.current = null;
    };
    // Mount once. Re-initialising GrapesJS on a prop change would discard the
    // owner's in-progress arrangement; the editor owns its own state after
    // this point and hands changes back through onSaved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
          >
            ← Done
          </button>
          <span className="font-display text-sm font-semibold text-slate-900">Customise design</span>
        </div>
        <span className="text-xs text-slate-500">
          {status === 'saving' && 'Saving…'}
          {status === 'saved' && 'All changes saved'}
          {status === 'ready' && 'Changes save automatically'}
          {status === 'loading' && 'Loading the editor…'}
          {status === 'error' && <span className="text-red-700">{error}</span>}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-60 shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50">
          <p className="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Sections</p>
          <div ref={blocksRef} />
          <p className="px-3 pt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Page order</p>
          <div ref={layersRef} />
        </div>

        <div ref={hostRef} className="min-w-0 flex-1 bg-slate-100" />

        <div className="w-64 shrink-0 overflow-y-auto border-l border-slate-200 bg-slate-50">
          <p className="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Section settings
          </p>
          <div ref={traitsRef} />
          <p className="px-3 py-3 text-xs leading-relaxed text-slate-500">
            Leave a field empty to use your pharmacy details. Lists and images are
            edited in the form behind “Done”.
          </p>
        </div>
      </div>
    </div>
  );
}
