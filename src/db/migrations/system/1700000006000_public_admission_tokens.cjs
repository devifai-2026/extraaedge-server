// Public share-links for the admission form.
//
// Why system DB: a public URL like /apply/<token> has no tenant context
// in the path, so the unauth public route resolves the tenant from this
// table (single sysQuery), then loads the lead from the tenant DB.
//
// Lifecycle: created when the accounts user clicks "Copy link" on a
// Pending Admission. Lives 24h (expires_at). On expiry the public route
// returns 410 Gone and the accounts user must "Regenerate" — which soft-
// deletes the old row (or just inserts a fresh one — token is unique).
// Once the student submits, we stamp `used_at` so the same link can't
// be reused to submit a second admission for the same lead.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS public_admission_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token text NOT NULL UNIQUE,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id uuid NOT NULL,
      created_by_user_id uuid,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- One active link per lead at a time. When a manager regenerates, we
    -- soft-replace by inserting a new row; this index keeps the lookups
    -- on (tenant_id, lead_id) cheap when we need to find the current row.
    CREATE INDEX IF NOT EXISTS idx_public_admission_tokens_tenant_lead
      ON public_admission_tokens (tenant_id, lead_id, created_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS public_admission_tokens;
  `);
};
