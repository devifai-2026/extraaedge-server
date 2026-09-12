/* eslint-disable camelcase */
// Seed the MoM's HR/placement tiers: hr_team_lead, hr_recruiter,
// placement_officer.
//
//   branch_manager
//     └── hr_team_lead            HR ops + placement oversight + manpower
//           ├── hr_recruiter      hiring, staff interviews, onboarding
//           └── placement_officer companies, student interviews, job posts
//
// "Trainer Team Lead" in the MoM is the EXISTING head_trainer — no new role,
// because a second one would split the course roster in two.
//
// Tab grants are COPIED from this tenant's own hr / placement rows rather than
// hardcoded, so the grant matches whatever that tenant actually has and cannot
// drift when the bundles change between deploys. Same approach as
// 1700000125000_seed_telecaller_roles. Fresh tenants get these from
// tenant-provisioning.js instead.
//
// Inserts roles ONLY — no users are touched. An admin moves people in with
// Switch Role, exactly as the telecaller split did.
//
// Idempotent via UNIQUE(name).

exports.shorthands = undefined;

exports.up = async (pgm) => {
  const roles = [
    {
      name: 'hr_team_lead',
      description: 'HR Team Lead — HR operations, placement oversight, manpower',
      // Widest of the two existing sources; the placement keys are merged below.
      copy_from: 'hr',
    },
    {
      name: 'hr_recruiter',
      description: 'HR Recruiter — hiring, interviews, onboarding',
      copy_from: 'hr',
    },
    {
      name: 'placement_officer',
      description: 'Placement Officer — student placement and employer coordination',
      copy_from: 'placement',
    },
  ];

  for (const r of roles) {
    // eslint-disable-next-line no-await-in-loop
    await pgm.db.query(
      `INSERT INTO custom_roles (name, description, scope, is_system, tab_permissions)
       SELECT $1, $2, $1, true,
              COALESCE(
                (SELECT tab_permissions FROM custom_roles
                  WHERE scope = $3 AND deleted_at IS NULL
                  ORDER BY created_at LIMIT 1),
                '{}'::jsonb
              )
       ON CONFLICT (name) DO NOTHING`,
      [r.name, r.description, r.copy_from],
    );
  }

  // hr_team_lead oversees placement too, so union in the placement grant plus
  // the LMS analytics it needs for the student / drop reports in the MoM.
  await pgm.db.query(`
    UPDATE custom_roles t
       SET tab_permissions = COALESCE(t.tab_permissions, '{}'::jsonb)
                             || COALESCE(
                                  (SELECT p.tab_permissions FROM custom_roles p
                                    WHERE p.scope = 'placement' AND p.deleted_at IS NULL
                                    ORDER BY p.created_at LIMIT 1),
                                  '{}'::jsonb
                                )
                             || jsonb_build_object('lms.analytics', 'full'),
           updated_at = now()
     WHERE t.scope = 'hr_team_lead' AND t.deleted_at IS NULL;
  `);

  // The placement officer assigns mock interviews, which lives on the HR side.
  await pgm.db.query(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('hr.interviews', 'full'),
           updated_at = now()
     WHERE scope = 'placement_officer' AND deleted_at IS NULL
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'hr.interviews');
  `);
};

exports.down = async (pgm) => {
  // Only drop a seeded row when nobody holds it, so a down-migration can never
  // orphan a live account. Mirrors 1700000125000.
  await pgm.db.query(`
    DELETE FROM custom_roles c
     WHERE c.scope IN ('hr_team_lead', 'hr_recruiter', 'placement_officer')
       AND c.is_system = true
       AND NOT EXISTS (
         SELECT 1 FROM users u WHERE u.role_id = c.id AND u.deleted_at IS NULL
       );
  `);
};
