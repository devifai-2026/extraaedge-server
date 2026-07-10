import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { randomToken } from '../../lib/crypto.js';

// ---------- Centers --------------------------------------------------------

export const listCenters = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, address, is_active, sort_order, created_at, updated_at
       FROM admission_centers
      WHERE deleted_at IS NULL
      ORDER BY sort_order ASC, name ASC`,
  );
  return rows;
};

export const findCenter = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT * FROM admission_centers WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
};

export const insertCenter = async (tenant, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO admission_centers (name, address, is_active, sort_order)
     VALUES ($1, $2, COALESCE($3, true), COALESCE($4, 0))
     RETURNING *`,
    [input.name, input.address ?? null, input.is_active, input.sort_order],
  );
  return rows[0];
};

export const updateCenter = async (tenant, id, patch) => {
  const fields = [];
  const params = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = $${i}`);
    params.push(v);
    i += 1;
  }
  if (!fields.length) return findCenter(tenant, id);
  params.push(id);
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE admission_centers SET ${fields.join(', ')}, updated_at = now()
      WHERE id = $${i} AND deleted_at IS NULL
      RETURNING *`,
    params,
  );
  return rows[0] || null;
};

export const softDeleteCenter = async (tenant, id) => {
  await tenantQuery(
    tenant,
    `UPDATE admission_centers SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
};

// ---------- Admissions ----------------------------------------------------

const ADMISSION_COLS = `
  a.id, a.admission_code, a.lead_id, a.admission_date,
  a.first_name, a.middle_name, a.last_name,
  a.email, a.whatsapp_number, a.alternate_contact, a.address,
  a.program_id, a.mode_of_training, a.center_id,
  a.total_fees, a.mode_of_payment,
  a.status, a.break_reason,
  a.selfie_r2_key, a.photo_r2_key,
  a.payment_proof_r2_key, a.payment_utr, a.payment_account_id,
  a.payment_amount, a.payment_verified_at, a.payment_verified_by,
  a.guided_by_counsellor_id, a.guided_by_manager_id, a.source,
  a.created_by, a.approved_by, a.approved_at,
  a.created_at, a.updated_at
`;

const ADMISSION_JOINS = `
  LEFT JOIN programs        p   ON p.id   = a.program_id
  LEFT JOIN admission_centers c ON c.id   = a.center_id
  LEFT JOIN users           u1  ON u1.id  = a.guided_by_counsellor_id
  LEFT JOIN users           u2  ON u2.id  = a.guided_by_manager_id
  LEFT JOIN payment_accounts pa ON pa.id  = a.payment_account_id
`;

const ADMISSION_NAMED_COLS = `
  p.name AS program_name,
  c.name AS center_name,
  u1.name AS guided_by_counsellor_name,
  u2.name AS guided_by_manager_name,
  pa.label AS payment_account_label,
  pa.bank_name AS payment_account_bank,
  pa.account_number AS payment_account_number,
  pa.ifsc AS payment_account_ifsc,
  pa.upi_id AS payment_account_upi
`;

export const list = async (tenant, q = {}) => {
  const conds = ['a.deleted_at IS NULL'];
  const params = [];
  if (q.status) { params.push(q.status); conds.push(`a.status = $${params.length}`); }
  // Counsellor scope (forced server-side in service.list): only their own
  // converted students.
  if (q.guided_by_counsellor_id) { params.push(q.guided_by_counsellor_id); conds.push(`a.guided_by_counsellor_id = $${params.length}`); }
  if (q.program_id) { params.push(q.program_id); conds.push(`a.program_id = $${params.length}`); }
  if (q.center_id) { params.push(q.center_id); conds.push(`a.center_id = $${params.length}`); }
  if (q.date_from) { params.push(q.date_from); conds.push(`a.admission_date >= $${params.length}`); }
  if (q.date_to) { params.push(q.date_to); conds.push(`a.admission_date <= $${params.length}`); }
  if (q.month) {
    // YYYY-MM → first day of month, < first day of next month
    const [y, m] = q.month.split('-').map(Number);
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const end = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
    params.push(start); conds.push(`a.admission_date >= $${params.length}`);
    params.push(end);   conds.push(`a.admission_date < $${params.length}`);
  }
  if (q.q) {
    params.push(`%${q.q}%`);
    conds.push(`(a.first_name ILIKE $${params.length} OR a.last_name ILIKE $${params.length} OR a.email ILIKE $${params.length} OR a.whatsapp_number ILIKE $${params.length})`);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const page = q.page || 1;
  const limit = q.limit || 50;
  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const [{ rows }, { rows: countRows }] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT ${ADMISSION_COLS}, ${ADMISSION_NAMED_COLS}
         FROM admissions a ${ADMISSION_JOINS}
         ${where}
         ORDER BY a.admission_date DESC, a.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    tenantQuery(tenant, `SELECT count(*)::int AS total FROM admissions a ${where}`, params.slice(0, -2)),
  ]);
  return { rows, total: countRows[0].total };
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${ADMISSION_COLS}, ${ADMISSION_NAMED_COLS}
       FROM admissions a ${ADMISSION_JOINS}
      WHERE a.id = $1 AND a.deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
};

export const findByIdWithRelations = async (tenant, id) => {
  const adm = await findById(tenant, id);
  if (!adm) return null;
  const [edu, fees, receipts, offer] = await Promise.all([
    tenantQuery(tenant, `SELECT * FROM admission_education WHERE admission_id = $1 ORDER BY sort_order, created_at`, [id]),
    tenantQuery(tenant, `SELECT * FROM admission_fee_schedule WHERE admission_id = $1 ORDER BY installment_no`, [id]),
    tenantQuery(tenant, `SELECT * FROM admission_receipts WHERE admission_id = $1 AND deleted_at IS NULL ORDER BY receipt_date DESC, created_at DESC`, [id]),
    // Per-lead fee offer carries registration_amount + installments. The
    // admission row itself only has total_fees, so without this join the
    // FE has no way to know how the total breaks down.
    adm.lead_id
      ? tenantQuery(
          tenant,
          `SELECT id, lead_id, program_id, course_fees, registration_amount,
                  payment_mode, fee_installments, created_at, updated_at
             FROM lead_fee_offers WHERE lead_id = $1 LIMIT 1`,
          [adm.lead_id],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const feeOffer = offer.rows[0] ?? null;
  // Aggregate the money side so the FE doesn't have to.
  const paid_till_date = receipts.rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  // Registration amount precedence:
  //   1. lead_fee_offers.registration_amount (authoritative — set by
  //      accounts when minting the offer).
  //   2. total_fees − Σ admission_fee_schedule.amount (legacy fallback
  //      for installment-mode admissions created before offers existed).
  //   3. null when neither is computable (e.g. Full-mode admission with
  //      no offer).
  let registration_amount = null;
  if (feeOffer && feeOffer.registration_amount != null) {
    registration_amount = Number(feeOffer.registration_amount);
  } else if (fees.rows.length) {
    const sumInst = fees.rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const synth = Number(adm.total_fees || 0) - sumInst;
    if (synth > 0.01) registration_amount = synth;
  }
  return {
    ...adm,
    education: edu.rows,
    fee_schedule: fees.rows,
    receipts: receipts.rows,
    fee_offer: feeOffer,
    registration_amount,
    paid_till_date,
    pending_fees: Number(adm.total_fees || 0) - paid_till_date,
  };
};

export const insert = async (tenant, input, created_by) =>
  tenantTx(tenant, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO admissions
         (lead_id, admission_date, first_name, middle_name, last_name, email,
          whatsapp_number, alternate_contact, address, program_id, mode_of_training,
          center_id, total_fees, mode_of_payment, status,
          selfie_r2_key, photo_r2_key,
          payment_proof_r2_key, payment_utr, payment_account_id, payment_amount,
          guided_by_counsellor_id, guided_by_manager_id, source,
          created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       RETURNING *`,
      [
        input.lead_id ?? null,
        input.admission_date,
        input.first_name,
        input.middle_name ?? null,
        input.last_name ?? null,
        input.email ?? null,
        input.whatsapp_number,
        input.alternate_contact ?? null,
        input.address ?? null,
        input.program_id ?? null,
        input.mode_of_training,
        input.center_id ?? null,
        input.total_fees ?? 0,
        input.mode_of_payment ?? null,
        input.status ?? 'pending_approval',
        input.selfie_r2_key ?? null,
        input.photo_r2_key ?? null,
        input.payment_proof_r2_key ?? null,
        input.payment_utr ?? null,
        input.payment_account_id ?? null,
        input.payment_amount ?? null,
        input.guided_by_counsellor_id ?? null,
        input.guided_by_manager_id ?? null,
        input.source ?? null,
        created_by ?? null,
      ],
    );
    let admission = rows[0];

    // Mint the friendly ADM-YYYY-NNNN code. Sequence resets per calendar
    // year, based on the admission's own created_at (now()). We compute
    // MAX(seq)+1 inside the same transaction; the partial unique index
    // catches the rare race where two inserts pick the same sequence —
    // a retry from the caller (or a regenerate call) would resolve it.
    {
      const year = new Date(admission.created_at).getFullYear();
      const prefix = `ADM-${year}-`;
      const { rows: maxRows } = await client.query(
        `SELECT admission_code
           FROM admissions
          WHERE admission_code LIKE $1
            AND deleted_at IS NULL
          ORDER BY admission_code DESC
          LIMIT 1`,
        [`${prefix}%`],
      );
      // Parse the trailing sequence; defaults to 0 when this is the
      // year's first admission. We slice the suffix and Number() it —
      // tolerant of any non-numeric tail just in case (returns NaN → 0).
      const lastSeq = maxRows[0]?.admission_code
        ? Number(maxRows[0].admission_code.slice(prefix.length)) || 0
        : 0;
      const nextCode = `${prefix}${String(lastSeq + 1).padStart(4, '0')}`;
      const { rows: codeRows } = await client.query(
        `UPDATE admissions SET admission_code = $2 WHERE id = $1 RETURNING *`,
        [admission.id, nextCode],
      );
      admission = codeRows[0] ?? admission;
    }

    if (Array.isArray(input.education) && input.education.length) {
      for (let i = 0; i < input.education.length; i += 1) {
        const e = input.education[i];
        await client.query(
          `INSERT INTO admission_education
             (admission_id, examination, stream, college_name, board_university,
              year_of_passing, percentage, grade_unit, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [admission.id, e.examination, e.stream ?? null, e.college_name ?? null,
           e.board_university ?? null, e.year_of_passing ?? null, e.percentage ?? null,
           e.grade_unit ?? 'percent', i],
        );
      }
    }
    if (Array.isArray(input.fee_schedule) && input.fee_schedule.length) {
      for (const fs of input.fee_schedule) {
        await client.query(
          `INSERT INTO admission_fee_schedule (admission_id, installment_no, due_date, amount)
           VALUES ($1,$2,$3,$4)`,
          [admission.id, fs.installment_no, fs.due_date, fs.amount],
        );
      }
    }
    return admission;
  });

export const updateRow = async (tenant, id, patch) =>
  tenantTx(tenant, async (client) => {
    const { education, fee_schedule, ...scalar } = patch;
    const fields = [];
    const params = [];
    let i = 1;
    for (const [k, v] of Object.entries(scalar)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i}`);
      params.push(v);
      i += 1;
    }
    if (fields.length) {
      params.push(id);
      await client.query(
        `UPDATE admissions SET ${fields.join(', ')}, updated_at = now()
          WHERE id = $${i} AND deleted_at IS NULL`,
        params,
      );
    }
    if (Array.isArray(education)) {
      // Replace strategy — wipe existing, re-insert. Cheap because N<=4.
      await client.query(`DELETE FROM admission_education WHERE admission_id = $1`, [id]);
      for (let n = 0; n < education.length; n += 1) {
        const e = education[n];
        await client.query(
          `INSERT INTO admission_education
             (admission_id, examination, stream, college_name, board_university,
              year_of_passing, percentage, grade_unit, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, e.examination, e.stream ?? null, e.college_name ?? null,
           e.board_university ?? null, e.year_of_passing ?? null, e.percentage ?? null,
           e.grade_unit ?? 'percent', n],
        );
      }
    }
    if (Array.isArray(fee_schedule)) {
      await client.query(`DELETE FROM admission_fee_schedule WHERE admission_id = $1`, [id]);
      for (const fs of fee_schedule) {
        await client.query(
          `INSERT INTO admission_fee_schedule (admission_id, installment_no, due_date, amount)
           VALUES ($1,$2,$3,$4)`,
          [id, fs.installment_no, fs.due_date, fs.amount],
        );
      }
    }
    return findById(tenant, id);
  });

export const softDelete = async (tenant, id) => {
  await tenantQuery(
    tenant,
    `UPDATE admissions SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
};

export const approve = async (tenant, id, user_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE admissions
        SET status = 'attending',
            approved_by = $2,
            approved_at = now(),
            -- Approving an admission also verifies the registration payment
            -- the student submitted. Only stamp when there's a payment and
            -- it isn't already verified, so re-approves don't churn it.
            payment_verified_at = CASE
              WHEN payment_amount IS NOT NULL AND payment_amount > 0 AND payment_verified_at IS NULL
              THEN now() ELSE payment_verified_at END,
            payment_verified_by = CASE
              WHEN payment_amount IS NOT NULL AND payment_amount > 0 AND payment_verified_by IS NULL
              THEN $2 ELSE payment_verified_by END,
            updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL AND status = 'pending_approval'
      RETURNING *`,
    [id, user_id],
  );
  return rows[0] || null;
};

// Does this admission already have a (live) registration receipt? Used to
// avoid double-creating one when approve() auto-converts the student's
// submitted payment into a receipt.
export const hasRegistrationReceipt = async (tenant, admission_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT 1 FROM admission_receipts
      WHERE admission_id = $1 AND receipt_kind = 'registration' AND deleted_at IS NULL
      LIMIT 1`,
    [admission_id],
  );
  return rows.length > 0;
};

// Reject a pending admission. Sets status='rejected' so the lead becomes
// eligible for a fresh share-link mint (the link-gate query in
// public-admissions/service.js explicitly excludes rejected rows).
// `reason` is optional free-text the accounts user can supply.
export const reject = async (tenant, id, user_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE admissions
        SET status = 'rejected',
            approved_by = $2,
            approved_at = now(),
            updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL AND status = 'pending_approval'
      RETURNING *`,
    [id, user_id],
  );
  return rows[0] || null;
};

// Drop a student (accounts decided they withdrew / won't continue). Allowed
// from any live status. Stamps the reason + who/when. The service additionally
// cancels the lead's planned follow-ups so reminders stop firing.
export const drop = async (tenant, id, user_id, reason) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE admissions
        SET status = 'dropped',
            dropped_by = $2,
            dropped_at = now(),
            dropped_reason = $3,
            updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL AND status <> 'dropped'
      RETURNING *`,
    [id, user_id, reason ?? null],
  );
  return rows[0] || null;
};

export const setStatus = async (tenant, id, status, extra = {}) => {
  const params = [id, status];
  let extraSql = '';
  if (status === 'on_break' && extra.break_reason) {
    params.push(extra.break_reason);
    extraSql = `, break_reason = $${params.length}`;
  }
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE admissions SET status = $2 ${extraSql}, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    params,
  );
  return rows[0] || null;
};

// ---------- Receipts ------------------------------------------------------

export const listReceipts = async (tenant, q = {}) => {
  const conds = ['r.deleted_at IS NULL'];
  const params = [];
  if (q.date_from) { params.push(q.date_from); conds.push(`r.receipt_date >= $${params.length}`); }
  if (q.date_to)   { params.push(q.date_to);   conds.push(`r.receipt_date <= $${params.length}`); }
  if (q.program_id) {
    params.push(q.program_id);
    conds.push(`a.program_id = $${params.length}`);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT r.*, a.first_name, a.last_name, a.email, a.whatsapp_number,
            p.name AS program_name
       FROM admission_receipts r
       JOIN admissions a ON a.id = r.admission_id
       LEFT JOIN programs p ON p.id = a.program_id
       ${where}
       ORDER BY r.receipt_date DESC, r.created_at DESC`,
    params,
  );
  return rows;
};

// ---------- Payment Details (admin ledger view) ---------------------------
//
// One row per recorded payment (admission_receipts), enriched with the
// admission code, lead id, program, payer, collected-by (accounts person),
// and the linked payment account. Paginated + filterable + sortable +
// searchable for the admin "Payment Details" tab.
const PAYMENT_SORTS = {
  date_desc: 'r.receipt_date DESC, r.created_at DESC',
  date_asc: 'r.receipt_date ASC, r.created_at ASC',
  amount_desc: 'r.amount DESC',
  amount_asc: 'r.amount ASC',
  receipt_no_asc: 'r.receipt_no ASC',
  receipt_no_desc: 'r.receipt_no DESC',
  admission_asc: 'a.admission_code ASC NULLS LAST',
  admission_desc: 'a.admission_code DESC NULLS LAST',
  collected_by_asc: 'cb.name ASC NULLS LAST',
  collected_by_desc: 'cb.name DESC NULLS LAST',
  created_desc: 'r.created_at DESC',
  created_asc: 'r.created_at ASC',
};

export const listPaymentDetails = async (tenant, q = {}) => {
  const conds = ['r.deleted_at IS NULL'];
  const params = [];
  const add = (sql, val) => { params.push(val); conds.push(sql.replace('$$', `$${params.length}`)); };

  if (q.date_from) add('r.receipt_date >= $$', q.date_from);
  if (q.date_to) add('r.receipt_date <= $$', q.date_to);
  if (q.program_id) add('a.program_id = $$', q.program_id);
  if (q.center_id) add('a.center_id = $$', q.center_id);
  if (q.admission_id) add('r.admission_id = $$', q.admission_id);
  if (q.lead_id) add('a.lead_id = $$', q.lead_id);
  if (q.collected_by) add('r.created_by = $$', q.collected_by);
  if (q.mode_of_payment) add('r.mode_of_payment = $$', q.mode_of_payment);
  if (q.receipt_kind) add('r.receipt_kind = $$', q.receipt_kind);
  if (q.is_old_collection === true) conds.push('r.is_old_collection = true');
  if (q.is_old_collection === false) conds.push('r.is_old_collection = false');
  if (q.amount_min != null) add('r.amount >= $$', q.amount_min);
  if (q.amount_max != null) add('r.amount <= $$', q.amount_max);
  if (q.admission_status) add('a.status = $$', q.admission_status);

  // Free-text search across receipt no / admission code / payer name /
  // phone / email / UTR-ish transaction details.
  if (q.q) {
    params.push(`%${q.q}%`);
    const i = params.length;
    conds.push(`(
      r.receipt_no ILIKE $${i}
      OR a.admission_code ILIKE $${i}
      OR a.first_name ILIKE $${i}
      OR a.last_name ILIKE $${i}
      OR a.email::text ILIKE $${i}
      OR a.whatsapp_number ILIKE $${i}
      OR r.transaction_details ILIKE $${i}
    )`);
  }

  const where = `WHERE ${conds.join(' AND ')}`;
  const orderBy = PAYMENT_SORTS[q.sort] || PAYMENT_SORTS.date_desc;
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  const offset = (page - 1) * limit;

  const baseFrom = `
    FROM admission_receipts r
    JOIN admissions a       ON a.id = r.admission_id
    LEFT JOIN leads l       ON l.id = a.lead_id
    LEFT JOIN programs p    ON p.id = a.program_id
    LEFT JOIN users cb      ON cb.id = r.created_by
    -- Prefer the account this specific receipt was collected into; fall
    -- back to the admission-level account (the registration destination).
    LEFT JOIN payment_accounts pa ON pa.id = COALESCE(r.payment_account_id, a.payment_account_id)
    ${where}
  `;

  const [{ rows }, { rows: countRows }, { rows: sumRows }] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT r.id, r.receipt_no, r.receipt_date, r.amount, r.mode_of_payment,
              r.transaction_details, r.is_old_collection, r.receipt_kind,
              r.installment_no, r.payment_screenshot_r2_key, r.share_token,
              r.created_at,
              a.id AS admission_id, a.admission_code, a.status AS admission_status,
              a.first_name, a.last_name, a.email, a.whatsapp_number,
              a.payment_utr, a.payment_verified_at,
              a.total_fees,
              -- Per-admission running totals: everything collected so far
              -- (all live receipts for this admission) and the balance left
              -- against the agreed total fee. Same value repeats on every
              -- receipt row for that admission — it's the admission's state.
              (SELECT COALESCE(sum(r2.amount), 0) FROM admission_receipts r2
                WHERE r2.admission_id = a.id AND r2.deleted_at IS NULL) AS paid_till_date,
              (COALESCE(a.total_fees, 0) - (SELECT COALESCE(sum(r2.amount), 0) FROM admission_receipts r2
                WHERE r2.admission_id = a.id AND r2.deleted_at IS NULL)) AS due_amount,
              a.lead_id,
              l.name AS lead_name,
              p.name AS program_name,
              cb.id AS collected_by_id, cb.name AS collected_by_name, cb.role AS collected_by_role,
              pa.type AS payment_account_type, pa.label AS payment_account_label,
              pa.upi_id AS payment_account_upi, pa.bank_name AS payment_account_bank
         ${baseFrom}
        ORDER BY ${orderBy}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    tenantQuery(tenant, `SELECT count(*)::int AS total ${baseFrom}`, params),
    tenantQuery(tenant, `SELECT COALESCE(sum(r.amount), 0)::numeric AS total_amount ${baseFrom}`, params),
  ]);

  // ---- Pending-verification rows ----
  // A student's submitted registration payment lives on the admissions row
  // (payment_amount / payment_utr / payment_proof) and has NO receipt until
  // an accounts user approves it. So those payments would be invisible in a
  // receipts-only ledger. Surface them as synthetic rows tagged is_pending,
  // built from the admissions table. We skip them when a receipt-specific
  // filter is set (mode/kind/collected-by/old) since a pending payment has
  // no receipt to match, and only attach them on page 1.
  const pending = await fetchPendingVerificationPayments(tenant, q, { page, limit });

  // Pending rows lead the list (they're what needs action). They count
  // toward the total + total_amount so the footer is honest.
  const merged = [...pending.rows, ...rows].slice(0, limit);

  return {
    rows: merged,
    total: (countRows[0]?.total ?? 0) + pending.total,
    total_amount: Number(sumRows[0]?.total_amount ?? 0) + pending.total_amount,
    pending_count: pending.total,
    page,
    limit,
  };
};

// Submitted-but-unverified registration payments, shaped to match a ledger
// row (same field names as the receipts SELECT) with is_pending = true and
// a synthetic id. Only the filters that map to an admission are applied.
const fetchPendingVerificationPayments = async (tenant, q = {}, { page, limit }) => {
  const empty = { rows: [], total: 0, total_amount: 0 };
  // Receipt-specific filters can't match a payment that has no receipt yet.
  if (q.collected_by || q.mode_of_payment || q.is_old_collection != null) return empty;
  // The pending bucket is conceptually "registration awaiting verification".
  if (q.receipt_kind && q.receipt_kind !== 'registration') return empty;
  // An explicit admission_status filter other than pending_approval excludes them.
  if (q.admission_status && q.admission_status !== 'pending_approval') return empty;

  const conds = [
    'a.deleted_at IS NULL',
    "a.status = 'pending_approval'",
    'a.payment_amount IS NOT NULL',
    'a.payment_amount > 0',
    'a.payment_verified_at IS NULL',
    // No live registration receipt yet (else it's already in the ledger).
    `NOT EXISTS (SELECT 1 FROM admission_receipts rr
                  WHERE rr.admission_id = a.id AND rr.receipt_kind = 'registration' AND rr.deleted_at IS NULL)`,
  ];
  const params = [];
  const add = (sql, val) => { params.push(val); conds.push(sql.replace('$$', `$${params.length}`)); };
  if (q.program_id) add('a.program_id = $$', q.program_id);
  if (q.center_id) add('a.center_id = $$', q.center_id);
  if (q.admission_id) add('a.id = $$', q.admission_id);
  if (q.lead_id) add('a.lead_id = $$', q.lead_id);
  if (q.amount_min != null) add('a.payment_amount >= $$', q.amount_min);
  if (q.amount_max != null) add('a.payment_amount <= $$', q.amount_max);
  // Date range applies to when the student submitted (admission created).
  if (q.date_from) add('a.created_at >= $$::date', q.date_from);
  if (q.date_to) add("a.created_at < ($$::date + interval '1 day')", q.date_to);
  if (q.q) {
    params.push(`%${q.q}%`);
    const i = params.length;
    conds.push(`(a.admission_code ILIKE $${i} OR a.first_name ILIKE $${i} OR a.last_name ILIKE $${i}
                 OR a.email::text ILIKE $${i} OR a.whatsapp_number ILIKE $${i} OR a.payment_utr ILIKE $${i})`);
  }

  const where = `WHERE ${conds.join(' AND ')}`;
  const from = `
    FROM admissions a
    LEFT JOIN leads l    ON l.id = a.lead_id
    LEFT JOIN programs p ON p.id = a.program_id
    LEFT JOIN payment_accounts pa ON pa.id = a.payment_account_id
    ${where}
  `;

  const [{ rows: cnt }, dataRes] = await Promise.all([
    tenantQuery(tenant, `SELECT count(*)::int AS total, COALESCE(sum(a.payment_amount),0)::numeric AS total_amount ${from}`, params),
    // Only materialise the rows on page 1 — they're the action queue and
    // shouldn't paginate weirdly mixed with receipts.
    page === 1
      ? tenantQuery(
          tenant,
          `SELECT a.id AS admission_id, a.admission_code, a.status AS admission_status,
                  a.first_name, a.last_name, a.email, a.whatsapp_number,
                  a.payment_utr, a.payment_verified_at, a.payment_amount, a.created_at,
                  a.total_fees,
                  a.lead_id, l.name AS lead_name, p.name AS program_name,
                  a.payment_proof_r2_key,
                  pa.type AS payment_account_type, pa.label AS payment_account_label,
                  pa.upi_id AS payment_account_upi, pa.bank_name AS payment_account_bank
             ${from}
            ORDER BY a.created_at DESC
            LIMIT $${params.length + 1}`,
          [...params, limit],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  // Shape each into a ledger-row lookalike. is_pending flags the FE to render
  // a "Pending verification" tag; payment_proof_r2_key reuses the screenshot
  // column the FE already knows how to preview.
  const rows = (dataRes.rows || []).map((a) => ({
    id: `pending-${a.admission_id}`,
    is_pending: true,
    receipt_no: null,
    receipt_date: a.created_at,
    amount: Number(a.payment_amount),
    total_fees: a.total_fees != null ? Number(a.total_fees) : null,
    // Not yet a receipt — "paid so far" is just this submitted amount, and
    // due is the balance against the agreed total fee.
    paid_till_date: Number(a.payment_amount),
    due_amount: a.total_fees != null ? Number(a.total_fees) - Number(a.payment_amount) : null,
    mode_of_payment: 'online',
    transaction_details: a.payment_utr ? `UTR ${a.payment_utr}` : null,
    is_old_collection: false,
    receipt_kind: 'registration',
    installment_no: null,
    payment_screenshot_r2_key: a.payment_proof_r2_key,
    share_token: null,
    created_at: a.created_at,
    admission_id: a.admission_id,
    admission_code: a.admission_code,
    admission_status: a.admission_status,
    first_name: a.first_name,
    last_name: a.last_name,
    email: a.email,
    whatsapp_number: a.whatsapp_number,
    payment_utr: a.payment_utr,
    payment_verified_at: null,
    lead_id: a.lead_id,
    lead_name: a.lead_name,
    program_name: a.program_name,
    collected_by_id: null,
    collected_by_name: null,
    collected_by_role: null,
    payment_account_type: a.payment_account_type,
    payment_account_label: a.payment_account_label,
    payment_account_upi: a.payment_account_upi,
    payment_account_bank: a.payment_account_bank,
  }));

  return { rows, total: cnt[0]?.total ?? 0, total_amount: Number(cnt[0]?.total_amount ?? 0) };
};

// Payment analytics for the admin dashboard charts. Returns:
//   • trend       — daily collected amount + count over the last N days
//   • by_mode     — total collected grouped by payment mode (cash/upi/…)
//   • by_kind     — total collected grouped by receipt kind (registration/
//                   installment/misc)
//   • totals      — overall collected amount + count in the window
const PAYMENT_ANALYTICS_DAYS = 30;
export const paymentAnalytics = async (tenant, { days = PAYMENT_ANALYTICS_DAYS } = {}) => {
  const tz = tenant.timezone || 'Asia/Kolkata';
  const since = `now() - ($1 || ' days')::interval`;
  const [trend, byMode, byKind, byAccount, totals] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT to_char((receipt_date)::date, 'YYYY-MM-DD') AS day,
              sum(amount)::numeric AS amount,
              count(*)::int AS count
         FROM admission_receipts
        WHERE deleted_at IS NULL AND receipt_date >= (${since})::date
        GROUP BY 1 ORDER BY 1`,
      [days],
    ),
    tenantQuery(
      tenant,
      `SELECT COALESCE(mode_of_payment, 'unknown') AS mode,
              sum(amount)::numeric AS amount, count(*)::int AS count
         FROM admission_receipts
        WHERE deleted_at IS NULL AND receipt_date >= (${since})::date
        GROUP BY 1 ORDER BY amount DESC`,
      [days],
    ),
    tenantQuery(
      tenant,
      `SELECT COALESCE(receipt_kind, 'misc') AS kind,
              sum(amount)::numeric AS amount, count(*)::int AS count
         FROM admission_receipts
        WHERE deleted_at IS NULL AND receipt_date >= (${since})::date
        GROUP BY 1 ORDER BY amount DESC`,
      [days],
    ),
    // Collected ₹ grouped by the payment account the receipt's admission was
    // paid into (admissions.payment_account_id). Unlinked → 'Unspecified'.
    tenantQuery(
      tenant,
      `SELECT COALESCE(
                NULLIF(TRIM(COALESCE(pa.label, '') ||
                  CASE WHEN pa.upi_id IS NOT NULL THEN ' (' || pa.upi_id || ')'
                       WHEN pa.account_number IS NOT NULL THEN ' (A/C ••' || RIGHT(pa.account_number, 4) || ')'
                       ELSE '' END), ''),
                'Unspecified') AS account,
              sum(r.amount)::numeric AS amount, count(*)::int AS count
         FROM admission_receipts r
         JOIN admissions a ON a.id = r.admission_id
         LEFT JOIN payment_accounts pa ON pa.id = a.payment_account_id
        WHERE r.deleted_at IS NULL AND r.receipt_date >= (${since})::date
        GROUP BY 1 ORDER BY amount DESC`,
      [days],
    ),
    tenantQuery(
      tenant,
      `SELECT COALESCE(sum(amount), 0)::numeric AS amount, count(*)::int AS count
         FROM admission_receipts
        WHERE deleted_at IS NULL AND receipt_date >= (${since})::date`,
      [days],
    ),
  ]);
  void tz; // receipt_date is a DATE already; tz reserved for future ts fields.
  return {
    trend: trend.rows.map((r) => ({ day: r.day, amount: Number(r.amount), count: r.count })),
    by_mode: byMode.rows.map((r) => ({ mode: r.mode, amount: Number(r.amount), count: r.count })),
    by_kind: byKind.rows.map((r) => ({ kind: r.kind, amount: Number(r.amount), count: r.count })),
    by_account: byAccount.rows.map((r) => ({ account: r.account, amount: Number(r.amount), count: r.count })),
    totals: { amount: Number(totals.rows[0].amount), count: totals.rows[0].count },
    days,
  };
};

