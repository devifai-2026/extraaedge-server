/* eslint-disable camelcase */
// Idempotent seed of the ExtraAEdge-style defaults across every tenant DB.
// Mirrors the institute-CSV vocabulary so a tenant migrating from ExtraAEdge
// can upload that CSV as-is and find every dropdown value already present.
//
// What this does NOT seed: programs. Programs are tenant-specific catalog
// items the institute curates themselves; we don't want to pre-pollute that.
//
// Every INSERT uses ON CONFLICT DO NOTHING so the migration is safe to
// re-run and safe on tenants where some defaults already exist.

exports.up = (pgm) => {
  pgm.sql(`
    -- ============================================================
    -- Stages
    -- ============================================================
    -- Idempotency: lead_stages.code is UNIQUE. We anchor every seeded
    -- stage on its code prefix ("01-New", "02-Ringing / Not Reachable", ...)
    -- so re-running this migration never produces dupes.
    INSERT INTO lead_stages (name, code, order_index, color, is_terminal) VALUES
      ('New',                       '01-New',                       1,  '#1976D2', false),
      ('Ringing / Not Reachable',   '02-Ringing / Not Reachable',   2,  '#FF9800', false),
      ('Contacted',                 '03-Contacted',                 3,  '#7B1FA2', false),
      ('Followup',                  '04-Followup',                  4,  '#F57C00', false),
      ('Qualified',                 '05-Qualified',                 5,  '#388E3C', false),
      ('Demo Scheduled',            '06-Demo Scheduled',            6,  '#0288D1', false),
      ('Requirement Match',         '07-Requirement-Match',         7,  '#00838F', false),
      ('Interested',                '08-Interested',                8,  '#2E7D32', false),
      ('Visited',                   '09-Visited',                   9,  '#1565C0', false),
      ('Enrolled',                  '10-Enrolled',                  10, '#2E7D32', true),
      ('Junk',                      '11-Junk',                      11, '#757575', true),
      ('Cold',                      '12-Cold',                      12, '#546E7A', true),
      ('Not Interested',            '13-Not-Interested',            13, '#9E9E9E', true)
    ON CONFLICT (code) DO NOTHING;

    -- ============================================================
    -- Sub-stages (scoped to parent stage)
    -- ============================================================
    -- lead_sub_stages has no UNIQUE constraint we can target with
    -- ON CONFLICT, so we WHERE NOT EXISTS the inserts instead.
    DO $seed_substages$
    DECLARE
      pair RECORD;
      v_stage_id uuid;
    BEGIN
      FOR pair IN
        SELECT * FROM (VALUES
          -- 02-Ringing / Not Reachable (the four shapes seen in the CSV)
          ('02-Ringing / Not Reachable', 'Ringing no response'),
          ('02-Ringing / Not Reachable', 'Did not connect'),
          ('02-Ringing / Not Reachable', 'Switched Off'),
          ('02-Ringing / Not Reachable', 'Could not speak'),
          ('02-Ringing / Not Reachable', 'Out of service'),
          ('02-Ringing / Not Reachable', 'Voicemail'),

          -- 01-New
          ('01-New', 'Not Called'),
          ('01-New', 'Awaiting confirmation'),

          -- 03-Contacted
          ('03-Contacted', 'Spoken — collecting details'),
          ('03-Contacted', 'Asked to call back'),
          ('03-Contacted', 'Wrong number'),

          -- 04-Followup
          ('04-Followup', 'Scheduled callback'),
          ('04-Followup', 'Needs more info'),
          ('04-Followup', 'Will join soon'),
          ('04-Followup', 'Awaiting parents consent'),

          -- 05-Qualified
          ('05-Qualified', 'Eligible'),
          ('05-Qualified', 'Needs demo'),

          -- 06-Demo Scheduled
          ('06-Demo Scheduled', 'Demo confirmed'),
          ('06-Demo Scheduled', 'Demo missed'),
          ('06-Demo Scheduled', 'Demo attended'),

          -- 07-Requirement-Match
          ('07-Requirement-Match', 'Program matched'),
          ('07-Requirement-Match', 'Negotiation phase'),

          -- 08-Interested
          ('08-Interested', 'High interest'),
          ('08-Interested', 'Will visit'),
          ('08-Interested', 'Wants brochure'),

          -- 09-Visited
          ('09-Visited', 'Visited campus'),
          ('09-Visited', 'Visited — discussing'),

          -- 10-Enrolled (terminal — success)
          ('10-Enrolled', 'Fees paid'),
          ('10-Enrolled', 'Token paid'),

          -- 11-Junk (terminal)
          ('11-Junk', 'Fake number'),
          ('11-Junk', 'Test entry'),
          ('11-Junk', 'Spam'),

          -- 12-Cold (terminal)
          ('12-Cold', 'No response for 30+ days'),
          ('12-Cold', 'Long-term followup'),

          -- 13-Not-Interested (terminal)
          ('13-Not-Interested', 'Not interested in IT courses'),
          ('13-Not-Interested', 'Joined elsewhere'),
          ('13-Not-Interested', 'Budget constraint'),
          ('13-Not-Interested', 'Course too long')
        ) AS t(stage_code, sub_name)
      LOOP
        SELECT id INTO v_stage_id FROM lead_stages WHERE code = pair.stage_code LIMIT 1;
        IF v_stage_id IS NULL THEN CONTINUE; END IF;
        IF NOT EXISTS (
          SELECT 1 FROM lead_sub_stages
           WHERE stage_id = v_stage_id AND name = pair.sub_name AND deleted_at IS NULL
        ) THEN
          INSERT INTO lead_sub_stages (stage_id, name, is_default)
          VALUES (v_stage_id, pair.sub_name, false);
        END IF;
      END LOOP;
    END
    $seed_substages$;

    -- ============================================================
    -- Channels (lead_channels.name UNIQUE)
    -- ============================================================
    INSERT INTO lead_channels (name) VALUES
      ('Offline'),
      ('Online'),
      ('Direct'),
      ('Facebook'),
      ('Instagram'),
      ('Google Ads'),
      ('LinkedIn'),
      ('Email Campaign'),
      ('Walk-in'),
      ('Phone')
    ON CONFLICT (name) DO NOTHING;

    -- ============================================================
    -- Sources (lead_sources_dict.name UNIQUE)
    -- ============================================================
    INSERT INTO lead_sources_dict (name) VALUES
      ('Social Media'),
      ('Raw Database'),
      ('JD'),
      ('Direct Walk-in'),
      ('Website'),
      ('Professional Network'),
      ('Newsletter'),
      ('Referral'),
      ('Justdial'),
      ('Sulekha')
    ON CONFLICT (name) DO NOTHING;

    -- ============================================================
    -- Campaigns (lead_campaigns_dict.name UNIQUE)
    -- ============================================================
    INSERT INTO lead_campaigns_dict (name) VALUES
      ('Meta'),
      ('INSTA'),
      ('Justdial'),
      ('Raw26'),
      ('Raw'),
      ('Web Quick Add Lead'),
      ('Web Add Lead'),
      ('ORGANIC'),
      ('PAID'),
      ('Referral')
    ON CONFLICT (name) DO NOTHING;

    -- ============================================================
    -- Mediums (lead_mediums.name UNIQUE)
    -- ============================================================
    INSERT INTO lead_mediums (name) VALUES
      ('Offline'),
      ('Free'),
      ('CPC'),
      ('Referral'),
      ('Email'),
      ('Organic'),
      ('Paid')
    ON CONFLICT (name) DO NOTHING;

    -- ============================================================
    -- Primary sources (lead_primary_sources.name UNIQUE)
    -- ============================================================
    INSERT INTO lead_primary_sources (name) VALUES
      ('Raw Database'),
      ('Social Media'),
      ('JD'),
      ('Website'),
      ('Referral'),
      ('Walk-in')
    ON CONFLICT (name) DO NOTHING;

    -- ============================================================
    -- Genders (genders.name UNIQUE)
    -- ============================================================
    INSERT INTO genders (name) VALUES
      ('Male'),
      ('Female'),
      ('Other'),
      ('Prefer not to say')
    ON CONFLICT (name) DO NOTHING;

    -- ============================================================
    -- Degrees (UNIQUE on (level, name))
    -- ============================================================
    INSERT INTO degrees (level, name) VALUES
      -- UG
      ('UG', 'B.Tech'),
      ('UG', 'B.E.'),
      ('UG', 'B.E. (Computer)'),
      ('UG', 'BCA'),
      ('UG', 'B.Sc'),
      ('UG', 'B.Com'),
      ('UG', 'BBA'),
      ('UG', 'BA'),
      ('UG', 'Bachelor''s degree'),
      ('UG', 'Some college / Associate''s degree'),
      ('UG', 'High school / GED'),
      ('UG', 'Some high school'),
      -- PG
      ('PG', 'M.Tech'),
      ('PG', 'MCA'),
      ('PG', 'M.Sc'),
      ('PG', 'M.Com'),
      ('PG', 'MBA'),
      ('PG', 'MA'),
      ('PG', 'Post-graduate degree')
    ON CONFLICT (level, name) DO NOTHING;

    -- ============================================================
    -- Specializations (specializations.name UNIQUE)
    -- ============================================================
    INSERT INTO specializations (name) VALUES
      ('Computer Science'),
      ('Information Technology'),
      ('Electronics'),
      ('Mechanical'),
      ('Civil'),
      ('Electrical'),
      ('Data Science'),
      ('Artificial Intelligence'),
      ('Finance'),
      ('Marketing'),
      ('Human Resources'),
      ('Operations'),
      ('General')
    ON CONFLICT (name) DO NOTHING;

    -- ============================================================
    -- Universities (universities.name UNIQUE)
    -- ============================================================
    -- Seed a small India-centric list; bulk-upload auto-creates the rest
    -- on first use anyway, so this is just to make manual-add easier on
    -- day one.
    INSERT INTO universities (name) VALUES
      ('Savitribai Phule Pune University'),
      ('University of Mumbai'),
      ('Pune University'),
      ('Genba Sopanrao Moze College Of Engineering'),
      ('Other')
    ON CONFLICT (name) DO NOTHING;

    -- ============================================================
    -- Countries (countries.name UNIQUE) — Make sure India exists
    -- ============================================================
    INSERT INTO countries (name, iso) VALUES
      ('India', 'IN')
    ON CONFLICT (name) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  // Reverting this seed is intentionally a no-op. Removing rows could
  // break leads that reference them (FK ON DELETE behaviour aside,
  // it's data the operator has likely come to depend on). If a tenant
  // truly wants to wipe these, they can do it from the dropdowns UI.
  pgm.sql(`SELECT 1`);
};
