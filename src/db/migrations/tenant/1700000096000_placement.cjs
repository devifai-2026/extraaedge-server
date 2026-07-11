/* eslint-disable camelcase */
// Placement: hiring-partner companies, job openings (open/closed) with an
// eligibility-criteria jsonb + optional poster, and applications (a student is
// "fired" an opening when they match the criteria; they then apply/progress).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE companies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      website text,
      industry text,
      location text,
      about text,
      logo_r2_key text,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON companies (name) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_companies_updated_at BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE job_openings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      title text NOT NULL,
      description text,
      ctc text,
      location text,
      job_type text,                                   -- full_time | internship | ...
      status text NOT NULL DEFAULT 'open',             -- open | closed
      criteria jsonb NOT NULL DEFAULT '{}'::jsonb,     -- eligibility filter
      poster_r2_key text,                              -- marketing poster (student-facing)
      program_id uuid REFERENCES programs(id) ON DELETE SET NULL,  -- optional course scope for criteria
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON job_openings (company_id) WHERE deleted_at IS NULL;
    CREATE INDEX ON job_openings (status) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_job_openings_updated_at BEFORE UPDATE ON job_openings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE job_applications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      opening_id uuid NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'fired',            -- fired | applied | shortlisted | selected | rejected
      note text,
      fired_by uuid REFERENCES users(id) ON DELETE SET NULL,
      applied_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX job_applications_uq ON job_applications (opening_id, student_id);
    CREATE INDEX ON job_applications (student_id);
    CREATE TRIGGER trg_job_applications_updated_at BEFORE UPDATE ON job_applications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS job_applications;
    DROP TABLE IF EXISTS job_openings;
    DROP TABLE IF EXISTS companies;
  `);
};
