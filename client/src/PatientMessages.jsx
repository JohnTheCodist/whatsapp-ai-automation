/**
 * Patient record → Messages.
 *
 * What was COMMUNICATED. Not what happened clinically (Consultation), not
 * what needs to happen next (Follow-up), not the long-term plan (Care
 * program). See MESSAGES_PLAN.md.
 *
 * THIS SCREEN SENDS NOTHING OF ITS OWN. Replying goes to
 * POST /api/conversations/:id/reply — the one send path this product has,
 * which checks the WhatsApp connection, declares a message category to
 * `communicationPolicy` and resets the handoff clock. A composer that posted
 * anywhere else would be a second send path, which is what §36 of the brief
 * forbids and how a message escapes the conduct rules.
 *
 * AND IT STARTS NOTHING. Phase 1 has no "New message": this product is
 * strictly reactive — every message it has ever sent is a reply to somebody
 * who wrote first — and that is the argument its WhatsApp access rests on.
 * The button is absent rather than present-and-disabled, because a control
 * that never works is worse than no control. The server says so in
 * `options.capabilities`, so when phase 3 builds it this screen follows
 * without being edited.
 */

import { useCallback, useEffect, useState } from 'react';
import { IconInbox } from './Icons.jsx';
import {
  AUTHOR_LABEL, AUTHOR_SIDE,
  deliveryLabel, didNotArrive, summaryParts, emptyText,
  timeLabel, byDay, lastActivityLabel, topicLine, stateLabel, previewLine,
  lagosToday, unreadLabel, linkLine, NO_LINKS,
  noteAuthor, INTERNAL_BANNER, PATIENT_BANNER, NO_INTERNAL_THREADS, NO_INTERNAL_HELP,
} from './messageFormat.js';

const FILTERS = [
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'History' },
  { id: 'all', label: 'All' },
];

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || 'Something went wrong.');
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

/**
 * One message.
 *
 * The sender is NAMED, never implied by which side of the screen it sits on —
 * §6: "Do not rely on color alone to indicate the sender." A transcript read
 * by someone colour-blind, or printed, must still say who spoke.
 */
function Message({ message }) {
  const delivery = deliveryLabel(message);
  const failed = didNotArrive(message);
  const side = AUTHOR_SIDE[message.author] || 'note';

  return (
    <li className={`ui-msg ui-msg-${side}${failed ? ' ui-msg-failed' : ''}`}>
      <div className="ui-msg-head">
        <span className="ui-msg-who">{AUTHOR_LABEL[message.author] || message.author}</span>
        <span className="ui-msg-time">{timeLabel(message.at)}</span>
      </div>
      {message.body
        ? <p className="ui-msg-body">{message.body}</p>
        : <p className="ui-msg-body ui-cprog-quiet">No text</p>}
      {/* Media WhatsApp already stored. Nothing is uploaded from here: the
          only file store in this product is a public bucket, and a patient's
          attachment cannot live at a guessable public URL. */}
      {message.mediaUrl && (
        <a className="ui-msg-media" href={message.mediaUrl} target="_blank" rel="noreferrer">
          Attachment sent over WhatsApp
        </a>
      )}
      {delivery && (
        <p className={`ui-msg-delivery ${delivery.tone || ''}`}>
          {delivery.label}
          {failed && message.deliveryError ? ` — ${message.deliveryError}` : ''}
        </p>
      )}
    </li>
  );
}

