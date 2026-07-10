// Grant the new 'admissions.my_students' tab to every existing counsellor
// role so counsellors get their scoped Admissions tab (their own converted
// students, where they configure the fee offer + send the admission link).
// Idempotent jsonb merge. New tenants get it via the provisioning seed.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions || '{"admissions.my_students": "full"}'::jsonb,
            updated_at = now()
      WHERE scope = 'counsellor'
        AND NOT (tab_permissions ? 'admissions.my_students')`,
  );
};

exports.down = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions - 'admissions.my_students',
            updated_at = now()
      WHERE scope = 'counsellor'`,
  );
};
