/* eslint-disable camelcase */
// Switch dropdown tables from soft-delete to hard-delete.
//
// The dropdown repo used `deleted_at = now()` but kept a plain UNIQUE(name)
// on lead_channels / lead_sources_dict / lead_campaigns_dict / lead_mediums
// / lead_primary_sources / genders / specializations / universities. Re-adding
// or renaming to a previously-deleted value collided with the leftover row.
//
// Admin wants hard delete. lead_source_attributions FKs to these dictionaries
// previously had no ON DELETE clause — flip them to SET NULL so deleting a
// dictionary row doesn't fail when attribution rows still reference it. Then
// purge any leftover soft-deleted rows so the UNIQUE constraints stop blocking
// writes.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_source_attributions
      DROP CONSTRAINT IF EXISTS lead_source_attributions_channel_id_fkey,
      DROP CONSTRAINT IF EXISTS lead_source_attributions_source_id_fkey,
      DROP CONSTRAINT IF EXISTS lead_source_attributions_campaign_id_fkey,
      DROP CONSTRAINT IF EXISTS lead_source_attributions_medium_id_fkey;

    ALTER TABLE lead_source_attributions
      ADD CONSTRAINT lead_source_attributions_channel_id_fkey
        FOREIGN KEY (channel_id) REFERENCES lead_channels(id) ON DELETE SET NULL,
      ADD CONSTRAINT lead_source_attributions_source_id_fkey
        FOREIGN KEY (source_id) REFERENCES lead_sources_dict(id) ON DELETE SET NULL,
      ADD CONSTRAINT lead_source_attributions_campaign_id_fkey
        FOREIGN KEY (campaign_id) REFERENCES lead_campaigns_dict(id) ON DELETE SET NULL,
      ADD CONSTRAINT lead_source_attributions_medium_id_fkey
        FOREIGN KEY (medium_id) REFERENCES lead_mediums(id) ON DELETE SET NULL;

    -- Purge leftover soft-deleted rows so their (still-unique) names free up.
    DELETE FROM lead_channels       WHERE deleted_at IS NOT NULL;
    DELETE FROM lead_sources_dict   WHERE deleted_at IS NOT NULL;
    DELETE FROM lead_campaigns_dict WHERE deleted_at IS NOT NULL;
    DELETE FROM lead_mediums        WHERE deleted_at IS NOT NULL;
    DELETE FROM lead_primary_sources WHERE deleted_at IS NOT NULL;
    DELETE FROM genders             WHERE deleted_at IS NOT NULL;
    DELETE FROM degrees             WHERE deleted_at IS NOT NULL;
    DELETE FROM specializations     WHERE deleted_at IS NOT NULL;
    DELETE FROM universities        WHERE deleted_at IS NOT NULL;
    DELETE FROM countries           WHERE deleted_at IS NOT NULL;
    DELETE FROM states              WHERE deleted_at IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_source_attributions
      DROP CONSTRAINT IF EXISTS lead_source_attributions_channel_id_fkey,
      DROP CONSTRAINT IF EXISTS lead_source_attributions_source_id_fkey,
      DROP CONSTRAINT IF EXISTS lead_source_attributions_campaign_id_fkey,
      DROP CONSTRAINT IF EXISTS lead_source_attributions_medium_id_fkey;

    ALTER TABLE lead_source_attributions
      ADD CONSTRAINT lead_source_attributions_channel_id_fkey
        FOREIGN KEY (channel_id) REFERENCES lead_channels(id),
      ADD CONSTRAINT lead_source_attributions_source_id_fkey
        FOREIGN KEY (source_id) REFERENCES lead_sources_dict(id),
      ADD CONSTRAINT lead_source_attributions_campaign_id_fkey
        FOREIGN KEY (campaign_id) REFERENCES lead_campaigns_dict(id),
      ADD CONSTRAINT lead_source_attributions_medium_id_fkey
        FOREIGN KEY (medium_id) REFERENCES lead_mediums(id);
  `);
};
