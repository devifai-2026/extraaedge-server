// Resolves the human-readable dropdown values on an admission-import row
// into the FK columns `leads` / `admissions` expect.
//
// Same two policies as the lead importer (bulk-ingestion/resolver.js):
//   STRICT      — must already exist; missing → the row fails with a clean
//                 message. Used for country and branch, which are small,
//                 admin-curated lists where a typo is a mistake, not intent.
//   AUTO_CREATE — missing values are inserted. Used for course, center and
//                 state, where a migration legitimately brings in names this
//                 CRM has never seen.
//
// One `createCache()` per import job: each dropdown is read at most once,
// and anything auto-created is immediately reusable by later rows.
//
// Matching is case- and whitespace-insensitive; inserted rows keep the
// spelling the operator typed.
import { tenantQuery } from '../../db/tenant.js';

const norm = (s) => (s ?? '').toString().trim().toLowerCase().replace(/\s+/gu, ' ');
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';

export const createCache = () => ({
  loaded: new Set(),
  data: {
    country: new Map(),
    state_by_country: new Map(), // `${country_id}::${name}` -> id
    program: new Map(),
    center: new Map(),
    branch: new Map(),
    payment_account: new Map(),
    // The tenant's success stage + a sub-stage under it. Resolved once per
    // job; see resolveEnrolledStage below for why it isn't a sheet column.
    enrolled: undefined,
  },
});

const ensureLoaded = async (tenant, cache, key, sql, intoMap) => {
  if (cache.loaded.has(key)) return;
  const { rows } = await tenantQuery(tenant, sql);
  for (const r of rows) intoMap(r);
  cache.loaded.add(key);
};

const loadCountries = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'country', `SELECT id, name FROM countries WHERE deleted_at IS NULL`,
    (r) => cache.data.country.set(norm(r.name), r.id));

const loadStates = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'state', `SELECT id, name, country_id FROM states WHERE deleted_at IS NULL`,
    (r) => cache.data.state_by_country.set(`${r.country_id}::${norm(r.name)}`, r.id));

const loadPrograms = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'program', `SELECT id, name FROM programs WHERE deleted_at IS NULL`,
    (r) => cache.data.program.set(norm(r.name), r.id));

const loadCenters = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'center', `SELECT id, name FROM admission_centers WHERE deleted_at IS NULL`,
    (r) => cache.data.center.set(norm(r.name), r.id));

const loadBranches = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'branch', `SELECT id, name FROM branches WHERE deleted_at IS NULL`,
    (r) => cache.data.branch.set(norm(r.name), r.id));

// payment_accounts.label is nullable, so index every identifier a human might
// reasonably paste — the same three the template's Allowed Values sheet
// renders. Matching any one of them resolves the account.
const loadPaymentAccounts = (tenant, cache) =>
  ensureLoaded(
    tenant, cache, 'payment_account',
    `SELECT id, label, upi_id, bank_name, account_number FROM payment_accounts
      WHERE deleted_at IS NULL AND is_active = true`,
    (r) => {
      for (const alias of [r.label, r.upi_id, [r.bank_name, r.account_number].filter(Boolean).join(' ')]) {
        if (alias && String(alias).trim()) cache.data.payment_account.set(norm(alias), r.id);
      }
    },
  );

const autoCreateState = async (tenant, country_id, name) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO states (country_id, name) VALUES ($1, $2)
     ON CONFLICT (country_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [country_id, name],
  );
  return rows[0].id;
};

// programs.name is not unique (only programs.code is), so we check-then-insert
// rather than ON CONFLICT. Same approach — and same accepted race — as the
// lead importer's autoCreateProgram.
const autoCreateProgram = async (tenant, name) => {
  const { rows: existing } = await tenantQuery(
    tenant,
    `SELECT id FROM programs WHERE lower(name) = lower($1) AND deleted_at IS NULL LIMIT 1`,
    [name],
  );
  if (existing[0]) return existing[0].id;
  const { rows } = await tenantQuery(tenant, `INSERT INTO programs (name) VALUES ($1) RETURNING id`, [name]);
  return rows[0].id;
};

// admission_centers has a partial unique index on lower(name), which
// ON CONFLICT can't target — so check-then-insert here too.
const autoCreateCenter = async (tenant, name) => {
  const { rows: existing } = await tenantQuery(
    tenant,
    `SELECT id FROM admission_centers WHERE lower(name) = lower($1) AND deleted_at IS NULL LIMIT 1`,
    [name],
  );
  if (existing[0]) return existing[0].id;
  const { rows } = await tenantQuery(tenant, `INSERT INTO admission_centers (name) VALUES ($1) RETURNING id`, [name]);
  return rows[0].id;
};

