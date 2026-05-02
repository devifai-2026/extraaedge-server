import { tenantQuery } from '../../db/tenant.js';

const DEFAULTS = {
  in_app: true, email: true, sms: false, whatsapp: false, push: false,
  digest_frequency: 'immediate',
  quiet_hours_start: null, quiet_hours_end: null, quiet_hours_tz: null,
  event_overrides: {},
};

export const getForUser = async (tenant, user_id) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM notification_preferences WHERE user_id = $1`, [user_id]);
  return rows[0] ?? { user_id, ...DEFAULTS };
};

export const upsert = async (tenant, user_id, updates) => {
  const merged = { ...DEFAULTS, ...updates };
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO notification_preferences
       (user_id, in_app, email, sms, whatsapp, push, digest_frequency, quiet_hours_start, quiet_hours_end, quiet_hours_tz, event_overrides)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (user_id) DO UPDATE SET
       in_app = EXCLUDED.in_app, email = EXCLUDED.email, sms = EXCLUDED.sms,
       whatsapp = EXCLUDED.whatsapp, push = EXCLUDED.push,
       digest_frequency = EXCLUDED.digest_frequency,
       quiet_hours_start = EXCLUDED.quiet_hours_start,
       quiet_hours_end = EXCLUDED.quiet_hours_end,
       quiet_hours_tz = EXCLUDED.quiet_hours_tz,
       event_overrides = EXCLUDED.event_overrides,
       updated_at = now()
     RETURNING *`,
    [user_id, merged.in_app, merged.email, merged.sms, merged.whatsapp, merged.push, merged.digest_frequency,
     merged.quiet_hours_start, merged.quiet_hours_end, merged.quiet_hours_tz, merged.event_overrides],
  );
  return rows[0];
};
