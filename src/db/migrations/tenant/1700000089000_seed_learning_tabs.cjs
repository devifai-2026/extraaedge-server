/* eslint-disable camelcase */
// Grant the new learning tab keys to existing tenants' role bundles:
//  - trainer.materials  → super_admin, branch_manager, head_trainer, trainer
//  - student.materials + student.certificate → student
// Guarded so re-running is a no-op. New tenants get these via constants.js +
// tenant-provisioning.js.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions || '{"trainer.materials": "full"}'::jsonb, updated_at = now()
      WHERE scope IN ('super_admin','branch_manager','head_trainer','trainer')
        AND NOT (tab_permissions ? 'trainer.materials')`,
  );
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions
              || '{"student.materials": "full"}'::jsonb
              || '{"student.certificate": "full"}'::jsonb,
            updated_at = now()
      WHERE scope = 'student'
        AND NOT (tab_permissions ? 'student.materials' AND tab_permissions ? 'student.certificate')`,
  );
};

exports.down = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions - 'trainer.materials', updated_at = now()
      WHERE scope IN ('super_admin','branch_manager','head_trainer','trainer')`,
  );
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = (tab_permissions - 'student.materials') - 'student.certificate', updated_at = now()
      WHERE scope = 'student'`,
  );
};
