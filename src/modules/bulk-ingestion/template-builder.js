// Generates the bulk-lead-template.xlsx live from the tenant's current
// dropdown values.
//
// We used to emit Excel "data-validation lists" (the little arrow on a cell)
// backed by INDIRECT()-resolved named ranges for the dependent sub_stage
// dropdown. That broke in Google Sheets, LibreOffice, WPS, mobile Excel and
// some older desktop Excel versions — the arrow simply didn't show and users
// thought the template was broken.
//
// New approach: skip data-validation entirely. Add a visible "Allowed Values"
// sheet listing every strict-match value (stages, sub-stages grouped under
// their stage, countries, gender, language). Users type / paste from there.
// The server validates strictly on import, so wrong values still get caught
// and surfaced on /failedleads — the dropdown was UX, not a safety net.
import ExcelJS from 'exceljs';

const HEADERS = [
  'first_name', 'last_name', 'email', 'alternate_email', 'phone', 'whatsapp_number', 'alternate_contact',
  'gender', 'language',
  'ug_degree', 'ug_specialization', 'ug_university', 'ug_graduation_year',
  'pg_degree', 'pg_specialization', 'pg_university', 'pg_graduation_year',
  'country', 'state', 'district', 'city', 'address', 'pincode',
  'program', 'stage', 'sub_stage',
  // Owner columns live next to stage/sub_stage — they're part of the same
  // workflow block (who handles this lead in this stage). Keeps the
  // assignment story together when the counsellor scans the sheet.
  'assigned_to_email', 'current_lead_owner_email', 'previous_lead_owner_email',
  'remarks',
  // Upcoming follow-up (single, planned)
  'followup_scheduled_on', 'followup_comments',
  // Past follow-up attempts — most recent first. Stored as completed rows
  // in lead_followups (status='done'). Format DD-MM-YYYY HH:mm:ss.
  'next_action_date_1', 'comment_1',
  'next_action_date_2', 'comment_2',
  'next_action_date_3', 'comment_3',
  'next_action_date_4', 'comment_4',
  'next_action_date_5', 'comment_5',
  // Optional audit timestamps. If blank, server uses now().
  // Format DD-MM-YYYY HH:mm:ss.
  'lead_created_on', 'lead_updated_on',
  'father_name', 'father_mobile', 'father_email',
  'mother_name', 'mother_mobile', 'mother_email',
  'guardian_name', 'guardian_mobile', 'guardian_email',
  'channel', 'source', 'primary_source', 'campaign', 'medium',
  'referral_code_used', 'tags',
];

const EXAMPLE_ROWS = [
  ['Rahul', 'Sharma', 'rahul@example.com', '', '+919811111111', '+919811111111', '',
    'Male', 'en',
    'B.Tech', 'Computer Science', 'Savitribai Phule Pune University', 2023,
    '', '', '', '',
    'India', 'Maharashtra', 'Pune', 'Pune', '12 FC Road', 411005,
    'Data Analyst Training and Certification', '02-Ringing / Not Reachable', 'Ringing no response',
    // assigned_to_email, current_lead_owner_email, previous_lead_owner_email
    '', '', '',
    'Prefers evening callback',
    // followup_scheduled_on, followup_comments
    '20-05-2026 18:00:00', 'Follow up tomorrow evening',
    // next_action_date_1..5 + comment_1..5  (most recent past attempts first)
    '17-04-2026 21:40:00', 'voicemail',
    '14-04-2026 14:55:00', 'not received',
    '', '',
    '', '',
    '', '',
    // lead_created_on, lead_updated_on
    '14-04-2026 13:07:56', '14-04-2026 13:08:29',
    'Ramesh Sharma', '+919822222222', 'ramesh@example.com',
    'Sunita Sharma', '+919833333333', '',
    '', '', '',
    'Offline', 'Raw Database', 'Raw Database', 'Web Quick Add Lead', 'Offline',
    '', 'priority'],
];

const FIXED_GENDER = ['Male', 'Female', 'Other', 'Prefer not to say'];
const FIXED_LANGUAGE = ['en', 'hi', 'mr', 'ta', 'te', 'kn', 'ml', 'gu', 'bn', 'pa'];

