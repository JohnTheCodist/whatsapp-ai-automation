/**
 * SterlingRx Advisors — Master Semantic Registry (Phase 1)
 *
 * Canonical semantic fields organized by business domain.
 * Every uploaded column maps to one semantic field or is classified as IGNORED.
 *
 * Domains:
 *   product_identity — fields that describe what was sold
 *   sales            — transaction-level sales data
 *   inventory        — stock level data
 *   expiry           — expiration / batch tracking
 *   supplier         — supply chain
 *   organization     — branch, staff, channel
 *   metadata         — system-generated identifiers
 *
 * Classifications:
 *   mapped   — core business field, actively used in analytics
 *   optional — enriches analysis but never blocks it
 *   metadata — system-managed (not user-mappable)
 *
 * Fields classified as IGNORED are columns that match NO semantic field
 * and contain irrelevant data (notes, phone numbers, shelf images, etc.).
 */

// =========================================================================
// Master Semantic Registry
// =========================================================================

const SEMANTIC_REGISTRY = {

  // ---- Product Identity ------------------------------------------------

  PRODUCT: {
    canonical: 'product_name',
    domain: 'product_identity',
    classification: 'mapped',
    description: 'Full product / medicine name. Can be composed from GENERIC_NAME, BRAND_NAME, STRENGTH, and DOSAGE_FORM if not present as a single column.',
    isCompositeTarget: true,
    synonyms: [
      'product', 'product name', 'product_name', 'medicine', 'drug', 'item',
      'item name', 'item_name', 'drug description', 'stock name', 'description',
      'name', 'drug name', 'drug_name', 'product description', 'product_description',
      'item description', 'item_description', 'medicine name', 'medicine_name',
      'pharmaceutical', 'stock', 'drug brand', 'formulation', 'active ingredient',
    ],
  },

  GENERIC_NAME: {
    canonical: 'generic_name',
    domain: 'product_identity',
    classification: 'mapped',
    description: 'INN / active pharmaceutical ingredient / generic compound name',
    synonyms: [
      'generic', 'generic name', 'generic_name', 'inn',
      'international nonproprietary name', 'active ingredient', 'active_ingredient',
      'drug substance', 'drug_substance', 'api', 'compound', 'molecule',
      'chemical name', 'chemical_name', 'scientific name',
    ],
  },

  BRAND_NAME: {
    canonical: 'brand',
    domain: 'product_identity',
    classification: 'mapped',
    description: 'Commercial brand or trade name. Distinct from the generic/chemical name.',
    synonyms: [
      'brand', 'brand name', 'brand_name', 'product brand',
      'trademark', 'label', 'brand label', 'brand_label',
      'commercial name', 'trade name', 'trade_name',
    ],
  },

  STRENGTH: {
    canonical: 'strength',
    domain: 'product_identity',
    classification: 'mapped',
    description: 'Dosage strength (e.g., 500mg, 10mg/ml, 5%). Numeric + unit pattern.',
    synonyms: [
      'strength', 'dose', 'dosage', 'dosage strength', 'dosage_strength',
      'concentration', 'potency', 'drug strength', 'drug_strength',
      'active strength', 'active_strength', 'dose strength', 'dose_strength',
      'strength mg', 'strength_mg',
    ],
  },

  DOSAGE_FORM: {
    canonical: 'dosage_form',
    domain: 'product_identity',
    classification: 'mapped',
    description: 'Physical form of the medicine (tablet, capsule, syrup, injection, cream, etc.)',
    synonyms: [
      'dosage form', 'dosage_form', 'form', 'drug form', 'drug_form',
      'formulation', 'dosage type', 'dosage_type', 'drug type', 'drug_type',
      'presentation', 'form type', 'form_type', 'preparation',
      'dosage format', 'dosage_format', 'pharmaceutical form', 'pharmaceutical_form',
    ],
  },

  PACK_SIZE: {
    canonical: 'pack_size',
    domain: 'product_identity',
    classification: 'mapped',
    description: 'Number of units per pack (e.g., 10, 28, 100). Integer value.',
    synonyms: [
      'pack size', 'pack_size', 'package size', 'package_size',
      'pack', 'package', 'pack qty', 'pack_quantity',
      'pack quantity', 'packaging', 'units per pack', 'units_per_pack',
      'pack contents', 'pack_contents', 'tablets per pack',
    ],
  },

  MANUFACTURER: {
    canonical: 'manufacturer',
    domain: 'product_identity',
    classification: 'mapped',
    description: 'Company that manufactured or produced the product',
    synonyms: [
      'manufacturer', 'manufacturer name', 'manufacturer_name', 'made by',
      'made_by', 'producer', 'mfr', 'manufactured by', 'manufactured_by',
      'company', 'pharma company',
    ],
  },

  // Category / classification (informational product grouping)
  CATEGORY: {
    canonical: 'category',
    domain: 'product_identity',
    classification: 'optional',
    description: 'Therapeutic class or product category (e.g., Analgesic, Antibiotic)',
    synonyms: [
      'category', 'product category', 'product_category', 'class',
      'product class', 'product_class', 'therapeutic class', 'therapeutic_class',
      'drug class', 'drug_class', 'type', 'product type', 'product_type',
      'pharmacological class',
    ],
  },

  SUBCATEGORY: {
    canonical: 'subcategory',
    domain: 'product_identity',
    classification: 'optional',
    description: 'Finer product segment within a category',
    synonyms: [
      'subcategory', 'sub category', 'sub_category', 'sub-category',
      'product subcategory', 'product_subcategory', 'subclass', 'sub class',
      'segment', 'product segment',
    ],
  },

  // ---- Sales ------------------------------------------------------------

  QUANTITY_SOLD: {
    canonical: 'quantity',
    domain: 'sales',
    classification: 'mapped',
    description: 'Number of units sold or dispensed. Integer values between 1 and 100,000.',
    synonyms: [
      'qty', 'quantity', 'qty sold', 'units sold', 'units_sold',
      'dispensed qty', 'disp qty', 'volume', 'pieces', 'units', 'nos',
      'no', 'count', 'pq', 'pack qty', 'pack quantity', 'pack_quantity',
      'dispensing quantity', 'dispensing_quantity', 'item count', 'item_count',
      'total units', 'total_units', 'sold quantity', 'sold_quantity',
      'tablets', 'capsules', 'bottles', 'strips',
    ],
  },

  SELLING_PRICE: {
    canonical: 'selling_price',
    domain: 'sales',
    classification: 'mapped',
    description: 'Unit selling price / retail price per item',
    synonyms: [
      'selling price', 'selling_price', 'retail price', 'retail_price',
      'unit price', 'unit_price', 'price', 'sellingprice', 'retail amount',
      'retail price per unit', 'sp', 'selling', 'rate', 'pack price',
      'pack_price', 'listing price', 'listing_price', 'srp', 'mrp',
      'customer price', 'customer_price', 'sale price', 'sale_price',
      'marked price', 'marked_price', 'sellingcost', 'selling cost',
      'retail cost', 'retailcost', 'sales price', 'unit selling price',
      'unit sellingprice',
    ],
  },

  COST_PRICE: {
    canonical: 'cost_price',
    domain: 'sales',
    classification: 'mapped',
    description: 'Unit cost / purchase price from supplier',
    synonyms: [
      'cost', 'cost price', 'cost_price', 'purchase price', 'purchase_price',
      'buying price', 'buying_price', 'unit cost', 'unit_cost', 'landed cost',
      'landed_cost', 'cp', 'costprice', 'purchase cost', 'purchase_cost',
      'unitcost', 'acquisition cost', 'acquisition_cost', 'wholesale cost',
      'wholesale_cost', 'base cost', 'base_cost', 'supplier price',
      'supplier_price', 'buy price', 'buy_price', 'purchasecost',
      'supplier cost', 'suppliercost', 'buying cost', 'buyingcost',
    ],
  },

  REVENUE: {
    canonical: 'revenue',
    domain: 'sales',
    classification: 'mapped',
    description: 'Total transaction amount (price x quantity, or invoice total)',
    synonyms: [
      'amount', 'sales amount', 'sales_amount', 'revenue', 'gross sales',
      'gross_sales', 'sales value', 'sales_value', 'invoice total',
      'invoice_total', 'invoice amount', 'invoice_amount', 'total amount',
      'total_amount', 'transaction amount', 'transaction_amount', 'total',
      'sales', 'total sales', 'total_sales', 'net sales', 'net_sales',
      'grand total', 'grand_total', 'sum', 'turnover',
    ],
  },

  TRANSACTION_DATE: {
    canonical: 'transaction_date',
    domain: 'sales',
    classification: 'mapped',
    description: 'Transaction / sale date. Date or Excel serial number.',
    synonyms: [
      'date', 'month', 'period', 'day', 'transaction date', 'transaction_date',
      'sale date', 'sale_date', 'order date', 'order_date', 'invoice date',
      'invoice_date', 'disp date', 'dispensation date', 'dispensing date', 'dispensing_date',
      'billing date', 'billing_date', 'entry date', 'entry_date', 'created date',
      'created_date', 'posting date', 'posting_date', 'sold date', 'sold_date',
      'date of sale', 'date_of_sale',
    ],
  },

  PAYMENT_METHOD: {
    canonical: 'payment_method',
    domain: 'sales',
    classification: 'optional',
    description: 'How the customer paid (Cash, Transfer, POS, Insurance, Credit)',
    synonyms: [
      'payment method', 'payment_method', 'payment type', 'payment_type',
      'mode of payment', 'mode_of_payment', 'payment mode', 'payment_mode',
      'pay type', 'pay_type', 'pay method', 'pay_method', 'transaction type',
      'transaction_type', 'tender', 'tender type', 'tender_type', 'payment',
      'type',
    ],
  },

  DISCOUNT: {
    canonical: 'discount',
    domain: 'sales',
    classification: 'optional',
    description: 'Discount amount or percentage applied to the sale',
    synonyms: [
      'discount', 'discount amount', 'discount_amount', 'disc',
      'discount pct', 'discount_percent', 'discount_rate', 'deduction',
      'rebate', 'price off', 'price_off', 'reduction', 'markdown',
      'concession', 'allowance', 'discount value', 'discount_value',
    ],
  },

  TAX: {
    canonical: 'tax',
    domain: 'sales',
    classification: 'optional',
    description: 'Tax or VAT amount',
    synonyms: [
      'tax', 'tax amount', 'tax_amount', 'vat', 'vat amount', 'vat_amount',
      'value added tax', 'value_added_tax', 'sales tax', 'sales_tax', 'gst',
      'tax rate', 'tax_rate', 'levy', 'duty', 'tax value', 'tax_value',
    ],
  },

  PROFIT: {
    canonical: 'profit',
    domain: 'sales',
    classification: 'optional',
    description: 'Profit amount per transaction row',
    synonyms: [
      'profit', 'profit amount', 'profit_amount', 'net profit', 'net_profit',
      'gross profit', 'gross_profit', 'profit naira', 'income', 'earnings',
      'gain', 'net income', 'net_income', 'profit value', 'profit_value',
    ],
  },

  MARGIN: {
    canonical: 'margin',
    domain: 'sales',
    classification: 'optional',
    description: 'Profit margin percentage per row',
    synonyms: [
      'margin', 'margin pct', 'margin percent', 'margin_percent',
      'margin percentage', 'margin_percentage', 'profit margin',
      'profit_margin', 'gross margin', 'gross_margin', 'net margin',
      'net_margin', 'margin rate', 'margin_rate', 'margin value', 'margin_value',
    ],
  },

  // ---- Inventory --------------------------------------------------------

  CURRENT_STOCK: {
    canonical: 'current_stock',
    domain: 'inventory',
    classification: 'mapped',
    description: 'Current stock level / quantity on hand',
    synonyms: [
      'stock', 'stock level', 'stock_level', 'closing stock', 'closing_stock',
      'current stock', 'current_stock', 'on hand', 'on_hand', 'available',
      'available stock', 'available_stock', 'stock qty', 'stock_quantity',
      'balance', 'stock balance', 'stock_balance', 'closing', 'closing qty',
      'physical stock', 'physical_stock', 'inventory', 'inventory level',
      'inventory_level',
    ],
  },

  REORDER_LEVEL: {
    canonical: 'reorder_level',
    domain: 'inventory',
    classification: 'optional',
    description: 'Reorder point / minimum stock before reordering',
    synonyms: [
      'reorder level', 'reorder_level', 'reorder point', 'reorder_point',
      're order', 'reorder', 're-order', 're order level',
      'minimum stock', 'min stock', 'min_stock', 'minimum_stock',
    ],
  },

  MIN_STOCK: {
    canonical: 'min_stock',
    domain: 'inventory',
    classification: 'optional',
    description: 'Minimum allowable stock level',
    synonyms: [
      'min', 'minimum', 'min level', 'min_level', 'minimum level',
      'minimum_level',
    ],
  },

  MAX_STOCK: {
    canonical: 'max_stock',
    domain: 'inventory',
    classification: 'optional',
    description: 'Maximum stock capacity',
    synonyms: [
      'max', 'maximum', 'max level', 'max_level', 'maximum level',
      'maximum_level', 'maximum stock', 'maximum_stock',
    ],
  },

  OPENING_STOCK: {
    canonical: 'opening_stock',
    domain: 'inventory',
    classification: 'optional',
    description: 'Opening stock level at period start',
    synonyms: [
      'opening', 'opening stock', 'opening_stock', 'opening balance',
      'opening_balance', 'beginning stock', 'beginning_stock', 'start stock',
      'start_stock',
    ],
  },

  // ---- Expiry -----------------------------------------------------------

  EXPIRY_DATE: {
    canonical: 'expiry_date',
    domain: 'expiry',
    classification: 'mapped',
    description: 'Product expiration / shelf-life date',
    synonyms: [
      'expiry', 'expiry date', 'expiry_date', 'expiration', 'expiration date',
      'expiration_date', 'exp date', 'exp_date', 'exp', 'best before',
      'best_before', 'use by', 'use_by', 'shelf life', 'shelf_life',
      'expires', 'expiring', 'expiry month', 'expiry year',
    ],
  },

  BATCH_NUMBER: {
    canonical: 'batch_number',
    domain: 'expiry',
    classification: 'mapped',
    description: 'Manufacturing batch or lot number',
    synonyms: [
      'batch', 'batch number', 'batch_number', 'batch no', 'batch_no',
      'batch #', 'lot', 'lot number', 'lot_number', 'lot no', 'lot_no',
      'batch id', 'batch_id', 'serial batch', 'production batch',
      'production_batch', 'manufacturing batch', 'manufacturing_batch',
    ],
  },

  // ---- Supplier ---------------------------------------------------------

  SUPPLIER: {
    canonical: 'supplier',
    domain: 'supplier',
    classification: 'mapped',
    description: 'Supplier or vendor who provided the products',
    synonyms: [
      'supplier', 'supplier name', 'supplier_name', 'vendor', 'vendor name',
      'vendor_name', 'source', 'supplied by', 'supplied_by', 'supplier id',
      'supplier_id',
    ],
  },

  // ---- Organization -----------------------------------------------------

  BRANCH: {
    canonical: 'branch',
    domain: 'organization',
    classification: 'mapped',
    description: 'Pharmacy branch or store location',
    synonyms: [
      'branch', 'branch name', 'branch_name', 'store', 'location', 'outlet',
      'pharmacy', 'pharmacy branch', 'pharmacy_branch', 'site',
      'branch location', 'branch_location', 'store name', 'store_name',
      'shop', 'outlet name', 'outlet_name', 'pharmacy name', 'pharmacy_name',
    ],
  },

  CASHIER: {
    canonical: 'sales_representative',
    domain: 'organization',
    classification: 'optional',
    description: 'Staff member / cashier / pharmacist who made the sale',
    synonyms: [
      'sales rep', 'sales_rep', 'sales representative', 'sales_representative',
      'rep', 'representative', 'staff', 'staff name', 'staff_name', 'employee',
      'employee name', 'employee_name', 'sales person', 'salesperson',
      'dispenser', 'pharmacist', 'attendant', 'seller', 'agent', 'cashier',
      'teller', 'served by', 'served_by',
    ],
  },

  WAREHOUSE: {
    canonical: 'warehouse',
    domain: 'organization',
    classification: 'optional',
    description: 'Warehouse or storage location',
    synonyms: [
      'warehouse', 'warehouse name', 'warehouse_name', 'store room',
      'storeroom', 'depot', 'storage', 'storage location', 'storage_location',
      'stock room', 'stockroom', 'inventory location', 'inventory_location',
      'stock location', 'stock_location',
    ],
  },

  SALES_CHANNEL: {
    canonical: 'sales_channel',
    domain: 'organization',
    classification: 'optional',
    description: 'Sales or distribution channel (retail, wholesale, online, etc.)',
    synonyms: [
      'sales channel', 'sales_channel', 'channel', 'channel type', 'channel_type',
      'sales type', 'sales_type', 'order channel', 'order_channel',
      'distribution channel', 'distribution_channel', 'selling channel',
      'selling_channel', 'retail channel', 'retail_channel', 'pos channel',
      'pos_channel', 'platform', 'marketplace',
    ],
  },

  CUSTOMER: {
    canonical: 'customer',
    domain: 'organization',
    classification: 'optional',
    description: 'Customer or patient name',
    synonyms: [
      'customer', 'customer name', 'customer_name', 'client', 'client name',
      'client_name', 'buyer', 'patient', 'patient name', 'patient_name',
      'purchaser', 'customer id', 'customer_id', 'patient id', 'patient_id',
    ],
  },

  INVOICE_NUMBER: {
    canonical: 'invoice_number',
    domain: 'organization',
    classification: 'optional',
    description: 'Invoice, receipt, or transaction reference number',
    synonyms: [
      'invoice', 'invoice number', 'invoice_number', 'invoice no', 'invoice_no',
      'receipt', 'receipt number', 'receipt_number', 'receipt no', 'receipt_no',
      'bill number', 'bill_number', 'bill no', 'bill_no', 'transaction id',
      'transaction_id', 'txn id', 'txn_id', 'order number', 'order_number',
      'order no', 'order_no', 'reference', 'ref', 'ref no', 'ref_no',
      'reference number', 'reference_number', 'doc number', 'doc_number',
      'sale id', 'sale_id',
    ],
  },

  // ---- Metadata (system-managed, not user-mappable) ---------------------

  UPLOAD_ID: {
    canonical: 'upload_id',
    domain: 'metadata',
    classification: 'metadata',
    description: 'System-generated upload identifier',
    synonyms: [],
  },

  DATASET_ID: {
    canonical: 'dataset_id',
    domain: 'metadata',
    classification: 'metadata',
    description: 'System-generated dataset identifier',
    synonyms: [],
  },
};

