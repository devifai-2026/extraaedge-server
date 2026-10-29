/* eslint-disable camelcase */

// Grant the "My Interviews" tab (hiring.my_interviews).
//
// WHY A SEPARATE MIGRATION: the grant belongs with 1700000166000, which adds
// the panel this tab displays — but that migration had already been applied to
// a live tenant by the time the grant was written, and node-pg-migrate will
// never re-run a recorded file. Editing an applied migration would therefore
// be a change that silently does nothing where it matters most (the tenant
// already running it), so the step gets its own file instead.
//
// WHY IT IS NEEDED AT ALL: buildAllowedTabs (modules/auth/service.js) emits
// only the keys PRESENT in a role's stored tab_permissions. Adding a key to
// the tab constants affects freshly-seeded roles only — every existing role
// keeps its stored row, so the tab stays invisible until it is written in.
//
// Granted to every STAFF role rather than the HR ones that own the rest of the
// hiring module. Anyone in the tenant can be invited onto an interview panel —
// a sales manager, a trainer — and the page is scoped server-side to the
// interviews the viewer actually sits on, exposing none of the candidate
// pipeline (salaries, HR remarks) the HR-gated hiring tabs do.
//
// Excluded: 'student' (not staff, never on a hiring panel) and 'super_admin'
// (holds the '*' wildcard, so an explicit row would be redundant).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || '{"hiring.my_interviews":"full"}'::jsonb,
           updated_at = now()
     WHERE name NOT IN ('student', 'super_admin')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'hiring.my_interviews')
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions - 'hiring.my_interviews',
           updated_at = now()
     WHERE tab_permissions ? 'hiring.my_interviews'
  `);
};
