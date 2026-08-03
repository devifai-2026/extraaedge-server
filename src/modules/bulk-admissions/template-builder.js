// Generates the historical-admission import template live from the tenant's
// own data — courses, centers, branches and, most importantly, the list of
// active counsellors with their emails.
//
// That counsellor list is the whole reason this sheet is generated rather
// than shipped static: the CRMs institutes migrate off export a "Guided By"
// column holding a first name ("Sakshi", "Divya N"), which matches nothing.
// Putting `Name — email` on the Allowed Values sheet turns an unmappable
// column into a copy-paste job.
//
// Same three-sheet layout as the counsellor bulk-lead template, and the same
// deliberate choice NOT to emit Excel data-validation dropdowns: they render
// unreliably in Google Sheets / LibreOffice / mobile Excel, and the server
// validates strictly on import anyway. See bulk-ingestion/template-builder.js
// for the full history behind that decision.
import ExcelJS from 'exceljs';
import {
  HEADERS, EXAMPLE_ROW, EMI_SLOTS, EDU_SLOTS,
  TRAINING_MODES, ADMISSION_STATUSES, PAYMENT_MODES, COLLECTION_MODES,
  GRADE_UNITS, GENDERS,
} from './columns.js';

const HEADER_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF3ED' } };
const SECTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E6' } };
const BORDER = {
  top:    { style: 'thin', color: { argb: 'FFE5E5E5' } },
  left:   { style: 'thin', color: { argb: 'FFE5E5E5' } },
  bottom: { style: 'thin', color: { argb: 'FFE5E5E5' } },
  right:  { style: 'thin', color: { argb: 'FFE5E5E5' } },
};

// ---------------------------------------------------------------------------
// Sheet 2 — Allowed Values
// ---------------------------------------------------------------------------
const buildAllowedValuesSheet = (wb, { counsellors, courses, centers, branches, paymentAccounts }) => {
  const sh = wb.addWorksheet('Allowed Values');
  [38, 34, 26, 22, 20, 18].forEach((w, i) => { sh.getColumn(i + 1).width = w; });

  const title = sh.addRow(['Allowed Values — copy these into the Admissions sheet']);
  title.font = { bold: true, size: 14 };
  sh.mergeCells(`A${title.number}:F${title.number}`);
  sh.addRow(['lead_owner_email, mode_of_training, status, mode_of_payment, collection_mode, grade unit, branch and payment_account are STRICT — they must match exactly.']);
  sh.addRow(['course and center are free text: a name that does not exist yet is created automatically on import.']);
  sh.addRow([]);

  // ---- Counsellors (the "Guided By" mapping) ----
  const cHdr = sh.addRow(['Counsellor (paste the EMAIL into "lead_owner_email")', 'Email']);
  cHdr.font = { bold: true };
  cHdr.eachCell((c) => { c.fill = HEADER_FILL; c.border = BORDER; });
  if (!counsellors.length) {
    const r = sh.addRow(['(no active counsellors configured yet)', '']);
    r.eachCell((c) => { c.border = BORDER; });
  }
  for (const u of counsellors) {
    const r = sh.addRow([u.name || '(unnamed)', u.email]);
    r.getCell(1).fill = SECTION_FILL;
    r.eachCell((c) => { c.border = BORDER; });
  }
  sh.addRow(['(leave lead_owner_email blank for students no counsellor owns — e.g. an "Others" row in your export)']);
  sh.addRow([]);

  // ---- Courses / centers / branches / payment accounts, side by side ----
  const listHdr = sh.addRow([
    'Course (column "course")',
    'Center (column "center")',
    'Branch (column "branch")',
    'Payment account (column "payment_account")',
  ]);
  listHdr.font = { bold: true };
  listHdr.eachCell((c) => { c.fill = HEADER_FILL; c.border = BORDER; });

  const listMax = Math.max(courses.length, centers.length, branches.length, paymentAccounts.length, 1);
  for (let i = 0; i < listMax; i += 1) {
    const r = sh.addRow([
      courses[i] || '', centers[i] || '', branches[i] || '', paymentAccounts[i] || '',
    ]);
    r.eachCell((c) => { c.border = BORDER; });
  }
  sh.addRow([]);

  // ---- Fixed enums ----
  const enumHdr = sh.addRow([
    'mode_of_training', 'status', 'mode_of_payment',
    'collection_mode', 'edu_*_grade_unit', 'gender',
  ]);
  enumHdr.font = { bold: true };
  enumHdr.eachCell((c) => { c.fill = HEADER_FILL; c.border = BORDER; });

  const enumCols = [TRAINING_MODES, ADMISSION_STATUSES, PAYMENT_MODES, COLLECTION_MODES, GRADE_UNITS, GENDERS];
  const enumMax = Math.max(...enumCols.map((c) => c.length));
  for (let i = 0; i < enumMax; i += 1) {
    const r = sh.addRow(enumCols.map((col) => col[i] || ''));
    r.eachCell((c) => { c.border = BORDER; });
  }

  sh.views = [{ state: 'frozen', ySplit: 1 }];
  return sh;
};

