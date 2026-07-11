// Placement data access: companies, job openings, applications, and the
// criteria-matched student audience. Pure tenantQuery SQL.
//
// Branch scoping: read helpers take `branchScope` — null means "all branches"
// (super_admin / "All branches" switcher), an array of branch ids restricts to
// those branches. A branch condition always also admits legacy rows with
// branch_id IS NULL so pre-F3 data stays visible. The service resolves the
// scope from the actor's branch memberships.
import { tenantQuery } from '../../db/tenant.js';

// Build a "(alias.branch_id IS NULL OR alias.branch_id = ANY($n))" clause, or ''
// when branchScope is null (no restriction). Pushes the array param.
const branchClause = (alias, branchScope, params) => {
  if (!branchScope) return '';
  params.push(branchScope);
  return ` AND (${alias}.branch_id IS NULL OR ${alias}.branch_id = ANY($${params.length}))`;
};

// ---------- Companies ----------
export const listCompanies = async (tenant, branchScope = null) => {
  const params = [];
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.name, c.website, c.industry, c.location, c.about, c.logo_r2_key, c.branch_id, c.created_at,
            (SELECT count(*)::int FROM job_openings o WHERE o.company_id = c.id AND o.deleted_at IS NULL) AS opening_count
       FROM companies c WHERE c.deleted_at IS NULL${branchClause('c', branchScope, params)} ORDER BY c.name`,
    params,
  );
  return rows;
};

export const createCompany = async (tenant, c, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO companies (name, website, industry, location, about, logo_r2_key, branch_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [c.name, c.website ?? null, c.industry ?? null, c.location ?? null, c.about ?? null, c.logo_r2_key ?? null, c.branch_id ?? null, actorId ?? null],
  );
  return rows[0];
};

export const updateCompany = async (tenant, id, c) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE companies SET name=COALESCE($2,name), website=$3, industry=$4, location=$5, about=$6, logo_r2_key=COALESCE($7,logo_r2_key), updated_at=now()
      WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
    [id, c.name ?? null, c.website ?? null, c.industry ?? null, c.location ?? null, c.about ?? null, c.logo_r2_key ?? null],
  );
  return rows[0] || null;
};

export const deleteCompany = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE companies SET deleted_at=now(), updated_at=now() WHERE id=$1`, [id]);
};

// Bulk insert (CSV). All rows land in `branchId` (the importer's active branch,
// or null for tenant-wide). Returns inserted count.
export const bulkCreateCompanies = async (tenant, list, actorId, branchId = null) => {
  let n = 0;
  for (const c of list) {
    if (!c.name) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await tenantQuery(
      tenant,
      `INSERT INTO companies (name, website, industry, location, about, branch_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [c.name, c.website ?? null, c.industry ?? null, c.location ?? null, c.about ?? null, branchId ?? null, actorId ?? null],
    );
    n += 1;
  }
  return n;
};

// ---------- Openings ----------
export const listOpenings = async (tenant, { status, branchScope = null } = {}) => {
  const params = [];
  let where = 'o.deleted_at IS NULL';
  if (status) { params.push(status); where += ` AND o.status = $${params.length}`; }
  where += branchClause('o', branchScope, params);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT o.*, co.name AS company_name, co.logo_r2_key AS company_logo_r2_key, p.name AS program_name,
            (SELECT count(*)::int FROM job_applications a WHERE a.opening_id = o.id) AS applicant_count
       FROM job_openings o
       JOIN companies co ON co.id = o.company_id
       LEFT JOIN programs p ON p.id = o.program_id
      WHERE ${where} ORDER BY o.created_at DESC`,
    params,
  );
  return rows;
};

export const getOpening = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT o.*, co.name AS company_name FROM job_openings o JOIN companies co ON co.id = o.company_id WHERE o.id = $1 AND o.deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
};

export const createOpening = async (tenant, o, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO job_openings (company_id, title, description, ctc, location, job_type, status, criteria, poster_r2_key, program_id, branch_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11) RETURNING *`,
    [o.company_id, o.title, o.description ?? null, o.ctc ?? null, o.location ?? null, o.job_type ?? null, JSON.stringify(o.criteria ?? {}), o.poster_r2_key ?? null, o.program_id ?? null, o.branch_id ?? null, actorId ?? null],
  );
  return rows[0];
};

export const setOpeningStatus = async (tenant, id, status) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE job_openings SET status=$2, closed_at = CASE WHEN $2='closed' THEN now() ELSE NULL END, updated_at=now()
      WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
    [id, status],
  );
  return rows[0] || null;
};

export const deleteOpening = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE job_openings SET deleted_at=now(), updated_at=now() WHERE id=$1`, [id]);
};

