/**
 * One patient's record: a navigation column of the record's twelve sections,
 * and the section that is open.
 *
 * THIS SIDEBAR COLLAPSES BY HAND, NOT BY HOVER. The app's main sidebar opens
 * when you point at it (design.md, "The sidebar opens on hover"); this one
 * does not, and must not. A pharmacist works inside one record for minutes
 * at a time with the cursor crossing this column constantly — on the way to
 * a table, a field, the scrollbar — and a panel that opened each time would
 * be movement they did not ask for. So there is a button, the state is
 * theirs, and it is remembered per browser (NAV_STATE_KEY).
 *
 * IT ANIMATES WIDTH, DELIBERATELY. The main sidebar animates a clip-path
 * precisely so the page does not re-lay-out; here the re-layout IS the
 * point — collapsing is how a pharmacist gives a wide table the room. The
 * column is a flex item, one transition, 220ms.
 *
 * COLLAPSED IS NOT HIDDEN. Labels go to `opacity: 0` and the column narrows,
 * but every button keeps its text in the accessibility tree, so a screen
 * reader hears "Tests" whichever state the column is in. The same
 * rule as the main rail, for the same reason.
 *
 * WHAT IS BUILT, AND WHAT IS NOT. Only Patient summary has a screen today
 * (PatientSummary), and it is a summary OF the other eleven — one card per
 * section, each linking into the section that holds the rest.
 *
 * The other eleven are in the navigation because they are the agreed shape
 * of a record, and each one says plainly that it is not built yet. An empty panel under Allergies would read as "this patient has
 * no allergies", which is the one thing this screen must never say by
 * accident.
 */

import { useEffect, useState } from 'react';
import PatientSummary from './PatientSummary.jsx';
import Vitals from './Vitals.jsx';
import Medications from './Medications.jsx';
import Allergies from './Allergies.jsx';
import Conditions from './Conditions.jsx';
import Tests from './Tests.jsx';
import CarePrograms from './CarePrograms.jsx';
import Followups from './Followups.jsx';
import PatientMessages from './PatientMessages.jsx';
import { AllergyStrip } from './AllergySafety.jsx';
import { IconChevronDown } from './Icons.jsx';
import {
  PATIENT_TABS, DEFAULT_PATIENT_TAB, NAV_STATE_KEY, patientTab, resolvePatientTab,
} from './patientRecordTabs.js';

/**
 * The remembered choice. Wrapped because storage throws in a private window
 * and comes back empty after site data is cleared — neither of which is a
 * reason for the record to fail to render.
 */
function readCollapsed() {
  try {
    return window.localStorage.getItem(NAV_STATE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed) {
  try {
    window.localStorage.setItem(NAV_STATE_KEY, collapsed ? 'collapsed' : 'open');
  } catch {
    // A preference that could not be saved is not an error worth showing.
  }
}

/** A section that has no screen yet. Says so, and says what will be here. */
function NotBuilt({ tab }) {
  return (
    <section className="rounded-xl border border-[var(--ui-line)] bg-[var(--ui-surface)] px-6 py-14 text-center">
      <h2 className="text-base font-semibold text-[var(--ui-ink)]">{tab.label}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--ui-ink-soft)]">
        This section is not built yet. It is in the record so the shape of a
        patient&rsquo;s file is settled — nothing here is hidden or empty,
        there is simply nothing to show until we build it.
      </p>
    </section>
  );
}

export default function PatientRecord({ customerId, onBack, onOpenConversation, onNavigate }) {
  const [active, setActive] = useState(DEFAULT_PATIENT_TAB);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // Bumped when the Allergies tab saves, so the strip above every section
  // re-reads the record rather than showing what it was.
  const [allergyVersion, setAllergyVersion] = useState(0);

  // A different patient opens on their summary: the section that was open
  // for the last person is not a statement about this one.
  useEffect(() => { setActive(DEFAULT_PATIENT_TAB); }, [customerId]);

  const toggle = () => setCollapsed((c) => { writeCollapsed(!c); return !c; });
  const current = patientTab(resolvePatientTab(active));

  return (
    <div className="flex items-start gap-5">
      {/* ---------------------------------------------------------- the nav */}
      <nav
        aria-label="Patient record"
        className="ui-precord"
        data-collapsed={collapsed ? 'true' : 'false'}
      >
        <div className="ui-precord-head">
          <span className="ui-precord-title">Record</span>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand the record menu' : 'Collapse the record menu'}
            title={collapsed ? 'Expand' : 'Collapse'}
            className="ui-precord-toggle"
          >
            {/* One glyph, rotated: the same arrow pointing the way it will
                move the panel. */}
            <IconChevronDown width={16} height={16} aria-hidden="true" />
          </button>
        </div>

        <ul className="ui-precord-list">
          {PATIENT_TABS.map(({ id, label, Icon, built }, i) => {
            const on = id === current.id;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => setActive(id)}
                  aria-current={on ? 'page' : undefined}
                  // The tooltip is the label while the column is narrow; it
                  // is harmless when it is wide.
                  title={label}
                  className={`ui-precord-item ${on ? 'is-on' : ''}`}
                  // Labels arrive one after another as the panel opens, top
                  // to bottom. Cheap, and it makes the opening read as one
                  // movement rather than twelve.
                  style={{ '--precord-i': i }}
                >
                  <span className="ui-precord-pill" aria-hidden="true" />
                  <span className="ui-precord-icon"><Icon width={18} height={18} /></span>
                  <span className="ui-precord-label">{label}</span>
                  {!built && <span className="ui-precord-soon">Soon</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ------------------------------------------------------- the section */}
      <div className="min-w-0 flex-1">
        <div className="ui-precord-top">
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-[var(--ui-ink-soft)] hover:text-[var(--ui-ink)]"
          >
            &larr; Back to patients
          </button>
          {/* The allergy answer on every section of the record — the one
              fact a pharmacist must never have to go looking for. A pointer
              to the Allergies tab, not a second copy of it. */}
          <AllergyStrip
            customerId={customerId}
            version={allergyVersion}
            onOpen={() => setActive('allergies')}
          />
        </div>

        {current.id === 'summary' ? (
          <PatientSummary
            key={customerId}
            customerId={customerId}
            // Every card on the summary opens the section that holds the
            // rest of it, so nothing on the summary is a dead end.
            onOpenTab={setActive}
            onOpenConversation={onOpenConversation}
            onNavigate={onNavigate}
          />
        ) : current.id === 'vitals' ? (
          <Vitals key={customerId} customerId={customerId} />
        ) : current.id === 'meds' ? (
          <Medications key={customerId} customerId={customerId} onOpenTab={setActive} />
        ) : current.id === 'allergies' ? (
          <Allergies key={customerId} customerId={customerId} onChanged={() => setAllergyVersion((v) => v + 1)} />
        ) : current.id === 'results' ? (
          <Tests key={customerId} customerId={customerId} onOpenTab={setActive} />
        ) : current.id === 'conditions' ? (
          <Conditions key={customerId} customerId={customerId} onOpenTab={setActive} />
        ) : current.id === 'care' ? (
          <CarePrograms key={customerId} customerId={customerId} onOpenTab={setActive} />
        ) : current.id === 'followup' ? (
          <Followups key={customerId} customerId={customerId} onOpenTab={setActive} />
        ) : current.id === 'messages' ? (
          <PatientMessages key={customerId} customerId={customerId} />
        ) : (
          <NotBuilt tab={current} />
        )}
      </div>
    </div>
  );
}