// =========================================================================
// Domain Groupings
// =========================================================================

/**
 * Fields that collectively identify a product. If PRODUCT is not directly
 * mapped, any combination of these fields satisfies the product identity
 * requirement. The normalizer will compose a display name from them.
 */
const PRODUCT_IDENTITY_FIELDS = new Set([
  'PRODUCT',
  'GENERIC_NAME',
  'BRAND_NAME',
  'STRENGTH',
  'DOSAGE_FORM',
  'PACK_SIZE',
  'MANUFACTURER',
  'CATEGORY',
  'SUBCATEGORY',
]);

/**
 * Each entry: { domain, fields (the semantic keys), minMapped, label }
 *
 * A domain requirement is SATISFIED when at least `minMapped` of `fields`
 * appear in the resolved mapping.
 */
const DOMAIN_REQUIREMENTS = [
  {
    domain: 'product_identity',
    fields: ['PRODUCT', 'GENERIC_NAME', 'BRAND_NAME', 'STRENGTH', 'DOSAGE_FORM', 'PACK_SIZE', 'MANUFACTURER'],
    minMapped: 1,
    label: 'Product Identity',
    message: 'At least one product identity field is required (Product, Generic Name, Brand, Strength, or Dosage Form).',
  },
];

/**
 * At least one of these price-related fields must be mapped for financial analysis.
 */
