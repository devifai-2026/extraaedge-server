/* eslint-disable camelcase */
// Per-tenant monotonic receipt-number counter.
//
// The legacy receipt_no scheme (RC-YYYYMMDD-<COUNT(*)+1>) is racy — two
// concurrent inserts on the same day can COUNT the same value and collide.
// When a tenant opts into the configurable `<prefix>-<counter>` format, the
// counter comes from THIS single-row table, advanced with a single atomic
// `UPDATE ... RETURNING` inside the receipt insert, which serialises
// concurrent callers on the row lock.
//
// One logical counter per tenant DB → a single row (id = 1). next_seq holds
// the NEXT number to hand out; it is seeded lazily from the tenant's
// admin-configured receipt_no_start the first time a numbered receipt is
// minted (see admissions/repo.insertReceipt), so this migration just creates
// the empty table.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS receipt_counters (
      id       integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      next_seq bigint  NOT NULL DEFAULT 1
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS receipt_counters;`);
};
