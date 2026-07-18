// Outbound WhatsApp media (whatsapp-web.js).
//
// The free-text whatsapp-web.js path already stores `body` on message_log
// (see 1700000053000_user_whatsapp_sessions). To let users attach an image /
// PDF / audio to an outbound WhatsApp message we also need to record the
// attachment. Inbound media already has a home (message_reply.media_urls), so
// this only adds the outbound side.
//
// The attachment is stored in GCS (via the shared uploads pipeline) and
// referenced here by its object key; the FE resolves it to a short-lived
// signed URL on demand. media_type/media_filename are kept for rendering
// (image vs. download link) and for the conversation-list preview.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE message_log ADD COLUMN media_r2_key text;
    ALTER TABLE message_log ADD COLUMN media_type text;
    ALTER TABLE message_log ADD COLUMN media_filename text;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE message_log DROP COLUMN IF EXISTS media_r2_key;
    ALTER TABLE message_log DROP COLUMN IF EXISTS media_type;
    ALTER TABLE message_log DROP COLUMN IF EXISTS media_filename;
  `);
};
