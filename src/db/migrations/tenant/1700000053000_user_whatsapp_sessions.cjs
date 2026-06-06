// Per-user WhatsApp connections (whatsapp-web.js).
//
// Each user links their OWN WhatsApp number via a QR scan; the gateway holds
// the live client and persists the session auth blob to GCS. This table is the
// durable record of that link: status, the linked phone, the GCS object key,
// and the timestamps the FE/gateway need to render and restore.
//
// We also thread a `user_whatsapp_session_id` onto message_log (outbound) and
// message_reply (inbound) so the unified message store can attribute each row
// to the specific user-number it went out from / came in to. New WhatsApp rows
// carry provider='wwebjs' (the old WABridge path used provider='wabridge').
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE user_whatsapp_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      phone text,
      -- pending_qr  : QR issued, awaiting scan
      -- connected   : linked + ready to send/receive
      -- disconnected: transport dropped (auto-reconnectable, blob kept)
      -- logged_out  : user unlinked the device (blob deleted)
      status text NOT NULL DEFAULT 'pending_qr',
      session_gcs_key text,
      last_qr_at timestamptz,
      connected_at timestamptz,
      last_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id)
    );
    CREATE TRIGGER trg_user_whatsapp_sessions_updated_at
      BEFORE UPDATE ON user_whatsapp_sessions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    ALTER TABLE message_log
      ADD COLUMN user_whatsapp_session_id uuid
        REFERENCES user_whatsapp_sessions(id) ON DELETE SET NULL;
    -- The WABridge model logged template sends (no inline text). Free-text
    -- whatsapp-web.js messages need the body stored on the outbound log too.
    ALTER TABLE message_log ADD COLUMN body text;
    ALTER TABLE message_reply
      ADD COLUMN user_whatsapp_session_id uuid
        REFERENCES user_whatsapp_sessions(id) ON DELETE SET NULL;
    CREATE INDEX ON message_log (user_whatsapp_session_id);
    CREATE INDEX ON message_reply (user_whatsapp_session_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE message_log   DROP COLUMN IF EXISTS user_whatsapp_session_id;
    ALTER TABLE message_log   DROP COLUMN IF EXISTS body;
    ALTER TABLE message_reply DROP COLUMN IF EXISTS user_whatsapp_session_id;
    DROP TABLE IF EXISTS user_whatsapp_sessions;
  `);
};
