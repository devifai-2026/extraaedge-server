/* eslint-disable camelcase */
// Generalise trainer_leave into staff_leave: leave for EVERY role, with types,
// quotas, a ledger and a configurable approval chain.
//
// The rename is safe to do in place and without a compatibility view because
// trainer_leave is EMPTY in every active tenant (verified before writing this)
// and has exactly five code references, all in modules/courses/repo.js, which
// are repointed in the same change. trainer_id already referenced users(id), so
// the table was generic in everything but its name.
//
// Approval model:
//   leave_approval_policies  one row per role scope -> approval_mode
//   leave_approvals          one row per REQUIRED step of a request
// A request is 'approved' only when every step is. Modelling the steps as rows
// rather than a single approver column is what makes a two-level chain
// auditable and a partial approval representable.

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ---- rename + generalise ------------------------------------------------
  pgm.sql(`
    DO $$
    BEGIN
      IF to_regclass('trainer_leave') IS NOT NULL AND to_regclass('staff_leave') IS NULL THEN
        ALTER TABLE trainer_leave RENAME TO staff_leave;
        ALTER TABLE staff_leave RENAME COLUMN trainer_id TO user_id;
      END IF;
    END $$;
  `);

  // ---- leave types --------------------------------------------------------
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS leave_types (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code                   text NOT NULL,
      name                   text NOT NULL,
      is_paid                boolean NOT NULL DEFAULT true,
      annual_quota_days      numeric(5,2) NOT NULL DEFAULT 0,
      accrual                text NOT NULL DEFAULT 'yearly',
      allow_half_day         boolean NOT NULL DEFAULT true,
      carry_forward_max_days numeric(5,2) NOT NULL DEFAULT 0,
      requires_approval      boolean NOT NULL DEFAULT true,
      color                  text,
      order_index            int NOT NULL DEFAULT 0,
      is_active              boolean NOT NULL DEFAULT true,
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),
      deleted_at             timestamptz,
      CONSTRAINT leave_types_accrual_chk CHECK (accrual IN ('none','monthly','yearly'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS leave_types_code_uniq
      ON leave_types (code) WHERE deleted_at IS NULL;
  `);

  // Seeded only when the tenant has none, so a tenant that configured its own
  // set is never clobbered. Quotas are PLACEHOLDERS — confirm with the client
  // before the accrual worker runs.
  pgm.sql(`
    INSERT INTO leave_types (code, name, is_paid, annual_quota_days, accrual, carry_forward_max_days, order_index)
    SELECT * FROM (VALUES
      ('CL',       'Casual Leave',        true,  12.0, 'yearly',  0.0,  1),
      ('SL',       'Sick Leave',          true,  12.0, 'yearly',  0.0,  2),
      ('EL',       'Earned Leave',        true,  15.0, 'monthly', 15.0, 3),
      ('LWP',      'Leave Without Pay',   false,  0.0, 'none',    0.0,  4),
      ('COMP_OFF', 'Compensatory Off',    true,   0.0, 'none',    0.0,  5)
    ) AS v(code, name, is_paid, annual_quota_days, accrual, carry_forward_max_days, order_index)
    WHERE NOT EXISTS (SELECT 1 FROM leave_types);
  `);

  // ---- extend staff_leave -------------------------------------------------
  pgm.sql(`
    ALTER TABLE staff_leave
      ADD COLUMN IF NOT EXISTS leave_type_id    uuid REFERENCES leave_types(id),
      ADD COLUMN IF NOT EXISTS day_count        numeric(5,2),
      ADD COLUMN IF NOT EXISTS half_day         text,
      ADD COLUMN IF NOT EXISTS decision_note    text,
      ADD COLUMN IF NOT EXISTS attachment_r2_key text,
      ADD COLUMN IF NOT EXISTS applied_via      text NOT NULL DEFAULT 'self',
      ADD COLUMN IF NOT EXISTS cancelled_at     timestamptz,
      ADD COLUMN IF NOT EXISTS decided_at       timestamptz;
  `);
  // Every request now starts pending. The old default was 'approved' with no
  // approval endpoint at all — self-service only.
  pgm.sql(`ALTER TABLE staff_leave ALTER COLUMN status SET DEFAULT 'pending';`);
  pgm.sql(`
    DO $$ BEGIN
      ALTER TABLE staff_leave ADD CONSTRAINT staff_leave_status_chk
        CHECK (status IN ('pending','approved','declined','cancelled'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  pgm.sql(`
    UPDATE staff_leave
       SET day_count = COALESCE(day_count, (to_date - from_date) + 1),
           leave_type_id = COALESCE(leave_type_id,
             (SELECT id FROM leave_types WHERE code = 'CL' AND deleted_at IS NULL LIMIT 1))
     WHERE deleted_at IS NULL;
  `);
  // The index attendance joins on when deciding whether a day is on_leave.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS staff_leave_range_idx
      ON staff_leave (user_id, from_date, to_date)
      WHERE deleted_at IS NULL AND status = 'approved';
  `);

  // ---- approval chain -----------------------------------------------------
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS leave_approval_policies (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role_scope    text NOT NULL,
      approval_mode text NOT NULL DEFAULT 'lead_only',
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT leave_policy_mode_chk
        CHECK (approval_mode IN ('two_level','hr_only','lead_only','none'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS leave_approval_policies_scope_uniq
      ON leave_approval_policies (role_scope);
  `);
  // Default every existing role to lead_only: the person's own manager decides,
  // HR still sees it on the calendar. Least surprising starting point, and an
  // admin can switch any scope to two_level / hr_only / none.
  pgm.sql(`
    INSERT INTO leave_approval_policies (role_scope, approval_mode)
    SELECT DISTINCT scope, 'lead_only' FROM custom_roles
     WHERE deleted_at IS NULL AND scope <> 'student'
    ON CONFLICT (role_scope) DO NOTHING;
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS leave_approvals (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      leave_id      uuid NOT NULL REFERENCES staff_leave(id) ON DELETE CASCADE,
      step_index    int  NOT NULL,
      approver_role text,
      approver_id   uuid REFERENCES users(id) ON DELETE SET NULL,
      status        text NOT NULL DEFAULT 'pending',
      decided_at    timestamptz,
      note          text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT leave_approvals_status_chk CHECK (status IN ('pending','approved','declined')),
      UNIQUE (leave_id, step_index)
    );
    CREATE INDEX IF NOT EXISTS leave_approvals_pending_idx
      ON leave_approvals (approver_id, status) WHERE status = 'pending';
  `);

  // ---- balances + ledger --------------------------------------------------
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS leave_balances (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      leave_type_id        uuid NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
      period_year          int  NOT NULL,
      opening_days         numeric(6,2) NOT NULL DEFAULT 0,
      accrued_days         numeric(6,2) NOT NULL DEFAULT 0,
      used_days            numeric(6,2) NOT NULL DEFAULT 0,
      carried_forward_days numeric(6,2) NOT NULL DEFAULT 0,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, leave_type_id, period_year)
    );
  `);
  // Append-only. Balances are a projection of this, never edited directly, so
  // every adjustment has a reason and an actor.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS leave_ledger (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      balance_id uuid NOT NULL REFERENCES leave_balances(id) ON DELETE CASCADE,
      delta_days numeric(6,2) NOT NULL,
      reason     text NOT NULL,
      leave_id   uuid REFERENCES staff_leave(id) ON DELETE SET NULL,
      actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
      note       text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS leave_ledger_balance_idx ON leave_ledger (balance_id, created_at DESC);
  `);

  // ---- holidays -----------------------------------------------------------
  // A `holidays` table ALREADY EXISTS (migration 1700000004000) and is served by
  // modules/calendar — date, name, is_full_day. We EXTEND it rather than create
  // a rival: two holiday tables would silently disagree, and the attendance
  // engine must have exactly one answer to "is this date a holiday?".
  //
  // branch_id makes a holiday org-wide (NULL) or branch-specific — regional
  // festivals differ by location. is_optional is the restricted-holiday case:
  // not auto-applied, the employee claims it against a quota.
  //
  // Multi-day spans (Ganesh Puja = 3 days) are stored as ONE ROW PER DATE. The
  // UI takes a range and expands it, so the engine can ask with a plain
  // equality instead of a range overlap on every lookup.
  pgm.sql(`
    ALTER TABLE holidays
      ADD COLUMN IF NOT EXISTS branch_id   uuid REFERENCES branches(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS is_optional boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS updated_at  timestamptz NOT NULL DEFAULT now();
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS holidays_date_idx ON holidays (date) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS holidays_org_wide_uniq
      ON holidays (date) WHERE branch_id IS NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS holidays_branch_uniq
      ON holidays (date, branch_id) WHERE branch_id IS NOT NULL AND deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS leave_ledger, leave_balances, leave_approvals, leave_approval_policies;`);
  // holidays predates this migration — only the columns we added come off.
  pgm.sql(`
    DROP INDEX IF EXISTS holidays_org_wide_uniq;
    DROP INDEX IF EXISTS holidays_branch_uniq;
    ALTER TABLE holidays
      DROP COLUMN IF EXISTS branch_id,
      DROP COLUMN IF EXISTS is_optional,
      DROP COLUMN IF EXISTS created_by;
  `);
  pgm.sql(`DROP TABLE IF EXISTS leave_types CASCADE;`);
  pgm.sql(`
    DO $$ BEGIN
      ALTER TABLE staff_leave DROP CONSTRAINT IF EXISTS staff_leave_status_chk;
      ALTER TABLE staff_leave ALTER COLUMN status SET DEFAULT 'approved';
      ALTER TABLE staff_leave
        DROP COLUMN IF EXISTS leave_type_id, DROP COLUMN IF EXISTS day_count,
        DROP COLUMN IF EXISTS half_day, DROP COLUMN IF EXISTS decision_note,
        DROP COLUMN IF EXISTS attachment_r2_key, DROP COLUMN IF EXISTS applied_via,
        DROP COLUMN IF EXISTS cancelled_at, DROP COLUMN IF EXISTS decided_at;
      IF to_regclass('staff_leave') IS NOT NULL AND to_regclass('trainer_leave') IS NULL THEN
        ALTER TABLE staff_leave RENAME COLUMN user_id TO trainer_id;
        ALTER TABLE staff_leave RENAME TO trainer_leave;
      END IF;
    END $$;
  `);
};
