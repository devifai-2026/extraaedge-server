// Speedup Hiring — data access. Internal staff recruitment.
import { tenantQuery, tenantTx } from '../../db/tenant.js';

// Digits-only, last 10. The dedup key and the join between the candidate sheet
// and the interview sheet, because email is blank on most real rows. Anything
// that does not yield 10 digits returns null and the caller treats the row as
// un-dedupable rather than guessing.
export const personKey = (phone) => {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
};

// "17,000/-" → 17000. Salaries in the source sheets are formatted strings.
//
// Returns null for anything that is not a single clean figure. The sample data
// contains ranges like "10 to 12" (meaning 10-12k), and naively stripping
// non-digits turned that into 1012 — a plausible-looking number that is simply
// wrong. A range is better recorded as "no figure" and left for a human than
// silently invented; the raw text survives in the import's failure notes.
export const parseMoney = (v) => {
  if (v == null || v === '') return null;
  const raw = String(v).trim();
  // Two or more separate number groups = a range or a note, not an amount.
  const groups = raw.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  if (groups.length !== 1) return null;
  const n = Number(groups[0].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ---------- statuses ----------
export const listStatuses = async (tenant, { includeInactive = false } = {}) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT * FROM hiring_statuses
      ${includeInactive ? '' : 'WHERE is_active = true'}
      ORDER BY order_index, name`,
  );
  return rows;
};

export const createStatus = async (tenant, b) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO hiring_statuses (name, kind, applies_to, order_index)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [b.name, b.kind ?? 'open', b.applies_to ?? 'both', b.order_index ?? 0],
  );
  return rows[0];
};

export const updateStatus = async (tenant, id, b) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE hiring_statuses
        SET name = COALESCE($2, name), kind = COALESCE($3, kind),
            applies_to = COALESCE($4, applies_to),
            order_index = COALESCE($5, order_index),
            is_active = COALESCE($6, is_active)
      WHERE id = $1 RETURNING *`,
    [id, b.name ?? null, b.kind ?? null, b.applies_to ?? null,
      b.order_index ?? null, b.is_active ?? null],
  );
  return rows[0] ?? null;
};

// ---------- positions ----------
export const listPositions = async (tenant, { status } = {}) => {
  const params = [];
  let where = 'WHERE p.deleted_at IS NULL';
  if (status) { params.push(status); where += ` AND p.status = $${params.length}`; }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT p.*, b.name AS branch_name,
            (SELECT count(*)::int FROM hiring_candidates c
              WHERE c.position_id = p.id AND c.deleted_at IS NULL) AS candidate_count,
            (SELECT count(*)::int FROM hiring_postings hp
              WHERE hp.position_id = p.id AND hp.deleted_at IS NULL) AS posting_count
       FROM hiring_positions p
       LEFT JOIN branches b ON b.id = p.branch_id
       ${where}
      ORDER BY p.status, p.title`,
    params,
  );
  return rows;
};

export const createPosition = async (tenant, b, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO hiring_positions (title, department, branch_id, openings_count, status, created_by)
     VALUES ($1,$2,$3,$4,COALESCE($5,'open'),$6) RETURNING *`,
    [b.title, b.department ?? null, b.branch_id ?? null,
      b.openings_count ?? 1, b.status ?? null, userId ?? null],
  );
  return rows[0];
};

export const updatePosition = async (tenant, id, b) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE hiring_positions
        SET title = COALESCE($2, title), department = COALESCE($3, department),
            branch_id = COALESCE($4, branch_id),
            openings_count = COALESCE($5, openings_count),
            status = COALESCE($6, status),
            closed_at = CASE WHEN $6 = 'closed' AND closed_at IS NULL THEN now()
                             WHEN $6 IS NOT NULL AND $6 <> 'closed' THEN NULL
                             ELSE closed_at END
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id, b.title ?? null, b.department ?? null, b.branch_id ?? null,
      b.openings_count ?? null, b.status ?? null],
  );
  return rows[0] ?? null;
};

export const softDeletePosition = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE hiring_positions SET deleted_at = now() WHERE id = $1`, [id]);
};

// ---------- postings ----------
export const listPostings = async (tenant, positionId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT hp.*, u.name AS posted_by_name
       FROM hiring_postings hp
       LEFT JOIN users u ON u.id = hp.posted_by
      WHERE hp.position_id = $1 AND hp.deleted_at IS NULL
      ORDER BY hp.posted_at DESC`,
    [positionId],
  );
  return rows;
};

export const createPosting = async (tenant, b, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO hiring_postings (position_id, channel, external_url, notes, posted_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.position_id, b.channel, b.external_url ?? null, b.notes ?? null, userId ?? null],
  );
  return rows[0];
};

