/**
 * Counting what a pharmacy's website did.
 *
 * NO JAVASCRIPT IS INVOLVED, AND THAT CONSTRAINT SHAPED EVERYTHING HERE.
 *
 * Published pages carry `script-src 'none'` and contain no script at all —
 * that is what makes the entire stored-XSS class unreachable rather than
 * merely defended against, and it is not being traded away for a metric. So
 * there is no tracking snippet, no pixel that a script inserts, and no
 * third-party analytics. What is left is the two things a server can observe
 * on its own:
 *
 *   VIEWS   counted when the page is served
 *   CLICKS  counted by sending the link through a redirect first
 *
 * Both are recorded here, buffered, and flushed on a timer.
 *
 * WHY BUFFERED. One upsert per page view puts a write on a connection pool
 * capped at 15 that every pharmacy's live WhatsApp socket also uses. A busy
 * pharmacy website would degrade messaging to count visitors, which is a
 * terrible trade. Accumulating in memory turns any amount of traffic into one
 * statement per kind per flush.
 *
 * WHAT THAT COSTS. A process restart loses up to one interval of counts.
 * That is acceptable for a number read as a trend and stated plainly rather
 * than discovered later as a discrepancy — and it is the correct trade
 * against the alternative, which is analytics that can slow down a pharmacy
 * answering a customer.
 *
 * NOTHING ABOUT A VISITOR IS RECORDED. No IP, no user agent, no session, no
 * referrer, no cookie. See the header of 0050_website_analytics.sql: a person
 * visiting a pharmacy's website is a sensitive fact about their health, and
 * the safest way to hold that is not to.
 */

const { getSql, assertPharmacyId } = require('../db');

const KINDS = Object.freeze(['view', 'whatsapp', 'phone', 'directions', 'email']);

/** Everything except a view is a conversion — the visitor did the thing. */
const CONVERSIONS = Object.freeze(KINDS.filter((k) => k !== 'view'));

/**
 * 30 seconds.
 *
 * Short enough that a pharmacy refreshing their dashboard sees today's number
 * move, long enough that a burst of traffic collapses into a single write.
 * The window is also the maximum a restart can lose.
 */
const FLUSH_INTERVAL_MS = 30_000;

/** `${pharmacyId}|${kind}|${day}` -> count */
let buffer = new Map();
let timer = null;

function today() {
  // UTC, so a flush that straddles midnight cannot put two rows in the same
  // day bucket under different local offsets. The dashboard reads these as
  // daily totals, and consistency matters more than matching a Lagos calendar
  // day exactly.
  return new Date().toISOString().slice(0, 10);
}

/**
 * Record one event. Cheap, synchronous, and never throws.
 *
 * Called from the public site route, which serves unauthenticated traffic and
 * must not fail because a counter did. An analytics problem is not a reason
 * to stop serving a pharmacy's website.
 */
function record(pharmacyId, kind) {
  if (!pharmacyId || !KINDS.includes(kind)) return;
  const key = `${pharmacyId}|${kind}|${today()}`;
  buffer.set(key, (buffer.get(key) || 0) + 1);
}

/**
 * Write the buffer out.
 *
 * The buffer is swapped BEFORE the await, not after: anything recorded while
 * this is in flight lands in the fresh map and is counted next time, rather
 * than being cleared away unwritten by a `buffer.clear()` after the write.
 *
 * On failure the counts are put back, so a transient database blip delays
 * them rather than losing them. Merged rather than assigned, because new
 * events may have arrived for the same keys in the meantime.
 */
async function flush() {
  if (buffer.size === 0) return { written: 0 };

  const pending = buffer;
  buffer = new Map();

  const rows = [...pending.entries()].map(([key, count]) => {
    const [pharmacyId, kind, day] = key.split('|');
    return { pharmacy_id: pharmacyId, kind, day, count };
  });

  try {
    const db = getSql();
    // One statement for the whole buffer. `excluded.count` is the value this
    // insert tried to write, so the increment adds a flush's worth to
    // whatever is already stored for that day.
    await db`
      insert into website_events ${db(rows, 'pharmacy_id', 'kind', 'day', 'count')}
      on conflict (pharmacy_id, kind, day)
      do update set count = website_events.count + excluded.count
    `;
    return { written: rows.length };
  } catch (err) {
    for (const [key, count] of pending) {
      buffer.set(key, (buffer.get(key) || 0) + count);
    }
    console.error(JSON.stringify({
      level: 'error',
      msg: 'website analytics flush failed — counts kept for the next attempt',
      pending: pending.size,
      error: err.message,
    }));
    return { written: 0, retained: pending.size };
  }
}

function startFlushing() {
  if (timer) return;
  timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
  // unref so a pending flush timer cannot hold the process open — this is a
  // counter, not work anybody is waiting for.
  timer.unref?.();
}

async function stopFlushing() {
  if (timer) { clearInterval(timer); timer = null; }
  // One last write on the way down, so a deliberate restart does not throw
  // away the interval it happened to land in.
  await flush().catch(() => {});
}

/**
 * A pharmacy's numbers, for the dashboard.
 *
 * Returns daily rows plus totals and a conversion rate. The rate is
 * conversions over views, which is the honest reading of "of the people who
 * saw your website, how many did something" — and it is null rather than 0
 * when there are no views, because 0% implies a measurement that did not
 * happen.
 */
async function summary(pharmacyId, { days = 30 } = {}) {
  assertPharmacyId(pharmacyId);
  const window = Math.min(Math.max(Number(days) || 30, 1), 365);

  const db = getSql();
  const rows = await db`
    select kind, day, count
      from website_events
     where pharmacy_id = ${pharmacyId}
       and day >= current_date - ${window}::integer
     order by day
  `;

  const totals = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const byDay = new Map();
  for (const row of rows) {
    totals[row.kind] += row.count;
    const day = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day);
    if (!byDay.has(day)) byDay.set(day, Object.fromEntries(KINDS.map((k) => [k, 0])));
    byDay.get(day)[row.kind] += row.count;
  }

  const conversions = CONVERSIONS.reduce((sum, k) => sum + totals[k], 0);

  return {
    days: window,
    totals,
    conversions,
    conversionRate: totals.view > 0 ? conversions / totals.view : null,
    daily: [...byDay.entries()].map(([day, counts]) => ({ day, ...counts })),
  };
}

module.exports = {
  KINDS,
  CONVERSIONS,
  FLUSH_INTERVAL_MS,
  record,
  flush,
  startFlushing,
  stopFlushing,
  summary,
  /** Tests only — inspect and reset the buffer without a database. */
  _buffer: () => buffer,
  _reset: () => { buffer = new Map(); },
};
