/* eslint-disable camelcase */
// Configurable "Thank you for choosing …" line on the fee receipt. Blank/null
// falls back in the template to "Thank you for choosing <brand_name>.".
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE tenants ADD COLUMN receipt_thankyou text;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE tenants DROP COLUMN IF EXISTS receipt_thankyou;`);
};