const PRICE_REQUIREMENT = {
  fields: ['SELLING_PRICE', 'REVENUE', 'COST_PRICE'],
  minMapped: 1,
  label: 'Price / Revenue',
  message: 'At least one price or revenue field is required.',
};

// =========================================================================
// Column Classification: Mapped / Optional / Ignored
// =========================================================================

/**
 * Returns the classification for a semantic field key.
 *   'mapped'   — core business field
 *   'optional' — enriches but optional
 *   'metadata' — system-managed
 *   'ignored'  — not in the registry (unknown column)
 */
function getClassification(semanticKey) {
  const entry = SEMANTIC_REGISTRY[semanticKey];
  return entry ? entry.classification : 'ignored';
}

/**
 * Patterns for columns that should be classified as IGNORED
 * even if they happen to fuzzy-match a semantic field.
 * Columns matching these patterns are irrelevant for analytics.
 */
const IGNORED_PATTERNS = [
  // Commentary / notes
  /\bremarks?\b/i,
  /\bnotes?\b/i,
  /\bcomments?\b/i,
  /\binternal\s*(notes?|comments?)?\b/i,
  /\bmemo\b/i,

  // Contact details
  /\bphone\b/i,
  /\btelephone\b/i,
  /\bmobile\b/i,
  /\bemail\b/i,
  /\baddress\b/i,
  /\bstore\s*address\b/i,
  /\bbranch\s*address\b/i,
  /\bgps\b/i,
  /\blocation\s*(url|link|coordinates?)\b/i,
  /\bgeolocation\b/i,

  // Images / media
  /\bshelf\s*image\b/i,
  /\bproduct\s*image\b/i,
  /\bimage\b/i,
  /\bpicture\b/i,
  /\bphoto\b/i,
  /\bavatar\b/i,

  // System / audit columns
  /\bcreated\s*(by|at|on)\b/i,
  /\bcreated[_\-]?(at|on|timestamp)\b/i,
  /\bupdated\s*(by|at|on)\b/i,
  /\bupdated[_\-]?(at|on|timestamp)\b/i,
  /\bmodified\s*(by|at|on)\b/i,
  /\bmodified[_\-]?(at|on|timestamp)\b/i,
  /\bdeleted\s*(by|at|on)\b/i,
  /\bdeleted[_\-]?(at|on|timestamp)\b/i,
  /\blast\s*modified\b/i,
  /\brow\s*(id|number|num)\b/i,
  /\brecord\s*(id|number)\b/i,
  /\bguid\b/i,
  /\buuid\b/i,

  // Misc non-business
  /\bstatus\b/i,
  /\bactive\b/i,
  /\bflag\b/i,
  /\bboolean\b/i,
  /\bbarcode\b/i,
  /\bqr\s*code\b/i,
];