// ---------- Criteria audience ----------
// Match students against an opening's criteria. Signals: attendance %, project
// submitted, capstone submitted, module completed, course completed. Optional
// program scope (o.program_id) + active branch (branchId). Returns matched rows.
export const matchAudience = async (tenant, { programId, criteria = {}, branchId }) => {
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const conds = ["s.deleted_at IS NULL", "s.status = 'active'"];
  if (programId) conds.push(`s.program_id = ${push(programId)}`);
  if (branchId) {
    conds.push(`EXISTS (SELECT 1 FROM admissions a JOIN leads l ON l.id = a.lead_id WHERE a.id = s.admission_id AND l.branch_id = ${push(branchId)})`);
  }
  // attendance % (present / ended classes in the student's batch, program-scoped when set)
  if (criteria.min_attendance_pct != null) {
    conds.push(`COALESCE((
      SELECT round(100.0 * count(*) FILTER (WHERE att.status='present') / NULLIF(count(*) FILTER (WHERE c.ended_at IS NOT NULL),0), 1)
        FROM batch_students bs
        JOIN classes c ON c.batch_id = bs.batch_id AND c.deleted_at IS NULL ${programId ? 'AND c.program_id = s.program_id' : ''}
        LEFT JOIN attendance att ON att.class_id = c.id AND att.student_id = s.id
       WHERE bs.student_id = s.id AND bs.deleted_at IS NULL
    ), 0) >= ${push(criteria.min_attendance_pct)}`);
  }
  if (criteria.project_submitted) {
    conds.push(`EXISTS (SELECT 1 FROM project_submissions ps JOIN projects pr ON pr.id = ps.project_id WHERE ps.student_id = s.id ${programId ? 'AND pr.program_id = s.program_id' : ''})`);
  }
  if (criteria.capstone_submitted) {
    conds.push(`EXISTS (SELECT 1 FROM capstone_submissions cs JOIN capstone_projects cp ON cp.id = cs.capstone_id WHERE cs.student_id = s.id ${programId ? 'AND cp.program_id = s.program_id' : ''})`);
  }
  if (criteria.module_completed_id) {
    conds.push(`EXISTS (SELECT 1 FROM student_module_progress smp WHERE smp.student_id = s.id AND smp.module_id = ${push(criteria.module_completed_id)})`);
  }
  if (criteria.course_completed) {
    // completed all modules of their program
    conds.push(`(
      SELECT count(*) FROM course_modules m WHERE m.program_id = s.program_id AND m.deleted_at IS NULL
    ) > 0 AND NOT EXISTS (
      SELECT 1 FROM course_modules m WHERE m.program_id = s.program_id AND m.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM student_module_progress smp WHERE smp.student_id = s.id AND smp.module_id = m.id)
    )`);
  }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.name, s.email, p.name AS program_name
       FROM students s LEFT JOIN programs p ON p.id = s.program_id
      WHERE ${conds.join(' AND ')}
      ORDER BY s.name`,
    params,
  );
  return rows;
};

// ---------- Applications ----------
export const fireToStudents = async (tenant, openingId, studentIds, actorId) => {
  let n = 0;
  for (const sid of studentIds) {
    // eslint-disable-next-line no-await-in-loop
    const { rowCount } = await tenantQuery(
      tenant,
      `INSERT INTO job_applications (opening_id, student_id, status, fired_by)
       VALUES ($1,$2,'fired',$3) ON CONFLICT (opening_id, student_id) DO NOTHING`,
      [openingId, sid, actorId ?? null],
    );
    n += rowCount;
  }
  return n;
};

export const listApplications = async (tenant, openingId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT a.id, a.student_id, st.name, st.email, st.cv_r2_key, a.status, a.note, a.offer_ctc, a.applied_at, a.created_at
       FROM job_applications a JOIN students st ON st.id = a.student_id
      WHERE a.opening_id = $1 ORDER BY st.name`,
    [openingId],
  );
  return rows;
};

export const setApplicationStatus = async (tenant, applicationId, status, note, offerCtc = undefined) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE job_applications SET
        status=$2,
        note=COALESCE($3,note),
        offer_ctc = COALESCE($4, offer_ctc),
        updated_at=now()
      WHERE id=$1 RETURNING *`,
    [applicationId, status, note ?? null, offerCtc ?? null],
  );
  return rows[0] || null;
};

export const applicationById = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM job_applications WHERE id=$1`, [id]);
  return rows[0] || null;
};