// Legacy fallback number: RC-YYYYMMDD-<count+1>. Kept for tenants that
// haven't configured a receipt-number prefix, so their receipts (and every
// receipt issued before this feature) are unaffected.
const legacyReceiptNo = async (client) => {
  const today = new Date();
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const { rows: c } = await client.query(
    `SELECT count(*)::int AS n FROM admission_receipts
      WHERE receipt_no LIKE $1 AND deleted_at IS NULL`,
    [`RC-${stamp}-%`],
  );
  return `RC-${stamp}-${String((c[0]?.n || 0) + 1).padStart(4, '0')}`;
};

// Configured number: `<prefix>-<zero-padded counter>` (e.g. 2026-01024). The
// counter is advanced with a single atomic UPDATE ... RETURNING on the
// singleton receipt_counters row, which serialises concurrent inserts on the
// row lock (no COUNT(*) race). Seeded lazily from the admin-set start value on
// first use, and only ever moves forward.
const nextConfiguredSeq = async (client, cfg) => {
  const start = Math.max(1, Number(cfg.start) || 1);
  await client.query(
    `INSERT INTO receipt_counters (id, next_seq) VALUES (1, $1)
       ON CONFLICT (id) DO NOTHING`,
    [start],
  );
  // If the admin RAISED the start above where the counter already sits, jump
  // forward to honour it; never move backward (would risk collisions).
  const { rows } = await client.query(
    `UPDATE receipt_counters
        SET next_seq = GREATEST(next_seq, $1) + 1
      WHERE id = 1
      RETURNING next_seq - 1 AS seq`,
    [start],
  );
  return Number(rows[0].seq);
};