/** The transcript, with a heading per day. */
function Transcript({ messages }) {
  const today = lagosToday();
  const days = byDay(messages, today);

  if (days.length === 0) {
    return <p className="ui-allergy-help">Nothing was said in this conversation.</p>;
  }

  return (
    <div className="ui-msg-transcript">
      {days.map((day) => (
        <section key={day.label}>
          <h4 className="ui-msg-day">{day.label}</h4>
          <ul className="ui-msg-list">
            {day.messages.map((m) => <Message key={m.id} message={m} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * What this conversation was about (§13).
 *
 * POINTERS. Every label here is produced by the section that owns the record
 * — the server resolves them on each read — so a dose changed in Medications
 * shows here next time, and this panel can never display a value that has
 * stopped being true. Nothing clinical is stored against the conversation.
 */
function LinksPanel({ links, kinds, sources, onAttach, onDetach, busy }) {
  const [kind, setKind] = useState('');
  const [refId, setRefId] = useState('');

  // The records this patient actually has, for the chosen kind. An empty list
  // is said out loud rather than leaving a select that silently does nothing.
  const choices = kind ? (sources[kind] || []) : [];

  return (
    <div className="ui-msg-links">
      <h4 className="ui-cprog-quiet">Related records</h4>

      {links.length === 0 && <p className="ui-med-context-none">{NO_LINKS}</p>}

      {links.length > 0 && (
        <ul className="ui-msg-linklist">
          {links.map((l) => {
            const line = linkLine(l);
            return (
              <li key={l.id} className={line.gone ? 'is-gone' : ''}>
                <span className="ui-cprog-quiet">{line.kind}</span>
                <span className="ui-cond-brief-name">{line.label}</span>
                {line.detail && <span className="ui-allergy-safety-reaction">{line.detail}</span>}
                {l.note && <span className="ui-cprog-said-text">{l.note}</span>}
                <button
                  type="button"
                  className="ui-psection-link"
                  disabled={busy}
                  onClick={() => onDetach(l.id)}
                  // Detaching removes the LINK. The record stays where it is.
                  aria-label={`Detach ${line.kind} from this conversation`}
                >
                  Detach
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="ui-msg-attach">
        <label>
          <span className="sr-only">Kind of record</span>
          <select value={kind} disabled={busy} onChange={(e) => { setKind(e.target.value); setRefId(''); }}>
            <option value="">Attach a record…</option>
            {kinds.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </label>

        {kind && choices.length === 0 && (
          <span className="ui-cprog-quiet">This patient has none recorded.</span>
        )}

        {kind && choices.length > 0 && (
          <>
            <label>
              <span className="sr-only">Which record</span>
              <select value={refId} disabled={busy} onChange={(e) => setRefId(e.target.value)}>
                <option value="">Choose…</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}{c.detail ? ` — ${c.detail}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="ui-cprog-check"
              disabled={busy || !refId}
              onClick={() => { onAttach(kind, refId); setKind(''); setRefId(''); }}
            >
              Attach
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Raise a follow-up from what the patient said (§23).
 *
 * NOTHING IS CREATED AUTOMATICALLY. The brief is explicit: "Do not
 * automatically create a Follow-up just because a message was sent. Make it
 * an explicit action." A pharmacist types what needs doing and presses the
 * button; the conversation is recorded as the source, which is all the link
 * between them ever is.
 */
function CreateFollowup({ customerId, conversationId, onCreated }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [made, setMade] = useState(null);

  if (made) {
    return (
      <p className="ui-allergy-help">
        Follow-up created: <strong>{made.title}</strong>
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" className="ui-psection-link" onClick={() => setOpen(true)}>
        Create follow-up from this conversation
      </button>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await readJson(await fetch(`/api/customers/${customerId}/followups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          dueOn: dueOn || null,
          // Where it came from. The follow-up queue owns the follow-up; this
          // only records that a conversation raised it.
          sourceType: 'conversation',
          sourceId: conversationId,
        }),
      }));
      setMade(created);
      onCreated?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ui-msg-followup" onSubmit={submit}>
      <label>
        <span className="ui-cprog-quiet">What needs to happen</span>
        <input
          type="text"
          value={title}
          disabled={busy}
          placeholder="Repeat blood pressure"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        {/* A follow-up may have no due date at all — "review the result when
            it comes back" is a real thing to remember, and forcing a date
            would put a made-up one in front of a pharmacist (0062). */}
        <span className="ui-cprog-quiet">Due (optional)</span>
        <input type="date" value={dueOn} disabled={busy} onChange={(e) => setDueOn(e.target.value)} />
      </label>
      <button type="submit" className="ui-cprog-check" disabled={busy || !title.trim()}>
        {busy ? 'Creating…' : 'Create follow-up'}
      </button>
      <button type="button" className="ui-psection-link" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <p className="ui-allergy-failed">{error}</p>}
    </form>
  );
}

/** Saying what a thread was about. The only thing this screen may change. */
function TopicPicker({ conversation, topics, onSet, busy }) {
  return (
    <label className="ui-msg-topic">
      <span className="ui-cprog-quiet">Topic</span>
      <select
        value={conversation.topic || ''}
        disabled={busy}
        onChange={(e) => onSet(e.target.value || null)}
      >
        {/* "Not labelled" is a real answer, and choosing it again removes a
            wrong label rather than forcing a pharmacist to pick `Other`. */}
        <option value="">Not labelled</option>
        {topics.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
    </label>
  );
}

/** One conversation, opened. */
function ConversationView({ customerId, conversation, topics, linkKinds, onBack, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [sendError, setSendError] = useState(null);
  const [sources, setSources] = useState({});

  // The list row carries a PREVIEW. The transcript is fetched, because
  // rendering a conversation from its summary is how a screen ends up
  // describing a record it has not read.
  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    fetch(`/api/customers/${customerId}/messages/${conversation.id}`)
      .then(readJson)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        // Read ONLY once the transcript is actually in hand (§17: "Do not
        // automatically mark messages as read before they are viewed"). It is
        // a POST, never a side effect of the GET, so nothing that merely
        // loads a summary can clear somebody's badge.
        fetch(`/api/customers/${customerId}/messages/${conversation.id}/read`, { method: 'POST' })
          .then(() => { if (live) onChanged?.(); })
          .catch(() => {});
      })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [customerId, conversation.id, onChanged]);

  // The records this patient has, for the attach picker. Reuses the follow-up
  // module's own read-only picker for the six kinds it already serves rather
  // than growing a second one.
  useEffect(() => {
    let live = true;
    Promise.all([
      fetch(`/api/customers/${customerId}/followups/sources`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch(`/api/customers/${customerId}/medications`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/customers/${customerId}/followups`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([src, meds, fu]) => {
      if (!live) return;
      setSources({
        consultation: src.consultations || [],
        medication_review: src.medicationReviews || [],
        care_program: src.carePrograms || [],
        test: src.tests || [],
        vitals: src.vitals || [],
        condition: src.conditions || [],
        medication: (meds?.medications || meds?.current || []).map((m) => ({
          id: m.id, label: m.medicineName || m.name || 'Medicine', detail: m.status,
        })),
        followup: (fu?.followups || []).map((f) => ({
          id: f.id, label: f.title, detail: f.status,
        })),
      });
    });
    return () => { live = false; };
  }, [customerId]);

  const attach = async (kind, refId) => {
    setBusy(true);
    setError(null);
    try {
      const { links } = await readJson(await fetch(
        `/api/customers/${customerId}/messages/${conversation.id}/links`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, refId }),
        },
      ));
      setDetail((d) => (d ? { ...d, links } : d));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const detach = async (linkId) => {
    setBusy(true);
    setError(null);
    try {
      const { links } = await readJson(await fetch(
        `/api/customers/${customerId}/messages/${conversation.id}/links/${linkId}`,
        { method: 'DELETE' },
      ));
      setDetail((d) => (d ? { ...d, links } : d));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const setTopic = async (topic) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await readJson(await fetch(
        `/api/customers/${customerId}/messages/${conversation.id}/topic`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic }),
        },
      ));
      setDetail((d) => (d ? { ...d, conversation: { ...d.conversation, ...updated } } : d));
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Reply — through the staff inbox endpoint, which is the one send path.
   *
   * §34: a failure is SHOWN. A composer that clears itself on error tells a
   * pharmacist their message went when it did not, which is the single worst
   * thing this screen could do.
   */
  const send = async (e) => {
    e.preventDefault();
    const text = reply.trim();
    if (!text || busy) return;
    setBusy(true);
    setSendError(null);
    try {
      await readJson(await fetch(`/api/conversations/${conversation.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }));
      setReply('');
      const fresh = await readJson(await fetch(`/api/customers/${customerId}/messages/${conversation.id}`));
      setDetail(fresh);
      onChanged?.();
    } catch (err) {
      // The text stays in the box. It was not sent, and the pharmacist should
      // not have to retype it to try again.
      setSendError(err.code === 'NOT_CONNECTED'
        ? 'WhatsApp is not connected, so this was not sent.'
        : err.message);
    } finally {
      setBusy(false);
    }
  };

  const shown = detail?.conversation || conversation;
  const state = stateLabel(shown);
  const canReply = shown.status === 'open';

  return (
    <div className="ui-followup-detail">
      <div className="ui-followup-head">
        <button type="button" className="ui-psection-link" onClick={onBack}>← All conversations</button>
      </div>

      <h3 className="ui-followup-title">{topicLine(shown)}</h3>
      <p className="ui-followup-context">
        {lastActivityLabel(shown.lastMessageAt)}
        {shown.messageCount ? ` · ${shown.messageCount} messages` : ''}
        {/* Every thread here came in over WhatsApp — this product has one
            channel, and §9 says show the ones it actually supports. */}
        {' · WhatsApp'}
      </p>
      {state && <p className={`ui-followup-urgent ${state.tone || ''}`}>{state.text}</p>}

      <TopicPicker conversation={shown} topics={topics} onSet={setTopic} busy={busy} />

      {detail && (
        <LinksPanel
          links={detail.links || []}
          kinds={linkKinds}
          sources={sources}
          onAttach={attach}
          onDetach={detach}
          busy={busy}
        />
      )}

      {detail && (
        <CreateFollowup
          customerId={customerId}
          conversationId={conversation.id}
          onCreated={onChanged}
        />
      )}

      {error && <p className="ui-allergy-failed">{error}</p>}

      {!detail && !error && <p className="ui-allergy-help">Loading the conversation…</p>}
      {detail && <Transcript messages={detail.messages} />}

      {detail && canReply && (
        <form className="ui-msg-composer" onSubmit={send}>
          <label className="sr-only" htmlFor="reply">Reply to this patient</label>
          <textarea
            id="reply"
            rows={2}
            value={reply}
            placeholder="Type a reply…"
            disabled={busy}
            onChange={(e) => setReply(e.target.value)}
          />
          <button type="submit" className="ui-cprog-check" disabled={busy || !reply.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          {sendError && <p className="ui-allergy-failed">{sendError}</p>}
        </form>
      )}

      {detail && !canReply && (
        <p className="ui-allergy-help">
          This conversation is closed. A reply here would reopen a thread the patient
          has finished; wait for them to write again.
        </p>
      )}
    </div>
  );
}

/**
 * Internal threads (§14) — staff-to-staff, about this patient.
 *
 * Kept as its own view rather than a filter over one list, because §14's
 * requirement is that the distinction is OBVIOUS and the safest form of
 * obvious is that the two never share a screen. Every internal view carries
 * the banner saying the patient cannot see it.
 *
 * Nothing here can reach the patient: the server refuses an internal
 * conversation in the one send path before it touches the transport, and the
 * database has nowhere to record one as sent (0066, GOLDEN-007).
 */
function InternalThread({ customerId, thread, onBack, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/messages/internal/${thread.id}`)
      .then(readJson)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        fetch(`/api/customers/${customerId}/messages/${thread.id}/read`, { method: 'POST' })
          .then(() => { if (live) onChanged?.(); })
          .catch(() => {});
      })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [customerId, thread.id, onChanged]);

  const add = async (e) => {
    e.preventDefault();
    const text = note.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await readJson(await fetch(
        `/api/customers/${customerId}/messages/internal/${thread.id}/notes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: text }),
        },
      ));
      setDetail(fresh);
      setNote('');
      onChanged?.();
    } catch (err) {
      // The text stays in the box. It was not saved, and nobody should have
      // to retype a clinical note.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const shown = detail?.conversation || thread;

  return (
    <div className="ui-followup-detail ui-msg-internal">
      <div className="ui-followup-head">
        <button type="button" className="ui-psection-link" onClick={onBack}>← Internal threads</button>
      </div>

      <p className="ui-msg-internal-banner">{INTERNAL_BANNER}</p>

      <h3 className="ui-followup-title">{shown.subject || 'Internal thread'}</h3>
      <p className="ui-followup-context">
        Started {lastActivityLabel(shown.startedAt || shown.lastMessageAt)}
      </p>

      {error && <p className="ui-allergy-failed">{error}</p>}
      {!detail && !error && <p className="ui-allergy-help">Loading…</p>}

      {detail && (
        <ul className="ui-msg-notes">
          {detail.notes.map((n) => (
            <li key={n.id}>
              <div className="ui-msg-head">
                <span className="ui-msg-who">{noteAuthor(n)}</span>
                <span className="ui-msg-time">{lastActivityLabel(n.at)}</span>
              </div>
              <p className="ui-msg-body">{n.body}</p>
            </li>
          ))}
        </ul>
      )}

      {detail && (
        <form className="ui-msg-composer" onSubmit={add}>
          <label className="sr-only" htmlFor="note">Add an internal note</label>
          <textarea
            id="note"
            rows={2}
            value={note}
            placeholder="Add a note for colleagues…"
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="submit" className="ui-cprog-check" disabled={busy || !note.trim()}>
            {busy ? 'Saving…' : 'Add note'}
          </button>
          {error && <p className="ui-allergy-failed">{error}</p>}
        </form>
      )}
    </div>
  );
}

function StartInternalThread({ customerId, onStarted }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!open) {
    return (
      <button type="button" className="ui-cprog-check" onClick={() => setOpen(true)}>
        Start an internal thread
      </button>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    if (!subject.trim() || !note.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await readJson(await fetch(`/api/customers/${customerId}/messages/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subject.trim(), note: note.trim() }),
      }));
      setSubject('');
      setNote('');
      setOpen(false);
      onStarted?.(created);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ui-msg-followup" onSubmit={submit}>
      <p className="ui-msg-internal-banner">{INTERNAL_BANNER}</p>
      <label>
        <span className="ui-cprog-quiet">What is this about</span>
        <input
          type="text"
          value={subject}
          disabled={busy}
          placeholder="Dose query before dispensing"
          onChange={(e) => setSubject(e.target.value)}
        />
      </label>
      <label>
        <span className="ui-cprog-quiet">First note</span>
        <input
          type="text"
          value={note}
          disabled={busy}
          placeholder="Prescriber wrote 10mg; the pack is 5mg."
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button type="submit" className="ui-cprog-check" disabled={busy || !subject.trim() || !note.trim()}>
        {busy ? 'Starting…' : 'Start thread'}
      </button>
      <button type="button" className="ui-psection-link" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <p className="ui-allergy-failed">{error}</p>}
    </form>
  );
}

export default function PatientMessages({ customerId }) {
  // Which KIND of thread. Patient-facing by default: "Messages" on a patient
  // record means communication WITH the patient, and an internal thread must
  // never appear there by accident (§14).
  const [channel, setChannel] = useState('whatsapp');
  const [filter, setFilter] = useState('active');
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ filter, channel });
    if (query.trim()) params.set('q', query.trim());
    try {
      setData(await readJson(await fetch(`/api/customers/${customerId}/messages?${params}`)));
    } catch (e) {
      // §34: a load failure says so. It does NOT render as "No messages",
      // which would tell a pharmacist this patient has never been contacted.
      setData(null);
      setError(e.message);
    }
  }, [customerId, filter, query, channel]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/messages/options`)
      .then(readJson)
      .then((o) => { if (live) setOptions(o); })
      .catch(() => { if (live) setOptions(null); });
    return () => { live = false; };
  }, [customerId]);

  if (open && channel === 'internal') {
    return (
      <InternalThread
        customerId={customerId}
        thread={open}
        onBack={() => { setOpen(null); load(); }}
        onChanged={load}
      />
    );
  }

  if (open) {
    return (
      <ConversationView
        customerId={customerId}
        conversation={open}
        topics={options?.topics || []}
        linkKinds={options?.linkKinds || []}
        onBack={() => { setOpen(null); load(); }}
        onChanged={load}
      />
    );
  }

  const counts = data?.counts || null;
  const empty = emptyText(counts, filter);

  return (
    <div className="ui-followup-main">
      <div className="ui-followup-head">
        <h3 className="ui-allergy-heading"><IconInbox width={16} height={16} aria-hidden="true" /> Messages</h3>
      </div>

      {/* Two KINDS of thread, never mixed into one list — §14's "the UI should
          make this distinction obvious", in its strongest form. */}
      <div className="ui-followup-head" role="tablist" aria-label="Which conversations">
        <button
          type="button"
          role="tab"
          aria-selected={channel === 'whatsapp'}
          className={`ui-cprog-pill${channel === 'whatsapp' ? ' is-on' : ''}`}
          onClick={() => { setChannel('whatsapp'); setOpen(null); }}
        >
          {PATIENT_BANNER}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={channel === 'internal'}
          className={`ui-cprog-pill${channel === 'internal' ? ' is-on' : ''}`}
          onClick={() => { setChannel('internal'); setOpen(null); }}
        >
          Internal
          {data?.internal?.unread > 0 && (
            <span className="ui-msg-unread">{data.internal.unread}</span>
          )}
        </button>
      </div>

      {channel === 'internal' && (
        <>
          <p className="ui-msg-internal-banner">{INTERNAL_BANNER}</p>
          <StartInternalThread
            customerId={customerId}
            onStarted={(created) => { load(); setOpen(created); }}
          />
        </>
      )}

      {counts && (
        <p className="ui-followup-counts">
          {summaryParts(counts).map((p) => (
            <span key={p.id} className={p.tone || ''}>{p.text}</span>
          ))}
          {data.lastContactAt && (
            <span className="ui-cprog-quiet">
              {/* "Last contact" is about the PATIENT. An internal thread has
                  no contact with anybody outside this pharmacy. */}
              {channel === 'internal' ? 'Last note ' : 'Last contact '}
              {lastActivityLabel(data.lastContactAt)}
            </span>
          )}
        </p>
      )}

      <div className="ui-followup-head">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`ui-cprog-pill${filter === f.id ? ' is-on' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <input
          type="search"
          value={query}
          placeholder="Search messages"
          aria-label="Search this patient's messages"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && <p className="ui-allergy-failed">{error}</p>}

      {!error && !data && <p className="ui-allergy-help">Loading…</p>}

      {data && data.conversations.length === 0 && channel === 'internal' && !query.trim() && (
        <div className="ui-allergy-body">
          <p className="ui-allergy-heading">{NO_INTERNAL_THREADS}</p>
          <p className="ui-allergy-help">{NO_INTERNAL_HELP}</p>
        </div>
      )}

      {data && data.conversations.length === 0 && channel !== 'internal' && (
        query.trim()
          ? <p className="ui-allergy-help">No conversation contains that.</p>
          : empty && (
            <div className="ui-allergy-body">
              <p className="ui-allergy-heading">{empty.title}</p>
              <p className="ui-allergy-help">{empty.help}</p>
            </div>
          )
      )}

      {data && data.conversations.length > 0 && (
        <ul className="ui-followup-list">
          {data.conversations.map((c) => {
            const state = stateLabel(c);
            return (
              <li key={c.id}>
                <button type="button" className="ui-followup-subject" onClick={() => setOpen(c)}>
                  <span className="ui-followup-title">
                    {c.channel === 'internal' ? (c.subject || 'Internal thread') : topicLine(c)}
                  </span>
                  {previewLine(c) && <span className="ui-cprog-said-text">{previewLine(c)}</span>}
                  <span className="ui-cprog-stamp">
                    {lastActivityLabel(c.lastMessageAt)}
                    {c.messageCount ? ` · ${c.messageCount} messages` : ''}
                  </span>
                  {/* Unread is THIS reader's, and a zero shows nothing at
                      all — a "0 unread" badge is one people stop seeing. */}
                  {unreadLabel(c.unread) && (
                    <span className="ui-msg-unread">{unreadLabel(c.unread)}</span>
                  )}
                  {state && <span className={`ui-cprog-pill ${state.tone || ''}`}>{state.text}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
