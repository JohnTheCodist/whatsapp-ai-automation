/**
 * Home — a greeting, what needs a person, and one place to type.
 *
 * SHELL_PLAN.md phase 2. Home was five module tiles whose descriptions and
 * live figures arrived in a card on hover. The owner shared Rhazes.ai and
 * chose its shape: you do not pick a destination first, you say what you
 * want and it takes you there.
 *
 * WHAT TYPING ACTUALLY DOES, because this is where a command surface goes
 * wrong. It searches two things that exist — this pharmacy's PATIENTS and
 * this app's SCREENS — and nothing else. It is not an assistant prompt. A
 * box that looks like it will answer a clinical question, and then does not,
 * is worse than a box that never implied it.
 *
 * WHY THERE IS NO MICROPHONE HERE. The reference has one. A recording in
 * this product needs a consultation to belong to and a consent recorded
 * against it (0071), neither of which exists until a patient is chosen — so
 * a mic on Home could only ask for a patient first, which is what the input
 * already does. It would be a second route to the same place, dressed as a
 * shortcut. The scribe stays where consent lives.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getWebsite } from './website/api.js';
import {
  greeting, headline, standing, PLACEHOLDER,
  matchScreens, shouldSearchPatients,
  PATIENTS_HEADING, SCREENS_HEADING, NO_MATCH,
} from './homeCommand.js';

export default function HomeCommand({
  onOpen, onOpenPatient, websiteEnabled, summary = null, inputRef = null,
}) {
  const [query, setQuery] = useState('');
  const [patients, setPatients] = useState([]);
  const [refillsDue, setRefillsDue] = useState(null);
  const [websiteStatus, setWebsiteStatus] = useState(null);

  // Asked once per visit, exactly as the tiles did — removing them must not
  // lose the figures a pharmacist read the shop by.
  useEffect(() => {
    let live = true;
    fetch('/api/refills', { signal: AbortSignal.timeout(20000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (live && j?.counts) setRefillsDue((j.counts.due || 0) + (j.counts.overdue || 0));
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (websiteEnabled !== true) return undefined;
    let live = true;
    getWebsite()
      .then((res) => { if (live) setWebsiteStatus(res?.site ? res.site.status : 'none'); })
      .catch(() => {});
    return () => { live = false; };
  }, [websiteEnabled]);

  /**
   * Patients, asked for as you type.
   *
   * DEBOUNCED, and the delay is not decoration: every keystroke would
   * otherwise be a tenant-scoped query, and a pharmacist typing a nine-letter
   * name would ask nine times for an answer they only want once.
   */
  useEffect(() => {
    if (!shouldSearchPatients(query)) { setPatients([]); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/customers?q=${encodeURIComponent(query.trim())}&limit=5`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (live) setPatients(j?.customers || []); })
        .catch(() => { if (live) setPatients([]); });
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  const screens = matchScreens(query, { websiteEnabled });
  const head = headline(summary);
  const figures = standing(
    summary ? { ...summary, refillsDue, websiteStatus } : null,
    { websiteEnabled },
  );

  // What Enter opens. A patient outranks a screen: somebody typing a name is
  // looking for a person, and the screens are one click away in the sidebar
  // that is now always open.
  const first = patients[0]
    ? { kind: 'patient', id: patients[0].id }
    : (screens[0] ? { kind: 'screen', tab: screens[0].tab } : null);

  const go = useCallback((target) => {
    if (!target) return;
    if (target.kind === 'patient') onOpenPatient?.(target.id);
    else onOpen?.(target.tab);
  }, [onOpen, onOpenPatient]);

  /**
   * THE SEARCH FIELD ON THIS SCREEN, which on Home is this one.
   *
   * The shell owns a `searchRef` meaning "whatever a person types into
   * here" and points Ctrl+K at it. Home used to carry TWO fields — the
   * header pill and this box — doing overlapping jobs a few inches
   * apart, so the shell hands its ref down and the header keeps its
   * field only on screens that still have one.
   *
   * The local fallback is not decoration: this component is rendered
   * without a ref by `homeCommand.test.jsx`, and autofocus has to keep
   * working there.
   */
  const localRef = useRef(null);
  const boxRef = inputRef || localRef;
  useEffect(() => { boxRef.current?.focus(); }, [boxRef]);

  const typed = query.trim().length > 0;
  const nothing = typed && screens.length === 0 && patients.length === 0
    && shouldSearchPatients(query);

  return (
    <div className="ui-home">
      <h1 className="ui-home-greeting">{greeting()}</h1>
      {/* The second line is reserved for the thing with a cost. A count that
          has not arrived yet renders nothing rather than a zero it has not
          earned. */}
      {head && (
        <p className={`ui-home-headline${head.tone === 'alert' ? ' ui-home-alert' : ''}`}>
          {head.text}
        </p>
      )}

      <form
        className="ui-home-command"
        onSubmit={(e) => { e.preventDefault(); go(first); }}
      >
        <input
          ref={boxRef}
          type="text"
          value={query}
          placeholder={PLACEHOLDER}
          aria-label={PLACEHOLDER}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
        />
      </form>

      {typed && (
        <div className="ui-home-results" role="listbox" aria-label="Results">
          {patients.length > 0 && (
            <>
              <p className="ui-cprog-quiet">{PATIENTS_HEADING}</p>
              {patients.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="ui-home-result"
                  onClick={() => go({ kind: 'patient', id: p.id })}
                >
                  <strong>{p.full_name || p.display_name || 'Unnamed'}</strong>
                  <small>{p.wa_phone}</small>
                </button>
              ))}
            </>
          )}

          {screens.length > 0 && (
            <>
              <p className="ui-cprog-quiet">{SCREENS_HEADING}</p>
              {screens.map((s) => (
                <button
                  key={s.tab}
                  type="button"
                  className="ui-home-result"
                  onClick={() => go({ kind: 'screen', tab: s.tab })}
                >
                  <strong>{s.label}</strong>
                  <small>{s.module}</small>
                </button>
              ))}
            </>
          )}

          {nothing && <p className="ui-allergy-help">{NO_MATCH}</p>}
        </div>
      )}

      {/* Everything the tiles used to carry, in one quiet row. Losing the
          tiles must not lose the figures. */}
      {!typed && figures.length > 0 && (
        <p className="ui-home-standing">{figures.join(' · ')}</p>
      )}
    </div>
  );
}