export const softDeletePosting = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE hiring_postings SET deleted_at = now() WHERE id = $1`, [id]);
};

// ---------- candidates ----------
const CANDIDATE_COLS = `c.*, p.title AS position_title, s.name AS status_name, s.kind AS status_kind,
  o.name AS owner_name,
  (SELECT count(*)::int FROM hiring_interviews i
    WHERE i.candidate_id = c.id AND i.deleted_at IS NULL) AS interview_count`;

export const listCandidates = async (tenant, q = {}) => {
  const params = [];
  const conds = ['c.deleted_at IS NULL'];
  if (q.position_id) { params.push(q.position_id); conds.push(`c.position_id = $${params.length}`); }
  if (q.status_id) { params.push(q.status_id); conds.push(`c.status_id = $${params.length}`); }
  if (q.experience_level) { params.push(q.experience_level); conds.push(`c.experience_level = $${params.length}`); }
  if (q.kind) { params.push(q.kind); conds.push(`s.kind = $${params.length}`); }
  if (q.q) {
    params.push(`%${q.q}%`);
    conds.push(`(c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const limit = Math.min(Number(q.limit) || 50, 200);
  const page = Math.max(Number(q.page) || 1, 1);
  params.push(limit, (page - 1) * limit);

  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${CANDIDATE_COLS}
       FROM hiring_candidates c
       LEFT JOIN hiring_positions p ON p.id = c.position_id
       LEFT JOIN hiring_statuses s ON s.id = c.status_id
       LEFT JOIN users o ON o.id = c.owner_id
       ${where}
      ORDER BY c.contacted_on DESC NULLS LAST, c.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const { rows: cnt } = await tenantQuery(
    tenant,
    `SELECT count(*)::int AS total FROM hiring_candidates c
       LEFT JOIN hiring_statuses s ON s.id = c.status_id ${where}`,
    params.slice(0, params.length - 2),
  );
  return { rows, total: cnt[0].total };
};

export const getCandidate = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${CANDIDATE_COLS}
       FROM hiring_candidates c
       LEFT JOIN hiring_positions p ON p.id = c.position_id
       LEFT JOIN hiring_statuses s ON s.id = c.status_id
       LEFT JOIN users o ON o.id = c.owner_id
      WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [id],
  );
  if (!rows[0]) return null;
  const { rows: interviews } = await tenantQuery(
    tenant,
    `SELECT i.*, s.name AS status_name, u.name AS interviewer_name
       FROM hiring_interviews i
       LEFT JOIN hiring_statuses s ON s.id = i.status_id
       LEFT JOIN users u ON u.id = i.interviewer_id
      WHERE i.candidate_id = $1 AND i.deleted_at IS NULL
      ORDER BY i.scheduled_at DESC NULLS LAST`,
    [id],
  );
  const { rows: history } = await tenantQuery(
    tenant,
    `SELECT h.*, f.name AS from_name, t.name AS to_name, u.name AS changed_by_name
       FROM hiring_status_history h
       LEFT JOIN hiring_statuses f ON f.id = h.from_status_id
       LEFT JOIN hiring_statuses t ON t.id = h.to_status_id
       LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.candidate_id = $1 ORDER BY h.created_at DESC`,
    [id],
  );
  return { ...rows[0], interviews, status_history: history };
};

const CANDIDATE_FIELDS = [
  'position_id', 'contacted_on', 'name', 'phone', 'email', 'location',
  'highest_qualification', 'stream', 'experience_level', 'current_area',
  'current_salary', 'expected_salary', 'notice_period', 'status_id',
  'remark', 'remark_2', 'posting_id', 'owner_id',
];

export const createCandidate = async (tenant, b, userId) => {
  const cols = ['person_key', 'created_by'];
  const vals = [personKey(b.phone), userId ?? null];
  for (const f of CANDIDATE_FIELDS) {
    if (b[f] !== undefined) { cols.push(f); vals.push(b[f]); }
  }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO hiring_candidates (${cols.join(',')}) VALUES (${ph}) RETURNING *`,
    vals,
  );
  return rows[0];
};

export const updateCandidate = async (tenant, id, b) => {
  const sets = [];
  const vals = [id];
  for (const f of CANDIDATE_FIELDS) {
    if (b[f] !== undefined) { vals.push(b[f]); sets.push(`${f} = $${vals.length}`); }
  }
  if (b.phone !== undefined) { vals.push(personKey(b.phone)); sets.push(`person_key = $${vals.length}`); }
  if (!sets.length) return getCandidate(tenant, id);
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE hiring_candidates SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
};

export const softDeleteCandidate = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE hiring_candidates SET deleted_at = now() WHERE id = $1`, [id]);
};

