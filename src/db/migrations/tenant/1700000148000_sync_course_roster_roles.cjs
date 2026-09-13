/* eslint-disable camelcase */
// Repair course rosters that drifted from users.role.
//
// Authority over a course is read from course_trainers.role = 'head', never
// from users.role (see courses/service.js assertCanManage). Switch Role changed
// the user record but left the roster alone, so when two trainers swapped
// roles the newly promoted head trainer could not manage their own courses
// while the demoted one kept the power. Live example: Shreeraj Mane was made
// head_trainer but stayed 'trainer' on 3 rosters, and Aswin Chaudhari stayed
// 'head' on 4 after being demoted to trainer.
//
// The code gap is fixed in users/service.js (syncCourseRosterRole, called from
// both switchRole and updateUser). This migration repairs the rows already
// written.
//
// Scope is deliberately narrow: only users whose role is trainer/head_trainer,
// and only rosters they are ALREADY on. Nobody is added to a course here.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE course_trainers ct
       SET role = CASE WHEN us.role = 'head_trainer' THEN 'head' ELSE 'trainer' END,
           updated_at = now()
      FROM users us
     WHERE us.id = ct.user_id
       AND ct.deleted_at IS NULL
       AND us.deleted_at IS NULL
       AND us.role IN ('trainer', 'head_trainer')
       AND ct.role <> (CASE WHEN us.role = 'head_trainer' THEN 'head' ELSE 'trainer' END);
  `);
};

// Not reversible: the previous roster roles were the drifted state, and
// restoring them would re-break course management. Down is a no-op on purpose.
exports.down = () => {};
