// Generates the bulk-lead-template.xlsx live from the tenant's current
// dropdown values, with Excel data validation (dropdown picker) on the
// columns where strict matching is required at import time.
//
// Why per-tenant: stage / sub_stage / country lists differ between
// institutes. Picking values from a dropdown in the spreadsheet means
// users can't typo strict fields, so the import never fails on
// "Stage not found".
//
// Long lists (universities/specializations/etc.) are deliberately NOT
// turned into dropdowns — too many entries to scroll, and the import
// auto-creates them anyway.
import ExcelJS from 'exceljs';

const HEADERS = [
  'first_name', 'last_name', 'email', 'alternate_email', 'phone', 'whatsapp_number', 'alternate_contact',
  'gender', 'language',
  'ug_degree', 'ug_specialization', 'ug_university', 'ug_graduation_year',
  'pg_degree', 'pg_specialization', 'pg_university', 'pg_graduation_year',
  'country', 'state', 'district', 'city', 'address', 'pincode',
  'program', 'stage', 'sub_stage', 'remarks',
  'father_name', 'father_mobile', 'father_email',
  'mother_name', 'mother_mobile', 'mother_email',
  'guardian_name', 'guardian_mobile', 'guardian_email',
  'channel', 'source', 'campaign', 'medium',
  'assigned_to_email', 'referral_code_used', 'tags',
];

const EXAMPLE_ROWS = [
  ['Rahul', 'Sharma', 'rahul@example.com', '', '+919811111111', '+919811111111', '',
    'Male', 'en',
    'B.Tech', 'Computer Science', 'IIT Delhi', 2023,
    '', '', '', '',
    'India', 'Delhi', 'New Delhi', 'New Delhi', '12 Rajiv Chowk', 110001,
    '', '', '', 'Prefers evening callback',
    'Ramesh Sharma', '+919822222222', 'ramesh@example.com',
    'Sunita Sharma', '+919833333333', '',
    '', '', '',
    'Online', 'Website', 'Web Add Lead', 'Free',
    '', '', 'priority'],
];

const FIXED_GENDER = ['Male', 'Female', 'Other', 'Prefer not to say'];
const FIXED_LANGUAGE = ['en', 'hi', 'mr', 'ta', 'te', 'kn', 'ml', 'gu', 'bn', 'pa'];

// Returns the 1-based column number for a header (so we know where to put
// data validation).
const colNum = (header) => HEADERS.indexOf(header) + 1;

// Convert a 1-based column number to an Excel letter (A, B, ..., Z, AA, ...).
const colLetter = (n) => {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
};

// Adds a hidden sheet column of values, returns the absolute range string
// suitable for `dataValidation.formulae[0]`. Excel requires the range to
// be on the same workbook, and dropdowns longer than ~255 chars must use
// a range (not inline values).
const addListToHiddenSheet = (listsSheet, header, values) => {
  if (!values.length) return null;
  const startCol = listsSheet.lastColumnIndex + 1;
  const letter = colLetter(startCol);
  // Header at row 1, values from row 2 down. Header is informational only.
  listsSheet.getCell(`${letter}1`).value = header;
  values.forEach((v, i) => {
    listsSheet.getCell(`${letter}${i + 2}`).value = v;
  });
  listsSheet.lastColumnIndex = startCol;
  // Reference must be absolute and quoted because the sheet name has odd chars.
  return `'Lists'!$${letter}$2:$${letter}$${values.length + 1}`;
};

const applyDropdown = (ws, header, rangeFormula) => {
  if (!rangeFormula) return;
  const col = colNum(header);
  if (col < 1) return;
  const letter = colLetter(col);
  // Apply to rows 2..1001 (1000 data rows). Going to 1048576 (Excel's max)
  // makes the file huge and Excel slower to open; 1000 is plenty for a
  // template fill-in. Users can paste-fill more rows if they need to.
  ws.dataValidations.add(`${letter}2:${letter}1001`, {
    type: 'list',
    allowBlank: true,
    formulae: [rangeFormula],
    showErrorMessage: true,
    errorStyle: 'warning',
    errorTitle: 'Value not in list',
    error: `Pick a value from the dropdown. New ${header} entries can be added under Settings → Dropdowns.`,
  });
};

// Excel "defined name" ids must be valid (start with a letter, no spaces,
// no punctuation other than _ . ?). Stage names like "01-New" or "Will join
// soon" don't qualify, so we sanitise into a deterministic key the
// INDIRECT() formula can rebuild from the cell value.
const safeNameKey = (s) => `_${String(s ?? '')
  .replace(/[^A-Za-z0-9]+/gu, '_')
  .replace(/^_+|_+$/gu, '')
  .replace(/^(\d)/u, '_$1')}`;