/**
 * Check whether a normalized header matches any IGNORED_PATTERN.
 * Returns true if the column should be classified as ignored.
 */
function isIgnoredColumn(normalizedHeader) {
  if (!normalizedHeader) return false;
  return IGNORED_PATTERNS.some((p) => p.test(normalizedHeader));
}

// =========================================================================
// Compatibility: Old DICTIONARY (used by schemaDetector, llmMapper, tests)
// =========================================================================

/**
 * Build the backward-compatible DICTIONARY from SEMANTIC_REGISTRY.
 * Keys are old canonical field names; values are arrays of synonyms.
 */
function buildLegacyDictionary() {
  const dict = {};
  for (const [semanticKey, entry] of Object.entries(SEMANTIC_REGISTRY)) {
    if (entry.synonyms.length === 0) continue;
    const legacyKey = entry.canonical;
    if (!dict[legacyKey]) {
      dict[legacyKey] = [];
    }
    // Merge synonyms (dedup)
    for (const syn of entry.synonyms) {
      if (!dict[legacyKey].includes(syn)) {
        dict[legacyKey].push(syn);
      }
    }
  }
  return dict;
}

const DICTIONARY = buildLegacyDictionary();

// =========================================================================
// Legacy-to-Canonical Mapping
// =========================================================================

