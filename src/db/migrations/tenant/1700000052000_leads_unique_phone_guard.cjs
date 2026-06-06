/* eslint-disable camelcase */
// DB-level backstop against duplicate leads with the same phone number.
//
// Why: app-level dedup (repo.findDuplicates) is the primary guard, but it
// can't catch two requests racing, a double-submitted bulk upload, or any
// future code path that forgets to call it. The two real-world SHUBHAM
// RAMKISHAN ALAPURE rows (same +919322994226, no email/whatsapp, two bulk
// uploads 40 min apart) got in precisely because the bulk path skipped phone.
//
// Guard: a partial UNIQUE index on the LAST-10-DIGITS of phone, scoped to
// live rows (deleted_at IS NULL) that actually have a 10+-digit phone. Last-10
// matches the app's normalisation so "+919322994226" and "9322994226" collide.
//
// Pre-existing duplicates would make CREATE UNIQUE INDEX fail, so we first
// soft-delete (deleted_at) all but the EARLIEST lead per normalised phone
// within this tenant. Oldest-wins keeps the row counsellors have worked
// longest; soft-delete (not hard) means the data is recoverable.
//
// NOTE: this enforces uniqueness on phone ALONE — stricter than the app's
// bulk policy (which only falls back to phone when no email/whatsapp). For the
// education-CRM reality of shared family numbers this is a deliberate "one
// lead per phone" trade-off. If shared numbers later need to coexist, drop
// this index and rely on app-level dedup.

exports.up = (pgm) => {
  pgm.sql(`
    -- 1) Soft-delete pre-existing phone duplicates, oldest-wins. Rank live
    --    leads within each normalised-phone group by (created_at, id); every
    --    row past the first is a dup and gets deleted_at stamped.
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10)
               ORDER BY created_at, id
             ) AS rn
        FROM leads
       WHERE deleted_at IS NULL
         AND length(right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10)) = 10
    )
    UPDATE leads
       SET deleted_at = now()
      WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

    -- 2) Enforce one live lead per normalised phone going forward.
    CREATE UNIQUE INDEX IF NOT EXISTS leads_unique_phone_digits
      ON leads ((right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10)))
      WHERE deleted_at IS NULL
        AND length(right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10)) = 10;
  `);
};

exports.down = (pgm) => {
  // We do NOT un-soft-delete the rows merged in up() — resurrecting them would
  // re-introduce the duplicates.
  pgm.sql(`DROP INDEX IF EXISTS leads_unique_phone_digits;`);
};
