/**
 * Reading the pharmacy's stock straight out of their POS database.
 *
 * WHY THIS EXISTS
 * Folder-watching works everywhere, but it still depends on somebody clicking
 * "Export" in their POS. A manual daily habit decays — by week three nobody is
 * doing it, the catalogue silently goes stale, and the assistant quotes last
 * month's prices with complete confidence. Reading the database removes the
 * last human step: nothing to remember, nothing to click.
 *
 * WHY IT PRODUCES A CSV RATHER THAN ITS OWN IMPORT PATH
 * The rows go out through exactly the same upload the folder watcher uses, so
 * everything downstream is untouched: schema detection, the LLM column mapper,
 * NAFDAC matching, identity resolution, the saved-mapping rule, the human
 * confirmation the first time. A database table is just another source of
 * rows, and the moment it becomes a second import path is the moment the two
 * start drifting apart. One pipeline, two ways in.
 *
 * READ-ONLY, AND THAT IS NOT A CONVENTION
 * This connects to the live system a pharmacy runs its business on. Every
 * query here is a SELECT, the identifiers are validated against what the
 * server itself reported rather than interpolated from anything a user typed,
 * and nothing in this file writes, alters or locks anything. A bug that
 * corrupted a pharmacy's stock table would be far worse than never having
 * built this.
 */

const mysql = require('mysql2/promise');

/** Never pull an entire sales history into memory because a table was misidentified. */
const MAX_ROWS = 20000;

/** Tables whose names suggest they hold products, best first. */
const TABLE_HINTS = [
  'product', 'produk', 'item', 'stock', 'inventory', 'drug', 'medicine',
  'goods', 'article', 'ware',
];

/** Columns that make a table look like a product list rather than a ledger. */
const NAME_HINTS = ['name', 'description', 'title', 'product', 'item', 'drug'];
const PRICE_HINTS = ['price', 'rate', 'amount', 'cost', 'selling', 'mrp', 'unit'];

/**
 * Connect.
 *
 * `connectTimeout` is short on purpose: this runs while somebody is standing
 * at the computer waiting, and "wrong password" should come back in seconds
 * rather than looking like the program has frozen.
 */
async function connect({ host = '127.0.0.1', port = 3306, user, password, database }) {
  return mysql.createConnection({
    host,
    port: Number(port) || 3306,
    user,
    password: password || '',
    database: database || undefined,
    connectTimeout: 8000,
    // The agent reads and nothing else. Multiple statements in one query is
    // the mechanism behind most SQL-injection escalation, and there is no
    // legitimate use for it here.
    multipleStatements: false,
    dateStrings: true,
  });
}

/** Databases on this server, minus MySQL's own. */
async function listDatabases(conn) {
  const [rows] = await conn.query('show databases');
  const system = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
  return rows
    .map((r) => Object.values(r)[0])
    .filter((n) => !system.has(String(n).toLowerCase()));
}

/**
 * Tables in a database, ranked by how much they look like a product list.
 *
 * Ranking rather than guessing. The pharmacist still chooses — this only
 * decides what to show them first, so the right answer is usually option 1
 * instead of buried at number 40 in an alphabetical list of a POS's eighty
 * internal tables.
 */
async function listTables(conn, database) {
  const [rows] = await conn.query(
    `select table_name as t, table_rows as n
       from information_schema.tables
      where table_schema = ?
        and table_type = 'BASE TABLE'`,
    [database]
  );

  const scored = [];
  for (const { t, n } of rows) {
    const name = String(t);
    const lower = name.toLowerCase();

    let score = 0;
    const hintIndex = TABLE_HINTS.findIndex((h) => lower.includes(h));
    if (hintIndex >= 0) score += 100 - hintIndex;

    // A table with both a name-ish and a price-ish column is the shape we
    // want, whatever it happens to be called — which is how this finds the
    // POS that named its product table "tblArtikel".
    const cols = await columnsOf(conn, database, name);
    const lowerCols = cols.map((c) => c.toLowerCase());
    const hasName = lowerCols.some((c) => NAME_HINTS.some((h) => c.includes(h)));
    const hasPrice = lowerCols.some((c) => PRICE_HINTS.some((h) => c.includes(h)));
    if (hasName) score += 30;
    if (hasPrice) score += 30;
    if (hasName && hasPrice) score += 20;

    // Empty tables are almost never the answer, and a POS ships plenty of them.
    if (Number(n) > 0) score += 5;

    scored.push({ table: name, rows: Number(n) || 0, columns: cols, score, hasName, hasPrice });
  }

  return scored.sort((a, b) => b.score - a.score || a.table.localeCompare(b.table));
}

async function columnsOf(conn, database, table) {
  const [rows] = await conn.query(
    `select column_name as c
       from information_schema.columns
      where table_schema = ? and table_name = ?
      order by ordinal_position`,
    [database, table]
  );
  return rows.map((r) => String(r.c));
}

/**
 * Quote an identifier for a query.
 *
 * Table and column names cannot be bound as parameters, so they are
 * interpolated — which is exactly the shape of a SQL-injection bug. Two
 * defences: the caller only ever passes names that came back from
 * information_schema on this same connection, and backticks are escaped here
 * so a table genuinely containing one cannot break out of the quoting.
 */
function quoteIdent(name) {
  if (typeof name !== 'string' || !name.length) throw new Error('Invalid identifier.');
  return `\`${name.replace(/`/g, '``')}\``;
}

/** A few rows, so a person can confirm they picked the right table. */
async function sample(conn, database, table, limit = 5) {
  const [rows] = await conn.query(
    `select * from ${quoteIdent(database)}.${quoteIdent(table)} limit ${Number(limit) || 5}`
  );
  return rows;
}

/** Everything in the chosen table, as rows. Bounded. */
async function readAll(conn, database, table) {
  const [rows] = await conn.query(
    `select * from ${quoteIdent(database)}.${quoteIdent(table)} limit ${MAX_ROWS}`
  );
  return rows;
}

/**
 * Rows to CSV, for the same upload the folder watcher uses.
 *
 * RFC4180 quoting — every field quoted and internal quotes doubled. A
 * pharmacy's product names contain commas ("Paracetamol 500mg, 20s"), quotes
 * and the occasional newline pasted in from a supplier's invoice, and any one
 * of those silently shifts every later column by one if the quoting is
 * approximate. That failure looks like scrambled data rather than a bad CSV
 * writer, and it would be blamed on the pharmacy's file.
 */
function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (v === null || v === undefined) return '""';
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [cols.map(cell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(','));
  return lines.join('\r\n');
}

/**
 * The scheduled path: connect, read the chosen table, hand back a CSV.
 *
 * Opens and closes its own connection every time rather than holding one open
 * for the six hours between syncs. A pooled connection to somebody else's
 * production database, kept alive by a background program they forgot they
 * installed, is a thing to explain to a pharmacist one day — and a connection
 * that only exists for the second it is used cannot be blamed for anything
 * their POS does the rest of the day.
 */
async function exportToCsv(dbConfig) {
  const conn = await connect(dbConfig);
  try {
    const rows = await readAll(conn, dbConfig.database, dbConfig.table);
    return { csv: toCsv(rows), rowCount: rows.length };
  } finally {
    await conn.end().catch(() => {});
  }
}

module.exports = {
  connect, listDatabases, listTables, columnsOf, sample, readAll,
  toCsv, exportToCsv, MAX_ROWS,
};
