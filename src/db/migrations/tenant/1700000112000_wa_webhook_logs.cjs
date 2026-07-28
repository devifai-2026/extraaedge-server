// Per-tenant raw WhatsApp webhook / API payload log.
//
// Captures BOTH directions for debugging + audit in the PO console:
//   direction='inbound'  → the raw body WABridge/Meta POSTed to our webhook.
//   direction='outbound' → the request WE POST to WABridge (createtext/…) plus
//                          the response body + HTTP status we got back.
//
// This is a debugging/audit surface (raw JSON, includes phone numbers + message
// text), so it is pruned to the last 30 days — see the delete in the writer.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE wa_webhook_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      direction text NOT NULL,          -- 'inbound' | 'outbound'
      event text,                       -- e.g. 'message', 'status', 'send_text', 'send_template'
      endpoint text,                    -- outbound: WABridge path; inbound: webhook slug
      phone text,                       -- best-effort extracted counterparty number
      status_code integer,              -- outbound: HTTP status of the WABridge call
      ok boolean,                       -- outbound: did the call succeed
      request_json jsonb,               -- inbound: raw body; outbound: request we sent
      response_json jsonb,              -- outbound: WABridge response; inbound: null
      error text,                       -- any error message
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX wa_webhook_logs_created_idx ON wa_webhook_logs (created_at DESC);
    CREATE INDEX wa_webhook_logs_dir_idx ON wa_webhook_logs (direction, created_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS wa_webhook_logs;`);
};
