// Full WhatsApp inbox (Baileys) — every chat/contact from the linked account,
// not just CRM leads.
//
// The lead-centric message_log / message_reply tables stay as-is (used for
// sending + lead-attributed history). These two tables are the *inbox mirror*:
// they hold ALL chats the linked device syncs (recent history WhatsApp sends to
// a new linked device, plus anything live afterwards), each optionally linked to
// a CRM lead by phone. This is what powers the "show all chats, flag leads" UI.
//
// Scoped per owning user (the person whose number is linked) so multiple staff
// can each link their own WhatsApp without seeing each other's chats.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE wa_chats (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wa_jid text NOT NULL,                 -- '<number>@s.whatsapp.net' (1:1) or group jid
      phone text,                           -- digits parsed from a 1:1 jid
      name text,                            -- pushName / contact name / group subject
      is_group boolean NOT NULL DEFAULT false,
      lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,  -- matched CRM lead, if any
      last_body text,
      last_at timestamptz,
      unread int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (owner_user_id, wa_jid)
    );
    CREATE INDEX wa_chats_owner_last ON wa_chats (owner_user_id, last_at DESC NULLS LAST);
    CREATE INDEX wa_chats_lead ON wa_chats (lead_id);

    CREATE TABLE wa_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      chat_id uuid NOT NULL REFERENCES wa_chats(id) ON DELETE CASCADE,
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_message_id text,             -- WhatsApp message id (for dedup + acks)
      direction text NOT NULL,              -- 'in' | 'out'
      body text,
      media_r2_key text,                    -- GCS key when the message carried media
      media_type text,
      at timestamptz NOT NULL,
      status text,                          -- out: sent|delivered|seen
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (owner_user_id, provider_message_id)
    );
    CREATE INDEX wa_messages_chat_at ON wa_messages (chat_id, at ASC);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS wa_messages;
    DROP TABLE IF EXISTS wa_chats;
  `);
};
