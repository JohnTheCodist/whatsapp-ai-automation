/**
 * Patient summary — the section a record opens on.
 *
 * TWO COLUMNS. On the left, the patient: who they are, then every section of
 * the record as a plain vertical list. On the right, the body.
 *
 * THE LEFT COLUMN IS ONE LIST, NOT A GRID OF CARDS. The first version put
 * each section in its own bordered box; the owner asked for this instead,
 * and it is the better shape — a record is read top to bottom, and eight
 * boxes make eight things of equal weight out of what is really one list
 * about one person. Sections are separated by hairlines, and each one names
 * itself, says its one line, lists what it holds, and offers the way in.
 *
 * IT IS A SUMMARY OF THE OTHER SECTIONS, never a page of its own. Nothing is
 * only here: anything a section shows here, that section shows in full.
 *
 * TWO RULES ABOUT THE WORDING, both enforced in patientSummaryModel.js:
 * a section with no data says "not recorded" rather than "none", and a
 * condition is never named without saying it came from purchase history.
 */

import { Suspense, lazy, useEffect, useState } from 'react';
import Loading from './Loading.jsx';
import AnatomicalAvatar from './AnatomicalAvatar.jsx';
import PatientCare from './PatientCare.jsx';
import CustomerProfile from './CustomerProfile.jsx';
import { IconOpen, IconChevronDown, IconPhone, IconPerson, IconCalendar, IconHeart } from './Icons.jsx';
import { summaryCards, bodyMarkers, identityLine } from './patientSummaryModel.js';

/**
 * three.js and the viewer are their own chunk. A member of staff who never
 * opens a patient record never downloads either — the same reasoning as the
 * website builder's lazy import in App.jsx.
 */
const BodyViewer3D = lazy(() => import('./BodyViewer3D.jsx'));

function fmtDate(v) {
  if (!v) return null;
  return new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** One fact about the patient: an icon, and the fact. */
function Fact({ Icon, children, note }) {
  return (
    <li className="ui-pfact">
      <span className="ui-pfact-icon" aria-hidden="true"><Icon width={15} height={15} /></span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] text-[var(--ui-ink)]">{children}</span>
        {note && <span className="block text-[11px] text-[var(--ui-ink-faint)]">{note}</span>}
      </span>
    </li>
  );
}

/**
 * One section of the record, in the list: its name, its one line, what it
 * holds, and the way into it. Collapsible, because a record with twelve
 * sections open at once is a scroll, and a pharmacist who works in Meds
 * wants Meds where they left it.
 */