// The stage every imported student lands on.
//
// There is deliberately no `stage` / `sub_stage` column on this sheet. Every
// row in a historical-admission import is by definition an enrolled student,
// so asking the operator to type the stage adds a column that can only be got
// wrong. We resolve the tenant's own success stage instead (leads.repo stamps
// converted_at off is_success), and pick its first sub-stage because
// insertLead rejects a stage that has sub-stages configured without one.
//
// Returns { stage_id, sub_stage_id } or null when the tenant has no success
// stage at all — the caller turns that into a whole-import failure, since
// every row would fail identically.
export const resolveEnrolledStage = async (tenant, cache) => {
  if (cache.data.enrolled !== undefined) return cache.data.enrolled;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM lead_stages
      WHERE is_success = true AND deleted_at IS NULL AND is_active = true
      ORDER BY order_index, name
      LIMIT 1`,
  );
  const stage_id = rows[0]?.id ?? null;
  if (!stage_id) {
    cache.data.enrolled = null;
    return null;
  }
  const { rows: subs } = await tenantQuery(
    tenant,
    `SELECT id FROM lead_sub_stages
      WHERE stage_id = $1 AND deleted_at IS NULL AND is_active = true
      ORDER BY order_index, name
      LIMIT 1`,
    [stage_id],
  );
  cache.data.enrolled = { stage_id, sub_stage_id: subs[0]?.id ?? null };
  return cache.data.enrolled;
};

// Returns { ok: true, resolved } or { ok: false, error: { code, message } }.
// `resolved` carries the *_id columns; the original name columns are dropped
// so nothing downstream tries to write a name into a uuid column.
export const resolveDropdowns = async (tenant, row, cache) => {
  const out = { ...row };
  const fail = (code, message) => ({ ok: false, error: { code, message } });

  // ---- COUNTRY (strict) ----
  if (!isEmpty(out.country)) {
    await loadCountries(tenant, cache);
    const id = cache.data.country.get(norm(out.country));
    if (!id) return fail('COUNTRY_NOT_FOUND', `Country "${out.country}" not found — add it under Settings → Dropdowns → Countries first`);
    out.country_id = id;
  }
  delete out.country;

  // ---- STATE (auto-create, requires country) ----
  if (!isEmpty(out.state)) {
    if (!out.country_id) return fail('STATE_NEEDS_COUNTRY', `State "${out.state}" provided but no valid country was set`);
    await loadStates(tenant, cache);
    const key = `${out.country_id}::${norm(out.state)}`;
    let id = cache.data.state_by_country.get(key);
    if (!id) {
      id = await autoCreateState(tenant, out.country_id, String(out.state).trim());
      cache.data.state_by_country.set(key, id);
    }
    out.state_id = id;
  }
  delete out.state;

  // ---- COURSE → program (auto-create) ----
  // Required: an admission with no course can't be priced, scheduled or
  // handed to the LMS, so we fail rather than importing a headless row.
  if (isEmpty(out.course)) return fail('MISSING_COURSE', 'course is required');
  {
    await loadPrograms(tenant, cache);
    const k = norm(out.course);
    let id = cache.data.program.get(k);
    if (!id) {
      id = await autoCreateProgram(tenant, String(out.course).trim());
      cache.data.program.set(k, id);
    }
    out.program_id = id;
  }
  delete out.course;

  // ---- CENTER (auto-create) ----
  if (!isEmpty(out.center)) {
    await loadCenters(tenant, cache);
    const k = norm(out.center);
    let id = cache.data.center.get(k);
    if (!id) {
      id = await autoCreateCenter(tenant, String(out.center).trim());
      cache.data.center.set(k, id);
    }
    out.center_id = id;
  }
  delete out.center;

  // ---- BRANCH (strict) ----
  // Branches drive visibility scoping for branch_managers, so silently
  // creating one from a typo would quietly widen or hide a manager's view.
  if (!isEmpty(out.branch)) {
    await loadBranches(tenant, cache);
    const id = cache.data.branch.get(norm(out.branch));
    if (!id) return fail('BRANCH_NOT_FOUND', `Branch "${out.branch}" not found — create it under Settings first`);
    out.branch_id = id;
  }
  delete out.branch;

  // ---- PAYMENT ACCOUNT (strict) ----
  // Applies to every receipt the row creates. Strict because "which account
  // did this money land in" is a reconciliation fact — inventing an account
  // from a typo would put real collections against a bank that doesn't exist.
  if (!isEmpty(out.payment_account)) {
    await loadPaymentAccounts(tenant, cache);
    const id = cache.data.payment_account.get(norm(out.payment_account));
    if (!id) return fail('PAYMENT_ACCOUNT_NOT_FOUND', `Payment account "${out.payment_account}" not found — copy one from the "Allowed Values" sheet`);
    out.payment_account_id = id;
  }
  delete out.payment_account;

  return { ok: true, resolved: out };
};