// ---------------------------------------------------------------------------
// Sheet 3 — Instructions
// ---------------------------------------------------------------------------
const buildInstructionsSheet = (wb) => {
  const sh = wb.addWorksheet('Instructions');
  sh.getColumn(1).width = 26;
  sh.getColumn(2).width = 16;
  sh.getColumn(3).width = 30;
  sh.getColumn(4).width = 78;

  const heading = (text, size = 14) => {
    const r = sh.addRow([text]);
    r.font = { bold: true, size };
  };
  const para = (text) => sh.addRow([text]);
  const blank = () => sh.addRow([]);

  heading('Historical admission import — how to fill this template', 16);
  blank();
  para('Fill rows on the "Admissions" sheet only. Do not edit, reorder or rename the header row.');
  para('ONE ROW PER STUDENT. If your old system exported one row per pending installment, merge those rows: the student appears once, and each installment goes into its own emi_N_* column group.');
  para(`Up to ${EMI_SLOTS} installments and ${EDU_SLOTS} qualifications per student — the same ${EMI_SLOTS} installments a fee plan supports everywhere else in the system.`);
  para('Every row creates: the lead (at your Enrolled stage), the admission, its EMI schedule, and a receipt for each amount already collected. Collected amounts are tagged as "old collection" so they are separated from money taken inside this system.');
  para('A student who is NOT in your CRM yet is created from scratch — you do not need to add them as a lead first. They are created already enrolled, owned by whoever you put in lead_owner_email, and are NOT sent to your auto-assignment rule (this is history, not a new enquiry).');
  para('See the "Allowed Values" sheet for counsellor emails, courses, centers and the fixed dropdown values.');
  para('Maximum 30,000 rows per upload.');
  blank();

  heading('Dates and numbers', 13);
  blank();
  para('All date columns use DD-MM-YYYY (e.g. 20-07-2026). A real Excel date cell also works — the importer reads it as Indian Standard Time.');
  para('All amount columns are plain numbers. No currency symbols, no thousands separators. Leave blank rather than typing 0 when a value is genuinely unknown.');
  blank();

  heading('The money rule (read this one)', 13);
  blank();
  para('registration_amount is the AGREED registration component. registration_paid_amount is how much of it has ACTUALLY been collected.');
  para('  • paid in full  → registration_paid_amount = registration_amount');
  para('  • part paid     → registration_paid_amount is lower (a receipt is created for what was paid; the rest stays outstanding)');
  para('  • still due     → registration_paid_amount = 0 or blank (no receipt is created)');
  para('The same applies per installment: emi_N_amount is what is owed on that date, emi_N_paid_amount is what has been collected against it.');
  blank();
  para('When mode_of_payment = Installment, this must balance exactly:');
  para('    registration_amount + emi_1_amount + emi_2_amount + … = course_fees');
  para('Off by more than 0.01 and the row fails with FEE_MATH_MISMATCH.');
  para('When mode_of_payment = Full, leave every emi_N_* column blank and put the whole fee in registration_amount (or leave registration_amount blank and record what was collected in registration_paid_amount).');
  blank();
  para('paid_till_date is OPTIONAL and is only a safety net: if you fill it, it must equal registration_paid_amount + every emi_N_paid_amount. It exists so a typo in one installment gets caught instead of silently importing. Leave it blank to skip the check.');
  blank();

  heading('Installment slots must be contiguous', 13);
  blank();
  para('Fill emi_1 before emi_2, emi_2 before emi_3, and so on. A gap (emi_3 filled while emi_2 is blank) fails the row with EMI_GAP — it almost always means a column got shifted.');
  blank();

  heading('UTR / transaction reference', 13);
  blank();
  para('registration_utr and emi_N_utr hold the bank or UPI reference for that specific collection. Leave blank for cash.');
  para('A UTR IS UNIQUE. It identifies one real transaction, so the same value can never appear on two receipts:');
  para('  • the same UTR twice in this file → both rows fail with DUPLICATE_UTR (this is what catches a cell dragged down a column)');
  para('  • a UTR that is already on a receipt in this system → the row fails with UTR_ALREADY_USED');
  para('The check is case-insensitive, so 412345678901 and 412345678901 are the same reference whatever the casing of any letters in it.');
  blank();
  para('Receipt numbers are NOT taken from this sheet — this system mints its own (per your Settings → Receipt numbering) so the sequence stays unbroken. Put your old system\'s receipt or reference number in the matching *_utr column and it stays searchable against the payment.');
  blank();

  heading('Photos and payment proofs', 13);
  blank();
  para('Three image columns, all optional:');
  para('  • photo — the student\'s photo, shown on the admission.');
  para('  • registration_proof — the screenshot / slip for the registration payment.');
  para('  • emi_N_proof — the screenshot / slip for that installment\'s payment.');
  blank();
  para('Each one accepts whichever of these three suits you — mix them freely, even within one sheet:');
  para('  1. PASTE THE IMAGE straight into the cell (Insert → Picture → Place in cell). Nothing to name, nothing to keep in sync. Best for a small batch.');
  para('  2. PASTE A LINK to the image (https://…). We download a copy into your CRM, so the record survives the original link later being deleted or made private. Google Drive and Dropbox share links work — just make sure the file is set to "anyone with the link can view".');
  para('  3. TYPE THE FILE NAME (e.g. payal-khatri.jpg) and attach those image files in the picker on the upload screen. Names are matched ignoring case. Best for hundreds of images, where pasting them all in would make this workbook too heavy to open.');
  blank();
  para('If a cell has both a pasted image and a link/name, the pasted image wins.');
  para('A cell we cannot resolve fails the row with PHOTO_NOT_FOUND or PROOF_NOT_FOUND and says why — a typo, a dead link or a private file is never silently ignored.');
  para('You can also leave all of them blank and attach images later from the admission screen.');
  blank();

  heading('Column reference', 13);
  blank();

  const tableHeader = sh.addRow(['Column', 'Required', 'Type / format', 'Notes']);
  tableHeader.font = { bold: true };
  tableHeader.fill = HEADER_FILL;

  const addRule = (col, required, type, note) => {
    const r = sh.addRow([col, required, type, note]);
    r.alignment = { vertical: 'top', wrapText: true };
    r.eachCell((c) => { c.border = BORDER; });
  };

  addRule('first_name',              'Yes',        'Text',                    'Given name. Combined with last_name for the lead + admission name.');
  addRule('middle_name',             'No',         'Text',                    '');
  addRule('last_name',               'No',         'Text',                    'Recommended — the admission form treats it as required, so a blank here leaves a gap to fill later.');
  addRule('email',                   'Conditional', 'Email format',           'Required unless whatsapp_number is filled. Used for duplicate detection and, later, for the student portal login.');
  addRule('whatsapp_number',         'Conditional', 'Phone',                  'Required unless email is filled. 10 digits or +91 form. Used for duplicate detection.');
  addRule('alternate_contact',       'No',         'Phone',                   'Second number. If your export packs both into one cell as "9876543210/9123456780", split them across whatsapp_number and this column.');
  addRule('gender',                  'No',         'Allowed value',           'Male / Female / Other / Prefer not to say.');
  addRule('address',                 'No',         'Text',                    'Stored on both the lead and the admission.');
  addRule('city',                    'No',         'Text',                    '');
  addRule('state',                   'No',         'Text (auto-create)',      'Requires country in the same row. New states are created scoped to that country.');
  addRule('country',                 'No',         'Strict',                  'Must already exist under Settings → Dropdowns → Countries.');
  addRule('pincode',                 'No',         'Text / number',           '');
  addRule('lead_owner_email',        'No',         'Counsellor email',        'The "Guided By" counsellor. MUST be an active counsellor — a manager or admin email fails with OWNER_NOT_COUNSELLOR. Blank leaves the student unassigned (use this for "Others" rows); the lead is NOT handed to your auto-assignment rule.');
  addRule('branch',                  'No',         'Strict',                  'Must match an existing branch. Blank when you do not use branches.');
  addRule('admission_date',          'Yes',        'Date (DD-MM-YYYY)',       'The real historical admission date. Also backdates the lead so reports read correctly.');
  addRule('course',                  'Yes',        'Text (auto-create)',      'Course / program name. Created automatically if new.');
  addRule('mode_of_training',        'Yes',        'Allowed value (strict)',  'Online / Offline / Hybrid.');
  addRule('center',                  'No',         'Text (auto-create)',      'Created automatically if new.');
  addRule('status',                  'Yes',        'Allowed value (strict)',  `${ADMISSION_STATUSES.join(' / ')}. Anything other than pending_approval is imported as already approved, so it shows in reports immediately.`);
  addRule('break_reason',            'No',         'Text',                    'Only meaningful when status = on_break.');
  addRule('source',                  'No',         'Text',                    'Free text, e.g. Walk-in / Referral.');
  addRule('edu_1_examination',       'No',         'Text',                    'e.g. B.E. / B.Sc / HSC. The whole edu_1 group is ignored when this is blank.');
  addRule('edu_1_stream',            'No',         'Text',                    'e.g. Computer / IT / E&TC.');
  addRule('edu_1_college',           'No',         'Text',                    '');
  addRule('edu_1_board_university',  'No',         'Text',                    '');
  addRule('edu_1_year',              'No',         'Year (1900–2100)',        '');
  addRule('edu_1_grade',             'No',         'Number',                  '0–100 when grade unit is percent, 0–10 when cgpa.');
  addRule('edu_1_grade_unit',        'No',         'Allowed value',           'percent (default) or cgpa.');
  addRule('edu_2_*',                 'No',         'Same as edu_1_*',         'Second qualification. Same seven columns.');
  addRule('photo',                   'No',         'Image',                   'The student\'s photo. Paste the image into the cell, give an https link to it, or type the name of a file attached on the upload screen. See "Photos and payment proofs" above.');
  addRule('course_fees',             'Yes',        'Number',                  'Total agreed fee. Lands on the admission and drives the Pending Fees figure in reports.');
  addRule('mode_of_payment',         'Yes',        'Allowed value (strict)',  'Installment or Full.');
  addRule('collection_mode',         'No',         'Allowed value',           `How the already-collected money was taken (${COLLECTION_MODES.join(' / ')}). Applies to every receipt this row creates. Defaults to cash.`);
  addRule('payment_account',         'No',         'Strict',                  'Which of your bank / UPI accounts the money was received into. Must match a payment account on the "Allowed Values" sheet. Applies to every receipt this row creates.');
  addRule('registration_amount',     'No',         'Number',                  'The agreed registration component. Counts towards the balance rule above.');
  addRule('registration_paid_amount', 'No',        'Number',                  'How much of the registration has actually been collected. Creates one registration receipt when above 0. Must not exceed registration_amount.');
  addRule('registration_paid_date',  'No',         'Date (DD-MM-YYYY)',       'Receipt date. Falls back to admission_date when blank.');
  addRule('registration_utr',        'No',         'Text, unique',            'Bank / UPI reference for the registration payment. Must be unique across this file AND against every receipt already in the system. Leave blank for cash.');
  addRule('registration_proof', 'No',        'Image',                   'Screenshot / slip for the registration payment. Same three options as photo.');
  addRule('emi_1_due_date',          'No',         'Date (DD-MM-YYYY)',       'When installment 1 is due. Required whenever emi_1_amount is filled.');
  addRule('emi_1_amount',            'No',         'Number',                  'What is owed on that date. Required whenever emi_1_due_date is filled.');
  addRule('emi_1_paid_amount',       'No',         'Number',                  'Collected against installment 1. Creates one installment receipt when above 0. Must not exceed emi_1_amount. Blank or 0 = still due.');
  addRule('emi_1_paid_date',         'No',         'Date (DD-MM-YYYY)',       'Receipt date for that collection. Falls back to the due date when blank.');
  addRule('emi_1_utr',               'No',         'Text, unique',            'Bank / UPI reference for that collection. Same uniqueness rule as registration_utr. Leave blank for cash.');
  addRule('emi_1_proof',             'No',         'Image',                   'Screenshot / slip for that collection. Same three options as photo.');
  addRule(`emi_2_* … emi_${EMI_SLOTS}_*`, 'No',    'Same as emi_1_*',         'Further installments — the same six columns each. Fill them in order — no gaps.');
  addRule('paid_till_date',          'No',         'Number',                  'Optional cross-check. Must equal every paid amount on the row added together. Leave blank to skip.');

  blank();
  heading('Duplicate handling', 13);
  blank();
  para('A row is a duplicate when its email or whatsapp_number already belongs to a lead in this CRM.');
  para('  • Attach to existing lead (default) — no second lead is created; the admission is attached to the lead already on file. This is what you want for a migration.');
  para('  • Skip — the row is not imported at all and is listed under the import failures.');
  para('A student who already has an admission in this system is never given a second one — the row fails with ADMISSION_EXISTS. That makes re-uploading the same corrected file safe.');
  blank();

  heading('What you will see if a row fails', 13);
  blank();
  para('Failed rows are listed on the import result with the row number and one of these codes:');
  para('  MISSING_IDENTITY — first_name is blank.');
  para('  MISSING_CONTACT — both email and whatsapp_number are blank.');
  para('  INVALID_EMAIL / INVALID_PHONE — the value is not a usable email / phone number.');
  para('  INVALID_DATE — a date column is not DD-MM-YYYY and is not a real Excel date cell.');
  para('  INVALID_NUMBER — an amount column contains something that is not a number.');
  para('  MISSING_ADMISSION_DATE / MISSING_COURSE / MISSING_COURSE_FEES — a required column is blank.');
  para('  INVALID_STATUS / INVALID_TRAINING_MODE / INVALID_PAYMENT_MODE / INVALID_COLLECTION_MODE / INVALID_GRADE_UNIT — value is not on the Allowed Values sheet.');
  para('  INVALID_GRADE / INVALID_YEAR — grade outside its scale, or a year outside 1900–2100.');
  para('  EMI_GAP — an installment slot was skipped.');
  para('  EMI_INCOMPLETE — an installment has an amount without a due date, or a due date without an amount.');
  para('  FEE_MATH_MISMATCH — registration + installments does not equal course_fees.');
  para('  PAID_EXCEEDS_DUE — a paid amount is larger than what was owed.');
  para('  PAID_MISMATCH — paid_till_date does not match the individual paid amounts.');
  para('  DUPLICATE_UTR — the same UTR appears on more than one payment in this file.');
  para('  UTR_ALREADY_USED — that UTR is already on a receipt in this system.');
  para('  COUNTRY_NOT_FOUND / STATE_NEEDS_COUNTRY / BRANCH_NOT_FOUND / PAYMENT_ACCOUNT_NOT_FOUND — a strict lookup did not match.');
  para('  OWNER_NOT_FOUND — lead_owner_email is not an active user here.');
  para('  OWNER_NOT_COUNSELLOR — lead_owner_email belongs to a manager or admin. Use the counsellor who actually guided the student.');
  para('  PHOTO_NOT_FOUND / PROOF_NOT_FOUND — a file-name column does not match any attached image.');
  para('  DUPLICATE_SKIPPED — the student already exists and you chose Skip.');
  para('  ADMISSION_EXISTS — that student already has an admission in this system.');
  para('  ROW_FAILED — an unexpected database error. Open the row to see the detail.');

  return sh;
};

