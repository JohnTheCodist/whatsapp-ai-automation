/**
 * Pipeline Validator — Phase 5: Uses the pipeline's own column mapping
 * for accurate before/after comparison.
 *
 * KEY FIX: computeRawMetrics no longer does its own heuristic column
 * detection. It uses the same mapping that normalize() resolved, so
 * the comparison is against what the pipeline actually processed.
 *
 * Also added: revenue reconciliation check — flags rows where
 * revenue ≠ selling_price × quantity (possible data entry error).
 */

const { parseCurrency } = require('./dataCleaner');

/**
 * Compute raw metrics using the PIPELINE'S mapping — not its own heuristic.
 * This ensures we're comparing the same columns the pipeline actually used.
 */
function computeRawMetrics(rawRows, pipelineResult) {
  if (!rawRows || rawRows.length === 0) {
    return { revenue: 0, cost: 0, quantity: 0, rowCount: 0, hasCost: false };
  }

  const mapping = pipelineResult?.mapping || {};
  let totalRevenue = 0;
  let totalCost = 0;
  let totalQty = 0;
  let hasCost = false;
  let productsSeen = 0;

  const revenueHeader = mapping.revenue?.rawHeader;
  const sellingPriceHeader = mapping.selling_price?.rawHeader;
  const costHeader = mapping.cost_price?.rawHeader;
  const qtyHeader = mapping.quantity?.rawHeader;
  const discountHeader = mapping.discount?.rawHeader;
  const productHeader = mapping.product_name?.rawHeader;

  for (const row of rawRows) {
    // Revenue: use the mapped revenue column, or compute from selling_price × qty
    let rowRevenue = null;
    if (revenueHeader && row[revenueHeader] != null) {
      rowRevenue = parseCurrency(row[revenueHeader]);
    }
    if (rowRevenue == null && sellingPriceHeader && row[sellingPriceHeader] != null) {
      const sp = parseCurrency(row[sellingPriceHeader]);
      const qty = qtyHeader ? parseCurrency(row[qtyHeader]) : 1;
      if (sp != null) rowRevenue = sp * (qty || 1);
    }
    if (rowRevenue == null || rowRevenue < 0) rowRevenue = 0;

    // Subtract discount if available
    if (discountHeader && row[discountHeader] != null) {
      const d = parseCurrency(row[discountHeader]);
      if (d != null && d > 0) rowRevenue = Math.max(0, rowRevenue - d);
    }

    // Cost
    let rowCost = null;
    if (costHeader && row[costHeader] != null) {
      rowCost = parseCurrency(row[costHeader]);
    }

    // Quantity
    let rowQty = 0;
    if (qtyHeader && row[qtyHeader] != null) {
      const parsed = parseCurrency(row[qtyHeader]);
      if (parsed != null && parsed > 0) rowQty = parsed;
    }
    if (rowQty === 0 && rowRevenue > 0) rowQty = 1;

    // Product name (for counting recognized products)
    if (productHeader && row[productHeader] && String(row[productHeader]).trim()) {
      productsSeen++;
    }

    totalRevenue += rowRevenue;
    totalQty += rowQty;
    if (rowCost != null && rowCost > 0) {
      const costIsTotal = pipelineResult?.costMode?.costIsTotal;
      totalCost += costIsTotal === true ? rowCost : rowCost * rowQty;
      hasCost = true;
    }
  }

  return {
    revenue: Math.round(totalRevenue * 100) / 100,
    cost: hasCost ? Math.round(totalCost * 100) / 100 : null,
    profit: hasCost ? Math.round((totalRevenue - totalCost) * 100) / 100 : null,
    quantity: Math.round(totalQty * 100) / 100,
    rowCount: rawRows.length,
    productsWithNames: productsSeen,
    hasCost,
    usedColumns: {
      revenue: revenueHeader || 'computed from selling_price × qty',
      selling_price: sellingPriceHeader || 'not available',
      cost_price: costHeader || 'not available',
      quantity: qtyHeader || 'defaulted to 1',
      product_name: productHeader || 'not available',
    },
  };
}

/**
 * Check for revenue reconciliation issues across records.
 * Flags rows where revenue ≠ selling_price × quantity (indicating
 * either dirty data or rows where Amount is a total, not per-unit).
 */
