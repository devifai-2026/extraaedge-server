/* eslint-disable camelcase */
// Backfill LMS roles + tabs onto EXISTING tenants (new tenants get these from
// the provisioning seed). Idempotent:
//   1. Grant 'lms.analytics' to super_admin + branch_manager (they see the LMS
//      dashboards) if missing.
//   2. Create the head_trainer / trainer / student custom_roles bundles if a
//      tenant doesn't already have them.
// Tab key lists are kept in sync with src/config/constants.js.

exports.shorthands = undefined;

const HEAD_TRAINER_TABS = [
  'courses.manage',
  'trainer.classes', 'trainer.attendance', 'trainer.recordings',
  'trainer.announcements', 'trainer.forum', 'trainer.tests',
  'trainer.projects', 'trainer.interviews', 'trainer.leaderboard',
];
const TRAINER_TABS = HEAD_TRAINER_TABS.filter((t) => t !== 'courses.manage');
const STUDENT_TABS = [
  'student.home', 'student.classes', 'student.forum', 'student.tests',
  'student.projects', 'student.leaderboard', 'student.catalog',
];

const bundle = (tabs) => JSON.stringify(Object.fromEntries(tabs.map((t) => [t, 'full'])));

exports.up = async (pgm) => {
  // 1. Admins + branch managers get the analytics tab.
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions || '{"lms.analytics": "full"}'::jsonb,
            updated_at = now()
      WHERE scope IN ('super_admin', 'branch_manager')
        AND NOT (tab_permissions ? 'lms.analytics')`,
  );

  // 2. Create the LMS role bundles per tenant if absent (scope is the anchor).
  const roles = [
    { name: 'head_trainer', description: 'Owns a course — modules, trainers, batches + teaches', scope: 'head_trainer', tabs: HEAD_TRAINER_TABS },
    { name: 'trainer', description: 'Teaches assigned modules of a course', scope: 'trainer', tabs: TRAINER_TABS },
    { name: 'student', description: 'Enrolled learner — student panel access', scope: 'student', tabs: STUDENT_TABS },
  ];
  for (const r of roles) {
    await pgm.db.query(
      `INSERT INTO custom_roles (name, description, scope, is_system, tab_permissions)
       SELECT $1, $2, $3, true, $4::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM custom_roles WHERE scope = $3)`,
      [r.name, r.description, r.scope, bundle(r.tabs)],
    );
  }
};

exports.down = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions - 'lms.analytics', updated_at = now()
      WHERE scope IN ('super_admin', 'branch_manager')`,
  );
  // Only drop the seeded LMS role bundles if no user is assigned to them.
  await pgm.db.query(
    `DELETE FROM custom_roles c
      WHERE c.scope IN ('head_trainer', 'trainer', 'student')
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = c.id)`,
  );
};
