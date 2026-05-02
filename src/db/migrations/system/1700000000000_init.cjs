/* eslint-disable camelcase */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });
  pgm.createExtension('citext', { ifNotExists: true });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP FUNCTION IF EXISTS set_updated_at() CASCADE;');
  pgm.dropExtension('citext', { ifExists: true });
  pgm.dropExtension('pgcrypto', { ifExists: true });
};