const LEGACY_MAP = {
  'price': 'selling_price',
  'cost': 'cost_price',
  'product': 'product_name',
  'date': 'transaction_date',
};

/**
 * Return the canonical (old-style) field name for a semantic key or synonym.
 */
function getCategory(synonym) {
  if (synonym == null || synonym === '') return null;
  const s = String(synonym).toLowerCase().trim();

  // First, check if it's already a canonical field name
  for (const [key, entry] of Object.entries(SEMANTIC_REGISTRY)) {
    if (entry.canonical === s) return entry.canonical;
    if (key.toLowerCase() === s) return entry.canonical;
    if (entry.synonyms.includes(s)) return entry.canonical;
  }
  return null;
}

/**
 * Resolve a semantic key (e.g., 'PRODUCT') to its canonical field name (e.g., 'product_name').
 */
function resolveCanonical(semanticKey) {
  const entry = SEMANTIC_REGISTRY[semanticKey];
  return entry ? entry.canonical : null;
}

function canonicalize(category) {
  return LEGACY_MAP[category] || category;
}

// =========================================================================
// Required / Optional Classification (backward compatible)
// =========================================================================

const REQUIRED_FIELDS = new Set(['product_name']);

const PRICE_FIELDS = new Set(['revenue', 'selling_price']);