// receiptConfig: { prefix, start, pad } from the system tenants row. A null/
// empty prefix means "use the legacy RC- scheme". An explicit input.receipt_no
// always wins (e.g. imports). Number generation + the INSERT share one
// transaction so the atomic counter is consistent with the row written.
export const insertReceipt = async (tenant, admission_id, input, created_by, receiptConfig = null) => {
  // share_token is a 32-byte random URL-safe token. Stamped at create
  // time so the public URL is stable; rotating it would invalidate any
  // links the accounts user has already shared with the student.
  const share_token = randomToken(32);
  return tenantTx(tenant, async (client) => {
    let receipt_no = input.receipt_no;
    if (!receipt_no) {
      const prefix = receiptConfig?.prefix ? String(receiptConfig.prefix).trim() : '';
      if (prefix) {
        const pad = Math.max(1, Number(receiptConfig?.pad) || 5);
        const seq = await nextConfiguredSeq(client, receiptConfig);
        receipt_no = `${prefix}-${String(seq).padStart(pad, '0')}`;
      } else {
        receipt_no = await legacyReceiptNo(client);
      }
    }
    const { rows } = await client.query(
      `INSERT INTO admission_receipts
         (admission_id, receipt_no, receipt_date, amount, mode_of_payment,
          transaction_details, is_old_collection, receipt_kind, installment_no,
          share_token, payment_screenshot_r2_key, payment_account_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [admission_id, receipt_no, input.receipt_date, input.amount, input.mode_of_payment,
       input.transaction_details ?? null, input.is_old_collection ?? false,
       input.receipt_kind ?? 'misc',
       input.receipt_kind === 'installment' ? (input.installment_no ?? null) : null,
       share_token,
       input.payment_screenshot_r2_key ?? null,
       input.payment_account_id ?? null,
       created_by ?? null],
    );
    return rows[0];
  });
};

export const deleteReceipt = async (tenant, id) => {
  await tenantQuery(
    tenant,
    `UPDATE admission_receipts SET deleted_at = now(), updated_at = now() WHERE id = $1`,
    [id],
  );
};

// ---------- Reports -------------------------------------------------------

// Pay-schedule report. For each admission active in the date window, compute
// total_fees / paid_till_date / pending / due-this-month / next-due-date.
export const paySchedule = async (tenant, q = {}) => {
  const conds = [`a.deleted_at IS NULL`, `a.status IN ('attending', 'on_break')`];
  const params = [];
  if (q.date_from) { params.push(q.date_from); conds.push(`a.admission_date >= $${params.length}`); }
  if (q.date_to)   { params.push(q.date_to);   conds.push(`a.admission_date <= $${params.length}`); }
  if (q.program_id) { params.push(q.program_id); conds.push(`a.program_id = $${params.length}`); }
  const where = `WHERE ${conds.join(' AND ')}`;
  const { rows } = await tenantQuery(
    tenant,
    `WITH paid AS (
       SELECT admission_id,
              COALESCE(SUM(amount) FILTER (WHERE deleted_at IS NULL), 0) AS paid,
              COALESCE(SUM(amount) FILTER (WHERE deleted_at IS NULL AND is_old_collection), 0) AS old_paid,
              COALESCE(SUM(amount) FILTER (WHERE deleted_at IS NULL AND NOT is_old_collection), 0) AS new_paid
         FROM admission_receipts
        GROUP BY admission_id
     ), next_due AS (
       SELECT DISTINCT ON (admission_id) admission_id, due_date, amount
         FROM admission_fee_schedule
        WHERE due_date >= CURRENT_DATE
        ORDER BY admission_id, due_date ASC
     ), this_month AS (
       SELECT admission_id, COALESCE(SUM(amount), 0) AS due_this_month
         FROM admission_fee_schedule
        WHERE due_date >= date_trunc('month', CURRENT_DATE)
          AND due_date <  date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
        GROUP BY admission_id
     )
     SELECT a.id, a.first_name, a.last_name, a.whatsapp_number, a.alternate_contact,
            a.admission_date, a.status, a.total_fees,
            p.name AS course,
            COALESCE(paid.paid, 0) AS paid_till_date,
            COALESCE(paid.old_paid, 0) AS old_paid,
            COALESCE(paid.new_paid, 0) AS new_paid,
            (a.total_fees - COALESCE(paid.paid, 0)) AS pending_fees,
            COALESCE(tm.due_this_month, 0) AS due_this_month,
            nd.due_date AS next_due_date
       FROM admissions a
       LEFT JOIN programs p   ON p.id = a.program_id
       LEFT JOIN paid         ON paid.admission_id = a.id
       LEFT JOIN next_due nd  ON nd.admission_id   = a.id
       LEFT JOIN this_month tm ON tm.admission_id  = a.id
       ${where}
       ORDER BY a.admission_date DESC`,
    params,
  );
  // Totals strip the FE shows above the table.
  const totals = rows.reduce(
    (acc, r) => {
      acc.due_this_month += Number(r.due_this_month || 0);
      acc.collection_received += Number(r.paid_till_date || 0);
      acc.old += Number(r.old_paid || 0);
      acc.new += Number(r.new_paid || 0);
      return acc;
    },
    { due_this_month: 0, collection_received: 0, old: 0, new: 0 },
  );
  return { rows, totals };
};

export const collectionReceiptWise = async (tenant, q = {}) => {
  const conds = [`r.deleted_at IS NULL`];
  const params = [];
  if (q.date_from) { params.push(q.date_from); conds.push(`r.receipt_date >= $${params.length}`); }
  if (q.date_to)   { params.push(q.date_to);   conds.push(`r.receipt_date <= $${params.length}`); }
  if (q.program_id) {
    params.push(q.program_id);
    conds.push(`a.program_id = $${params.length}`);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT r.id, r.receipt_no, r.receipt_date, r.amount, r.mode_of_payment,
            r.transaction_details, r.is_old_collection,
            a.first_name, a.last_name,
            p.name AS course
       FROM admission_receipts r
       JOIN admissions a ON a.id = r.admission_id
       LEFT JOIN programs p ON p.id = a.program_id
       ${where}
       ORDER BY r.receipt_date DESC, r.created_at DESC`,
    params,
  );
  const totals = rows.reduce(
    (acc, r) => {
      acc.total += Number(r.amount || 0);
      if (r.is_old_collection) acc.old += Number(r.amount || 0);
      else acc.new += Number(r.amount || 0);
      return acc;
    },
    { total: 0, old: 0, new: 0 },
  );
  return { rows, totals };
};

// ---------- Pending admissions queue ----------
// "Pending" = converted-but-not-yet-fully-onboarded. Two sources:
//   1. Leads with converted_at IS NOT NULL that have NO admissions row
//      → the auto-stub failed, OR conversion happened before the
//      admissions module existed. UI shows them with stage='lead'.
//   2. Admissions in 'pending_approval' status → the stub exists but
//      accounts hasn't filled the full form / verified yet.
// Unified into one ranked list newest-first so accounts has a single
// queue to chew through.
// Counsellor "My Students": their converted leads unified with any admission,
// ACROSS ALL statuses. `source_kind='lead'` = converted but the student hasn't
// filled the public form yet → counsellor configures the offer + sends the
// link. `source_kind='admission'` = the student HAS submitted → counsellor
// views the filled form (read-only). Scoped to leads the counsellor owns
// (leads.assigned_to) / admissions they guided (guided_by_counsellor_id).
export const myStudents = async (tenant, counsellorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `WITH unified AS (
       -- Converted leads with NO admission yet → awaiting the student's form.
       SELECT
         l.id                AS lead_id,
         NULL::uuid          AS admission_id,
         'lead'              AS source_kind,
         l.name              AS student_name,
         l.email             AS email,
         l.whatsapp_number   AS whatsapp_number,
         p.name              AS program_name,
         l.converted_at      AS event_at,
         NULL::text          AS admission_status,
         EXISTS (SELECT 1 FROM lead_fee_offers o WHERE o.lead_id = l.id) AS has_fee_offer,
         false               AS has_admission
       FROM leads l
       LEFT JOIN programs p ON p.id = l.program_id
       WHERE l.converted_at IS NOT NULL
         AND l.deleted_at IS NULL
         AND l.assigned_to = $1
         AND NOT EXISTS (SELECT 1 FROM admissions a WHERE a.lead_id = l.id AND a.deleted_at IS NULL)

       UNION ALL

       -- Admissions the student HAS submitted (any status) that this
       -- counsellor guided.
       SELECT
         a.lead_id           AS lead_id,
         a.id                AS admission_id,
         'admission'         AS source_kind,
         COALESCE(NULLIF(TRIM(a.first_name || ' ' || COALESCE(a.last_name, '')), ''), a.email) AS student_name,
         a.email             AS email,
         a.whatsapp_number   AS whatsapp_number,
         p.name              AS program_name,
         a.admission_date    AS event_at,
         a.status            AS admission_status,
         true                AS has_fee_offer,
         true                AS has_admission
       FROM admissions a
       LEFT JOIN programs p ON p.id = a.program_id
       WHERE a.deleted_at IS NULL
         AND a.guided_by_counsellor_id = $1
     )
     SELECT * FROM unified ORDER BY event_at DESC NULLS LAST`,
    [counsellorId],
  );
  return rows;
};

export const pendingAdmissions = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `WITH unified AS (
       -- Source 1: leads converted but with no admission row
       SELECT
         l.id                AS source_id,
         'lead'              AS source_kind,
         NULL::uuid          AS admission_id,
         l.id                AS lead_id,
         l.name              AS student_name,
         l.email             AS email,
         l.whatsapp_number   AS whatsapp_number,
         p.name              AS program_name,
         l.converted_at      AS event_at,
         l.assigned_to       AS owner_id,
         u.name              AS owner_name,
         EXISTS (
           SELECT 1 FROM lead_fee_offers o WHERE o.lead_id = l.id
         )                   AS has_fee_offer,
         NULL::text          AS admission_status,
         NULL::text          AS break_reason
       FROM leads l
       LEFT JOIN programs p ON p.id = l.program_id
       LEFT JOIN users u    ON u.id = l.assigned_to
       WHERE l.converted_at IS NOT NULL
         AND l.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM admissions a
            WHERE a.lead_id = l.id AND a.deleted_at IS NULL
         )

       UNION ALL

       -- Source 2: admissions in pending_approval (stub exists, accounts to verify)
       --   OR on_break (the student stepped away — accounts wants to see
       --   these on the same queue so they don't fall out of memory).
       SELECT
         a.id                AS source_id,
         'admission'         AS source_kind,
         a.id                AS admission_id,
         a.lead_id           AS lead_id,
         COALESCE(NULLIF(TRIM(a.first_name || ' ' || COALESCE(a.last_name, '')), ''), a.email) AS student_name,
         a.email             AS email,
         a.whatsapp_number   AS whatsapp_number,
         p.name              AS program_name,
         -- For pending_approval rows the natural sort key is created_at
         -- (newest stub first). For on_break rows we use updated_at as
         -- the proxy "when did the break start" (markBreak is the only
         -- mutation that flips status → on_break in this flow). Falling
         -- back across the COALESCE keeps a unified event_at column.
         CASE WHEN a.status = 'on_break' THEN a.updated_at ELSE a.created_at END AS event_at,
         a.guided_by_counsellor_id AS owner_id,
         u.name              AS owner_name,
         -- Admission rows: an admission already exists, so the offer
         -- gate isn't relevant for this branch. Default to true so the
         -- FE doesn't gate the row buttons.
         true                AS has_fee_offer,
         a.status            AS admission_status,
         a.break_reason      AS break_reason
       FROM admissions a
       LEFT JOIN programs p ON p.id = a.program_id
       LEFT JOIN users u    ON u.id = a.guided_by_counsellor_id
       WHERE a.deleted_at IS NULL
         AND a.status IN ('pending_approval', 'on_break')
     )
     SELECT * FROM unified ORDER BY event_at DESC NULLS LAST`,
  );
  return rows;
};

