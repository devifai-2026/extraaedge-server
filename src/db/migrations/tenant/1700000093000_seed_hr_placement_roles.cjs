/* eslint-disable camelcase */
// Add two operational departments to existing tenants: HR and Placement.
// (a) insert their custom_roles bundles (guarded on scope), (b) grant the
// student.jobs tab to student + super_admin, and the hr.*/placement.* tabs to
// super_admin so the owner can see those sidebar sections. New tenants get all
// of this from constants.js + tenant-provisioning.js. Idempotent — the runner
// fans out across every tenant DB.
//
// NOTE: tab lists are intentionally hard-coded here (frozen at authoring time),
// mirroring 1700000078000/1700000089000 — keep in sync with constants.js.

exports.shorthands = undefined;

const bundle = (tabs) => JSON.stringify(Object.fromEntries(tabs.map((t) => [t, 'full'])));
const HR_TABS = ['hr.dashboard', 'hr.interviews', 'hr.certificates'];
const PLACEMENT_TABS = ['placement.dashboard', 'placement.companies', 'placement.openings', 'placement.applications'];

exports.up = async (pgm) => {
  const roles = [
    { name: 'hr', description: 'HR — interview evaluation + certificates', scope: 'hr', tabs: HR_TABS },
    { name: 'placement', description: 'Placement — companies, openings, applications', scope: 'placement', tabs: PLACEMENT_TABS },
  ];
  for (const r of roles) {
    // eslint-disable-next-line no-await-in-loop
    await pgm.db.query(
      `INSERT INTO custom_roles (name, description, scope, is_system, tab_permissions)
       SELECT $1, $2, $3, true, $4::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM custom_roles WHERE scope = $3)`,
      [r.name, r.description, r.scope, bundle(r.tabs)],
    );
  }

  // Grant hr.* / placement.* to super_admin so the owner sees those sections.
  const allNew = [...HR_TABS, ...PLACEMENT_TABS];
  for (const key of allNew) {
    // eslint-disable-next-line no-await-in-loop
    await pgm.db.query(
      `UPDATE custom_roles SET tab_permissions = tab_permissions || $1::jsonb, updated_at = now()
        WHERE scope = 'super_admin' AND NOT (tab_permissions ? $2)`,
      [JSON.stringify({ [key]: 'full' }), key],
    );
  }

  // Grant student.jobs to student + super_admin.
  for (const scope of ['student', 'super_admin']) {
    // eslint-disable-next-line no-await-in-loop
    await pgm.db.query(
      `UPDATE custom_roles SET tab_permissions = tab_permissions || '{"student.jobs": "full"}'::jsonb, updated_at = now()
        WHERE scope = $1 AND NOT (tab_permissions ? 'student.jobs')`,
      [scope],
    );
  }
};

exports.down = async (pgm) => {
  const allNew = ['hr.dashboard', 'hr.interviews', 'hr.certificates', 'placement.dashboard', 'placement.companies', 'placement.openings', 'placement.applications', 'student.jobs'];
  for (const key of allNew) {
    // eslint-disable-next-line no-await-in-loop
    await pgm.db.query(`UPDATE custom_roles SET tab_permissions = tab_permissions - $1, updated_at = now()`, [key]);
  }
  await pgm.db.query(
    `DELETE FROM custom_roles c WHERE c.scope IN ('hr', 'placement')
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = c.id)`,
  );
};
