/* eslint-disable camelcase */
// Add `grade_unit` to admission_education so each row can record whether
// the number in `percentage` is on a 0–100 scale (default, %) or a 0–10
// CGPA scale. Students were getting forced to convert CGPA → % which led
// to inaccurate records (everyone rounding to "85%" or similar).
//
// Existing rows are backfilled to 'percent' so reads stay consistent
// without an app-layer fallback. Nullable check + default keep the
// migration online-safe.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE admission_education
      ADD COLUMN IF NOT EXISTS grade_unit text NOT NULL DEFAULT 'percent'
        CHECK (grade_unit IN ('percent', 'cgpa'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE admission_education DROP COLUMN IF EXISTS grade_unit;
  `);
};
