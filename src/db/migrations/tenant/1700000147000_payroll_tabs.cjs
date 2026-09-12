/* eslint-disable camelcase */
// Payroll navigation.
//
// payroll.my_payslips goes to EVERY staff role: your own payslip is yours, and
// the route behind it resolves req.user.id with no role gate.
//
// payroll.runs / payroll.structures go only to the roles the server's
// PAYROLL_ADMIN_ROLES actually admits (ADMIN_TIER_ROLES + hr_team_lead). The
// tab is navigation only — the real gate is service.assertMaySeeSalary, which
// is a per-row rule precisely because branch_manager holds the '*' tab wildcard
// and a tab-only check would hand over every salary in the org.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('payroll.my_payslips', 'full'),
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope <> 'student'
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'payroll.my_payslips');
  `);

  for (const tab of ['payroll.runs', 'payroll.structures']) {
    pgm.sql(`
      UPDATE custom_roles
         SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                               || jsonb_build_object('${tab}', 'full'),
             updated_at = now()
       WHERE deleted_at IS NULL
         AND scope IN ('super_admin','branch_manager','hr_team_lead')
         AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? '${tab}');
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions - 'payroll.my_payslips'
                             - 'payroll.runs' - 'payroll.structures',
           updated_at = now()
     WHERE deleted_at IS NULL;
  `);
};
