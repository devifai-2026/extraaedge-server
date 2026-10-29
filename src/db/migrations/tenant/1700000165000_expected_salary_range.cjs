/* eslint-disable camelcase */

// Expected salary becomes a RANGE ("20k to 25k"), which is how candidates
// actually answer the question. A single number forced the recruiter to pick
// one end and lose the other.
//
// Two nullable columns rather than a postgres numrange: the ends are edited
// independently in the form, are reported on separately ("show me everyone
// expecting under 25k"), and a range type would need a custom operator class
// for those filters. Two plain numerics keep the existing numeric(12,2)
// semantics and stay trivially queryable.
//
// expected_salary (the old single column) is DELIBERATELY KEPT, not dropped:
//   - 55 live candidate rows carry a value, and dropping the column in the
//     same migration that adds the new ones would make this irreversible if
//     the deploy needed rolling back;
//   - the bulk importer and the API still accept a single figure, which now
//     lands in BOTH ends (a point range), so older payloads keep working.
// It can be dropped later, once nothing reads it.
//
// Backfill maps each existing value to a point range (min = max = the old
// figure). That is the honest reading: we know what they said, we just don't
// know a spread, so the range is exact rather than invented.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('hiring_candidates', {
    expected_salary_min: { type: 'numeric(12,2)' },
    expected_salary_max: { type: 'numeric(12,2)' },
  });

  pgm.sql(`
    UPDATE hiring_candidates
       SET expected_salary_min = expected_salary,
           expected_salary_max = expected_salary
     WHERE expected_salary IS NOT NULL
  `);

  // A range that runs backwards is a data-entry slip, not a valid state.
  // Allows either end to be null (an open-ended "from 20k" is legitimate).
  pgm.addConstraint('hiring_candidates', 'hiring_candidates_expected_salary_range_chk',
    'CHECK (expected_salary_min IS NULL OR expected_salary_max IS NULL OR expected_salary_min <= expected_salary_max)');
};

exports.down = (pgm) => {
  pgm.dropConstraint('hiring_candidates', 'hiring_candidates_expected_salary_range_chk');
  pgm.dropColumns('hiring_candidates', ['expected_salary_min', 'expected_salary_max']);
};