// ---------------------------------------------------------------------------
export const buildTemplateXlsx = async (lookups) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ExtraaEdge';
  wb.created = new Date();

  const ws = wb.addWorksheet('Admissions');
  ws.addRow(HEADERS);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = HEADER_FILL;
  HEADERS.forEach((h, i) => { ws.getColumn(i + 1).width = Math.max(16, Math.min(26, h.length + 4)); });
  ws.addRow(EXAMPLE_ROW);
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // Per-column filter/sort arrows on the header row. Excel extends the
  // filter to every data row below automatically.
  ws.autoFilter = `A1:${ws.getColumn(HEADERS.length).letter}1`;

  buildAllowedValuesSheet(wb, lookups);
  buildInstructionsSheet(wb);

  return wb.xlsx.writeBuffer();
};

// Read everything the template needs from the tenant DB in one round of
// parallel queries. Takes tenantQuery + tenant from the callsite so the
// route can hand over its own req.tenant.
export const loadTemplateLookups = async (tenantQuery, tenant) => {
  const [counsellorsRes, coursesRes, centersRes, branchesRes, paymentAccountsRes] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT name, email FROM users
        WHERE role = 'counsellor' AND is_active = true AND deleted_at IS NULL
        ORDER BY name NULLS LAST, email`,
    ),
    tenantQuery(
      tenant,
      `SELECT name FROM programs
        WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true
        ORDER BY name`,
    ),
    tenantQuery(
      tenant,
      `SELECT name FROM admission_centers
        WHERE deleted_at IS NULL AND is_active = true
        ORDER BY sort_order, name`,
    ),
    tenantQuery(
      tenant,
      `SELECT name FROM branches WHERE deleted_at IS NULL ORDER BY name`,
    ).catch(() => ({ rows: [] })),
    tenantQuery(
      tenant,
      `SELECT label, upi_id, bank_name, account_number FROM payment_accounts
        WHERE deleted_at IS NULL AND is_active = true
        ORDER BY is_primary DESC, label NULLS LAST`,
    ).catch(() => ({ rows: [] })),
  ]);
  return {
    counsellors: counsellorsRes.rows,
    courses: coursesRes.rows.map((r) => r.name),
    centers: centersRes.rows.map((r) => r.name),
    branches: branchesRes.rows.map((r) => r.name),
    // `label` is optional on payment_accounts, so fall back to something a
    // human can still recognise and the resolver can still match on.
    paymentAccounts: paymentAccountsRes.rows
      .map((r) => r.label || r.upi_id || [r.bank_name, r.account_number].filter(Boolean).join(' '))
      .filter(Boolean),
  };
};
