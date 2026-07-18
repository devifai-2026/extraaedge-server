// WhatsApp inbox (WABridge send + Meta webhook receive).
//
// Each message now carries the provider's message id (WABridge messageid for
// outbound, Meta wamid for inbound) so delivery/read status webhooks can match
// and update the right row. Also indexes wa_chats.phone for the webhook's fast
// per-phone upsert.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS wa_message_id text;
    CREATE INDEX IF NOT EXISTS wa_messages_wamid ON wa_messages (wa_message_id);
    CREATE INDEX IF NOT EXISTS wa_chats_owner_phone ON wa_chats (owner_user_id, phone);
    CREATE INDEX IF NOT EXISTS wa_chats_phone ON wa_chats (phone);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP INDEX IF EXISTS wa_messages_wamid;
    DROP INDEX IF EXISTS wa_chats_owner_phone;
    DROP INDEX IF EXISTS wa_chats_phone;
    ALTER TABLE wa_messages DROP COLUMN IF EXISTS wa_message_id;
  `);
};
