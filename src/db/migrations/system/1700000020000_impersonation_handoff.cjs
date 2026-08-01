/* eslint-disable camelcase */
// One-time handoff codes for product-owner impersonation.
//
// The PO console and the tenant admin app are separate origins, so the console
// can't write the admin app's session storage directly. Instead it starts an
// impersonation session, gets a short-lived single-use code, and opens the
// admin app at /sudo?code=… — the admin app exchanges the code for the token
// pair and drops it into its own storage.
//
// Only the sha256 of the code is stored: the DB never holds anything that
// could be replayed into a tenant session. The code is single-use
// (handoff_used_at) and expires in minutes, so the window on a leaked URL is
// small — and, unlike putting the JWTs straight in the query string, the URL
// stops working the moment it has been redeemed once.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE impersonation_sessions
      ADD COLUMN IF NOT EXISTS handoff_code_hash text,
      ADD COLUMN IF NOT EXISTS handoff_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS handoff_used_at timestamptz;
    CREATE UNIQUE INDEX IF NOT EXISTS impersonation_sessions_handoff_uq
      ON impersonation_sessions (handoff_code_hash) WHERE handoff_code_hash IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS impersonation_sessions_handoff_uq;
    ALTER TABLE impersonation_sessions
      DROP COLUMN IF EXISTS handoff_code_hash,
      DROP COLUMN IF EXISTS handoff_expires_at,
      DROP COLUMN IF EXISTS handoff_used_at;
  `);
};
