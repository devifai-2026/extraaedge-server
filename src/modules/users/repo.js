import { tenantQuery, tenantTx } from '../../db/tenant.js';

const COLS = `
  u.id, u.email, u.phone, u.name, u.avatar_r2_key, u.role, u.role_id,
  u.manager_id, u.team_id, u.branch_id, u.is_active, u.last_login_at,
  u.session_timeout_minutes, u.track_work_time, u.permissions_json,
  u.designation,
  u.created_at, u.updated_at, r.name AS role_name, r.scope AS role_scope,
  COALESCE(
    (SELECT array_agg(um.manager_id) FROM user_managers um WHERE um.user_id = u.id),
    ARRAY[]::uuid[]
  ) AS manager_ids
`;

export const list = async (tenant, { q, role, team_id, manager_id, is_active, page, limit, scope_user_ids }) => {
  const conds = ['u.deleted_at IS NULL'];
  const params = [];
  if (role) { params.push(role); conds.push(`u.role = $${params.length}`); }
  if (team_id) { params.push(team_id); conds.push(`u.team_id = $${params.length}`); }
  if (manager_id) { params.push(manager_id); conds.push(`u.manager_id = $${params.length}`); }
  // Branch subtree restriction (branch_manager) — only these user ids.
  if (Array.isArray(scope_user_ids)) { params.push(scope_user_ids); conds.push(`u.id = ANY($${params.length})`); }
  if (is_active === 'true') conds.push('u.is_active = true');
  if (is_active === 'false') conds.push('u.is_active = false');
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const countParams = params.slice(0, -2);
  const [{ rows }, { rows: countRows }] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT ${COLS}
         FROM users u LEFT JOIN custom_roles r ON r.id = u.role_id
         ${where}
         ORDER BY u.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    tenantQuery(tenant, `SELECT count(*)::int AS total FROM users u ${where}`, countParams),
  ]);
  return { rows, total: countRows[0].total };
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM users u LEFT JOIN custom_roles r ON r.id = u.role_id WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};

// Multi-branch membership for teaching staff (user_branches join). Primary
// branch stays on users.branch_id; these are the ADDITIONAL branches they work.
// Label-only projection for pick-lists: no email/phone/permissions, every
// active user, ordered for display.
export const listOptions = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT u.id, u.name, u.role, u.branch_id, u.designation
       FROM users u
      WHERE u.deleted_at IS NULL AND u.is_active = true
      ORDER BY u.name ASC`,
  );
  return rows;
};

export const listUserBranchIds = async (tenant, userId) => {
  const { rows } = await tenantQuery(tenant, `SELECT branch_id FROM user_branches WHERE user_id = $1`, [userId]);
  return rows.map((r) => r.branch_id);
};

export const setUserBranches = async (tenant, userId, branchIds) => {
  await tenantTx(tenant, async (client) => {
    await client.query(`DELETE FROM user_branches WHERE user_id = $1`, [userId]);
    for (const bid of [...new Set((branchIds || []).filter(Boolean))]) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO user_branches (user_id, branch_id) VALUES ($1,$2) ON CONFLICT (user_id, branch_id) DO NOTHING`,
        [userId, bid],
      );
    }
  });
};

export const findByEmail = async (tenant, email) => {
  // Case-insensitive: the DB has a partial unique index on lower(email)
  // where deleted_at IS NULL, so the app-level dedup check must match the
  // same casing rule. Otherwise the FE could submit "Foo@x.com" past the
  // app check and then trip the unique index at INSERT time.
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM users u LEFT JOIN custom_roles r ON r.id = u.role_id
      WHERE lower(u.email) = lower($1) AND u.deleted_at IS NULL`,
    [email],
  );
  return rows[0] ?? null;
};

export const insert = async (tenant, input, password_hash) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO users (name, email, phone, password_hash, role, role_id, manager_id, team_id, branch_id, track_work_time, session_timeout_minutes, permissions_json, designation, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10, true), COALESCE($11, 15), $12, $13, true)
     RETURNING id, email, phone, name, avatar_r2_key, role, role_id, manager_id, team_id, branch_id, is_active, session_timeout_minutes, track_work_time, permissions_json, designation, created_at, updated_at`,
    [
      input.name,
      input.email,
      input.phone ?? null,
      password_hash,
      input.role,
      input.role_id ?? null,
      input.manager_id ?? null,
      input.team_id ?? null,
      input.branch_id ?? null,
      input.track_work_time ?? null,
      input.session_timeout_minutes ?? null,
      input.permissions_json ?? null,
      input.designation ?? null,
    ],
  );
  return rows[0];
};

