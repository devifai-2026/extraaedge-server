/* eslint-disable camelcase */
// Phase F5 — HR & Placement completeness.
//  - interview_slot_scores.comment: HR/trainer leave a qualitative note per
//    rubric category (not just a number).
//  - job_applications.offer_ctc: the CTC offered when an application reaches the
//    new 'offer' stage (status stays free text; no enum migration needed).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE interview_slot_scores ADD COLUMN IF NOT EXISTS comment text;
    ALTER TABLE job_applications       ADD COLUMN IF NOT EXISTS offer_ctc text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE interview_slot_scores DROP COLUMN IF EXISTS comment;
    ALTER TABLE job_applications       DROP COLUMN IF EXISTS offer_ctc;
  `);
};
