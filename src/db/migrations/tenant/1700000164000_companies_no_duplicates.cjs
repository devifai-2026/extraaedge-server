/* eslint-disable camelcase */

// One company = one row.
//
// SYMPTOM: the hiring-partner directory accumulated the same company twice —
// in the live tenant, "NB Entrepreneurs" and "Sterelema" each appeared twice
// with the same website, same branch, created the same day. Nothing stopped
// it: createCompany is a bare INSERT and the bulk importer inserts per row,
// so adding a partner someone had already added just made a second card.
//
// That is worse than untidy. Openings hang off company_id, so the directory
// splits one partner's hiring across two rows: a card showing "0 openings"
// next to an identical card showing 2, and per-company reporting that silently
// halves.
//
// THE KEY — a normalised name, per branch:
//   • lower() + btrim() so "Sterelema" and "sterelema " collide.
//   • per branch_id, not tenant-wide: branch_id is nullable and branches are a
//     real scoping boundary elsewhere in this module (branchClause), so two
//     branches may legitimately each track their own row for the same partner.
//     COALESCE to a sentinel uuid because NULL never equals NULL in a unique
//     index, which would let unbranched duplicates straight back in.
//   • live rows only (deleted_at IS NULL), so a soft-deleted company frees the
//     name and can be re-added.
//
// Deliberately NOT fuzzy. Stripping "Pvt Ltd"/"Technologies" and punctuation
// would also collapse genuinely different companies that share a root word,
// and a unique index cannot be argued with once it is wrong. Exact-after-
// normalisation catches the real duplicates seen in the data (both pairs here
// are byte-identical names) and leaves judgement calls to the API, which warns
// on a near match instead of refusing.

const SENTINEL = '00000000-0000-0000-0000-000000000000';

exports.up = (pgm) => {
  // Fold existing duplicates together before the index can exist.
  //
  // Survivor = the row with the most openings, tie-broken by earliest
  // created_at. Picking by openings rather than age matters: in the live data
  // the NEWER "NB Entrepreneurs" row is the empty one, so an age-only rule
  // would have kept the right row by luck here and the wrong one elsewhere.
  pgm.sql(`
    CREATE TEMP TABLE company_dedupe_map AS
    WITH ranked AS (
      SELECT c.id,
             lower(btrim(c.name)) AS k,
             COALESCE(c.branch_id, '${SENTINEL}'::uuid) AS b,
             (SELECT count(*) FROM job_openings o
               WHERE o.company_id = c.id AND o.deleted_at IS NULL) AS openings,
             c.created_at
        FROM companies c
       WHERE c.deleted_at IS NULL
    ), winners AS (
      SELECT DISTINCT ON (k, b) k, b, id AS keep_id
        FROM ranked
       ORDER BY k, b, openings DESC, created_at ASC, id ASC
    )
    SELECT r.id AS dup_id, w.keep_id
      FROM ranked r
      JOIN winners w ON w.k = r.k AND w.b = r.b
     WHERE r.id <> w.keep_id
  `);

  // Repoint the duplicates' openings at the survivor, so no vacancy is
  // orphaned by the soft-delete below.
  pgm.sql(`
    UPDATE job_openings o
       SET company_id = m.keep_id, updated_at = now()
      FROM company_dedupe_map m
     WHERE o.company_id = m.dup_id
  `);

  // Carry over any profile detail the survivor is missing, so merging cannot
  // lose a website or address that only the duplicate had.
  pgm.sql(`
    UPDATE companies keep
       SET website  = COALESCE(keep.website,  dup.website),
           industry = COALESCE(keep.industry, dup.industry),
           location = COALESCE(keep.location, dup.location),
           about    = COALESCE(keep.about,    dup.about),
           logo_r2_key = COALESCE(keep.logo_r2_key, dup.logo_r2_key),
           updated_at = now()
      FROM company_dedupe_map m
      JOIN companies dup ON dup.id = m.dup_id
     WHERE keep.id = m.keep_id
  `);

  // Soft-delete the duplicates (reversible; nothing is destroyed).
  pgm.sql(`
    UPDATE companies c
       SET deleted_at = now(), updated_at = now()
      FROM company_dedupe_map m
     WHERE c.id = m.dup_id AND c.deleted_at IS NULL
  `);

  pgm.sql(`DROP TABLE company_dedupe_map`);

  pgm.sql(`
    CREATE UNIQUE INDEX companies_unique_name_per_branch
        ON companies ((lower(btrim(name))), (COALESCE(branch_id, '${SENTINEL}'::uuid)))
     WHERE deleted_at IS NULL
  `);
};

exports.down = (pgm) => {
  // Only the index is reversible — the merge is a data decision that should
  // not be silently undone (the duplicates' openings now live on the survivor).
  pgm.sql(`DROP INDEX IF EXISTS companies_unique_name_per_branch`);
};
