// Plan persistence layer. Owns all SQL — no business logic, no req/res.
import { sysQuery } from '../../db/system.js';
import { selectMany, selectOne } from '../../lib/dbHelpers.js';

const PLAN_COLUMNS = `
  id, name, description, price_monthly, currency, features_json,
  included_email_credits, included_sms_credits, included_whatsapp_credits,
  max_users, max_leads, is_public, created_at, updated_at
`;

export const findAll = () => selectMany(
  sysQuery,
  `SELECT ${PLAN_COLUMNS}
     FROM plans
    WHERE deleted_at IS NULL
    ORDER BY price_monthly NULLS LAST, name`,
);

export const findById = (id) => selectOne(
  sysQuery,
  `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1 AND deleted_at IS NULL`,
  [id],
);
