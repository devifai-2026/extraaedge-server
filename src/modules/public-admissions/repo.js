// System-DB repo for the public_admission_tokens table.
//
// The table lives in the SYSTEM database (not per-tenant) so the public
// /apply/:token route can resolve a token to a tenant in a single query
// without knowing which tenant owns the lead.
import { sysQuery } from '../../db/system.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h, per product spec

export const insertToken = async ({ token, tenant_id, lead_id, created_by_user_id }) => {
  const expires_at = new Date(Date.now() + TOKEN_TTL_MS);
  const { rows } = await sysQuery(
    `INSERT INTO public_admission_tokens (token, tenant_id, lead_id, created_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, token, expires_at, created_at`,
    [token, tenant_id, lead_id, created_by_user_id ?? null, expires_at],
  );
  return rows[0];
};

// Single point of lookup for the public route. Returns null when:
//   • token doesn't exist
//   • token already used (student already submitted)
//   • token expired
// The route maps the null reasons to 404 / 410 distinctly using the
// `status` field below — easier than throwing structured errors here.
export const lookupToken = async (token) => {
  const { rows } = await sysQuery(
    `SELECT id, token, tenant_id, lead_id, expires_at, used_at
       FROM public_admission_tokens
      WHERE token = $1
      LIMIT 1`,
    [token],
  );
  const row = rows[0];
  if (!row) return { status: 'not_found' };
  if (row.used_at) return { status: 'used', row };
  if (new Date(row.expires_at).getTime() < Date.now()) return { status: 'expired', row };
  return { status: 'ok', row };
};

// Mark the token consumed after a successful student submission. The same
// link cannot be reused — the accounts user must regenerate to share again
// (though by then there's already an admission for the lead, so the
// regenerate button would be hidden FE-side too).
export const markUsed = async (id) => {
  await sysQuery(
    `UPDATE public_admission_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
    [id],
  );
};
