/* eslint-disable camelcase */
// Payroll: salary structures with FIXED and VARIABLE components.
//
// The shape the client asked for:
//   fixed      BASIC, HRA, allowances — the same every month
//   per_unit   a rate x a countable thing. A trainer paid 500/extra class who
//              took 3 gets 1500. Demo classes priced separately.
//   incentive  target-linked. A counsellor or telecaller hitting N admissions
//              earns a slab or a per-admission amount.
//   deduction  PF, PT, TDS, LOP
//
// Two design decisions worth stating, because both are easy to get wrong:
//
// 1. A payslip SNAPSHOTS its components as jsonb. It never re-derives from the
//    structure at read time — otherwise a raise in March silently rewrites
//    January's payslip and the arithmetic stops matching what was paid.
//
// 2. Structures are VERSIONED, never edited in place: a change closes the old
//    row's effective_to and inserts a new one. A payslip points at the version
//    that produced it, so history stays explicable.
//
// Rates are numeric, never float — a float rounding drift in payroll is money.

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ---- the chart of pay heads --------------------------------------------
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS salary_components (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code          text NOT NULL,
      name          text NOT NULL,
      kind          text NOT NULL,
      calc_type     text NOT NULL DEFAULT 'fixed',
      unit_label    text,
      default_value numeric(12,2) NOT NULL DEFAULT 0,
      is_taxable    boolean NOT NULL DEFAULT true,
      affects_lop   boolean NOT NULL DEFAULT true,
      applies_to    text[] NOT NULL DEFAULT '{}',
      order_index   int NOT NULL DEFAULT 0,
      is_active     boolean NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      deleted_at    timestamptz,
      CONSTRAINT salary_components_kind_chk
        CHECK (kind IN ('earning','deduction','employer_contribution')),
      CONSTRAINT salary_components_calc_chk
        CHECK (calc_type IN ('fixed','percent_of_basic','percent_of_gross','per_unit','incentive_slab'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS salary_components_code_uniq
      ON salary_components (code) WHERE deleted_at IS NULL;
  `);

  // Seeded only when empty, so a tenant that configured its own chart is never
  // clobbered. applies_to is advisory — it drives which heads the UI OFFERS for
  // a role, not a hard restriction, because real orgs always have exceptions.
  pgm.sql(`
    INSERT INTO salary_components
      (code, name, kind, calc_type, unit_label, default_value, is_taxable, affects_lop, applies_to, order_index)
    SELECT * FROM (VALUES
      ('BASIC',        'Basic Salary',        'earning',   'fixed',            NULL,              0.00, true,  true,  '{}'::text[],                                          1),
      ('HRA',          'House Rent Allowance','earning',   'percent_of_basic', NULL,             40.00, true,  true,  '{}'::text[],                                          2),
      ('CONVEYANCE',   'Conveyance',          'earning',   'fixed',            NULL,              1600.00, false, true,  '{}'::text[],                                       3),
      ('SPECIAL',      'Special Allowance',   'earning',   'fixed',            NULL,              0.00, true,  true,  '{}'::text[],                                          4),
      -- Variable, per-unit. The trainer case from the brief.
      ('EXTRA_CLASS',  'Extra Class',         'earning',   'per_unit',         'class',            500.00, true,  false, '{trainer,head_trainer}'::text[],                    10),
      ('DEMO_CLASS',   'Demo Class',          'earning',   'per_unit',         'demo',             300.00, true,  false, '{trainer,head_trainer,counsellor}'::text[],         11),
      -- Variable, target-linked. The sales case from the brief.
      ('ADM_INCENTIVE','Admission Incentive', 'earning',   'incentive_slab',   'admission',       1000.00, true,  false, '{counsellor,telecaller,telecaller_lead}'::text[],   12),
      ('CALL_INCENTIVE','Call Target Incentive','earning', 'incentive_slab',   'target',          2000.00, true,  false, '{telecaller,telecaller_lead}'::text[],              13),
      -- Deductions.
      ('PF_EMP',       'Provident Fund',      'deduction', 'percent_of_basic', NULL,             12.00, false, true,  '{}'::text[],                                          20),
      ('PT',           'Professional Tax',    'deduction', 'fixed',            NULL,              200.00, false, false, '{}'::text[],                                        21),
      ('TDS',          'TDS',                 'deduction', 'fixed',            NULL,              0.00, false, false, '{}'::text[],                                          22),
      ('LOP',          'Loss of Pay',         'deduction', 'per_unit',         'day',              0.00, false, false, '{}'::text[],                                         23),
      ('PF_ER',        'PF (Employer)',       'employer_contribution','percent_of_basic', NULL,   12.00, false, true,  '{}'::text[],                                         30)
    ) AS v(code, name, kind, calc_type, unit_label, default_value, is_taxable, affects_lop, applies_to, order_index)
    WHERE NOT EXISTS (SELECT 1 FROM salary_components);
  `);

  // ---- per-employee structure, versioned ---------------------------------
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS employee_salary_structures (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      effective_from date NOT NULL,
      effective_to   date,
      annual_ctc     numeric(14,2) NOT NULL DEFAULT 0,
      monthly_gross  numeric(12,2) NOT NULL DEFAULT 0,
      status         text NOT NULL DEFAULT 'active',
      notes          text,
      created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at    timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      deleted_at     timestamptz,
      CONSTRAINT ess_status_chk CHECK (status IN ('draft','active','superseded')),
      UNIQUE (user_id, effective_from)
    );
    CREATE INDEX IF NOT EXISTS ess_current_idx
      ON employee_salary_structures (user_id) WHERE effective_to IS NULL AND deleted_at IS NULL;
  `);

  // amount OR percent OR rate, depending on the component's calc_type.
  // `rate` is the per-unit price — 500 for an extra class — and default_units
  // lets a structure carry an expected monthly count that the run can override
  // with what actually happened.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS employee_salary_components (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      structure_id  uuid NOT NULL REFERENCES employee_salary_structures(id) ON DELETE CASCADE,
      component_id  uuid NOT NULL REFERENCES salary_components(id) ON DELETE CASCADE,
      amount        numeric(12,2),
      percent       numeric(6,2),
      rate          numeric(12,2),
      default_units numeric(8,2) NOT NULL DEFAULT 0,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (structure_id, component_id)
    );
  `);

  // Target slabs for incentive_slab heads: "12+ admissions pays 1500 each".
  // Kept as its own table so a slab can be retuned without versioning the whole
  // structure, and so one employee can carry several targets.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS incentive_slabs (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      component_id   uuid NOT NULL REFERENCES salary_components(id) ON DELETE CASCADE,
      user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
      role_scope     text,
      min_units      numeric(8,2) NOT NULL DEFAULT 0,
      max_units      numeric(8,2),
      amount_per_unit numeric(12,2) NOT NULL DEFAULT 0,
      flat_amount    numeric(12,2) NOT NULL DEFAULT 0,
      is_active      boolean NOT NULL DEFAULT true,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      deleted_at     timestamptz
    );
    CREATE INDEX IF NOT EXISTS incentive_slabs_lookup_idx
      ON incentive_slabs (component_id, user_id, role_scope) WHERE deleted_at IS NULL;
  `);

  // ---- runs + payslips ----------------------------------------------------
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      period_month     int NOT NULL,
      period_year      int NOT NULL,
      branch_id        uuid REFERENCES branches(id) ON DELETE SET NULL,
      status           text NOT NULL DEFAULT 'draft',
      employee_count   int NOT NULL DEFAULT 0,
      total_gross      numeric(14,2) NOT NULL DEFAULT 0,
      total_deductions numeric(14,2) NOT NULL DEFAULT 0,
      total_net        numeric(14,2) NOT NULL DEFAULT 0,
      notes            text,
      created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at      timestamptz,
      locked_at        timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payroll_runs_status_chk
        CHECK (status IN ('draft','processing','review','approved','paid','cancelled')),
      CONSTRAINT payroll_runs_month_chk CHECK (period_month BETWEEN 1 AND 12)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_period_uniq
      ON payroll_runs (period_year, period_month, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
      WHERE status <> 'cancelled';
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS payslips (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id           uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      structure_id     uuid REFERENCES employee_salary_structures(id) ON DELETE SET NULL,
      period_month     int NOT NULL,
      period_year      int NOT NULL,
      working_days     numeric(5,2) NOT NULL DEFAULT 0,
      present_days     numeric(5,2) NOT NULL DEFAULT 0,
      paid_leave_days  numeric(5,2) NOT NULL DEFAULT 0,
      lop_days         numeric(5,2) NOT NULL DEFAULT 0,
      gross_earnings   numeric(12,2) NOT NULL DEFAULT 0,
      total_deductions numeric(12,2) NOT NULL DEFAULT 0,
      net_pay          numeric(12,2) NOT NULL DEFAULT 0,
      components       jsonb NOT NULL DEFAULT '[]'::jsonb,
      units_snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
      status           text NOT NULL DEFAULT 'draft',
      notes            text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payslips_status_chk CHECK (status IN ('draft','finalised','paid','held')),
      UNIQUE (run_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS payslips_user_period_idx ON payslips (user_id, period_year, period_month);
  `);

  // ---- disbursement -------------------------------------------------------
  // manual is the DEFAULT path: mark paid, optional reference, optional proof.
  // Payroll is fully usable with no bank credentials.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS payroll_disbursements (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payslip_id     uuid NOT NULL UNIQUE REFERENCES payslips(id) ON DELETE CASCADE,
      run_id         uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount         numeric(12,2) NOT NULL,
      method         text NOT NULL DEFAULT 'manual',
      status         text NOT NULL DEFAULT 'pending',
      paid_at        timestamptz,
      reference_no   text,
      proof_r2_key   text,
      notes          text,
      marked_by      uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payroll_disb_method_chk CHECK (method IN ('manual','bank_transfer','upi','provider')),
      CONSTRAINT payroll_disb_status_chk CHECK (status IN ('pending','processing','paid','failed','reversed'))
    );
  `);

  // Every read of somebody else's salary is logged. Separate from audit_log
  // because it is high volume and must be readable without handing over the
  // whole tenant audit trail.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS salary_access_log (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
      subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      action          text NOT NULL,
      entity_type     text,
      entity_id       uuid,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS salary_access_subject_idx ON salary_access_log (subject_user_id, created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS salary_access_log, payroll_disbursements, payslips, payroll_runs,
                         incentive_slabs, employee_salary_components,
                         employee_salary_structures, salary_components;
  `);
};
