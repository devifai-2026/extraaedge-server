/* eslint-disable camelcase */
// The self-service "My HR" tabs — granted to EVERY role.
//
// Leave, attendance and payslips are personal records: a telecaller needs to
// apply for leave exactly as much as a branch manager does. The backing routes
// (/staff-leave/mine*, apply, cancel) carry NO requireRole and resolve
// req.user.id, so they can only ever return the caller's own rows — the tab is
// navigation, not authority.
//
// Without this, the whole staff-leave API was unreachable from the product:
// the endpoints existed and nothing in the sidebar pointed at them.
//
// hr.leave_calendar is the shared org view. It is granted broadly on purpose —
// knowing who is away is ordinary team information, and the endpoint returns
// only name/date/status, never the reason or any document.
exports.shorthands = undefined;

const SELF_TABS = ['hr.my_leave', 'hr.my_attendance', 'hr.leave_calendar'];

exports.up = (pgm) => {
  // 'student' is excluded: students are not employees and have no leave quota,
  // attendance register or payslip. Their attendance is a COURSE record, served
  // by the student portal, not by staff HR.
  for (const tab of SELF_TABS) {
    pgm.sql(`
      UPDATE custom_roles
         SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                               || jsonb_build_object('${tab}', 'full'),
             updated_at = now()
       WHERE deleted_at IS NULL
         AND scope <> 'student'
         AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? '${tab}');
    `);
  }

  // Undo the grant if an earlier run of this migration gave it to students.
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions ${SELF_TABS.map((t) => `- '${t}'`).join(' ')},
           updated_at = now()
     WHERE deleted_at IS NULL AND scope = 'student';
  `);

  // Approver queue: only roles that can actually decide. Kept separate from the
  // self-service grant so a counsellor never sees an approvals inbox.
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('hr.leave_approvals', 'full'),
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin','branch_manager','hr','hr_team_lead',
                     'sales_manager','telecaller_lead','head_trainer')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'hr.leave_approvals');
  `);

  // Quota / holiday / policy administration. Must match the server's LEAVE_ADMIN
  // set exactly (ADMIN_TIER_ROLES + hr_team_lead) — granting the tab to the flat
  // `hr` role too would put a Leave Settings link in the nav that 403s on open.
  // Setting org-wide policy is the HR lead's job, not every HR user's.
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('hr.leave_admin', 'full'),
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin','branch_manager','hr_team_lead')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'hr.leave_admin');
  `);
  pgm.sql(`
    UPDATE custom_roles SET tab_permissions = tab_permissions - 'hr.leave_admin', updated_at = now()
     WHERE deleted_at IS NULL AND scope = 'hr';
  `);
};

exports.down = (pgm) => {
  const all = [...SELF_TABS, 'hr.leave_approvals', 'hr.leave_admin'];
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions ${all.map((t) => `- '${t}'`).join(' ')},
           updated_at = now()
     WHERE deleted_at IS NULL;
  `);
};