// ---------------- EMI digest for the Accounts Dashboard ----------------
//
// Two buckets:
//   • upcoming → installments due in the next `upcomingDays` days that
//                don't yet have a paid receipt tagged to that slot.
//   • overdue  → installments past their due_date with no paid receipt.
//                The Accounts team typically wants to see "24h+ overdue"
//                separately from "due today" so we expose both via the
//                same query and let the FE bucket.
//
// We join receipts with a LATERAL filter so "paid for this slot" is a
// boolean per fee_schedule row (not just any receipt on the admission).
export const emiDigest = async (tenant, upcomingDays = 7) => {
  const { rows } = await tenantQuery(
    tenant,
    `
    SELECT
      fs.admission_id,
      fs.installment_no,
      fs.due_date,
      fs.amount,
      a.status AS admission_status,
      TRIM(COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '')) AS student_name,
      a.whatsapp_number,
      a.email,
      p.name AS program_name,
      a.guided_by_counsellor_id AS owner_id,
      u.name AS owner_name,
      (fs.due_date - CURRENT_DATE)::int AS days_until_due,
      EXISTS (
        SELECT 1 FROM admission_receipts r
         WHERE r.admission_id = fs.admission_id
           AND r.deleted_at IS NULL
           AND r.receipt_kind = 'installment'
           AND r.installment_no = fs.installment_no
      ) AS is_paid
    FROM admission_fee_schedule fs
    JOIN admissions a ON a.id = fs.admission_id AND a.deleted_at IS NULL
    LEFT JOIN programs p ON p.id = a.program_id
    LEFT JOIN users u    ON u.id = a.guided_by_counsellor_id
    WHERE a.status IN ('attending', 'on_break', 'pending_approval')
      AND (
        -- Upcoming: due_date in [today, today + upcomingDays]
        (fs.due_date >= CURRENT_DATE AND fs.due_date <= CURRENT_DATE + ($1::int) * INTERVAL '1 day')
        OR
        -- Overdue: any due_date in the past with no receipt
        (fs.due_date < CURRENT_DATE)
      )
    ORDER BY fs.due_date ASC
    `,
    [upcomingDays],
  );
  // Drop already-paid rows in the result set so the FE doesn't have to.
  return rows.filter((r) => !r.is_paid);
};

