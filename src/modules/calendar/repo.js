import { tenantQuery, tenantTx } from '../../db/tenant.js';

export const listHours = async (tenant) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM business_hours ORDER BY day_of_week`);
  return rows;
};

export const replaceHours = async (tenant, hours, timezone) => tenantTx(tenant, async (client) => {
  await client.query('DELETE FROM business_hours');
  for (const h of hours) {
    await client.query(
      `INSERT INTO business_hours (day_of_week, is_open, open_time, close_time, timezone)
       VALUES ($1,$2,$3,$4,$5)`,
      [h.day_of_week, h.is_open, h.open_time ?? null, h.close_time ?? null, timezone ?? tenant.timezone ?? 'Asia/Kolkata'],
    );
  }
  const { rows } = await client.query(`SELECT * FROM business_hours ORDER BY day_of_week`);
  return rows;
});

export const listHolidays = async (tenant) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM holidays WHERE deleted_at IS NULL ORDER BY date`);
  return rows;
};

export const addHoliday = async (tenant, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO holidays (date, name, is_full_day) VALUES ($1,$2,$3) RETURNING *`,
    [input.date, input.name, input.is_full_day],
  );
  return rows[0];
};

export const deleteHoliday = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE holidays SET deleted_at = now() WHERE id = $1`, [id]);
};

export const nextBusinessMoment = async (tenant, fromIso) => {
  const from = fromIso ? new Date(fromIso) : new Date();
  const [hoursRes, holidaysRes] = await Promise.all([
    tenantQuery(tenant, `SELECT * FROM business_hours ORDER BY day_of_week`),
    tenantQuery(tenant, `SELECT date FROM holidays WHERE deleted_at IS NULL AND date >= current_date`),
  ]);
  const hoursByDay = new Map(hoursRes.rows.map((r) => [r.day_of_week, r]));
  const holidaySet = new Set(holidaysRes.rows.map((r) => new Date(r.date).toISOString().slice(0, 10)));

  // Naive forward scan — at most 14 days.
  for (let i = 0; i < 14; i += 1) {
    const candidate = new Date(from.getTime() + i * 86_400_000);
    const dow = candidate.getUTCDay();
    const dateKey = candidate.toISOString().slice(0, 10);
    const hoursRow = hoursByDay.get(dow);
    if (!hoursRow || !hoursRow.is_open || holidaySet.has(dateKey)) continue;
    const [oh, om] = String(hoursRow.open_time ?? '10:00').split(':').map(Number);
    const [ch, cm] = String(hoursRow.close_time ?? '19:00').split(':').map(Number);
    const open = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate(), oh, om));
    const close = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate(), ch, cm));
    if (i === 0 && from >= open && from < close) return from.toISOString();
    if (i === 0 && from >= close) continue;
    return open.toISOString();
  }
  return from.toISOString();
};