export const recordStatusChange = async (tenant, { candidate_id, from_status_id, to_status_id, note, changed_by }) => {
  await tenantQuery(
    tenant,
    `INSERT INTO hiring_status_history (candidate_id, from_status_id, to_status_id, note, changed_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [candidate_id, from_status_id ?? null, to_status_id ?? null, note ?? null, changed_by ?? null],
  );
};

// ---------- interviews ----------
export const listInterviews = async (tenant, q = {}) => {
  const params = [];
  const conds = ['i.deleted_at IS NULL'];
  if (q.from) { params.push(q.from); conds.push(`i.scheduled_at >= $${params.length}`); }
  if (q.to) { params.push(q.to); conds.push(`i.scheduled_at <= $${params.length}`); }
  if (q.status_id) { params.push(q.status_id); conds.push(`i.status_id = $${params.length}`); }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT i.*, c.name AS candidate_name, c.phone AS candidate_phone,
            p.title AS position_title, s.name AS status_name, u.name AS interviewer_name
       FROM hiring_interviews i
       JOIN hiring_candidates c ON c.id = i.candidate_id
       LEFT JOIN hiring_positions p ON p.id = c.position_id
       LEFT JOIN hiring_statuses s ON s.id = i.status_id
       LEFT JOIN users u ON u.id = i.interviewer_id
      WHERE ${conds.join(' AND ')}
      ORDER BY i.scheduled_at DESC NULLS LAST
      LIMIT 500`,
    params,
  );
  return rows;
};

export const createInterview = async (tenant, b, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO hiring_interviews (candidate_id, scheduled_at, mode, status_id, interviewer_id, remark_1, remark_2, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [b.candidate_id, b.scheduled_at ?? null, b.mode ?? null, b.status_id ?? null,
      b.interviewer_id ?? null, b.remark_1 ?? null, b.remark_2 ?? null, userId ?? null],
  );
  return rows[0];
};

export const updateInterview = async (tenant, id, b) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE hiring_interviews
        SET scheduled_at = COALESCE($2, scheduled_at), mode = COALESCE($3, mode),
            status_id = COALESCE($4, status_id), interviewer_id = COALESCE($5, interviewer_id),
            remark_1 = COALESCE($6, remark_1), remark_2 = COALESCE($7, remark_2)
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id, b.scheduled_at ?? null, b.mode ?? null, b.status_id ?? null,
      b.interviewer_id ?? null, b.remark_1 ?? null, b.remark_2 ?? null],
  );
  return rows[0] ?? null;
};