// Lightweight count query for the sidebar badge — same WHERE shape as
// pendingAdmissions() but skips the JOINs / column projection.
export const pendingAdmissionsCount = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT
       (SELECT count(*)::int FROM leads l
         WHERE l.converted_at IS NOT NULL
           AND l.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM admissions a WHERE a.lead_id = l.id AND a.deleted_at IS NULL))
       +
       (SELECT count(*)::int FROM admissions a
         WHERE a.deleted_at IS NULL AND a.status = 'pending_approval')
       AS pending`,
  );
  return rows[0]?.pending || 0;
};

// ---------- Charts ----------
// Daily admissions count over the last `days` days. Returns
// [{ day: 'YYYY-MM-DD', count: int }] padded so missing days show 0.
export const admissionsTrend = async (tenant, days = 30) => {
  const { rows } = await tenantQuery(
    tenant,
    `WITH range AS (
       SELECT generate_series(
         CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day',
         CURRENT_DATE,
         INTERVAL '1 day'
       )::date AS day
     ), counts AS (
       SELECT admission_date::date AS day, count(*)::int AS n
         FROM admissions
        WHERE deleted_at IS NULL
          AND admission_date >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
        GROUP BY admission_date::date
     )
     SELECT to_char(r.day, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0) AS count
       FROM range r LEFT JOIN counts c ON c.day = r.day
      ORDER BY r.day`,
    [days],
  );
  return rows;
};

// Daily collection (sum of admission_receipts.amount) over the last N days.
export const collectionTrend = async (tenant, days = 30) => {
  const { rows } = await tenantQuery(
    tenant,
    `WITH range AS (
       SELECT generate_series(
         CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day',
         CURRENT_DATE,
         INTERVAL '1 day'
       )::date AS day
     ), sums AS (
       SELECT receipt_date::date AS day, COALESCE(SUM(amount), 0)::float AS amt
         FROM admission_receipts
        WHERE deleted_at IS NULL
          AND receipt_date >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
        GROUP BY receipt_date::date
     )
     SELECT to_char(r.day, 'YYYY-MM-DD') AS day, COALESCE(s.amt, 0)::float AS amount
       FROM range r LEFT JOIN sums s ON s.day = r.day
      ORDER BY r.day`,
    [days],
  );
  return rows;
};

// Pie / donut: count by status (excludes soft-deleted).
export const statusBreakdown = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT status, count(*)::int AS n
       FROM admissions WHERE deleted_at IS NULL
      GROUP BY status
      ORDER BY status`,
  );
  return rows;
};

