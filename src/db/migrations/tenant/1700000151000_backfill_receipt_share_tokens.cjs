/* eslint-disable camelcase */
// Give every receipt a share_token so it can actually be downloaded.
//
// share_token is stamped at creation time (repo.insertReceipt) and is what
// both the public page /r/:token and the "Download PDF" button resolve the
// receipt by. Receipts issued BEFORE that column existed (migration
// 1700000046000) have NULL, and the UI can only tell the user
// "Old receipt — re-create it to mint a downloadable receipt." Re-creating a
// receipt to fix a missing token would mint a NEW receipt number for a payment
// that was already receipted, so the honest fix is to backfill the token and
// leave the receipt itself untouched.
//
// Format matches randomToken(32) in lib/crypto.js: 32 random bytes, base64url.
// gen_random_bytes comes from pgcrypto, which the tenant template already
// installs (gen_random_uuid() is used as a column default throughout).
// encode(...,'base64') then translated to the URL-safe alphabet with the '='
// padding stripped, which is exactly what Node's 'base64url' produces.
//
// Only touches rows where share_token IS NULL, so existing tokens — already
// shared with students — are never rotated.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    UPDATE admission_receipts
       SET share_token = translate(
             encode(gen_random_bytes(32), 'base64'),
             '+/=', '-_'
           )
     WHERE share_token IS NULL
  `);
};

exports.down = async () => {
  // Deliberately irreversible. Clearing the tokens would break links that may
  // already have been shared, and the column is nullable, so leaving the
  // backfilled values in place is harmless.
};
