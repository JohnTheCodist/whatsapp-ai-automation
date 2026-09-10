/**
 * Publishing, as one state machine shared by everything that can trigger it.
 *
 * WHY THIS WAS EXTRACTED. Publishing is now reachable from two places: the
 * action bar at the top of the tab, which is where an owner looks for it, and
 * the Publishing panel at the bottom, which also owns the web address and the
 * take-down. Two components each holding their own busy/error/note state
 * would mean pressing Publish at the top and watching the bottom panel report
 * nothing — or worse, both firing at once because neither knew the other was
 * mid-request.
 *
 * So the state lives here, WebsitePanel creates it once, and both surfaces
 * render the same object. `busy` is a single value rather than a boolean per
 * action, which is what makes "any request in flight disables all of them"
 * fall out for free instead of needing to be remembered in three places.
 *
 * NOTHING IS OPTIMISTIC. Every setter waits for the server's own row and
 * hands it back through onChanged. A screen that said "Live" because a button
 * was pressed, rather than because the site is live, is the one lie this
 * feature must not tell.
 */

import { useCallback, useState } from 'react';
import * as api from './api.js';

export default function usePublishing(onChanged) {
  // null when idle, otherwise the kind of request in flight: 'publish',
  // 'unpublish' or 'address'.
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const run = useCallback(async (kind, fn, done) => {
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      const res = await fn();
      onChanged?.(res.site);
      if (done) setNote(done);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }, [onChanged]);

  const publish = useCallback(
    () => run('publish', api.publish, 'Your website is live.'),
    [run],
  );

  const unpublish = useCallback(
    () => run('unpublish', api.unpublish, 'Taken down. Nothing was deleted — publish again any time.'),
    [run],
  );

  const saveAddress = useCallback(
    (address) => run('address', () => api.setWebAddress(address)),
    [run],
  );

  // Clearing is explicit rather than on a timer. A note that vanishes while
  // somebody is reading it is worse than one that stays until the next thing
  // happens, and every action already clears both before it starts.
  const dismiss = useCallback(() => { setError(null); setNote(null); }, []);

  return { busy, error, note, publish, unpublish, saveAddress, dismiss };
}
