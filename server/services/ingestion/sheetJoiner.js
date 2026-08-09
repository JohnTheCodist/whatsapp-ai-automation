/**
 * SheetJoiner — detects dimension tables in multi-sheet Excel workbooks
 * and automatically joins them into the fact table.
 *
 * Supports dimension sheets named:
 *   DimProduct, DimProducts, Product, Products, DimPharmacy, DimPharmacies,
 *   DimDate, DimDates, DimCalendar, Dates, Calendar, DimCustomer, Customers,
 *   DimBranch, Branches, DimEmployee, Employees
 *
 * Detection is case-insensitive and uses common key columns to auto-join.
 */

// Known dimension sheet name patterns
const DIM_PATTERNS = {
  product:  /^(dim[-_]?)?products?$/i,
  pharmacy: /^(dim[-_]?)?pharmac(y|ies)$/i,
  date:     /^(dim[-_]?)?(date|dates|calendar)s?$/i,
  customer: /^(dim[-_]?)?customers?$/i,
  branch:   /^(dim[-_]?)?branch(es)?$/i,
  employee: /^(dim[-_]?)?employees?$/i,
};

// Known key columns for joins (checked in order — first match wins)
const KEY_COLUMNS = {
  product:  ['productid', 'product_id', 'product code', 'drugid', 'drug_id'],
  pharmacy: ['pharmacyid', 'pharmacy_id', 'pharmacyid', 'storeid', 'branchid'],
  date:     ['datekey', 'date_key', 'dateid', 'date_id'],
  customer: ['customerid', 'customer_id'],
  branch:   ['branchid', 'branch_id', 'storeid', 'store_id'],
  employee: ['employeeid', 'employee_id'],
};

// Column names on a dimension table that should replace the fact key
const NAME_COLUMNS = {
  product:  ['productname', 'product_name', 'product', 'name', 'drugname', 'drug_name', 'description'],
  pharmacy: ['pharmacyname', 'pharmacy_name', 'storename', 'store_name', 'name', 'branch_name'],
};

/**
 * Classify a sheet by its name. Returns the dimension type or 'fact'.
 */
function classifySheet(sheetName) {
  const n = String(sheetName).trim();
  for (const [type, pattern] of Object.entries(DIM_PATTERNS)) {
    if (pattern.test(n)) return type;
  }
  return 'fact';
}

/**
 * Find the join key column that exists in the fact table.
 */
function findJoinKey(factHeaders, dimensionType) {
  for (const candidate of KEY_COLUMNS[dimensionType] || []) {
    if (factHeaders.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * Find a matching key column in the dimension table.
 */
function findDimKey(dimHeaders, dimensionType) {
  for (const candidate of KEY_COLUMNS[dimensionType] || []) {
    if (dimHeaders.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * Find a column in the dimension table that contains human-readable names.
 */
function findNameColumn(dimHeaders, dimensionType) {
  for (const candidate of NAME_COLUMNS[dimensionType] || []) {
    if (dimHeaders.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * Build a lookup map from the dimension table.
 * @returns {Map} keyValue → row object
 */
function buildLookup(dimRows, dimKeyColumn) {
  const map = new Map();
  for (const row of dimRows) {
    const key = String(row[dimKeyColumn]).trim();
    map.set(key, row);
  }
  return map;
}

/**
 * Normalize a single header string for case-insensitive matching.
 */
function normalizeHeaderForLookup(h) {
  return String(h).toLowerCase().trim().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, '');
}

/**
 * Normalize headers to lowercase for case-insensitive matching.
 */
function normalizeHeaders(headers) {
  return headers.map(normalizeHeaderForLookup);
}

/**
 * Join dimension tables into the fact table.
 *
 * @param {object} sheets — { SheetName: [rows], ... } from xlsx parse
 * @returns {{ rows: object[], meta: object }}
 *   rows: joined fact rows with product names, pharmacy names, parsed dates
 *   meta: info about what was joined
 */
function joinSheets(sheets) {
  const sheetNames = Object.keys(sheets);
  if (sheetNames.length === 0) return { rows: [], meta: { joined: [] } };

  const meta = { joined: [], sheetsFound: sheetNames.length };

  // Classify each sheet
  let factSheetName = null;
  const dims = {}; // { product: { rows, dimKeyColumn, nameColumn }, ... }

  for (const name of sheetNames) {
    const type = classifySheet(name);
    if (type === 'fact') {
      if (!factSheetName) factSheetName = name; // use first fact sheet
    } else {
      dims[type] = { name, rows: sheets[name], dimKeyColumn: null, nameColumn: null };
    }
  }

  // If no fact sheet classified, treat the first sheet as fact
  if (!factSheetName && sheetNames.length > 0) {
    factSheetName = sheetNames[0];
  }

  const factRows = sheets[factSheetName] || [];
  if (factRows.length === 0) return { rows: [], meta };

  const rawHeaders = Object.keys(factRows[0]);
  const factHeaders = normalizeHeaders(rawHeaders);

  // For each dimension, find join keys and build lookups
  const lookups = {};

  for (const [dimType, dimInfo] of Object.entries(dims)) {
    if (dimInfo.rows.length === 0) continue;

    const dimHeaders = normalizeHeaders(Object.keys(dimInfo.rows[0]));

    const factKey = findJoinKey(factHeaders, dimType);
    const dimKey = findDimKey(dimHeaders, dimType);

    if (factKey && dimKey) {
      const nameCol = findNameColumn(dimHeaders, dimType);

      // Map normalized header back to the raw header (for both fact and dim tables)
      const dimRawHeaders = Object.keys(dimInfo.rows[0]);
      const dimHeaderMap = {};
      dimRawHeaders.forEach((h) => { dimHeaderMap[normalizeHeaderForLookup(h)] = h; });
      const dimRawKey = dimHeaderMap[dimKey];

      const factRawHeaders = Object.keys(factRows[0]);
      const factHeaderMap = {};
      factRawHeaders.forEach((h) => { factHeaderMap[normalizeHeaderForLookup(h)] = h; });
      const factRawKey = factHeaderMap[factKey];

      // Map name column the same way
      const nameRawCol = nameCol ? dimHeaderMap[nameCol] : null;

      lookups[dimType] = {
        map: buildLookup(dimInfo.rows, dimRawKey),
        factRawKey,
        nameColumn: nameRawCol,
        dimRows: dimInfo.rows,
        dimKeyColumn: dimRawKey,
      };
    }
  }

  // Join: for each fact row, look up dimensions and enrich
  const joined = factRows.map((row) => {
    const enriched = { ...row };

    for (const [dimType, lookup] of Object.entries(lookups)) {
      const factKeyVal = String(row[lookup.factRawKey]).trim();
      const dimRow = lookup.map.get(factKeyVal);

      if (dimRow && lookup.nameColumn) {
        // Add product name / pharmacy name
        const suffix = dimType === 'product' ? 'Name' : (dimType === 'pharmacy' ? 'Name' : '');
        enriched[`_${dimType}${suffix}`] = dimRow[lookup.nameColumn];
      }

      if (dimRow) {
        // Add all non-key dimension columns as enrichments
        for (const [col, val] of Object.entries(dimRow)) {
          if (col === lookup.dimKeyColumn || col === lookup.nameColumn) continue;
          enriched[`_${dimType}_${col}`] = val;
        }
      }
    }

    return enriched;
  });

  meta.joined = Object.keys(lookups);
  meta.dimensionsFound = Object.keys(dims).length;
  meta.rowsBeforeJoin = factRows.length;
  meta.rowsAfterJoin = joined.length;

  return { rows: joined, meta };
}

module.exports = { joinSheets, classifySheet };