// Build the workbook in memory and return the xlsx buffer.
export const buildTemplateXlsx = async ({ stages, subStagesByStageName, countries }) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ExtraaEdge';
  wb.created = new Date();

  const ws = wb.addWorksheet('Leads');

  // ---- Header row ----
  ws.addRow(HEADERS);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF3ED' } };
  HEADERS.forEach((_, i) => { ws.getColumn(i + 1).width = 18; });

  // ---- Example rows ----
  for (const row of EXAMPLE_ROWS) ws.addRow(row);

  // ---- Hidden sheet to host dropdown source ranges ----
  const listsSheet = wb.addWorksheet('Lists', { state: 'hidden' });
  listsSheet.lastColumnIndex = 0;

  // ---- Fixed enums ----
  applyDropdown(ws, 'gender', addListToHiddenSheet(listsSheet, 'gender', FIXED_GENDER));
  applyDropdown(ws, 'language', addListToHiddenSheet(listsSheet, 'language', FIXED_LANGUAGE));

  // ---- Tenant-driven enums ----
  if (stages.length) applyDropdown(ws, 'stage', addListToHiddenSheet(listsSheet, 'stage', stages));

  // ---- Dependent sub_stage dropdown ----
  // Each stage gets its own column on the Lists sheet. We register a workbook
  // "defined name" pointing at that column (sanitised — Excel names can't
  // contain spaces or hyphens). Then the sub_stage column's data validation
  // uses INDIRECT() to look up the right named range based on the stage cell.
  //
  // The lookup formula in column Z (sub_stage), row 2:
  //   =INDIRECT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE("_"&Y2," ","_"),"-","_"),".","_"))
  //
  // This rebuilds safeNameKey() in Excel: prepend "_", replace each space /
  // hyphen / dot with "_". So stage "01-New" → name "_01_New" matches the
  // defined name we registered below. If a stage has no sub_stages registered
  // (e.g. "Junk"), INDIRECT returns #REF! and Excel shows an empty dropdown.
  const stageColLetter = colLetter(colNum('stage'));
  const subStageMap = subStagesByStageName || {};
  // Track if at least one stage has sub_stages — if not, skip the validation.
  let anyDefined = false;
  for (const [stageName, subList] of Object.entries(subStageMap)) {
    if (!subList?.length) continue;
    const startCol = listsSheet.lastColumnIndex + 1;
    const letter = colLetter(startCol);
    listsSheet.getCell(`${letter}1`).value = stageName;
    subList.forEach((v, i) => { listsSheet.getCell(`${letter}${i + 2}`).value = v; });
    listsSheet.lastColumnIndex = startCol;
    const range = `'Lists'!$${letter}$2:$${letter}$${subList.length + 1}`;
    // Workbook-scoped named range. exceljs writes these to xl/workbook.xml.
    wb.definedNames.add(range, safeNameKey(stageName));
    anyDefined = true;
  }
  if (anyDefined) {
    const subStageCol = colLetter(colNum('sub_stage'));
    // Apply per-row data validation with a relative reference to the
    // current row's stage cell. Range "Z2:Z1001" gets validation that
    // resolves the formula against each row's own Y cell.
    ws.dataValidations.add(`${subStageCol}2:${subStageCol}1001`, {
      type: 'list',
      allowBlank: true,
      // Y2 is the stage cell on the same row as the first data row. Excel
      // shifts this reference automatically for rows 3..1001.
      formulae: [`=INDIRECT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE("_"&${stageColLetter}2," ","_"),"-","_"),".","_"))`],
      showErrorMessage: true,
      errorStyle: 'warning',
      errorTitle: 'Sub-stage doesn\'t match the stage',
      error: 'Pick a sub-stage that belongs to the chosen stage. Some stages have no sub-stages — in that case leave this column blank.',
    });
  }

  if (countries.length) applyDropdown(ws, 'country', addListToHiddenSheet(listsSheet, 'country', countries));

  // ---- Instructions sheet ----
  // Pure UX. The import parser reads only the first sheet ("Leads"), so
  // anything written here is ignored when the user uploads the file —
  // safe to be verbose. Goal: a user can answer "what should I type in
  // column X?" without leaving the spreadsheet.
  const notes = wb.addWorksheet('Instructions');
  notes.getColumn(1).width = 22;
  notes.getColumn(2).width = 16;
  notes.getColumn(3).width = 28;
  notes.getColumn(4).width = 70;

  const heading = (text, size = 14) => {
    const r = notes.addRow([text]);
    r.font = { bold: true, size };
  };
  const para = (text) => notes.addRow([text]);
  const blank = () => notes.addRow([]);

  heading('Bulk lead upload — how to fill this template', 16);
  blank();
  para('Fill rows on the "Leads" sheet only. Don\'t edit, reorder, or rename the header row.');
  para('At least one of first_name / email / phone / whatsapp_number must be filled in every row.');
  para('Maximum 30,000 rows per upload.');
  blank();

  heading('Column reference', 13);
  blank();

  // Validation-rules table.
  const tableHeader = notes.addRow(['Column', 'Required', 'Type / format', 'Notes']);
  tableHeader.font = { bold: true };
  tableHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF3ED' } };

  const ROW_BORDER = {
    top: { style: 'thin', color: { argb: 'FFE5E5E5' } },
    left: { style: 'thin', color: { argb: 'FFE5E5E5' } },
    bottom: { style: 'thin', color: { argb: 'FFE5E5E5' } },
    right: { style: 'thin', color: { argb: 'FFE5E5E5' } },
  };
  const addRule = (col, required, type, note) => {
    const r = notes.addRow([col, required, type, note]);
    r.alignment = { vertical: 'top', wrapText: true };
    r.eachCell((c) => { c.border = ROW_BORDER; });
  };

  addRule('first_name',          'One of name/email/phone/whatsapp', 'Text',         'Free text. Trimmed on import.');
  addRule('last_name',           'No',                               'Text',         'Free text.');
  addRule('email',               'See first_name',                   'Email format', 'Lowercased and used for duplicate detection. Invalid formats fail the row.');
  addRule('alternate_email',     'No',                               'Email format', 'Same format rules as email. Not used for duplicate detection.');
  addRule('phone',               'See first_name',                   'Phone',        '10 digits, or with country code (+91...). Used for duplicate detection (exact match after normalization).');
  addRule('whatsapp_number',     'See first_name',                   'Phone',        'Same format as phone. Used for duplicate detection.');
  addRule('alternate_contact',   'No',                               'Phone',        'Same format as phone.');
  addRule('gender',              'No',                               'Dropdown',     'Pick from the dropdown — Male / Female / Other / Prefer not to say.');
  addRule('language',            'No',                               'Dropdown',     'Two-letter code (en, hi, mr, ta, te, kn, ml, gu, bn, pa).');
  addRule('ug_degree',           'No',                               'Text (auto-create)', 'Free text. New degrees are added automatically (level=UG).');
  addRule('ug_specialization',   'No',                               'Text (auto-create)', 'Free text. New specializations are added automatically.');
  addRule('ug_university',       'No',                               'Text (auto-create)', 'Free text. New universities are added automatically. Casing is preserved on first use.');
  addRule('ug_graduation_year',  'No',                               'Year (1950–2100)',   'Whole number, e.g. 2023.');
  addRule('pg_degree',           'No',                               'Text (auto-create)', 'Free text. New degrees are added automatically (level=PG).');
  addRule('pg_specialization',   'No',                               'Text (auto-create)', 'Free text.');
  addRule('pg_university',       'No',                               'Text (auto-create)', 'Free text.');
  addRule('pg_graduation_year',  'No',                               'Year (1950–2100)',   'Whole number, e.g. 2025.');
  addRule('country',             'No',                               'Dropdown (strict)',  'Pick from the dropdown. Typed-in values that don\'t match a country in your settings will fail the row.');
  addRule('state',               'No',                               'Text (auto-create)', 'Free text. Requires a valid country in the same row. New states are added automatically scoped to that country.');
  addRule('district',            'No',                               'Text',         'Free text.');
  addRule('city',                'No',                               'Text',         'Free text.');
  addRule('address',             'No',                               'Text',         'Free text. Long values are stored as-is.');
  addRule('pincode',             'No',                               'Number',       'Postal code. Stored as text on the lead.');
  addRule('program',             'No',                               'Text (auto-create)', 'Free text. New programs are added automatically.');
  addRule('stage',               'No',                               'Dropdown (strict)',  'Pick from the dropdown. Required if you also fill sub_stage. Unknown values will fail the row.');
  addRule('sub_stage',           'No',                               'Dropdown (strict)',  'Pick from the dropdown. Must belong under the chosen stage — mismatches fail the row.');
  addRule('remarks',             'No',                               'Text',         'Free text.');
  addRule('father_name',         'No',                               'Text',         'Free text.');
  addRule('father_mobile',       'No',                               'Phone',        'Same format as phone.');
  addRule('father_email',        'No',                               'Email format', '');
  addRule('mother_name',         'No',                               'Text',         '');
  addRule('mother_mobile',       'No',                               'Phone',        '');
  addRule('mother_email',        'No',                               'Email format', '');
  addRule('guardian_name',       'No',                               'Text',         '');
  addRule('guardian_mobile',     'No',                               'Phone',        '');
  addRule('guardian_email',      'No',                               'Email format', '');
  addRule('channel',             'No',                               'Text (auto-create)', 'Marketing channel — e.g. Online / Offline / Facebook. New entries created on first use.');
  addRule('source',              'No',                               'Text (auto-create)', 'Marketing source — e.g. Website / Social Media. New entries created on first use.');
  addRule('campaign',            'No',                               'Text (auto-create)', 'Marketing campaign name. New entries created on first use.');
  addRule('medium',              'No',                               'Text (auto-create)', 'Marketing medium — e.g. CPC / Organic / Free. New entries created on first use.');
  addRule('assigned_to_email',   'No',                               'Email format', 'Email of the counsellor to assign this lead to. If not provided, auto-assignment runs after the import.');
  addRule('referral_code_used',  'No',                               'Text',         'Free text.');
  addRule('tags',                'No',                               'Comma-separated', 'e.g. priority,returning. Trimmed.');

  blank();
  heading('Duplicate handling', 13);
  blank();
  para('Rows are flagged as duplicates when their email, phone, or whatsapp_number exactly matches an existing lead in your CRM (after normalization).');
  para('Duplicate behavior is controlled by the Duplicate handling setting on the upload screen:');
  para('  • Skip — duplicate rows are NOT inserted; they show on the Failed Leads → Duplicates tab.');
  para('  • Update existing — the existing lead\'s name and email are merged from the row; the duplicate is logged.');
  para('  • Create new — a new lead is created anyway and the duplicate is logged for review.');

  blank();
  heading('What you\'ll see if a row fails', 13);
  blank();
  para('Failed rows show on the Failed Leads page with one of these codes:');
  para('  MISSING_CONTACT — none of first_name / email / phone / whatsapp filled.');
  para('  INVALID_EMAIL / INVALID_ALTERNATE_EMAIL — email format is wrong.');
  para('  INVALID_PHONE / INVALID_WHATSAPP — phone digits or length wrong.');
  para('  INVALID_YEAR — graduation year outside 1950–2100.');
  para('  STAGE_NOT_FOUND — stage value isn\'t in your institute\'s stage list.');
  para('  SUBSTAGE_WITHOUT_STAGE — sub_stage filled but stage missing.');
  para('  SUBSTAGE_MISMATCH — sub_stage doesn\'t belong under the chosen stage.');
  para('  COUNTRY_NOT_FOUND — country isn\'t in your institute\'s country list.');
  para('  STATE_NEEDS_COUNTRY — state filled but country missing or invalid.');
  para('  ROW_FAILED — generic insert failure (rare). Open the row to see the database error.');

  return wb.xlsx.writeBuffer();
};