/**
 * Semantic keys considered "price fields" for flexible requirements.
 */
const PRICE_SEMANTIC_KEYS = new Set(PRICE_REQUIREMENT.fields);

const FIELD_METADATA = {
  // Core transaction fields
  product_name:   { group: 'core',     required: true,   label: 'Product Name',           desc: 'Medicine or item name — required for analysis' },
  quantity:       { group: 'core',     required: false,  label: 'Quantity',                desc: 'Units sold or dispensed' },
  revenue:        { group: 'core',     required: false,  label: 'Revenue',                  desc: 'Total transaction amount (or use Selling Price + Quantity)' },
  cost_price:     { group: 'core',     required: false,  label: 'Cost Price',               desc: 'Unit purchase cost — enables profit analysis' },
  selling_price:  { group: 'core',     required: false,  label: 'Selling Price',            desc: 'Unit selling price (or use Revenue + Quantity)' },
  transaction_date: { group: 'core',     required: false,  label: 'Transaction Date',          desc: 'Transaction date — enables trends and time-series' },
  payment_method: { group: 'core',     required: false,  label: 'Payment Method',           desc: 'How the customer paid (Cash, Transfer, etc.)' },

  // Product detail fields
  supplier:               { group: 'product', required: false, label: 'Supplier',              desc: 'Who supplied the product' },
  manufacturer:           { group: 'product', required: false, label: 'Manufacturer',          desc: 'Who manufactured the product' },
  brand:                  { group: 'product', required: false, label: 'Brand',                 desc: 'Commercial brand / trade name' },
  generic_name:           { group: 'product', required: false, label: 'Generic Name',          desc: 'INN / active ingredient name' },
  category:               { group: 'product', required: false, label: 'Category',              desc: 'Therapeutic class or product category' },
  subcategory:            { group: 'product', required: false, label: 'Subcategory',           desc: 'Finer product segment' },
  batch_number:           { group: 'product', required: false, label: 'Batch Number',          desc: 'Manufacturing batch or lot code' },
  expiry_date:            { group: 'product', required: false, label: 'Expiry Date',           desc: 'Product expiration date' },
  strength:               { group: 'product', required: false, label: 'Strength',              desc: 'Dosage strength (e.g., 500mg)' },
  dosage_form:            { group: 'product', required: false, label: 'Dosage Form',           desc: 'Physical form (tablet, capsule, syrup, etc.)' },
  pack_size:              { group: 'product', required: false, label: 'Pack Size',             desc: 'Units per pack (e.g., 10, 28, 100)' },

  // Organizational fields
  branch:                 { group: 'org', required: false, label: 'Branch',                    desc: 'Pharmacy branch or store location' },
  warehouse:              { group: 'org', required: false, label: 'Warehouse',                 desc: 'Storage / warehouse location' },
  sales_channel:          { group: 'org', required: false, label: 'Sales Channel',             desc: 'Retail, wholesale, online, etc.' },
  customer:               { group: 'org', required: false, label: 'Customer',                  desc: 'Customer or patient name' },
  sales_representative:   { group: 'org', required: false, label: 'Cashier / Staff',           desc: 'Staff member who made the sale' },
  invoice_number:         { group: 'org', required: false, label: 'Invoice Number',            desc: 'Invoice or receipt reference' },

  // Inventory fields
  current_stock:          { group: 'inventory', required: false, label: 'Current Stock',       desc: 'Current stock level / quantity on hand' },
  reorder_level:          { group: 'inventory', required: false, label: 'Reorder Level',       desc: 'Reorder point / minimum before ordering' },
  min_stock:              { group: 'inventory', required: false, label: 'Min Stock',           desc: 'Minimum allowable stock level' },
  max_stock:              { group: 'inventory', required: false, label: 'Max Stock',           desc: 'Maximum stock capacity' },
  opening_stock:          { group: 'inventory', required: false, label: 'Opening Stock',       desc: 'Opening stock at period start' },

  // Financial detail fields
  discount:               { group: 'finance', required: false, label: 'Discount',              desc: 'Discount amount or percentage' },
  tax:                    { group: 'finance', required: false, label: 'Tax',                   desc: 'Tax or VAT amount' },
  profit:                 { group: 'finance', required: false, label: 'Profit',                desc: 'Profit amount per row' },
  margin:                 { group: 'finance', required: false, label: 'Margin',                desc: 'Margin percentage per row' },
};

