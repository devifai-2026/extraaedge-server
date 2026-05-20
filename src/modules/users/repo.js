import { tenantQuery } from '../../db/tenant.js';

const COLS = `
  u.id, u.email, u.phone, u.name, u.avatar_r2_key, u.role, u.role_id,
  u.manager_id, u.team_id, u.is_active, u.last_login_at,
  u.session_timeout_minutes, u.track_work_time, u.permissions_json,
  u.designation,
  u.created_at, u.updated_at, r.name AS role_name, r.scope AS role_scope,
  COALESCE(
    (SELECT array_agg(um.manager_id) FROM user_managers um WHERE um.user_id = u.id),
    ARRAY[]::uuid[]
  ) AS manager_ids
`;

export const list = async (tenant, { q, role, team_id, manager_id, is_active, page, limit }) => {
  const conds = ['u.deleted_at IS NULL'];
  const params = [];
  if (role) { params.push(role); conds.push(`u.role = $${params.length}`); }
  if (team_id) { params.push(team_id); conds.push(`u.team_id = $${params.length}`); }
  if (manager_id) { params.push(manager_id); conds.push(`u.manager_id = $${params.length}`); }
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
    `INSERT INTO users (name, email, phone, password_hash, role, role_id, manager_id, team_id, track_work_time, session_timeout_minutes, permissions_json, designation, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, true), COALESCE($10, 15), $11, $12, true)
     RETURNING id, email, phone, name, avatar_r2_key, role, role_id, manager_id, team_id, is_active, session_timeout_minutes, track_work_time, permissions_json, designation, created_at, updated_at`,
    [
      input.name,
      input.email,
      input.phone ?? null,
      password_hash,
      input.role,
      input.role_id ?? null,
      input.manager_id ?? null,
      input.team_id ?? null,
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
     RETURNING id, email, phone, name, role, role_id, manager_id, team_id, is_active, session_timeout_minutes, track_work_time, permissions_json, updated_at`,
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
export const userWorkSessions = async (tenant, userId, { days = 30 } = {}) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, status, started_at, ended_at, paused_seconds, active_minutes,
            restart_of_day, last_paused_at
       FROM work_sessions
      WHERE user_id = $1 AND started_at > now() - ($2::int * interval '1 day')
      ORDER BY started_at DESC`,
    [userId, days],
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


export const userLoginEvents = async (tenant, userId, { days = 30 } = {}) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT created_at, kind, ip, user_agent, session_id
       FROM user_login_events
      WHERE user_id = $1 AND created_at > now() - ($2::int * interval '1 day')
      ORDER BY created_at DESC
      LIMIT 200`,
    [userId, days],
  );
  return rows;
};
