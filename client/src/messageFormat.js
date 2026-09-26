/**
 * How the patient's Messages section reads.
 *
 * Pure functions, so the wording is testable without a screen — the same
 * reason `followupFormat` and `allergyFormat` exist. The wording is the
 * product here: a transcript is what somebody actually said, and every label
 * around it is a claim about whether it arrived, who said it and whether
 * anyone is still waiting.
 *
 * Phase 2 adds two more claims: how much THIS reader has not seen (§17), and
 * what a conversation was about (§13) — where the label always comes from the
 * section that owns the record, never from anything Messages stored.
 */

/** Who said it, in words, and never in a way that blurs the assistant. */
export const AUTHOR_LABEL = Object.freeze({
  customer: 'Patient',
  // §11: "Do not make the AI appear to be a pharmacist." It is the assistant,
  // it is labelled the assistant, and no screen may call it anything else.
  assistant: 'Assistant',
  staff: 'Pharmacy',
  // Not something anybody said — a note the system wrote into the thread.
  system: 'System',
});

/** A patient is one side of this conversation; the pharmacy is the other. */
export const AUTHOR_SIDE = Object.freeze({
  customer: 'them',
  assistant: 'us',
  staff: 'us',
  system: 'note',
});

/**
 * Delivery, in words a pharmacist can act on.
 *
 * §8 and §34. `failed` and `undelivered` are the two that mean the patient did
 * NOT get it, and they are the only ones that carry a tone — everything else
 * is quiet, because a green tick on every message trains people to stop
 * reading them.
 */
export const DELIVERY = Object.freeze({
  queued: { label: 'Sending', tone: null },
  sent: { label: 'Sent', tone: null },
  delivered: { label: 'Delivered', tone: null },
  read: { label: 'Read', tone: null },
  failed: { label: 'Not delivered', tone: 'ui-tone-1' },
  undelivered: { label: 'Not delivered', tone: 'ui-tone-1' },
});

/**
 * What to say about an outbound message's delivery.
 *
 * Returns null for anything inbound (the patient's own message has no
 * delivery state — we did not send it) and for an outbound message whose
 * status never came back. That second null is the important one: §34 says a
 * message that was not sent must never look like one that was, and "we do not
 * know" is not "Sent".
 */
export function deliveryLabel(message) {
  if (!message || message.direction !== 'outbound') return null;
  const known = DELIVERY[message.deliveryStatus];
  return known || null;
}

/** The message failed, and a person should do something about it. */
export const didNotArrive = (message) =>
  message?.direction === 'outbound' &&
  (message.deliveryStatus === 'failed' || message.deliveryStatus === 'undelivered');

/**
 * The summary line at the top of the section (§4).
 *
 * Counts only, in the order a pharmacist scans them. No "unread" — this phase
 * has no read state, and a count of unread messages that is really a count of
 * all messages is worse than no count at all (MESSAGES_PLAN.md §5, phase 2).
 */
export function summaryParts(counts) {
  if (!counts) return [];
  const out = [];
  if (counts.awaitingPharmacist > 0) {
    // AMBER, not red. This IS a person waiting on a human, which is what
    // design.md gives red to — but the same line says "Only Consultations
    // earns it", and a second screen claiming the strongest colour is how
    // red stops meaning anything. Amber is design.md's "queued work", and a
    // thread the assistant stepped back from is queued work with a person on
    // the other end of it.
    out.push({ id: 'waiting', text: 'Waiting for a pharmacist', tone: 'ui-tone-1' });
  }
  // Unread outranks the plain counts but NOT "somebody is waiting": one means
  // a person has not been answered, the other means you have not looked.
  if (counts.unread > 0) {
    out.push({ id: 'unread', text: `${counts.unread} unread`, tone: 'ui-tone-1' });
  }
  if (counts.active > 0) out.push({ id: 'active', text: `${counts.active} active` });
  if (counts.archived > 0) out.push({ id: 'archived', text: `${counts.archived} in history` });
  return out;
}

/**
 * Which empty sentence is TRUE of this patient's messages, or null when there
 * is something to show.
 *
 * Three different claims, and they are not interchangeable — the distinction
 * the follow-up card had to be fixed to make (2026-09-25), applied here from
 * the start rather than after a screen said the wrong one:
 *
 *   the read failed / never happened   the caller says "Not recorded"
 *   nobody has ever messaged           "No messages"
 *   there are threads, none active     "No active conversations"
 */
export function emptyText(counts, filter = 'active') {
  if (!counts) return null;
  if (counts.all === 0) {
    return {
      title: 'No messages',
      help: 'There are no patient communications recorded yet.',
    };
  }
  if (filter === 'active' && counts.active === 0) {
    return {
      title: 'No active conversations',
      help: 'Archived conversations remain available under History.',
    };
  }
  if (filter === 'archived' && counts.archived === 0) {
    return { title: 'Nothing in history', help: 'Every conversation with this patient is still active.' };
  }
  return null;
}

/** Nigeria runs on UTC+1, and the pharmacy's day is the one that matters. */
export function lagosToday(now = new Date()) {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000);
  return lagos.toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

function lagos(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + 60 * 60 * 1000);
}