function hasRequiredFields(mappedCategories) {
  const hasProduct = mappedCategories.has('product_name');
  const hasPrice = mappedCategories.has('revenue') || mappedCategories.has('selling_price');
  return hasProduct && hasPrice;
}

function buildFieldOptions() {
  const groups = {};
  for (const [field, meta] of Object.entries(FIELD_METADATA)) {
    const g = meta.group;
    if (!groups[g]) groups[g] = [];
    groups[g].push({ value: field, label: meta.label, required: meta.required, desc: meta.desc });
  }
  return {
    required: [
      ...(groups.core || []).filter((f) => f.required),
      ...(groups.core || []).filter((f) => !f.required),
    ],
    optional: [
      ...(groups.product || []),
      ...(groups.inventory || []),
      ...(groups.org || []),
      ...(groups.finance || []),
    ],
  };
}

// =========================================================================
// Semantic → Canonical reverse lookup
// =========================================================================

/**
 * Build a map from canonical field name → semantic key.
 * Used by the normalizer to look up domain/classification for mapped fields.
 */
function buildCanonicalToSemantic() {
  const map = {};
  for (const [semanticKey, entry] of Object.entries(SEMANTIC_REGISTRY)) {
    map[entry.canonical] = semanticKey;
  }
  return map;
}

const CANONICAL_TO_SEMANTIC = buildCanonicalToSemantic();

module.exports = {
  // Master Semantic Registry (new)
  SEMANTIC_REGISTRY,
  PRODUCT_IDENTITY_FIELDS,
  DOMAIN_REQUIREMENTS,
  PRICE_REQUIREMENT,
  PRICE_SEMANTIC_KEYS,
  IGNORED_PATTERNS,
  isIgnoredColumn,
  getClassification,
  resolveCanonical,
  CANONICAL_TO_SEMANTIC,

  // Backward-compatible exports
  DICTIONARY,
  getCategory,
  canonicalize,
  LEGACY_MAP,
  FIELD_METADATA,
  REQUIRED_FIELDS,
  PRICE_FIELDS,
  hasRequiredFields,
  buildFieldOptions,
};
