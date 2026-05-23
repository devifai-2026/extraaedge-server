/* eslint-disable camelcase */
// Trigram indexes that back the global lead search.
//
// Why: the q-search in repo.js list() ILIKEs across name/email/phone plus
// whatsapp_number, alternate_contact, and the digits-only form of each
// phone-like column (so "9876543210" matches "+91 98765-43210"). Without
// these indexes the ILIKE falls back to a seq scan on every lead row, which
// is what made the search feel "sometimes there, sometimes not" — at low
// concurrency the planner found it via the existing leads_phone_trgm, at
// higher concurrency it timed out or returned partial pages before the
// scan finished.
//
// pg_trgm is already enabled (used by leads_phone_trgm in the initial
// leads migration), so we only add the missing partial+functional indexes.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    -- ILIKE acceleration for the two phone-like columns the old query missed.
    CREATE INDEX IF NOT EXISTS leads_whatsapp_trgm
      ON leads USING gin (whatsapp_number gin_trgm_ops)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS leads_alt_contact_trgm
      ON leads USING gin (alternate_contact gin_trgm_ops)
      WHERE deleted_at IS NULL;

    -- Digits-only functional indexes: lets the planner use trigram lookup
    -- on the normalised form so a noisy user query ("98765 43210") still
    -- gets indexed access against a stored "+91-98765-43210".
    CREATE INDEX IF NOT EXISTS leads_phone_digits_trgm
      ON leads USING gin ((regexp_replace(coalesce(phone,''), '\\D', '', 'g')) gin_trgm_ops)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS leads_whatsapp_digits_trgm
      ON leads USING gin ((regexp_replace(coalesce(whatsapp_number,''), '\\D', '', 'g')) gin_trgm_ops)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS leads_alt_contact_digits_trgm
      ON leads USING gin ((regexp_replace(coalesce(alternate_contact,''), '\\D', '', 'g')) gin_trgm_ops)
      WHERE deleted_at IS NULL;

    -- Name search is currently the slowest branch (no trigram). Add one.
    CREATE INDEX IF NOT EXISTS leads_name_trgm
      ON leads USING gin (name gin_trgm_ops)
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS leads_name_trgm;
    DROP INDEX IF EXISTS leads_alt_contact_digits_trgm;
    DROP INDEX IF EXISTS leads_whatsapp_digits_trgm;
    DROP INDEX IF EXISTS leads_phone_digits_trgm;
    DROP INDEX IF EXISTS leads_alt_contact_trgm;
    DROP INDEX IF EXISTS leads_whatsapp_trgm;
  `);
};