// Read the lookup data the template needs from the tenant DB, using the
// callsite's provided `tenantQuery` so the route can pass its `req.tenant`.
// Returns the data shape the builder expects.
export const loadTemplateLookups = async (tenantQuery, tenant) => {
  const [stagesRes, subStagesRes, countriesRes] = await Promise.all([
    tenantQuery(tenant, `SELECT id, name FROM lead_stages WHERE deleted_at IS NULL AND is_active ORDER BY order_index, name`),
    tenantQuery(tenant, `SELECT name, stage_id FROM lead_sub_stages WHERE deleted_at IS NULL AND is_active ORDER BY order_index, name`),
    tenantQuery(tenant, `SELECT name FROM countries WHERE deleted_at IS NULL AND is_active ORDER BY name`),
  ]);
  const stages = stagesRes.rows.map((r) => r.name);
  // subStagesByStageName: { "<stage name>": ["<sub_stage name>", ...] }
  // Indexing by stage NAME (not stage_id) is what the Excel builder needs:
  // the dependent-dropdown formula INDIRECT() resolves the stage cell's
  // text against named ranges, and named ranges are keyed by stage name.
  const idToName = new Map(stagesRes.rows.map((r) => [r.id, r.name]));
  const subStagesByStageName = {};
  for (const r of subStagesRes.rows) {
    const stageName = idToName.get(r.stage_id);
    if (!stageName) continue; // orphaned sub_stage — skip
    if (!subStagesByStageName[stageName]) subStagesByStageName[stageName] = [];
    subStagesByStageName[stageName].push(r.name);
  }
  const countries = countriesRes.rows.map((r) => r.name);
  return { stages, subStagesByStageName, countries };
};
