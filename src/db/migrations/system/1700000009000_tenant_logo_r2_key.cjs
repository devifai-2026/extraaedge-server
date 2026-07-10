// Tenant logo is stored as a PRIVATE GCS object and streamed through the app's
// public branding proxy (GET /public/branding/:slug/logo). We keep the opaque
// GCS object key here so the proxy can resolve slug -> key -> stream. The
// human-facing tenants.logo_url now holds that stable proxy URL, not a raw
// (private, 403-ing) storage URL.
exports.up = (pgm) => {
  pgm.addColumn('tenants', {
    logo_r2_key: { type: 'text', notNull: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('tenants', 'logo_r2_key');
};