// Build the visible "Allowed Values" reference sheet. Layout: a banner at the
// top, then for each strict-match field a small titled block listing the valid
// values. Sub-stages are grouped under the parent stage so users can see which
// sub-stage belongs where without scrolling.
const buildAllowedValuesSheet = (wb, { stages, subStagesByStageName, countries }) => {
  const sh = wb.addWorksheet('Allowed Values');
  sh.getColumn(1).width = 34;
  sh.getColumn(2).width = 34;
  sh.getColumn(3).width = 28;
  sh.getColumn(4).width = 26;
  sh.getColumn(5).width = 18;

  const HEADER_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF3ED' } };
  const SECTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E6' } };
  const BORDER = {
    top:    { style: 'thin', color: { argb: 'FFE5E5E5' } },
    left:   { style: 'thin', color: { argb: 'FFE5E5E5' } },
    bottom: { style: 'thin', color: { argb: 'FFE5E5E5' } },
    right:  { style: 'thin', color: { argb: 'FFE5E5E5' } },
  };

  // Title row
  const title = sh.addRow(['Allowed Values — copy these into the Leads sheet']);
  title.font = { bold: true, size: 14 };
  sh.mergeCells(`A${title.number}:E${title.number}`);
  sh.addRow(['Stage, sub_stage, country, gender and language are STRICT — values must match exactly.']);
  sh.addRow(['Type or paste from the lists below. Other fields (program, channel, university…) are free text and auto-created on import.']);
  sh.addRow([]);

  // ---- Stage / sub_stage (grouped) ----
  const stageHdr = sh.addRow(['Stage (column "stage")', 'Sub-stage (column "sub_stage")']);
  stageHdr.font = { bold: true };
  stageHdr.eachCell((c) => { c.fill = HEADER_FILL; c.border = BORDER; });

  for (const stageName of stages) {
    const subs = subStagesByStageName[stageName] || [];
    if (subs.length === 0) {
      const r = sh.addRow([stageName, '(no sub-stages — leave blank)']);
      r.getCell(1).fill = SECTION_FILL;
      r.getCell(1).font = { bold: true };
      r.eachCell((c) => { c.border = BORDER; c.alignment = { vertical: 'top', wrapText: true }; });
      continue;
    }
    // Print one row per sub-stage; merge the stage cell down for visual grouping.
    const firstRow = sh.rowCount + 1;
    for (let i = 0; i < subs.length; i += 1) {
      const r = sh.addRow([i === 0 ? stageName : '', subs[i]]);
      if (i === 0) {
        r.getCell(1).fill = SECTION_FILL;
        r.getCell(1).font = { bold: true };
      }
      r.eachCell((c) => { c.border = BORDER; c.alignment = { vertical: 'top', wrapText: true }; });
    }
    const lastRow = sh.rowCount;
    if (subs.length > 1) sh.mergeCells(`A${firstRow}:A${lastRow}`);
  }

  sh.addRow([]);

  // ---- Other strict-match enums laid out side-by-side ----
  const otherHdr = sh.addRow(['Country (column "country")', 'Gender (column "gender")', 'Language (column "language")']);
  otherHdr.font = { bold: true };
  otherHdr.eachCell((c) => { c.fill = HEADER_FILL; c.border = BORDER; });

  const maxRows = Math.max(countries.length, FIXED_GENDER.length, FIXED_LANGUAGE.length);
  for (let i = 0; i < maxRows; i += 1) {
    const r = sh.addRow([
      countries[i]      || '',
      FIXED_GENDER[i]   || '',
      FIXED_LANGUAGE[i] || '',
    ]);
    r.eachCell((c) => { c.border = BORDER; });
  }

  // Freeze the title so it stays put while scrolling the value lists.
  sh.views = [{ state: 'frozen', ySplit: 1 }];
  return sh;
};

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

  // Freeze the header row so it stays visible while users scroll down to fill rows.
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Per-column filter + sort dropdowns anchored on the HEADER ROW. Excel
  // renders the little arrow on each header cell so the user can filter /
  // sort any column inline without leaving the spreadsheet. Range spans
  // A1 to the last header column on row 1 — Excel automatically extends
  // the filter to all data rows below it.
  const lastColLetter = ws.getColumn(HEADERS.length).letter;
  ws.autoFilter = `A1:${lastColLetter}1`;

  // ---- Allowed Values reference sheet (replaces in-cell dropdowns) ----
  // We deliberately do NOT add Excel data-validation lists. They render
  // unreliably in Google Sheets, LibreOffice, mobile Excel etc., and the
  // server validates strictly on import anyway. A visible reference sheet
  // is portable across every spreadsheet app.
  buildAllowedValuesSheet(wb, { stages, subStagesByStageName, countries });

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
  para('Required per row: at least one of email / first_name / last_name, at least one of whatsapp_number / phone, plus stage. Sub-stage is required only when the chosen stage has sub-stages configured.');
  para('See the "Allowed Values" sheet for valid stage / sub_stage / country / gender / language entries.');
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

  addRule('first_name',          'One of email/first_name/last_name', 'Text',         'Free text. Trimmed on import.');
  addRule('last_name',           'One of email/first_name/last_name', 'Text',         'Free text.');
  addRule('email',               'One of email/first_name/last_name', 'Email format', 'Lowercased and used for duplicate detection. Invalid formats fail the row.');
  addRule('alternate_email',     'No',                                'Email format', 'Same format rules as email. Not used for duplicate detection.');
  addRule('phone',               'One of whatsapp_number/phone',      'Phone',        '10 digits, or with country code (+91...). Used for duplicate detection (exact match after normalization).');
  addRule('whatsapp_number',     'One of whatsapp_number/phone',      'Phone',        'Same format as phone. Used for duplicate detection.');
  addRule('alternate_contact',   'No',                               'Phone',        'Same format as phone.');
  addRule('gender',              'No',                               'Allowed value', 'Type one of Male / Female / Other / Prefer not to say. See "Allowed Values" sheet.');
  addRule('language',            'No',                               'Allowed value', 'Two-letter code (en, hi, mr, ta, te, kn, ml, gu, bn, pa). See "Allowed Values" sheet.');
  addRule('ug_degree',           'No',                               'Text (auto-create)', 'Free text. New degrees are added automatically (level=UG).');
  addRule('ug_specialization',   'No',                               'Text (auto-create)', 'Free text. New specializations are added automatically.');
  addRule('ug_university',       'No',                               'Text (auto-create)', 'Free text. New universities are added automatically. Casing is preserved on first use.');
  addRule('ug_graduation_year',  'No',                               'Year (1950–2100)',   'Whole number, e.g. 2023.');
  addRule('pg_degree',           'No',                               'Text (auto-create)', 'Free text. New degrees are added automatically (level=PG).');
  addRule('pg_specialization',   'No',                               'Text (auto-create)', 'Free text.');
  addRule('pg_university',       'No',                               'Text (auto-create)', 'Free text.');
  addRule('pg_graduation_year',  'No',                               'Year (1950–2100)',   'Whole number, e.g. 2025.');
  addRule('country',             'No',                               'Allowed value (strict)',  'Type a country exactly as listed on the "Allowed Values" sheet. Unknown values fail the row.');
  addRule('state',               'No',                               'Text (auto-create)', 'Free text. Requires a valid country in the same row. New states are added automatically scoped to that country.');
  addRule('district',            'No',                               'Text',         'Free text.');
  addRule('city',                'No',                               'Text',         'Free text.');
  addRule('address',             'No',                               'Text',         'Free text. Long values are stored as-is.');
  addRule('pincode',             'No',                               'Number',       'Postal code. Stored as text on the lead.');
  addRule('program',             'No',                               'Text (auto-create)', 'Free text. New programs are added automatically.');
  addRule('stage',               'Yes',                              'Allowed value (strict)',  'Type a stage name exactly as listed on the "Allowed Values" sheet. Unknown values fail the row.');
  addRule('sub_stage',           'Conditional',                      'Allowed value (strict)',  'Required only when the chosen stage has sub-stages configured. If the stage has none, leave blank. If provided, must match a sub-stage under its parent stage on the "Allowed Values" sheet.');
  addRule('remarks',             'No',                               'Text',         'Free text.');
  addRule('followup_scheduled_on','No',                              'Date (DD-MM-YYYY HH:mm:ss)', 'Upcoming follow-up. Creates a planned row in lead_followups. Example: 20-05-2026 18:00:00.');
  addRule('followup_comments',   'No',                               'Text',         'Comment for the upcoming follow-up. Stored on the same lead_followups row.');
  addRule('next_action_date_1',  'No',                               'Date (DD-MM-YYYY HH:mm:ss)', 'Past follow-up attempt #1 (most recent). Creates a "done" lead_followups row.');
  addRule('comment_1',           'No',                               'Text',         'Comment for past follow-up attempt #1.');
  addRule('next_action_date_2',  'No',                               'Date (DD-MM-YYYY HH:mm:ss)', 'Past follow-up attempt #2. Same shape as #1.');
  addRule('comment_2',           'No',                               'Text',         'Comment for past follow-up attempt #2.');
  addRule('next_action_date_3',  'No',                               'Date (DD-MM-YYYY HH:mm:ss)', 'Past follow-up attempt #3.');
  addRule('comment_3',           'No',                               'Text',         'Comment for past follow-up attempt #3.');
  addRule('next_action_date_4',  'No',                               'Date (DD-MM-YYYY HH:mm:ss)', 'Past follow-up attempt #4.');
  addRule('comment_4',           'No',                               'Text',         'Comment for past follow-up attempt #4.');
  addRule('next_action_date_5',  'No',                               'Date (DD-MM-YYYY HH:mm:ss)', 'Past follow-up attempt #5 (oldest).');
  addRule('comment_5',           'No',                               'Text',         'Comment for past follow-up attempt #5.');
  addRule('lead_created_on',     'No',                               'Date (DD-MM-YYYY HH:mm:ss)', 'Optional. If provided, used as the lead.created_at value. Blank → server uses now().');
  addRule('lead_updated_on',     'No',                               'Date (DD-MM-YYYY HH:mm:ss)', 'Optional. If provided, used as the lead.updated_at value.');
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
  addRule('primary_source',      'No',                               'Text (auto-create)', 'Primary marketing source dictionary — separate from `source`. Auto-created on first use. Stored directly on the lead (not as attribution row).');
  addRule('campaign',            'No',                               'Text (auto-create)', 'Marketing campaign name. New entries created on first use.');
  addRule('medium',              'No',                               'Text (auto-create)', 'Marketing medium — e.g. CPC / Organic / Free. New entries created on first use.');
  addRule('current_lead_owner_email', 'No',                          'Email',              'Any active user email. Counsellor → direct assign. Sales-manager → round-robin within their team. Super-admin → round-robin across the tenant. Interchangeable with assigned_to_email; if both are set they must point to the SAME user (OWNER_MISMATCH otherwise).');
  addRule('previous_lead_owner_email', 'No',                         'Email',              'Any active user (any role). Recorded as prior owner in the lead\'s ownership history — does NOT affect current assignment.');
  addRule('assigned_to_email',   'No',                               'Email',              'Same semantics as current_lead_owner_email. Counsellor → direct; sales-manager → RR within team; super-admin → RR tenant-wide. Both columns blank → end-of-upload auto-assignment rule picks an owner.');
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
  para('  MISSING_IDENTITY — none of email / first_name / last_name filled.');
  para('  MISSING_CONTACT — none of whatsapp_number / phone filled.');
  para('  MISSING_STAGE — stage column is empty.');
  para('  MISSING_SUBSTAGE — sub_stage column is empty AND the chosen stage has sub-stages configured.');
  para('  INVALID_EMAIL / INVALID_ALTERNATE_EMAIL — email format is wrong.');
  para('  INVALID_PHONE / INVALID_WHATSAPP — phone digits or length wrong.');
  para('  INVALID_YEAR — graduation year outside 1950–2100.');
  para('  STAGE_NOT_FOUND — stage value isn\'t in your institute\'s stage list.');
  para('  SUBSTAGE_WITHOUT_STAGE — sub_stage filled but stage missing.');
  para('  SUBSTAGE_MISMATCH — sub_stage doesn\'t belong under the chosen stage.');
  para('  COUNTRY_NOT_FOUND — country isn\'t in your institute\'s country list.');
  para('  STATE_NEEDS_COUNTRY — state filled but country missing or invalid.');
  para('  INVALID_DATE — a date column (followup_scheduled_on, next_action_date_1..5, lead_created_on, lead_updated_on) is not in DD-MM-YYYY HH:mm:ss format.');
  para('  OWNER_MISMATCH — assigned_to_email and current_lead_owner_email are both set but point to different users. Leave one blank or make them match.');
  para('  OWNER_NOT_FOUND — assigned_to_email / current_lead_owner_email doesn\'t match any active user in this tenant.');
  para('  PREVIOUS_OWNER_NOT_FOUND — previous_lead_owner_email doesn\'t match any active user in this tenant.');
  para('  ROW_FAILED — generic insert failure (rare). Open the row to see the database error.');

  blank();
  heading('Owner columns — how each behaves', 13);
  blank();
  para('There are three optional owner columns. Use the one that fits your workflow:');
  para('  • current_lead_owner_email — Any active user email. Counsellor → direct assignment (manager_id snapped from their manager). Sales-manager → round-robin across their team. Super-admin → round-robin across the whole tenant. Interchangeable with assigned_to_email below.');
  para('  • previous_lead_owner_email — Any active user (any role). Recorded as prior owner in lead_assignments history; doesn\'t affect current assignment.');
  para('  • assigned_to_email — Same role-aware routing as current_lead_owner_email:');
  para('       - counsellor email → assigns directly to that counsellor.');
  para('       - sales_manager email → round-robins across that manager\'s counsellors within the upload.');
  para('       - super_admin email → round-robins across every counsellor + sales_manager in the tenant (excluding the admin themselves).');
  para('  • All three blank → lead lands unassigned; the active auto-assignment rule picks it up at end-of-upload.');
  para('  • Setting BOTH assigned_to_email and current_lead_owner_email to DIFFERENT emails fails with OWNER_MISMATCH. If they match (case-insensitive trim) they\'re treated as one and the same.');

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
