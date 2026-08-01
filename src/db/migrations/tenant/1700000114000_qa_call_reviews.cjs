/* eslint-disable camelcase */
// QA call-quality reviews.
//
// A QA reviewer listens to matched call recordings (the ones already bound to
// a lead, and through uploaded_by to the counsellor who made the call) and
// scores them against a per-tenant rubric — Communication, Fluency, etc. —
// plus a free-text feedback comment. Admins / branch managers / sales
// managers read those reviews back, branch-wise.
//
// Shape mirrors the interview rubric (1700000094000): a parameters table the
// tenant can tune, a review header, and one score row per parameter. Scores
// live in their own table rather than as columns so adding a parameter is a
// data change, not a migration.
//
// device_recordings gets a branch_id snapshot (taken from the uploading
// counsellor at confirm time) so the QA queue and the manager reports can
// filter branch-wise on an indexed column instead of joining through users —
// and so a later staff transfer doesn't silently re-file historical calls.

exports.shorthands = undefined;

const PARAMETERS = [
  { code: 'communication', name: 'Communication', order: 1 },
  { code: 'fluency', name: 'Fluency', order: 2 },
  { code: 'product_knowledge', name: 'Product Knowledge', order: 3 },
  { code: 'objection_handling', name: 'Objection Handling', order: 4 },
  { code: 'call_etiquette', name: 'Call Etiquette', order: 5 },
];

const QA_TABS = ['qa.reviews', 'qa.feedback'];

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE device_recordings
      ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS device_recordings_branch_idx
      ON device_recordings (branch_id) WHERE deleted_at IS NULL;
  `);

  // Backfill the branch from whoever uploaded each existing recording.
  await pgm.db.query(`
    UPDATE device_recordings dr
       SET branch_id = u.branch_id
      FROM users u
     WHERE u.id = dr.uploaded_by
       AND dr.branch_id IS NULL
       AND u.branch_id IS NOT NULL
  `);

  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS qa_review_parameters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL,
      name text NOT NULL,
      -- Each parameter is scored 0..max_score; the review's overall figure is
      -- the percentage of the total achievable across active parameters, so
      -- retuning a max doesn't silently rescale historical reviews (each
      -- review stores its own max_total).
      max_score numeric(5,2) NOT NULL DEFAULT 5,
      order_index integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS qa_review_parameters_code_uq ON qa_review_parameters (code);
    DROP TRIGGER IF EXISTS trg_qa_review_parameters_updated_at ON qa_review_parameters;
    CREATE TRIGGER trg_qa_review_parameters_updated_at BEFORE UPDATE ON qa_review_parameters
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS qa_reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      recording_id uuid NOT NULL REFERENCES device_recordings(id) ON DELETE CASCADE,
      -- Snapshots taken at review time: the lead the call was attached to, the
      -- counsellor being rated, and their branch. Kept on the row so a later
      -- lead merge / staff move doesn't rewrite past scorecards.
      lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
      counsellor_id uuid REFERENCES users(id) ON DELETE SET NULL,
      branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
      -- Roll-up of qa_review_scores: points scored, points available, and the
      -- percentage. Denormalised so list/report queries don't aggregate the
      -- child table on every read.
      total_score numeric(6,2),
      max_total numeric(6,2),
      overall_percent numeric(5,2),
      comment text,
      reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    -- One live review per recording; re-submitting updates it in place.
    CREATE UNIQUE INDEX IF NOT EXISTS qa_reviews_recording_uq
      ON qa_reviews (recording_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS qa_reviews_counsellor_idx ON qa_reviews (counsellor_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS qa_reviews_branch_idx ON qa_reviews (branch_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS qa_reviews_reviewed_at_idx ON qa_reviews (reviewed_at DESC);
    DROP TRIGGER IF EXISTS trg_qa_reviews_updated_at ON qa_reviews;
    CREATE TRIGGER trg_qa_reviews_updated_at BEFORE UPDATE ON qa_reviews
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS qa_review_scores (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      review_id uuid NOT NULL REFERENCES qa_reviews(id) ON DELETE CASCADE,
      parameter_id uuid NOT NULL REFERENCES qa_review_parameters(id) ON DELETE RESTRICT,
      score numeric(5,2) NOT NULL,
      -- The parameter's max at scoring time, so a later rubric change doesn't
      -- make an old score look out of range.
      max_score numeric(5,2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS qa_review_scores_uq ON qa_review_scores (review_id, parameter_id);
  `);

  for (const p of PARAMETERS) {
    // eslint-disable-next-line no-await-in-loop
    await pgm.db.query(
      `INSERT INTO qa_review_parameters (code, name, max_score, order_index)
       VALUES ($1, $2, 5, $3) ON CONFLICT (code) DO NOTHING`,
      [p.code, p.name, p.order],
    );
  }

  // The QA role itself. Guarded on scope like the HR/placement seed so a
  // re-run (or a tenant provisioned after this ships) doesn't duplicate it.
  await pgm.db.query(
    `INSERT INTO custom_roles (name, description, scope, is_system, tab_permissions)
     SELECT 'qa', 'QA — reviews and rates counsellor call recordings', 'qa', true, $1::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM custom_roles WHERE scope = 'qa')`,
    [JSON.stringify({ 'qa.reviews': 'full' })],
  );

  // Reviewing surface for QA + super_admin; the read-back report for every
  // manager tier.
  const grants = [
    { scopes: ['super_admin'], tabs: QA_TABS },
    { scopes: ['branch_manager', 'sales_manager'], tabs: ['qa.feedback'] },
  ];
  for (const g of grants) {
    for (const scope of g.scopes) {
      for (const key of g.tabs) {
        // eslint-disable-next-line no-await-in-loop
        await pgm.db.query(
          `UPDATE custom_roles SET tab_permissions = tab_permissions || $1::jsonb, updated_at = now()
            WHERE scope = $2 AND NOT (tab_permissions ? $3)`,
          [JSON.stringify({ [key]: 'full' }), scope, key],
        );
      }
    }
  }
};

exports.down = async (pgm) => {
  for (const key of QA_TABS) {
    // eslint-disable-next-line no-await-in-loop
    await pgm.db.query(`UPDATE custom_roles SET tab_permissions = tab_permissions - $1, updated_at = now()`, [key]);
  }
  await pgm.db.query(
    `DELETE FROM custom_roles c WHERE c.scope = 'qa'
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = c.id)`,
  );
  await pgm.db.query(`
    DROP TABLE IF EXISTS qa_review_scores;
    DROP TABLE IF EXISTS qa_reviews;
    DROP TABLE IF EXISTS qa_review_parameters;
    DROP INDEX IF EXISTS device_recordings_branch_idx;
    ALTER TABLE device_recordings DROP COLUMN IF EXISTS branch_id;
  `);
};
