/* eslint-disable camelcase */

// Speedup Hiring — internal staff recruitment.
//
// Deliberately its own tables rather than reusing placement or the mock-
// interview module. Both of those are bound to STUDENTS by NOT NULL FKs
// (job_applications.student_id, interview_slots.student_id) and to COURSES
// (mock_interviews.program_id). A job candidate is neither: forcing them in
// would pollute student counts, LMS rosters and placement reports.
//
// Columns come from the two spreadsheets HR keeps today, so an import is a
// straight mapping rather than a reinterpretation. See docs/speedup-hiring-spec.md.

exports.up = (pgm) => {
  pgm.sql(`
    -- Vacancies being recruited for. "Telecaller", "Placement Coordinator".
    CREATE TABLE IF NOT EXISTS hiring_positions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      department text,
      branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
      openings_count int NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'open',
      opened_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT hiring_positions_status_chk CHECK (status IN ('open','on_hold','closed'))
    );
    CREATE INDEX IF NOT EXISTS hiring_positions_status_idx ON hiring_positions (status) WHERE deleted_at IS NULL;

    -- Tenant-defined outcomes. 'kind' classifies them so funnel reports never
    -- string-match a name: the sample data alone has "Rejected", "Offer
    -- Accepted", "Location issue", "Not looking for job", "Not relevant".
    -- applies_to lets one status serve a candidate, an interview, or both.
    CREATE TABLE IF NOT EXISTS hiring_statuses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      kind text NOT NULL DEFAULT 'open',
      applies_to text NOT NULL DEFAULT 'both',
      order_index int NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT hiring_statuses_kind_chk CHECK (kind IN ('open','hired','rejected')),
      CONSTRAINT hiring_statuses_applies_chk CHECK (applies_to IN ('candidate','interview','both'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS hiring_statuses_name_uq ON hiring_statuses (lower(name));

    -- Where a vacancy was advertised. Manual/tracked rather than API-posted:
    -- LinkedIn job posting needs a Talent Solutions partnership, Meta dropped
    -- Facebook Jobs and Instagram has no jobs surface. Recording the channel
    -- + URL still answers "which channel produced this candidate", which is
    -- the reporting value; real API posting can hang off these rows later.
    CREATE TABLE IF NOT EXISTS hiring_postings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      position_id uuid NOT NULL REFERENCES hiring_positions(id) ON DELETE CASCADE,
      channel text NOT NULL,
      external_url text,
      notes text,
      posted_at timestamptz NOT NULL DEFAULT now(),
      posted_by uuid REFERENCES users(id) ON DELETE SET NULL,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS hiring_postings_position_idx ON hiring_postings (position_id) WHERE deleted_at IS NULL;

    -- One row per candidate per position. The same person applying for a
    -- second vacancy is a second row, grouped by person_key (normalised
    -- phone) so their history stays joinable.
    CREATE TABLE IF NOT EXISTS hiring_candidates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      position_id uuid REFERENCES hiring_positions(id) ON DELETE SET NULL,
      contacted_on date,
      name text NOT NULL,
      phone text,
      -- Digits-only, last 10. The dedup key and the join between the two
      -- spreadsheets, because email is blank on most sample rows.
      person_key text,
      email text,
      location text,
      highest_qualification text,
      stream text,
      experience_level text,
      current_area text,
      current_salary numeric(12,2),
      expected_salary numeric(12,2),
      notice_period text,
      status_id uuid REFERENCES hiring_statuses(id) ON DELETE SET NULL,
      remark text,
      remark_2 text,
      posting_id uuid REFERENCES hiring_postings(id) ON DELETE SET NULL,
      owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
      hired_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT hiring_candidates_exp_chk
        CHECK (experience_level IS NULL OR experience_level IN ('fresher','experienced'))
    );
    CREATE INDEX IF NOT EXISTS hiring_candidates_person_idx ON hiring_candidates (person_key) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS hiring_candidates_position_idx ON hiring_candidates (position_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS hiring_candidates_status_idx ON hiring_candidates (status_id) WHERE deleted_at IS NULL;
    -- One live application per person per position. Re-importing the same
    -- sheet updates rather than duplicating.
    CREATE UNIQUE INDEX IF NOT EXISTS hiring_candidates_person_position_uq
      ON hiring_candidates (person_key, position_id)
      WHERE deleted_at IS NULL AND person_key IS NOT NULL AND position_id IS NOT NULL;

    -- A candidate can be interviewed more than once, so this is a child table
    -- rather than columns on the candidate.
    CREATE TABLE IF NOT EXISTS hiring_interviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      candidate_id uuid NOT NULL REFERENCES hiring_candidates(id) ON DELETE CASCADE,
      scheduled_at timestamptz,
      mode text,
      status_id uuid REFERENCES hiring_statuses(id) ON DELETE SET NULL,
      interviewer_id uuid REFERENCES users(id) ON DELETE SET NULL,
      remark_1 text,
      remark_2 text,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT hiring_interviews_mode_chk CHECK (mode IS NULL OR mode IN ('online','in_person','telephonic'))
    );
    CREATE INDEX IF NOT EXISTS hiring_interviews_candidate_idx ON hiring_interviews (candidate_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS hiring_interviews_sched_idx ON hiring_interviews (scheduled_at) WHERE deleted_at IS NULL;

    -- Audit of status moves, so "why was this rejected" survives a later edit.
    CREATE TABLE IF NOT EXISTS hiring_status_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      candidate_id uuid NOT NULL REFERENCES hiring_candidates(id) ON DELETE CASCADE,
      from_status_id uuid REFERENCES hiring_statuses(id) ON DELETE SET NULL,
      to_status_id uuid REFERENCES hiring_statuses(id) ON DELETE SET NULL,
      note text,
      changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS hiring_status_history_candidate_idx ON hiring_status_history (candidate_id);
  `);

  // updated_at triggers, matching the convention used elsewhere in the schema.
  for (const t of ['hiring_positions', 'hiring_statuses', 'hiring_candidates', 'hiring_interviews']) {
    pgm.sql(`
      DROP TRIGGER IF EXISTS trg_${t}_updated_at ON ${t};
      CREATE TRIGGER trg_${t}_updated_at BEFORE UPDATE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);
  }

  // Seed the statuses actually present in the supplied sheets, so the feature
  // is usable before anyone opens Configuration. All are terminal outcomes
  // except Scheduled/Shortlisted, which is why 'kind' exists.
  pgm.sql(`
    INSERT INTO hiring_statuses (name, kind, applies_to, order_index) VALUES
      ('Shortlisted',              'open',     'candidate', 10),
      ('Interview Scheduled',      'open',     'both',      20),
      ('Interview Done',           'open',     'interview', 30),
      ('Offer Accepted',           'hired',    'candidate', 40),
      ('Rejected',                 'rejected', 'both',      50),
      ('Did not attend interview', 'rejected', 'both',      60),
      ('Location issue',           'rejected', 'candidate', 70),
      ('Not looking for a job',    'rejected', 'candidate', 80),
      ('Not relevant',             'rejected', 'candidate', 90)
    ON CONFLICT DO NOTHING;
  `);

  // Tabs for the new module. hr_recruiter and hr_team_lead only — candidate
  // records carry salary expectations and personal contact details for people
  // who do not work here, so this is not general staff information.
  const TABS = ['hiring.dashboard', 'hiring.positions', 'hiring.candidates', 'hiring.interviews', 'hiring.statuses'];
  for (const tab of TABS) {
    pgm.sql(`
      UPDATE custom_roles
         SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb) || '{"${tab}":"full"}'::jsonb
       WHERE name IN ('hr_recruiter','hr_team_lead')
         AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? '${tab}');
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS hiring_status_history;
    DROP TABLE IF EXISTS hiring_interviews;
    DROP TABLE IF EXISTS hiring_candidates;
    DROP TABLE IF EXISTS hiring_postings;
    DROP TABLE IF EXISTS hiring_statuses;
    DROP TABLE IF EXISTS hiring_positions;
  `);
  const TABS = ['hiring.dashboard', 'hiring.positions', 'hiring.candidates', 'hiring.interviews', 'hiring.statuses'];
  for (const tab of TABS) {
    pgm.sql(`
      UPDATE custom_roles SET tab_permissions = tab_permissions - '${tab}'
       WHERE tab_permissions -> '${tab}' = '"full"';
    `);
  }
};