function checkRevenueReconciliation(normalizedRecords) {
  const flagged = [];
  let mismatchCount = 0;
  let totalVariance = 0;

  for (let i = 0; i < normalizedRecords.length; i++) {
    const rec = normalizedRecords[i];
    const revenue = rec.revenue != null ? rec.revenue : 0;
    const sp = rec.selling_price != null ? rec.selling_price : 0;
    const qty = rec.quantity != null ? rec.quantity : 0;

    if (sp > 0 && qty > 0 && revenue > 0) {
      const expected = sp * qty;
      const variance = revenue - expected;
      const variancePct = expected > 0 ? Math.abs(variance / expected) * 100 : 0;

      if (variancePct > 20) {
        mismatchCount++;
        totalVariance += variance;
        flagged.push({
          row: i + 1,
          product: rec.product_name || 'Unknown',
          revenue,
          sellingPrice: sp,
          quantity: qty,
          expected: Math.round(expected * 100) / 100,
          variance: Math.round(variance * 100) / 100,
          variancePct: Math.round(variancePct * 100) / 100,
        });
      }
    }
  }

  return {
    totalRows: normalizedRecords.length,
    rowsChecked: normalizedRecords.length,
    mismatches: mismatchCount,
    mismatchRate: normalizedRecords.length > 0
      ? Math.round((mismatchCount / normalizedRecords.length) * 100)
      : 0,
    totalVariance: Math.round(totalVariance * 100) / 100,
    flagged,
    status: mismatchCount === 0 ? 'CLEAN'
      : mismatchCount / normalizedRecords.length < 0.1 ? 'MINOR_ISSUES'
      : 'DATA_QUALITY_PROBLEM',
  };
}

/**
 * Generate a full validation report.
 */
function validate(rawRows, pipelineResult, analyticsResult) {
  const raw = computeRawMetrics(rawRows, pipelineResult);
  const clean = analyticsResult?.metrics || {};
  const stats = pipelineResult?.cleaningStats || {};

  // Compare
  const revenueDiff = Math.round(((clean.totalRevenue || 0) - raw.revenue) * 100) / 100;
  const quantityDiff = Math.round(((clean.totalQuantitySold || 0) - raw.quantity) * 100) / 100;
  const rowsDropped = (stats.inputRows || raw.rowCount) - (stats.outputRows || (clean.recordCount || 0));

  // What was removed
  const removals = [];
  if (stats.emptyRemoved > 0) removals.push(`Empty rows: ${stats.emptyRemoved}`);
  if (stats.headersRemoved > 0) removals.push(`Duplicate headers: ${stats.headersRemoved}`);
  if (stats.duplicatesRemoved > 0) removals.push(`Duplicate transactions: ${stats.duplicatesRemoved}`);

  // Assessment
  let assessment = 'PASS';
  const issues = [];

  // Revenue lost without explanation
  if (revenueDiff < -0.01 && (stats.duplicatesRemoved || 0) === 0 && (stats.emptyRemoved || 0) === 0) {
    issues.push(`Revenue decreased by ₦${Math.abs(revenueDiff).toLocaleString()} but no removable rows were identified. Check column mapping.`);
    assessment = 'WARNING';
  }

  // Non-duplicate rows dropped with revenue loss
  const nonDupDrops = rowsDropped - (stats.duplicatesRemoved || 0);
  if (nonDupDrops > 0 && Math.abs(revenueDiff) > 0.01) {
    issues.push(`${nonDupDrops} non-duplicate rows were dropped, causing ₦${Math.abs(revenueDiff).toLocaleString()} revenue loss.`);
    assessment = 'WARNING';
  }

  // Quantity mismatch
  if (Math.abs(quantityDiff) > 0.5 && Math.abs(quantityDiff) !== rowsDropped) {
    issues.push(`Quantity changed by ${quantityDiff} units — this is more than just removed rows.`);
    if (assessment === 'PASS') assessment = 'WARNING';
  }

  // Revenue reconciliation check
  const reconciliation = checkRevenueReconciliation(pipelineResult?.normalized || []);

  if (reconciliation.status === 'DATA_QUALITY_PROBLEM') {
    issues.push(`${reconciliation.mismatches} of ${reconciliation.totalRows} rows have revenue-breaking inconsistencies (revenue ≠ selling_price × qty by >20%). Total variance: ₦${reconciliation.totalVariance.toLocaleString()}.`);
    assessment = 'WARNING';
  } else if (reconciliation.status === 'MINOR_ISSUES') {
    issues.push(`${reconciliation.mismatches} rows have minor revenue discrepancies. Check for data entry errors.`);
  }

  return {
    assessment,
    stage: {
      raw: {
        revenue: raw.revenue,
        profit: raw.profit,
        quantity: raw.quantity,
        rowCount: raw.rowCount,
      },
      cleaned: {
        revenue: clean.totalRevenue || 0,
        profit: clean.grossProfit,
        quantity: clean.totalQuantitySold || 0,
        rowCount: clean.recordCount || 0,
      },
      delta: {
        revenue: revenueDiff,
        quantity: quantityDiff,
        rowsDropped,
      },
    },
    rawMetricsComputedUsing: raw.usedColumns,
    removals: removals.length > 0 ? removals : ['None'],
    issues: issues.length > 0 ? issues : ['None'],
    reconciliation,
    pipelineStages: {
      inputRows: stats.inputRows || raw.rowCount,
      afterCleaning: stats.outputRows || raw.rowCount,
      afterDedup: clean.recordCount || 0,
      emptyRowsRemoved: stats.emptyRemoved || 0,
      headersRemoved: stats.headersRemoved || 0,
      duplicatesRemoved: stats.duplicatesRemoved || 0,
    },
  };
}

module.exports = { validate, computeRawMetrics, checkRevenueReconciliation };
