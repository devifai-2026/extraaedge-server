/* eslint-disable camelcase */
// Backfill: every photo_r2_key / selfie_r2_key referenced by an
// admission must have a matching uploaded_files row, so the admin-side
// `/uploads/by-key/signed-url` lookup can resolve it.
//
// The student-side `confirmPublicPhoto` was indexing only in GCS (HEAD
// check), not in `uploaded_files`. That's now fixed for new uploads,
// but existing student-uploaded photos still need an index row. We
// stamp them with user_id=NULL, visibility='tenant', purpose='admission_photo'
// so account-side previewers can fetch them.

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO uploaded_files
      (user_id, r2_key, r2_bucket, content_type, size_bytes, purpose,
       ref_entity_type, ref_entity_id, visibility)
    SELECT
      NULL,
      keys.r2_key,
      -- r2_bucket is NOT NULL but we don't know the historical bucket
      -- here. The application reads from env.GCS_BUCKET at signing
      -- time, not from this column — '' is a safe placeholder.
      '',
      NULL,
      NULL,
      'admission_photo',
      'admission',
      keys.admission_id,
      'tenant'
    FROM (
      SELECT id AS admission_id, photo_r2_key AS r2_key
        FROM admissions
       WHERE photo_r2_key IS NOT NULL
      UNION
      SELECT id, selfie_r2_key
        FROM admissions
       WHERE selfie_r2_key IS NOT NULL
    ) AS keys
    LEFT JOIN uploaded_files uf ON uf.r2_key = keys.r2_key
    WHERE uf.id IS NULL;
  `);
};

exports.down = () => {
  // No-op. Reversing the backfill blindly would drop rows that might
  // have been touched by subsequent uploads.
};
