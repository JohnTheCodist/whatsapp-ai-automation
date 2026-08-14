/**
 * Internal CRM data: staff notes and customer tags.
 *
 * WHAT MAKES THIS SAFE IS WHERE IT IS NOT CALLED FROM
 * Nothing in this file is reachable from the assistant path. `respond()` takes
 * an explicitly enumerated set of arguments and no profile object, so adding
 * notes to a customer cannot flow into a prompt by accident — it would take
 * someone importing this module into the assistant and passing the result on
 * purpose. crmBoundary.test.js plants a sentinel note and fails if it ever
 * reaches the model, so that "on purpose" is also "caught immediately".
 *
 * TAGS ARE METADATA, NOT INSTRUCTIONS
 * PHARMACIST_FOLLOW_UP is a filter for staff, not a rule telling the assistant
 * to redirect someone. HIGH_VALUE does not change a price. The system has
 * exactly one place that decides how the assistant behaves — the system prompt
 * and the tool contracts — and CRM metadata is deliberately not wired into it.
 *
 * Every function takes pharmacyId first and scopes on it, like the rest of the
 * services here.
 */

const { getSql, assertPharmacyId } = require('../db');
const { recordEvent } = require('./customerEvents');
const { PATIENT_EVENTS } = require('./patientEventTypes');

/** A customer this pharmacy actually owns, or null. Never an existence oracle. */
async function assertOwnedCustomer(sql, pharmacyId, customerId) {
  const [row] = await sql`
    select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  if (!row) {
    const err = new Error('Customer not found.');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  return row;
}

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

async function listNotes(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  await assertOwnedCustomer(db, pharmacyId, customerId);

  return db`
    select n.id, n.content, n.created_at, n.updated_at,
           n.author_id, u.email as author_email
    from patient_notes n
    left join auth.users u on u.id = n.author_id
    where n.pharmacy_id = ${pharmacyId} and n.customer_id = ${customerId}
    order by n.created_at desc
  `;
}

async function addNote(pharmacyId, customerId, { content, authorId = null }) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  await assertOwnedCustomer(db, pharmacyId, customerId);

  const text = String(content || '').trim();
  if (!text) {
    const err = new Error('A note cannot be empty.');
    err.status = 400; err.code = 'EMPTY_NOTE';
    throw err;
  }
  if (text.length > 2000) {
    const err = new Error('A note cannot be longer than 2000 characters.');
    err.status = 400; err.code = 'NOTE_TOO_LONG';
    throw err;
  }

  const [note] = await db`
    insert into patient_notes (pharmacy_id, customer_id, author_id, content)
    values (${pharmacyId}, ${customerId}, ${authorId}, ${text})
    returning id, content, created_at, updated_at, author_id
  `;

  // The event records THAT a note was written, never what it said. Copying
  // the content here would put staff-only prose in a second table and make
  // the boundary depend on remembering this one too.
  await recordEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.NOTE_ADDED,
    actorType: 'staff', actorId: authorId,
    entityType: 'note', entityId: note.id,
    visibility: 'internal',
    metadata: {},
    idempotencyKey: `note_added:${note.id}`,
  });

  return note;
}

async function updateNote(pharmacyId, customerId, noteId, { content, authorId = null }) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const text = String(content || '').trim();
  if (!text) {
    const err = new Error('A note cannot be empty.');
    err.status = 400; err.code = 'EMPTY_NOTE';
    throw err;
  }

  // pharmacy_id in the WHERE, not just the note id: without it, knowing a
  // note's uuid would be enough to edit another pharmacy's note.
  const [note] = await db`
    update patient_notes
    set content = ${text}, updated_at = now()
    where id = ${noteId} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
    returning id, content, created_at, updated_at, author_id
  `;
  if (!note) {
    const err = new Error('Note not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  await recordEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.NOTE_UPDATED,
    actorType: 'staff', actorId: authorId,
    entityType: 'note', entityId: note.id,
    visibility: 'internal',
    metadata: {},
    // Timestamped, because a note can be edited many times and each edit is a
    // separate fact. The default key would collapse them into one event.
    idempotencyKey: `note_updated:${note.id}:${note.updated_at.toISOString()}`,
  });

  return note;
}

async function deleteNote(pharmacyId, customerId, noteId, { authorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [note] = await db`
    delete from patient_notes
    where id = ${noteId} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
    returning id
  `;
  if (!note) {
    const err = new Error('Note not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  // Recorded after the row is gone — which is why `note` has no table in
  // ENTITY_TABLES. Verifying the entity still exists would make it impossible
  // to record the deletion that just happened.
  await recordEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.NOTE_DELETED,
    actorType: 'staff', actorId: authorId,
    entityType: 'note', entityId: note.id,
    visibility: 'internal',
    metadata: {},
    idempotencyKey: `note_deleted:${note.id}`,
  });

  return { id: note.id };
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

/** Every tag this pharmacy has available. */
async function listTags(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select id, name, slug, is_system from tags
    where pharmacy_id = ${pharmacyId}
    order by is_system desc, name
  `;
}