// Replace-all the user's reporting managers in user_managers join table.
export const setManagers = async (tenant, user_id, manager_ids) => {
  await tenantQuery(tenant, `DELETE FROM user_managers WHERE user_id = $1`, [user_id]);
  for (const mid of (manager_ids || [])) {
    if (!mid || mid === user_id) continue;
    // eslint-disable-next-line no-await-in-loop
    await tenantQuery(
      tenant,
      `INSERT INTO user_managers (user_id, manager_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [user_id, mid],
    );
  }
};

export const getManagerIds = async (tenant, user_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT manager_id FROM user_managers WHERE user_id = $1 ORDER BY created_at`,
    [user_id],
  );
  return rows.map((r) => r.manager_id);
};

export const update = async (tenant, id, updates) => {
  const fields = [];
  const params = [];
  let i = 1;
  for (const [k, v] of Object.entries(updates)) {
    fields.push(`${k} = $${i}`);
    params.push(v);
    i += 1;
  }
  if (!fields.length) return findById(tenant, id);
  params.push(id);
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL
     RETURNING id, email, phone, name, role, role_id, manager_id, team_id, branch_id, is_active, session_timeout_minutes, track_work_time, permissions_json, updated_at`,
    params,
  );
  return rows[0] ?? null;
};

export const updatePasswordHash = async (tenant, id, password_hash) => {
  await tenantQuery(tenant, `UPDATE users SET password_hash = $2 WHERE id = $1`, [id, password_hash]);
};

export const softDelete = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE users SET deleted_at = now(), is_active = false WHERE id = $1`, [id]);
};

export const getUpdatedAt = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT updated_at FROM users WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0]?.updated_at ?? null;
};

// Walk the reporting chain UPWARD from a user: returns every manager_id
// above them, plus all super_admins as a final "umbrella" layer. Used by
// follow-up cancellation notifications so the full org sees the action.
// The returned array does NOT include the user themselves.
export const managerChain = async (tenant, user_id) => {
  if (!user_id) return [];
  const { rows } = await tenantQuery(
    tenant,
    `WITH RECURSIVE chain AS (
       SELECT manager_id AS id FROM users
        WHERE id = $1 AND deleted_at IS NULL AND manager_id IS NOT NULL
       UNION
       SELECT u.manager_id FROM users u JOIN chain c ON u.id = c.id
        WHERE u.deleted_at IS NULL AND u.manager_id IS NOT NULL
     )
     SELECT id FROM chain WHERE id IS NOT NULL
     UNION
     SELECT id FROM users
      WHERE role = 'super_admin' AND deleted_at IS NULL AND is_active = true`,
    [user_id],
  );
  return rows.map((r) => r.id);
};

// Recursive CTE for my-team (manager hierarchy).
export const teamHierarchy = async (tenant, root_user_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `WITH RECURSIVE team AS (
       SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL
       UNION
       SELECT u.id FROM users u JOIN team t ON u.manager_id = t.id WHERE u.deleted_at IS NULL
     )
     SELECT id FROM team`,
    [root_user_id],
  );
  return rows.map((r) => r.id);
};

export const teamUsers = async (tenant, ids) => {
  if (!ids.length) return [];
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM users u LEFT JOIN custom_roles r ON r.id = u.role_id
      WHERE u.id = ANY($1::uuid[]) AND u.deleted_at IS NULL
      ORDER BY u.role DESC, u.name`,
    [ids],
  );
  return rows;
};

// ---------- Per-user views (used by /users/:id/* endpoints) ----------

// status=current → leads currently owned. status=past → leads previously
// assigned but moved on (read from lead_assignments where is_active=false).
export const userLeads = async (tenant, userId, { status, limit = 100 }) => {
  if (status === 'past') {
    const { rows } = await tenantQuery(
      tenant,
      `SELECT DISTINCT ON (l.id)
              l.id, l.name, l.email, l.phone, l.created_at, l.updated_at, l.lead_score,
              s.name AS stage_name, ss.name AS sub_stage_name,
              p.name AS program_name,
              cur.name AS current_owner_name,
              la.created_at AS assigned_at,
              la.reason AS assignment_reason
         FROM lead_assignments la
         JOIN leads l   ON l.id  = la.lead_id AND l.deleted_at IS NULL
         LEFT JOIN lead_stages     s   ON s.id  = l.stage_id
         LEFT JOIN lead_sub_stages ss  ON ss.id = l.sub_stage_id
         LEFT JOIN programs        p   ON p.id  = l.program_id
         LEFT JOIN users           cur ON cur.id = l.assigned_to
        WHERE la.assigned_to = $1
          AND la.is_active = false
          AND l.assigned_to IS DISTINCT FROM $1
        ORDER BY l.id, la.created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT l.id, l.name, l.email, l.phone, l.created_at, l.updated_at, l.lead_score,
            s.name AS stage_name, ss.name AS sub_stage_name,
            p.name AS program_name
       FROM leads l
       LEFT JOIN lead_stages     s   ON s.id  = l.stage_id
       LEFT JOIN lead_sub_stages ss  ON ss.id = l.sub_stage_id
       LEFT JOIN programs        p   ON p.id  = l.program_id
      WHERE l.assigned_to = $1 AND l.deleted_at IS NULL
      ORDER BY l.updated_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
};