export const softDeleteInterview = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE hiring_interviews SET deleted_at = now() WHERE id = $1` , [id]);
};

// ---------- bulk import ----------
// Find an existing candidate by person_key, optionally scoped to a position.
export const findByPersonKey = async (tenant, key, positionId = null) => {
  if (!key) return null;
  const params = [key];
  let cond = 'person_key = $1 AND deleted_at IS NULL';
  if (positionId) { params.push(positionId); cond += ` AND position_id = $${params.length}`; }
  const { rows } = await tenantQuery(
    tenant, `SELECT * FROM hiring_candidates WHERE ${cond} ORDER BY created_at DESC LIMIT 1`, params,
  );
  return rows[0] ?? null;
};

// Commit a validated batch. One transaction: a half-imported sheet is worse
// than a rejected one, because the recruiter cannot tell which rows landed.
export const commitCandidates = async (tenant, rows, userId) => tenantTx(tenant, async (client) => {
  let created = 0;
  let updated = 0;
  for (const r of rows) {
    const key = personKey(r.phone);
    let existing = null;
    if (key && r.position_id) {
      const { rows: found } = await client.query(
        `SELECT id, status_id FROM hiring_candidates
          WHERE person_key = $1 AND position_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [key, r.position_id],
      );
      existing = found[0] ?? null;
    }
    if (existing) {
      await client.query(
        `UPDATE hiring_candidates
            SET name = COALESCE($2, name), email = COALESCE($3, email),
                location = COALESCE($4, location),
                highest_qualification = COALESCE($5, highest_qualification),
                stream = COALESCE($6, stream),
                experience_level = COALESCE($7, experience_level),
                current_area = COALESCE($8, current_area),
                current_salary = COALESCE($9, current_salary),
                expected_salary = COALESCE($10, expected_salary),
                notice_period = COALESCE($11, notice_period),
                status_id = COALESCE($12, status_id),
                remark = COALESCE($13, remark), remark_2 = COALESCE($14, remark_2),
                contacted_on = COALESCE($15, contacted_on)
          WHERE id = $1`,
        [existing.id, r.name, r.email, r.location, r.highest_qualification, r.stream,
          r.experience_level, r.current_area, r.current_salary, r.expected_salary,
          r.notice_period, r.status_id, r.remark, r.remark_2, r.contacted_on],
      );
      updated += 1;
    } else {
      await client.query(
        `INSERT INTO hiring_candidates
           (position_id, contacted_on, name, phone, person_key, email, location,
            highest_qualification, stream, experience_level, current_area,
            current_salary, expected_salary, notice_period, status_id, remark, remark_2, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [r.position_id, r.contacted_on, r.name, r.phone, key, r.email, r.location,
          r.highest_qualification, r.stream, r.experience_level, r.current_area,
          r.current_salary, r.expected_salary, r.notice_period, r.status_id,
          r.remark, r.remark_2, userId ?? null],
      );
      created += 1;
    }
  }
  return { created, updated };
});

// Interview sheet. Matches an existing candidate by phone; creates a stub
// candidate when unknown, because in practice the interview sheet sometimes
// leads and refusing the row would lose the interview record entirely.
export const commitInterviews = async (tenant, rows, userId) => tenantTx(tenant, async (client) => {
  let created = 0;
  let candidatesCreated = 0;
  for (const r of rows) {
    const key = personKey(r.phone);
    let candidateId = null;
    if (key) {
      const { rows: found } = await client.query(
        `SELECT id FROM hiring_candidates WHERE person_key = $1 AND deleted_at IS NULL
          ORDER BY (position_id = $2) DESC, created_at DESC LIMIT 1`,
        [key, r.position_id ?? null],
      );
      candidateId = found[0]?.id ?? null;
    }
    if (!candidateId) {
      const { rows: ins } = await client.query(
        `INSERT INTO hiring_candidates (position_id, name, phone, person_key, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [r.position_id ?? null, r.name, r.phone ?? null, key, userId ?? null],
      );
      candidateId = ins[0].id;
      candidatesCreated += 1;
    }
    await client.query(
      `INSERT INTO hiring_interviews
         (candidate_id, scheduled_at, mode, status_id, remark_1, remark_2, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [candidateId, r.scheduled_at ?? null, r.mode ?? null, r.status_id ?? null,
        r.remark_1 ?? null, r.remark_2 ?? null, userId ?? null],
    );
    created += 1;
  }
  return { created, candidates_created: candidatesCreated };
});

// ---------- dashboard ----------
export const dashboard = async (tenant) => {
  const [positions, byStatus, upcoming, recent] = await Promise.all([
    tenantQuery(tenant, `SELECT count(*) FILTER (WHERE status='open')::int AS open_positions,
                                sum(openings_count) FILTER (WHERE status='open')::int AS open_seats
                           FROM hiring_positions WHERE deleted_at IS NULL`),
    tenantQuery(tenant, `SELECT s.name, s.kind, count(*)::int AS n
                           FROM hiring_candidates c JOIN hiring_statuses s ON s.id = c.status_id
                          WHERE c.deleted_at IS NULL GROUP BY s.name, s.kind, s.order_index
                          ORDER BY s.order_index`),
    tenantQuery(tenant, `SELECT count(*)::int AS n FROM hiring_interviews
                          WHERE deleted_at IS NULL AND scheduled_at >= now()
                            AND scheduled_at < now() + interval '7 days'`),
    tenantQuery(tenant, `SELECT count(*)::int AS n FROM hiring_candidates
                          WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days'`),
  ]);
  return {
    open_positions: positions.rows[0].open_positions ?? 0,
    open_seats: positions.rows[0].open_seats ?? 0,
    by_status: byStatus.rows,
    interviews_next_7d: upcoming.rows[0].n,
    candidates_30d: recent.rows[0].n,
  };
};

// ---------- import jobs ----------
export const createImport = async (tenant, b, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO hiring_imports (kind, file_key, file_name, sheet_name, position_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b.kind, b.file_key ?? null, b.file_name ?? null, b.sheet_name ?? null,
      b.position_id ?? null, userId ?? null],
  );
  return rows[0];
};

export const listImports = async (tenant, { limit = 30 } = {}) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT i.*, u.name AS created_by_name, p.title AS position_title
       FROM hiring_imports i
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN hiring_positions p ON p.id = i.position_id
      ORDER BY i.created_at DESC LIMIT $1`,
    [Math.min(Number(limit) || 30, 100)],
  );
  return rows;
};

export const getImport = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM hiring_imports WHERE id = $1`, [id]);
  return rows[0] ?? null;
};

// Rejected + duplicate rows for one import, for the review tabs.
export const importRows = async (tenant, id, outcome) => {
  const params = [id];
  let cond = 'import_id = $1';
  if (outcome) { params.push(outcome); cond += ` AND outcome = $${params.length}`; }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT * FROM hiring_import_rows WHERE ${cond} ORDER BY row_no LIMIT 2000`,
    params,
  );
  return rows;
};