async function listCustomerTags(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select t.id, t.name, t.slug, pt.created_at
    from patient_tags pt
    join tags t on t.id = pt.tag_id
    where pt.pharmacy_id = ${pharmacyId} and pt.customer_id = ${customerId}
    order by t.name
  `;
}

/**
 * Attach a tag. Idempotent: attaching twice is success, not an error, because
 * two staff clicking at the same moment is a normal thing to happen and not
 * something either of them should see an error for.
 */
async function addTag(pharmacyId, customerId, tagId, { authorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  await assertOwnedCustomer(db, pharmacyId, customerId);

  // The tag must belong to this pharmacy too — otherwise a known tag uuid
  // would let one tenant label another tenant's customers.
  const [tag] = await db`
    select id, name, slug from tags where id = ${tagId} and pharmacy_id = ${pharmacyId}
  `;
  if (!tag) {
    const err = new Error('Tag not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  const [link] = await db`
    insert into patient_tags (customer_id, tag_id, pharmacy_id, created_by)
    values (${customerId}, ${tag.id}, ${pharmacyId}, ${authorId})
    on conflict (customer_id, tag_id) do nothing
    returning customer_id
  `;

  // Only record an event when something actually changed. A repeated click
  // should not add a second identical line to the staff timeline.
  if (link) {
    await recordEvent(db, {
      pharmacyId, customerId,
      eventType: PATIENT_EVENTS.TAG_ADDED,
      actorType: 'staff', actorId: authorId,
      entityType: 'tag', entityId: tag.id,
      visibility: 'internal',
      metadata: { slug: tag.slug, name: tag.name },
      // Timestamped so add -> remove -> add is three events, not one. This is
      // exactly the recurrence case the caller-supplied key exists for: the
      // default (type + entity) would swallow every re-add after the first.
      idempotencyKey: `tag_added:${customerId}:${tag.id}:${Date.now()}`,
    });
  }

  return { tag, added: Boolean(link) };
}

async function removeTag(pharmacyId, customerId, tagId, { authorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [removed] = await db`
    delete from patient_tags
    where customer_id = ${customerId} and tag_id = ${tagId} and pharmacy_id = ${pharmacyId}
    returning tag_id
  `;
  if (!removed) return { removed: false };

  const [tag] = await db`select name, slug from tags where id = ${tagId}`;

  await recordEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.TAG_REMOVED,
    actorType: 'staff', actorId: authorId,
    entityType: 'tag', entityId: tagId,
    visibility: 'internal',
    metadata: { slug: tag?.slug || null, name: tag?.name || null },
    idempotencyKey: `tag_removed:${customerId}:${tagId}:${Date.now()}`,
  });

  // The tag definition itself is untouched — removing a label from one
  // customer must not delete it for the whole pharmacy.
  return { removed: true };
}

module.exports = {
  listNotes, addNote, updateNote, deleteNote,
  listTags, listCustomerTags, addTag, removeTag,
};