// Recent work sessions for the time-sheet table on the user-profile page.
// We compute per-row active_seconds on the way out so the FE can render it.
// hours (not days) so the FE's 6h/24h/7d/30d/lifetime filter can express the
// 6h option; lifetime is just a very large hours value from the caller.
export const userWorkSessions = async (tenant, userId, range = {}) => {
  const startedAt = timeBoundClause('started_at', range);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, status, started_at, ended_at, paused_seconds, active_minutes,
            restart_of_day, last_paused_at, auto_closed, closed_reason
       FROM work_sessions
      WHERE user_id = $1 AND ${startedAt.sql}
      ORDER BY started_at DESC`,
    [userId, ...startedAt.params],
  );
  return rows.map((r) => {
    const start = new Date(r.started_at).getTime();
    const end = r.ended_at ? new Date(r.ended_at).getTime() : Date.now();
    let paused = (r.paused_seconds || 0) * 1000;
    if (r.status === 'paused' && r.last_paused_at) {
      paused += Date.now() - new Date(r.last_paused_at).getTime();
    }
    const active_seconds = Math.max(0, Math.floor((end - start - paused) / 1000));
    return { ...r, active_seconds };
  });
};

// Time-bound WHERE fragment for a column, shared by userWorkSessions /
// userActivitySummary / userLoginEvents. An explicit {from,to} (absolute
// calendar range, e.g. a date-picker) takes precedence over hours (relative
// lookback from now) — they mean genuinely different things: "1 Jul to 5
// Jul" is not "however many hours that spans, counted back from right now".
// $1 is always the user id in every caller below, so this always starts
// filling params from $2.
const timeBoundClause = (col, { hours, from, to } = {}) => {
  if (from && to) return { sql: `${col} BETWEEN $2::timestamptz AND $3::timestamptz`, params: [from, to] };
  return { sql: `${col} > now() - ($2::int * interval '1 hour')`, params: [hours ?? 720] };
};

// Real-vs-api activity split for the super_admin activity report — how much
// of this user's tracked time was backed by an actual mouse/keyboard pattern
// (see requireClockIn/useGenuineActivity) vs just an API call happening —
// plus the leads-created breakdown and lead-activity count for the same
// window, so the Users page can show them as one time-ranged KPI strip.
export const userActivitySummary = async (tenant, userId, range = {}) => {
  const minuteBucket = timeBoundClause('minute_bucket', range);
  const createdAt = timeBoundClause('created_at', range);
  const [activity, leadsCreated, bulkCreated, systemAssigned, activityCount] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT count(*)::int AS active_minutes,
              count(*) FILTER (WHERE source = 'genuine')::int AS genuine_minutes
         FROM work_activity_minutes
        WHERE user_id = $1 AND ${minuteBucket.sql}`,
      [userId, ...minuteBucket.params],
    ),
    tenantQuery(
      tenant,
      `SELECT count(*)::int AS n FROM leads
        WHERE created_by = $1 AND deleted_at IS NULL AND ${createdAt.sql}`,
      [userId, ...createdAt.params],
    ),
    // Bulk-uploaded leads don't carry their own marker on `leads` — a bulk
    // import sets created_by to the uploader same as a manual add — so this
    // is read from the import job itself (success_rows = leads actually
    // created, not attempted rows) rather than derived from `leads`.
    tenantQuery(
      tenant,
      `SELECT COALESCE(SUM(success_rows), 0)::int AS n FROM bulk_imports
        WHERE user_id = $1 AND kind = 'leads' AND ${createdAt.sql}`,
      [userId, ...createdAt.params],
    ),
    // Leads the round-robin/assignment-rule engine handed to this user,
    // as opposed to leads they created themselves.
    tenantQuery(
      tenant,
      `SELECT count(*)::int AS n FROM lead_assignments
        WHERE assigned_to = $1 AND assignment_type = 'auto_assign' AND ${createdAt.sql}`,
      [userId, ...createdAt.params],
    ),
    // "Lead stages moved or any activity updated" — every lead_activities
    // row this user is the actor for (stage changes, notes, auto_assign
    // markers excluded since those have user_id NULL by design).
    tenantQuery(
      tenant,
      `SELECT count(*)::int AS n FROM lead_activities
        WHERE user_id = $1 AND ${createdAt.sql}`,
      [userId, ...createdAt.params],
    ),
  ]);
  const totalCreated = leadsCreated.rows[0].n;
  const bulk = bulkCreated.rows[0].n;
  return {
    ...activity.rows[0],
    leads_created_total: totalCreated,
    leads_created_manual: Math.max(0, totalCreated - bulk),
    leads_created_bulk: bulk,
    leads_assigned_by_system: systemAssigned.rows[0].n,
    lead_activity_count: activityCount.rows[0].n,
  };
};

export const userLoginEvents = async (tenant, userId, range = {}) => {
  const createdAt = timeBoundClause('created_at', range);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT created_at, kind, ip, user_agent, session_id,
            lat::float8 AS lat, lng::float8 AS lng, geo_city, geo_country, geo_isp, location_source
       FROM user_login_events
      WHERE user_id = $1 AND ${createdAt.sql}
      ORDER BY created_at DESC
      LIMIT 200`,
    [userId, ...createdAt.params],
  );
  return rows;
};