// ---------- Counts (dashboard) ----------
// Branch-scoped: openings/companies filter by their own branch_id; applications
// (no branch column) inherit their opening's branch. Adds a fired→selected
// funnel for the placement dashboard.
export const counts = async (tenant, branchScope = null) => {
  const params = [];
  const coB = branchClause('companies', branchScope, params);
  // Openings + application subqueries each need their own placeholder set — build
  // a fresh clause per correlated subquery so the params line up.
  const oB1 = branchClause('o', branchScope, params);
  const oB2 = branchClause('o', branchScope, params);
  const oB3 = branchClause('o', branchScope, params);
  const oB4 = branchClause('o', branchScope, params);
  const oB5 = branchClause('o', branchScope, params);
  const oB6 = branchClause('o', branchScope, params);
  const oB7 = branchClause('o', branchScope, params);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT
       (SELECT count(*)::int FROM companies WHERE deleted_at IS NULL${coB}) AS companies,
       (SELECT count(*)::int FROM job_openings o WHERE o.deleted_at IS NULL AND o.status='open'${oB1}) AS open_positions,
       (SELECT count(*)::int FROM job_openings o WHERE o.deleted_at IS NULL AND o.status='closed'${oB2}) AS closed_positions,
       (SELECT count(*)::int FROM job_applications a JOIN job_openings o ON o.id=a.opening_id WHERE o.deleted_at IS NULL${oB3}) AS applications,
       (SELECT count(*)::int FROM job_applications a JOIN job_openings o ON o.id=a.opening_id WHERE a.status='fired'${oB4}) AS fired,
       (SELECT count(*)::int FROM job_applications a JOIN job_openings o ON o.id=a.opening_id WHERE a.status IN ('applied','shortlisted','offer','selected')${oB5}) AS applied,
       (SELECT count(*)::int FROM job_applications a JOIN job_openings o ON o.id=a.opening_id WHERE a.status='offer'${oB6}) AS offers,
       (SELECT count(*)::int FROM job_applications a JOIN job_openings o ON o.id=a.opening_id WHERE a.status='selected'${oB7}) AS selected`,
    params,
  );
  return rows[0] || {};
};

// ---------- Student ----------
export const studentOpenings = async (tenant, studentId) => {
  // Openings fired to the student (with company + their application status).
  const { rows } = await tenantQuery(
    tenant,
    `SELECT o.id, o.title, o.description, o.ctc, o.location, o.job_type, o.status, o.poster_r2_key,
            co.name AS company_name, co.website AS company_website, co.logo_r2_key AS company_logo_r2_key,
            a.status AS application_status, a.id AS application_id
       FROM job_applications a
       JOIN job_openings o ON o.id = a.opening_id AND o.deleted_at IS NULL
       JOIN companies co ON co.id = o.company_id
      WHERE a.student_id = $1 ORDER BY o.created_at DESC`,
    [studentId],
  );
  return rows;
};

// A student's branch (via admission→lead). Null if not derivable.
export const studentBranchId = async (tenant, studentId) => {
  const has = await tenantQuery(tenant, `SELECT to_regclass('branches') IS NOT NULL AS ok`, []);
  if (!has.rows[0]?.ok) return null;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT l.branch_id FROM students s
       JOIN admissions a ON a.id = s.admission_id
       JOIN leads l ON l.id = a.lead_id
      WHERE s.id = $1 LIMIT 1`,
    [studentId],
  );
  return rows[0]?.branch_id || null;
};

// Open openings with a poster (student marketing feed), scoped to the student's
// branch — a student sees their branch's posters + tenant-wide (branch_id NULL)
// ones, never another branch's marketing.
export const posterFeed = async (tenant, branchId = null) => {
  const params = [];
  let branchCond = '';
  if (branchId) { params.push(branchId); branchCond = ` AND (o.branch_id IS NULL OR o.branch_id = $${params.length})`; }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT o.id, o.title, o.poster_r2_key, co.name AS company_name
       FROM job_openings o JOIN companies co ON co.id = o.company_id
      WHERE o.deleted_at IS NULL AND o.status='open' AND o.poster_r2_key IS NOT NULL${branchCond}
      ORDER BY o.created_at DESC LIMIT 30`,
    params,
  );
  return rows;
};

export const applyToOpening = async (tenant, openingId, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO job_applications (opening_id, student_id, status, applied_at)
     VALUES ($1,$2,'applied',now())
     ON CONFLICT (opening_id, student_id) DO UPDATE SET status = CASE WHEN job_applications.status='fired' THEN 'applied' ELSE job_applications.status END, applied_at = COALESCE(job_applications.applied_at, now()), updated_at = now()
     RETURNING *`,
    [openingId, studentId],
  );
  return rows[0];
};
