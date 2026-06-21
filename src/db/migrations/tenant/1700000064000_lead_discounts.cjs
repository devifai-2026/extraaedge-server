/* eslint-disable camelcase */
// Per-lead Discount % captured when a counsellor moves a lead to the
// Qualified stage.
//
// Rules (enforced in src/modules/lead-discounts/service.js):
//   - A counsellor may self-apply a discount up to 10% — it lands 'approved'
//     immediately.
//   - Anything above 10% lands 'pending_approval' and must be approved (or
//     rejected) by a sales_manager / branch_manager / super_admin.
//
// One row per lead (UNIQUE lead_id) — the current discount. History lives in
// lead_activities (type = 'discount_*'), mirroring how fee offers audit.
// The discount % is visible to the Accounts team (account_manager) on the
// converted lead, alongside the lead_fee_offers row.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lead_discounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
      discount_percent numeric(5,2) NOT NULL CHECK (discount_percent >= 0 AND discount_percent <= 100),
      -- approved      : within the counsellor's self-approve cap (<=10%), or
      --                 a higher discount a manager has signed off on.
      -- pending_approval : >10% awaiting a manager.
      -- rejected      : a manager declined the requested discount.
      status text NOT NULL DEFAULT 'pending_approval'
        CHECK (status IN ('approved', 'pending_approval', 'rejected')),
      reason text,                                   -- counsellor's justification
      reject_reason text,                            -- manager's note on rejection
      requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON lead_discounts (status);
    CREATE INDEX ON lead_discounts (requested_by);
    CREATE TRIGGER trg_lead_discounts_updated_at
      BEFORE UPDATE ON lead_discounts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS lead_discounts;`);
};
