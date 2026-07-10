/* eslint-disable camelcase */
// Student self-managed profile fields for the LMS portal: photo, contact,
// professional links, skills/bio, and a CV (GCS object key — served via signed
// URL, viewable by the student's course trainers).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE students
      ADD COLUMN IF NOT EXISTS photo_r2_key text,
      ADD COLUMN IF NOT EXISTS cv_r2_key text,
      ADD COLUMN IF NOT EXISTS cv_filename text,
      ADD COLUMN IF NOT EXISTS dob date,
      ADD COLUMN IF NOT EXISTS address text,
      ADD COLUMN IF NOT EXISTS github_url text,
      ADD COLUMN IF NOT EXISTS linkedin_url text,
      ADD COLUMN IF NOT EXISTS portfolio_url text,
      ADD COLUMN IF NOT EXISTS skills text,
      ADD COLUMN IF NOT EXISTS bio text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE students
      DROP COLUMN IF EXISTS photo_r2_key,
      DROP COLUMN IF EXISTS cv_r2_key,
      DROP COLUMN IF EXISTS cv_filename,
      DROP COLUMN IF EXISTS dob,
      DROP COLUMN IF EXISTS address,
      DROP COLUMN IF EXISTS github_url,
      DROP COLUMN IF EXISTS linkedin_url,
      DROP COLUMN IF EXISTS portfolio_url,
      DROP COLUMN IF EXISTS skills,
      DROP COLUMN IF EXISTS bio;
  `);
};