/** "10:42" — the time a message was sent, on the pharmacy's clock. */
export function timeLabel(iso) {
  const d = lagos(iso);
  if (!d) return null;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** "Today", "Yesterday", or "20 Sept 2026" — the heading above a day's messages. */
export function dayLabel(iso, today = lagosToday()) {
  const d = lagos(iso);
  if (!d) return null;
  const day = d.toISOString().slice(0, 10);
  if (day === today) return 'Today';

  const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400000)
    .toISOString().slice(0, 10);
  if (day === yesterday) return 'Yesterday';

  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Today · 10:42" — when a thread was last active, for the list. */
export function lastActivityLabel(iso, today = lagosToday()) {
  const day = dayLabel(iso, today);
  if (!day) return null;
  return `${day} · ${timeLabel(iso)}`;
}

/**
 * Group a transcript into days.
 *
 * Oldest first, because a conversation read from the bottom is a conversation
 * misread. The day headings are what make a six-month thread legible.
 */
export function byDay(messages, today = lagosToday()) {
  const days = [];
  for (const m of messages || []) {
    const label = dayLabel(m.at, today);
    const last = days[days.length - 1];
    if (last && last.label === label) last.messages.push(m);
    else days.push({ label, messages: [m] });
  }
  return days;
}

/**
 * The one line that says what a thread is, under its title.
 *
 * A topic if somebody labelled it; otherwise the honest "Not labelled" — never
 * "General", which would be this product answering a question nobody asked.
 */
export function topicLine(conversation) {
  if (!conversation) return null;
  return conversation.topicLabel || 'Not labelled';
}

/** What is going on in this thread, for the list row. */
export function stateLabel(conversation) {
  if (!conversation) return null;
  // An internal thread has no patient on the other end, so none of the words
  // below apply to it: "a person is replying" and "the assistant is replying"
  // are both about who answers the PATIENT. Saying either on an internal
  // thread is exactly the blurring §14 exists to prevent.
  if (conversation.channel === 'internal') {
    return conversation.status === 'closed' ? { text: 'Closed', tone: null } : null;
  }
  if (conversation.awaitingPharmacist) return { text: 'Waiting for a pharmacist', tone: 'ui-tone-1' };
  if (conversation.status === 'closed') return { text: 'Closed', tone: null };
  if (conversation.mode === 'human') return { text: 'A person is replying', tone: null };
  if (conversation.mode === 'bot') return { text: 'Assistant is replying', tone: null };
  return null;
}

/** The preview under a thread's title: who spoke last, and what they said. */
export function previewLine(conversation) {
  const last = conversation?.lastMessage;
  if (!last || !last.body) return null;
  const who = last.direction === 'outbound' ? `${AUTHOR_LABEL[last.author] || 'Pharmacy'}: ` : '';
  return `${who}${last.body}`;
}

/**
 * "2 unread", or nothing at all (§17).
 *
 * Zero has no badge. A badge reading "0 unread" is a badge a pharmacist
 * learns to ignore, and the whole point of this one is that it means
 * something is waiting for THEM.
 */
export function unreadLabel(n) {
  const count = Number(n || 0);
  if (count <= 0) return null;
  return `${count} unread`;
}

/**
 * How a linked record reads (§13).
 *
 * The label comes from the section that OWNS the record, through the server's
 * `describeRecord` — never from anything Messages stored. When the record is
 * gone, the link says so rather than disappearing, because "this thread was
 * about a reading that has since been deleted" is true and useful, and a row
 * that vanishes loses it.
 */
export const LINK_GONE = 'No longer on the record';

export function linkLine(link) {
  if (!link) return null;
  const kind = link.kindLabel || link.kind;
  if (!link.record) return { kind, label: LINK_GONE, gone: true, detail: null };
  return {
    kind,
    label: link.record.label || kind,
    gone: false,
    // Whatever the owning section calls it — a status, a date. Never a value
    // this screen worked out for itself.
    detail: link.record.detail || null,
  };
}

/** What the links panel says when a pharmacist has attached nothing yet. */
export const NO_LINKS = 'Nothing attached';

/**
 * Who wrote an internal note, for a colleague reading it (§14).
 *
 * The email is what this product knows; there is no display name for staff.
 * "You" for your own, because a thread where every note says the same address
 * is a thread nobody can scan.
 */
export function noteAuthor(note) {
  if (!note) return null;
  if (note.mine) return 'You';
  if (!note.authorEmail) return 'A colleague';
  // The local part is enough to tell two people apart on a narrow screen.
  return String(note.authorEmail).split('@')[0];
}

/**
 * What an internal thread is, said so it cannot be mistaken for the patient's.
 *
 * §14: "The UI should make this distinction obvious." This is the sentence
 * that does it, and it is deliberately about the READER's obligation, not a
 * decoration — a pharmacist glancing at a thread must know in one line that
 * the person being discussed cannot see it.
 */
export const INTERNAL_BANNER = 'Internal — the patient cannot see this';
export const PATIENT_BANNER = 'With the patient';

export const NO_INTERNAL_THREADS = 'No internal threads';
export const NO_INTERNAL_HELP = 'Start one to discuss this patient with a colleague. Nothing here reaches the patient.';
