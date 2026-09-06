/**
 * Uploading a pharmacy's logo.
 *
 * ONE UPLOAD, EVERYWHERE IT BELONGS. The image is stored against the pharmacy
 * (pharmacy_profile.logo_asset_id), and the header block inherits it — so an
 * owner uploads once and it appears on their website without them choosing it
 * again. The same row is what a receipt or a QR sheet would use later.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: validate the file. The `accept`
 * attribute below is a convenience that makes the file picker show the right
 * things, and nothing more — a browser will happily hand over anything, and
 * the extension is whatever the uploader typed. The real check is on the
 * server, which reads the first bytes and ignores the name and the declared
 * type entirely. A client-side check here would only teach whoever reads this
 * that one had happened.
 */

import { useEffect, useState } from 'react';
import * as api from './api.js';

export default function LogoUpload({ profile, onChanged }) {
  const [asset, setAsset] = useState(null);
  const [baseUrl, setBaseUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Resolve the current logo to something displayable. The profile stores an
  // id; the URL needs the storage path, which only the asset list carries.
  useEffect(() => {
    let live = true;
    if (!profile?.logo_asset_id) { setAsset(null); return undefined; }
    api.listAssets('logo')
      .then((res) => {
        if (!live) return;
        setBaseUrl(res.baseUrl);
        setAsset(res.assets.find((a) => a.id === profile.logo_asset_id) || null);
      })
      .catch(() => { /* a missing thumbnail is not worth an error banner */ });
    return () => { live = false; };
  }, [profile?.logo_asset_id]);

  async function choose(event) {
    const file = event.target.files?.[0];
    // Let the same file be picked again after a failure — without this, an
    // owner who fixes their image and re-selects it gets no change event.
    event.target.value = '';
    if (!file) return;

    setBusy(true);
    setError(null);
    try {
      const { asset: uploaded, baseUrl: base } = await api.uploadAsset(file, 'logo');
      const saved = await api.saveProfile({ logo_asset_id: uploaded.id });
      setAsset(uploaded);
      setBaseUrl(base);
      onChanged?.(saved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!asset) return;
    setBusy(true);
    setError(null);
    try {
      // Deleting the asset clears the profile reference server-side, so there
      // is no second call and no window in which the profile points at a row
      // that no longer exists.
      await api.deleteAsset(asset.id);
      const saved = await api.getProfile();
      setAsset(null);
      onChanged?.(saved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const src = api.assetSrc(baseUrl, asset?.storage_path);

  return (
    <div>
      <span className="text-sm font-medium text-slate-700">Pharmacy logo</span>
      <span className="mt-0.5 block text-xs text-slate-500">
        PNG, JPG or WebP, up to 2MB. Appears at the top of your website.
      </span>

      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-2 flex items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          {src
            ? <img src={src} alt="Your pharmacy logo" className="max-h-full max-w-full object-contain" />
            : <span className="text-xs text-slate-400">None</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50">
            {busy ? 'Uploading…' : asset ? 'Replace' : 'Upload a logo'}
            <input
              type="file"
              // A hint to the file picker, not a check. See the header.
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              disabled={busy}
              onChange={choose}
            />
          </label>
          {asset && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="text-sm font-medium text-slate-500 transition hover:text-red-700 disabled:opacity-40"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
