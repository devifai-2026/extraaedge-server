// Locally-registered WhatsApp templates.
//
// WABridge templates are created + approved in the WABridge/Meta portal. The
// user then registers each here by its portal template_id + the message body
// (with {{1}},{{2}}… placeholders) + how many variables it takes, so the
// composer can list and fill them. Managed by the tenant super_admin and by the
// PO console. This is NOT template creation — just referencing approved ones.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE wa_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_id text NOT NULL,          -- WABridge portal template id
      label text NOT NULL,                -- friendly name in the picker
      body text NOT NULL,                 -- message text with {{n}} placeholders
      variable_count int NOT NULL DEFAULT 0,
      category text,                      -- optional (marketing/utility/…)
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (template_id)
    );
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS wa_templates;`);
};
