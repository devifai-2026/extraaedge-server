// Resolves `lead_owner_email` on an admission-import row into the counsellor
// who guided the student.
//
// This is deliberately NOT bulk-ingestion/assignee-resolver.js. That one is
// built for lead distribution: hand it a manager's email and it round-robins
// across their team, hand it an admin's and it spreads across the tenant.
// That behaviour is wrong here — "Guided By" on a historical export names one
// specific person, and admissions.guided_by_counsellor_id is an attribution
// field, not a workload one. Spreading it round-robin would credit the wrong
// counsellor for someone else's admission.
//
// So: exact match, counsellor role only, no fallback.
//   blank             → { user: null }         (their "Others" rows)
//   unknown email     → OWNER_NOT_FOUND
//   non-counsellor    → OWNER_NOT_COUNSELLOR
//   active counsellor → { user: { id, manager_id } }
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

export const createOwnerCache = () => new Map(); // lowercased email -> user | null

export const resolveOwner = async (tenant, cache, email) => {
  if (email === undefined || email === null || String(email).trim() === '') {
    return { ok: true, user: null };
  }
  const key = String(email).trim().toLowerCase();
  let user = cache.get(key);
  if (user === undefined) {
    const { rows } = await tenantQuery(
      tenant,
      `SELECT id, name, email, role, manager_id
         FROM users
        WHERE lower(email) = $1 AND deleted_at IS NULL AND is_active = true
        LIMIT 1`,
      [key],
    );
    user = rows[0] ?? null;
    cache.set(key, user);
  }
  if (!user) {
    return {
      ok: false,
      error: {
        code: 'OWNER_NOT_FOUND',
        message: `lead_owner_email "${email}" doesn't match any active user — check the counsellor list on the "Allowed Values" sheet`,
      },
    };
  }
  if (user.role !== SYSTEM_TENANT_ROLES.COUNSELLOR) {
    return {
      ok: false,
      error: {
        code: 'OWNER_NOT_COUNSELLOR',
        message: `lead_owner_email "${email}" belongs to a ${user.role}, not a counsellor — use the counsellor who actually guided this student, or leave the column blank`,
      },
    };
  }
  return { ok: true, user };
};
