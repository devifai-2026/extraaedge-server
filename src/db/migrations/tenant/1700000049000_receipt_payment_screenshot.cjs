/* eslint-disable camelcase */
// Optional payment screenshot attached to a receipt.
//
// Accounts often capture money based on a screenshot the student sends
// over WhatsApp (UPI / bank transfer confirmation). Storing the image
// alongside the receipt gives admins a paper trail and keeps the
// receipt's public-share URL self-contained — the parent / student
// can verify what was credited.
//
// Stored as a GCS r2_key (same pattern as admission photos). Nullable
// because legacy rows + cash receipts won't have one.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE admission_receipts
      ADD COLUMN IF NOT EXISTS payment_screenshot_r2_key text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE admission_receipts
      DROP COLUMN IF EXISTS payment_screenshot_r2_key;
  `);
};
