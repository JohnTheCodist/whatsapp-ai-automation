/**
 * Photographs of the pharmacy.
 *
 * ONE CONTROL, NOT TWO. Everything uploaded here is stored with kind
 * 'gallery', and the renderer asks for hero and gallery together on both the
 * About and Location pages. A "hero photo" picker as well would be a second
 * decision about the same pile of photographs, and the owner is a pharmacist
 * with a queue at the counter, not a designer.
 *
 * NOT REFERENCED FROM THE PROFILE, unlike the logo. The logo is one image the
 * header inherits by id, so pharmacy_profile.logo_asset_id has to point at it.
 * These are a set, found by kind — so uploading is the whole action, and there
 * is no second write that could leave the profile pointing at a row that was
 * deleted a moment later.
 *
 * NO CLIENT-SIDE VALIDATION, for the same reason as LogoUpload: `accept` only
 * changes what the file picker shows. The server reads the first bytes and
 * ignores the filename and the declared type, and a check here would only
 * teach whoever reads this that one had happened.
 *
 * The images are not resized before upload. A 2MB cap and a server that
 * rejects anything larger is a smaller, more predictable thing than canvas
 * re-encoding in a browser on a phone — and the pages that display these emit
 * width, height and lazy loading, which is what actually governs how they
 * feel on a slow connection.
 */

import { useEffect, useState } from 'react';
import * as api from './api.js';

/**
 * Enough to show a shopfront, a counter and a consulting area without turning
 * the page into an album. The renderer caps what it displays as well, so this
 * is about not wasting an owner's time and their data allowance.
 */
const MAX_PHOTOS = 6;

export default function PhotoUpload() {
  const [photos, setPhotos] = useState([]);
  const [baseUrl, setBaseUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.listAssets('gallery')
      .then((res) => {
        if (!live) return;
        setBaseUrl(res.baseUrl);
        setPhotos(res.assets || []);
      })
      .catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, []);

  async function choose(event) {
    const files = [...(event.target.files || [])];
    // Let the same file be picked again after a failure. Without this, an
    // owner who fixes a photo and re-selects it gets no change event.
    event.target.value = '';
    if (!files.length) return;

    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) return;

    setBusy(true);
    setError(null);
    const added = [];
    try {
      // One at a time, and the loop stops at the first failure rather than
      // continuing. If the third of five is rejected, the owner is told which
      // and keeps the two that worked — a partial success reported honestly
      // beats an all-or-nothing rollback of files that were fine.
      for (const file of files.slice(0, room)) {
        const { asset, baseUrl: base } = await api.uploadAsset(file, 'gallery');
        added.push(asset);
        if (base) setBaseUrl(base);
      }
    } catch (err) {
      setError(added.length
        ? `${err.message} The photos before it were saved.`
        : err.message);
    } finally {
      if (added.length) setPhotos((current) => [...current, ...added]);
      setBusy(false);
    }
  }

  async function remove(id) {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAsset(id);
      setPhotos((current) => current.filter((p) => p.id !== id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const full = photos.length >= MAX_PHOTOS;

  return (
    <div>
      <span className="text-sm font-medium text-slate-700">Photos of your pharmacy</span>
      <span className="mt-0.5 block text-xs text-slate-500">
        PNG, JPG or WebP, up to 2MB each. Shown on your About and Location pages —
        a photo of the shopfront helps people recognise you when they arrive.
      </span>

      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {photos.length > 0 && (
        <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo) => (
            <li key={photo.id} className="group relative">
              <img
                src={api.assetSrc(baseUrl, photo.storage_path)}
                // Decorative in THIS context: the page already says what these
                // are, and repeating it on every thumbnail is noise to a screen
                // reader. The published page generates real alt text.
                alt=""
                className="aspect-[4/3] w-full rounded-lg border border-slate-200 object-cover"
              />
              <button
                type="button"
                onClick={() => remove(photo.id)}
                disabled={busy}
                aria-label="Remove this photo"
                className="absolute right-1 top-1 rounded-md bg-white/90 px-1.5 py-0.5 text-xs
                           font-semibold text-slate-600 shadow-sm transition
                           hover:text-red-700 disabled:opacity-40"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label
          className={`rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold transition
            ${full || busy
    ? 'cursor-not-allowed border-slate-200 text-slate-400'
    : 'cursor-pointer text-slate-700 hover:border-slate-400 hover:bg-slate-50'}`}
        >
          {busy ? 'Uploading…' : photos.length ? 'Add more' : 'Upload photos'}
          <input
            type="file"
            // A hint to the file picker, not a check. See the header.
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            disabled={busy || full}
            onChange={choose}
          />
        </label>
        <span className="text-xs text-slate-500">
          {full
            ? `${MAX_PHOTOS} photos is the maximum.`
            : `${photos.length} of ${MAX_PHOTOS} added.`}
        </span>
      </div>
    </div>
  );
}
