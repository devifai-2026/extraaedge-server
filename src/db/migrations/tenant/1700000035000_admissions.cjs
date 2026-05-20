// Admissions module (account_manager role).
//
// Five new tables:
//   1. admission_centers           — tenant-managed dropdown (JM Road, etc.)
//   2. admissions                  — one row per enrolled student
//   3. admission_education         — 1..N education rows per admission
//   4. admission_fee_schedule      — installment plan per admission
//   5. admission_receipts          — money-collected log per admission
//
// All FK to leads / users use ON DELETE SET NULL so removing an upstream
// row doesn't cascade-delete accounting history; soft-delete via deleted_at
// is the canonical "remove" path.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    -- 1. CENTERS dropdown -------------------------------------------------
    CREATE TABLE IF NOT EXISTS admission_centers (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name        text NOT NULL,
      address     text,
      is_active   boolean NOT NULL DEFAULT true,
      sort_order  smallint NOT NULL DEFAULT 0,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      deleted_at  timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS admission_centers_name_uq
      ON admission_centers (lower(name)) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_admission_centers_updated_at
      BEFORE UPDATE ON admission_centers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- 2. ADMISSIONS -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS admissions (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Link back to the originating lead. Nullable so accounts can create
      -- standalone admissions (walk-ins, manual entries).
      lead_id                  uuid REFERENCES leads(id) ON DELETE SET NULL,
      admission_date           date NOT NULL,
      -- Identity (snapshot at admission time; lead.* may diverge later)
      first_name               text NOT NULL,
      middle_name              text,
      last_name                text,
      email                    text,
      whatsapp_number          text,
      alternate_contact        text,
      address                  text,
      -- Programme details
      program_id               uuid REFERENCES programs(id) ON DELETE SET NULL,
      mode_of_training         text NOT NULL,           -- Online / Offline / Hybrid
      center_id                uuid REFERENCES admission_centers(id) ON DELETE SET NULL,
      -- Money
      total_fees               numeric(12, 2) NOT NULL DEFAULT 0,
      mode_of_payment          text,                    -- Installment / Full
      -- Workflow status
      status                   text NOT NULL DEFAULT 'pending_approval',
        -- pending_approval | attending | on_break | completed | rejected
      break_reason             text,
      -- Photos (GCS r2_keys)
      selfie_r2_key            text,
      photo_r2_key             text,
      -- Provenance
      guided_by_counsellor_id  uuid REFERENCES users(id) ON DELETE SET NULL,
      guided_by_manager_id     uuid REFERENCES users(id) ON DELETE SET NULL,
      source                   text,
      -- Audit
      created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_by              uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at              timestamptz,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now(),
      deleted_at               timestamptz,
      CHECK (status IN ('pending_approval', 'attending', 'on_break', 'completed', 'rejected'))
    );
    CREATE INDEX IF NOT EXISTS admissions_status_idx
      ON admissions (status) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS admissions_admission_date_idx
      ON admissions (admission_date DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS admissions_lead_id_idx
      ON admissions (lead_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS admissions_program_id_idx
      ON admissions (program_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_admissions_updated_at
      BEFORE UPDATE ON admissions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- 3. EDUCATION (1..N per admission) ----------------------------------
    CREATE TABLE IF NOT EXISTS admission_education (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admission_id    uuid NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
      examination     text NOT NULL,    -- B.E. / M.E. / MSc / ...
      stream          text,             -- IT / Computer / E&TC / ...
      college_name    text,
      board_university text,
      year_of_passing smallint,
      percentage      numeric(5, 2),
      sort_order      smallint NOT NULL DEFAULT 0,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS admission_education_admission_idx
      ON admission_education (admission_id);
    CREATE TRIGGER trg_admission_education_updated_at
      BEFORE UPDATE ON admission_education
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- 4. FEE SCHEDULE (installment plan) ----------------------------------
    CREATE TABLE IF NOT EXISTS admission_fee_schedule (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admission_id    uuid NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
      installment_no  smallint NOT NULL,
      due_date        date NOT NULL,
      amount          numeric(12, 2) NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (admission_id, installment_no)
    );
    CREATE INDEX IF NOT EXISTS admission_fee_schedule_due_idx
      ON admission_fee_schedule (due_date);
    CREATE TRIGGER trg_admission_fee_schedule_updated_at
      BEFORE UPDATE ON admission_fee_schedule
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- 5. RECEIPTS (money collected) --------------------------------------
    CREATE TABLE IF NOT EXISTS admission_receipts (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admission_id        uuid NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
      receipt_no          text NOT NULL,
      receipt_date        date NOT NULL,
      amount              numeric(12, 2) NOT NULL,
      mode_of_payment     text NOT NULL,        -- cash / online / cheque / upi / card
      transaction_details text,
      -- "Old" = pre-system collection (manual entry); "New" = collected in-app.
      -- Drives the Old vs New split on the Pay Schedule and Collection reports.
      is_old_collection   boolean NOT NULL DEFAULT false,
      created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      deleted_at          timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS admission_receipts_no_uq
      ON admission_receipts (receipt_no) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS admission_receipts_admission_idx
      ON admission_receipts (admission_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS admission_receipts_date_idx
      ON admission_receipts (receipt_date DESC) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_admission_receipts_updated_at
      BEFORE UPDATE ON admission_receipts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS admission_receipts;
    DROP TABLE IF EXISTS admission_fee_schedule;
    DROP TABLE IF EXISTS admission_education;
    DROP TABLE IF EXISTS admissions;
    DROP TABLE IF EXISTS admission_centers;
  `);
};