function Section({ card, onOpenTab, onNavigate }) {
  const [open, setOpen] = useState(card.items.length > 0);
  return (
    <section className="ui-psection">
      <h3>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="ui-psection-head"
        >
          <IconChevronDown
            width={14}
            height={14}
            aria-hidden="true"
            className={`ui-psection-chevron ${open ? 'is-open' : ''}`}
          />
          <span className="flex-1 text-left">{card.title}</span>
          {/* The count IS the summary. A section that lists two medicines
              does not also need a sentence saying it has two medicines. */}
          {card.count > 0 && <span className="ui-pcount">{card.count}</span>}
          {card.flag && <span className="ui-pflag">{card.flag}</span>}
        </button>
      </h3>

      {open && (
        <div className="ui-psection-body">
          {/* Only when there is nothing to list. */}
          {card.line && <p className="text-[12px] text-[var(--ui-ink-faint)]">{card.line}</p>}

          {card.items.length > 0 && (
            <ul className="space-y-1">
              {card.items.map((item) => (
                // The source of the claim is the tooltip, not a tag under
                // every row — see patientSummaryModel.js, rule 2.
                <li key={item.id} title={item.provenance || undefined} className="text-[13px] text-[var(--ui-ink)]">
                  {item.label}
                </li>
              ))}
            </ul>
          )}

          {card.at && <p className="mt-1 text-[11px] text-[var(--ui-ink-faint)]">Last {fmtDate(card.at)}</p>}

          {/* A section of this record opens in place; the Clinical module's
              own screens open there, and the label says which it will be. */}
          <button
            type="button"
            onClick={() => (card.module ? onNavigate?.(card.module) : onOpenTab(card.tab))}
            className="ui-psection-link"
          >
            {card.module ? 'Open consultations' : 'See all'}
            <IconOpen width={12} height={12} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}

export default function PatientSummary({ customerId, onOpenTab, onOpenConversation, onNavigate }) {
  const [profile, setProfile] = useState(null);
  const [care, setCare] = useState(null);
  const [allergies, setAllergies] = useState(null);
  const [problems, setProblems] = useState(null);
  const [tests, setTests] = useState(null);
  const [carePrograms, setCarePrograms] = useState(null);
  const [followups, setFollowups] = useState(null);
  const [messages, setMessages] = useState(null);
  const [error, setError] = useState(null);
  // Why the 3D body is not being shown, if it is not. Kept as a reason
  // rather than a boolean so the panel can say which of the two it is.
  const [bodyFailed, setBodyFailed] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    (async () => {
      try {
        const [p, c, a, pr, te, cp, fu, ms] = await Promise.all([
          fetch(`/api/customers/${customerId}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load this patient.')))),
          // The care details are a separate endpoint and a separate failure:
          // the summary is still worth showing without the age and sex.
          fetch(`/api/customers/${customerId}/care`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          // Same for allergies: if this fails the card says "Not recorded",
          // never a state it could not read.
          fetch(`/api/customers/${customerId}/allergies`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          // The problem list. If it fails, the card falls back to the older
          // purchase-based view rather than showing nothing.
          fetch(`/api/customers/${customerId}/problems`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          // The test record. Its own failure, like the others: the card says
          // "Not recorded" rather than a count it could not read.
          fetch(`/api/customers/${customerId}/tests`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          // Care programmes. Its own failure too: the card says "Not recorded"
          // rather than "No care programmes", which would be a claim it could
          // not stand behind.
          fetch(`/api/customers/${customerId}/care-programs`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          // The follow-up queue. Its own failure too: the card says "Not
          // recorded" rather than "No follow-ups", which would be a claim it
          // could not stand behind.
          fetch(`/api/customers/${customerId}/followups`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          // The patient's communication history. `filter=all` because the
          // card counts UNREAD across every thread, and unread does not stop
          // mattering when a conversation is closed. Its own failure is its
          // own too: "Not recorded", never "No messages".
          fetch(`/api/customers/${customerId}/messages?filter=all`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        if (cancelled) return;
        setProfile(p);
        setCare(c);
        setAllergies(a);
        setProblems(pr);
        setCarePrograms(cp ? { counts: cp.counts, active: cp.active.slice(0, 3) } : null);
        // The same shape the server's own summary returns, built from the
        // queue the section reads — so the card and the section agree.
        setMessages(ms ? { counts: ms.counts, lastContactAt: ms.lastContactAt } : null);
        setFollowups(fu ? {
          counts: fu.counts,
          next: (fu.followups || [])
            .filter((f) => ['overdue', 'today', 'upcoming'].includes(f.bucket))
            .slice(0, 3),
        } : null);
        // The summary wants the last few reported tests, which is what the
        // Tests tab's own summary shape is — built here from the list.
        setTests(te ? {
          counts: te.counts,
          pending: (te.counts.ordered || 0) + (te.counts.pending || 0),
          recent: (te.tests || [])
            .filter((t) => ['preliminary', 'final', 'amended', 'corrected'].includes(t.status))
            .slice(0, 3)
            .map((t) => ({
              id: t.id,
              testName: t.testName,
              result: t.results[0]
                ? { value: t.results[0].valueNumber ?? t.results[0].valueDisplay ?? null, unit: t.results[0].unit, interpretation: t.results[0].interpretation }
                : null,
            })),
        } : null);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [customerId]);

  if (error) return <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  if (!profile) return <p className="text-sm text-[var(--ui-ink-faint)]"><Loading /></p>;

  const { customer } = profile;
  const name = customer.fullName || customer.displayName || customer.waPhone;
  const cards = summaryCards(profile, care, allergies, problems, tests, carePrograms, followups, messages);
  const markers = bodyMarkers(profile, problems);
  const [age, sex] = identityLine(care);
  const optedOut = profile.communication?.status === 'opted_out';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  return (
    <div className="space-y-4">
      <div className="ui-summary">
        {/* ------------------------------------------------- the patient */}
        <aside className="ui-pprofile">
          <div className="ui-pprofile-head">
            <span className="ui-pavatar" aria-hidden="true">{initials}</span>
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold text-[var(--ui-ink)]">{name}</span>
              <span className="block text-[12px] text-[var(--ui-ink-faint)]">
                {age.text}{optedOut ? ' · opted out' : ''}
              </span>
            </span>
          </div>

          <ul className="ui-pfacts">
            <Fact Icon={IconCalendar}>{age.text}</Fact>
            <Fact Icon={IconPerson}>{sex.text}</Fact>
            <Fact Icon={IconPhone}>{customer.waPhone}</Fact>
            <Fact Icon={IconHeart} note="Assigned pharmacist">
              {care?.assignedPharmacist?.email || 'Unassigned'}
            </Fact>
            <Fact Icon={IconCalendar} note="Patient since">{fmtDate(customer.createdAt) || '—'}</Fact>
          </ul>

          <div className="ui-psections">
            {cards.map((card) => <Section key={card.id} card={card} onOpenTab={onOpenTab} onNavigate={onNavigate} />)}
          </div>
        </aside>

        {/* ---------------------------------------------------- the body */}
        <div className="ui-summary-body">
          {bodyFailed ? (
            // The drawn figure, with the same markers on it. A pharmacy on a
            // machine with no GPU still gets a body it can point at.
            <div className="ui-body-fallback">
              <AnatomicalAvatar
                sex={care?.sex || null}
                markers={markers}
                height={320}
                onSelect={(tab) => { if (tab) onOpenTab(tab); }}
              />
              <p className="ui-body3d-credit">{bodyFailed}</p>
            </div>
          ) : (
            <Suspense fallback={<p className="ui-body3d-loading">Loading the body…</p>}>
              <BodyViewer3D
                sex={care?.sex || null}
                markers={markers}
                onSelect={(tab) => { if (tab) onOpenTab(tab); }}
                onFail={setBodyFailed}
              />
            </Suspense>
          )}
        </div>
      </div>

      {/* ---- the editable care details, which belong to no section ---- */}
      <PatientCare customerId={customerId} />

      {/* ---- the old profile, until its parts have sections ----
          TEMPORARY, and labelled as such. The full profile holds staff
          notes, tags, the timeline, consultations and the communication
          preferences; none of those has a section of the record yet, and
          quietly dropping a screen that staff write into is not something a
          redesign gets to do. Each part leaves here as its section is built,
          and this block goes with the last of them. */}
      <details className="ui-sumcard">
        <summary className="cursor-pointer text-[13px] font-semibold text-[var(--ui-ink)]">
          Everything not yet filed into a section
          <span className="ml-2 font-normal text-[var(--ui-ink-faint)]">
            orders, notes, tags, timeline, consultations, message preferences
          </span>
        </summary>
        <div className="mt-4 border-t border-[var(--ui-line)] pt-4">
          <CustomerProfile
            customerId={customerId}
            onOpenConversation={onOpenConversation}
            onNavigate={onNavigate}
          />
        </div>
      </details>
    </div>
  );
}