// Bar: this month's admissions per program. Top 10 to keep the chart legible.
export const courseBreakdown = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT COALESCE(p.name, 'Unassigned') AS course, count(*)::int AS n
       FROM admissions a
       LEFT JOIN programs p ON p.id = a.program_id
      WHERE a.deleted_at IS NULL
        AND a.admission_date >= date_trunc('month', CURRENT_DATE)
        AND a.admission_date <  date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      GROUP BY p.name
      ORDER BY n DESC
      LIMIT 10`,
  );
  return rows;
};

export const dashboard = async (tenant) => {
  // Single fan-out query so the FE renders the dashboard with one round-trip.
  const [counts, monthCounts, monthMoney] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT status, count(*)::int AS n
         FROM admissions WHERE deleted_at IS NULL
        GROUP BY status`,
    ),
    tenantQuery(
      tenant,
      `SELECT count(*)::int AS n
         FROM admissions
        WHERE deleted_at IS NULL
          AND admission_date >= date_trunc('month', CURRENT_DATE)
          AND admission_date <  date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'`,
    ),
    tenantQuery(
      tenant,
      `SELECT COALESCE(SUM(amount), 0)::float AS month_collection
         FROM admission_receipts
        WHERE deleted_at IS NULL
          AND receipt_date >= date_trunc('month', CURRENT_DATE)
          AND receipt_date <  date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'`,
    ),
  ]);
  const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
  return {
    by_status: byStatus,
    this_month_admissions: monthCounts.rows[0].n,
    this_month_collection: monthMoney.rows[0].month_collection,
    pending_approval: byStatus.pending_approval || 0,
    attending: byStatus.attending || 0,
    on_break: byStatus.on_break || 0,
  };
};
