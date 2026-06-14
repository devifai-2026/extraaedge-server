import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { notFound, conflict, validationError } from '../../lib/errors.js';

const COLUMNS = `
  id, type, label,
  account_holder_name, account_number, ifsc, bank_name, branch, account_type,
  upi_id, qr_r2_key, is_primary, is_active,
  created_by, created_at, updated_at
`;

// Columns a caller may set/patch (type is immutable after create).
const SETTABLE = [
  'label', 'account_holder_name', 'account_number', 'ifsc', 'bank_name',
  'branch', 'account_type', 'upi_id', 'qr_r2_key', 'is_active',
];

export const list = async (tenant, { type, include_inactive } = {}) => {
  const conds = ['deleted_at IS NULL'];
  const params = [];
  if (type) { params.push(type); conds.push(`type = $${params.length}`); }
  if (!include_inactive) conds.push('is_active = true');
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLUMNS} FROM payment_accounts
      WHERE ${conds.join(' AND ')}
      ORDER BY is_primary DESC, created_at DESC`,
    params,
  );
  return rows;
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLUMNS} FROM payment_accounts WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};

const liveCount = async (client) => {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM payment_accounts WHERE deleted_at IS NULL`);
  return rows[0].n;
};

// How many live primaries remain, optionally excluding a set of ids (the
// rows about to be un-primaried / deleted). Used to enforce "≥1 primary".
const primaryCount = async (client, excludeIds = []) => {
  if (excludeIds.length) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM payment_accounts
        WHERE deleted_at IS NULL AND is_primary = true AND id <> ALL($1::uuid[])`,
      [excludeIds],
    );
    return rows[0].n;
  }
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM payment_accounts WHERE deleted_at IS NULL AND is_primary = true`,
  );
  return rows[0].n;
};

// Tenant-scoped uniqueness pre-check (each tenant = its own DB) for
// account_number and UPI ID across all LIVE rows. Excludes `excludeId` on
// update. Throws a friendly 409 before we hit the DB unique index.
const assertUnique = async (client, { account_number, upi_id }, excludeId = null) => {
  if (account_number) {
    const { rows } = await client.query(
      `SELECT 1 FROM payment_accounts
        WHERE account_number = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id <> $2) LIMIT 1`,
      [account_number, excludeId],
    );
    if (rows[0]) throw conflict('This account number already exists in another payment account.');
  }
  if (upi_id) {
    const { rows } = await client.query(
      `SELECT 1 FROM payment_accounts
        WHERE lower(upi_id) = lower($1) AND deleted_at IS NULL AND ($2::uuid IS NULL OR id <> $2) LIMIT 1`,
      [upi_id, excludeId],
    );
    if (rows[0]) throw conflict('This UPI ID already exists in another payment account.');
  }
};

export const create = async (tenant, input, actorId) => tenantTx(tenant, async (client) => {
  await assertUnique(client, input);

  // First account is always primary (must have ≥1). Multiple primaries are
  // allowed, so we DON'T demote others — just honor the requested flag.
  const isFirst = (await liveCount(client)) === 0;
  const makePrimary = isFirst || input.is_primary === true;

  // A row now carries any combination of Bank / UPI / QR sections, so `type`
  // is no longer a single discriminator — left NULL on new rows.
  const { rows } = await client.query(
    `INSERT INTO payment_accounts
       (label, account_holder_name, account_number, ifsc, bank_name, branch,
        account_type, upi_id, qr_r2_key, is_primary, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING ${COLUMNS}`,
    [
      input.label ?? null,
      input.account_holder_name ?? null,
      input.account_number ?? null,
      input.ifsc ?? null,
      input.bank_name ?? null,
      input.branch ?? null,
      input.account_type ?? null,
      input.upi_id ?? null,
      input.qr_r2_key ?? null,
      makePrimary,
      input.is_active ?? true,
      actorId ?? null,
    ],
  );
  return rows[0];
});

export const update = async (tenant, id, patch) => tenantTx(tenant, async (client) => {
  const { rows: existingRows } = await client.query(
    `SELECT ${COLUMNS} FROM payment_accounts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [id],
  );
  const existing = existingRows[0];
  if (!existing) throw notFound('Payment account not found');

  // Guard: un-primarying is fine as long as at least one primary remains.
  // Multiple primaries are allowed now, but the count must never hit zero.
  if (existing.is_primary && patch.is_primary === false) {
    const remaining = await primaryCount(client, [id]);
    if (remaining === 0) {
      throw conflict('At least one primary account is required. Mark another account primary first.');
    }
  }

  // Merge the patch over the existing row, then enforce "≥1 complete section"
  // and reject a partially-filled bank section — mirrors the schema rules so
  // a partial update can't leave a half-built record.
  const merged = { ...existing, ...patch };
  const bankComplete = Boolean(merged.account_holder_name && merged.account_number && merged.ifsc);
  const bankTouched = Boolean(merged.account_holder_name || merged.account_number || merged.ifsc || merged.bank_name || merged.branch || merged.account_type);
  if (bankTouched && !bankComplete) {
    throw validationError([{ path: 'account_number', message: 'Bank section needs holder name, account number and IFSC.' }]);
  }
  if (!bankComplete && !merged.upi_id && !merged.qr_r2_key) {
    throw validationError([{ path: '_', message: 'Fill at least one section: Bank, UPI ID, or a QR image.' }]);
  }

  // Tenant-scoped uniqueness on the merged values (excluding this row).
  await assertUnique(client, { account_number: merged.account_number, upi_id: merged.upi_id }, id);

  const fields = [];
  const params = [];
  let i = 1;
  for (const key of SETTABLE) {
    if (patch[key] === undefined) continue;
    fields.push(`${key} = $${i}`);
    params.push(patch[key]);
    i += 1;
  }
  // is_primary is a plain flag now — set it directly, no demotion of others.
  if (patch.is_primary !== undefined) { fields.push(`is_primary = $${i}`); params.push(patch.is_primary === true); i += 1; }
  if (!fields.length) return existing;
  params.push(id);
  const { rows } = await client.query(
    `UPDATE payment_accounts SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0];
});

export const remove = async (tenant, id) => tenantTx(tenant, async (client) => {
  const { rows } = await client.query(
    `SELECT id, is_primary FROM payment_accounts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound('Payment account not found');

  // Deleting a primary is only allowed if at least one OTHER primary remains.
  // (When it's the very last account overall, there are no payments to take,
  // so we allow it — the "≥1 primary" rule only applies while accounts exist.)
  if (row.is_primary) {
    const live = await liveCount(client);
    const otherPrimaries = await primaryCount(client, [id]);
    if (live > 1 && otherPrimaries === 0) {
      throw conflict('Cannot delete the only primary account. Mark another account primary first.');
    }
  }

  await client.query(
    `UPDATE payment_accounts SET deleted_at = now(), is_primary = false, is_active = false WHERE id = $1`,
    [id],
  );
});

// Bulk "mark these as primary" — multiple primaries are allowed, so this just
// flips is_primary=true on each live+active id (no demotion of others).
// Returns the updated rows.
export const setPrimaryBulk = async (tenant, ids) => tenantTx(tenant, async (client) => {
  const { rows: found } = await client.query(
    `SELECT id FROM payment_accounts
      WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND is_active = true FOR UPDATE`,
    [ids],
  );
  if (!found.length) throw notFound('No matching active payment accounts found');
  const validIds = found.map((r) => r.id);
  const { rows } = await client.query(
    `UPDATE payment_accounts SET is_primary = true
      WHERE id = ANY($1::uuid[]) RETURNING ${COLUMNS}`,
    [validIds],
  );
  return rows;
});

// Bulk "unset primary" on these ids — blocked if it would leave zero
// primaries overall (≥1 primary always required).
export const unsetPrimaryBulk = async (tenant, ids) => tenantTx(tenant, async (client) => {
  const remaining = await primaryCount(client, ids);
  if (remaining === 0) {
    throw conflict('At least one primary account is required. Keep or set another primary first.');
  }
  const { rows } = await client.query(
    `UPDATE payment_accounts SET is_primary = false
      WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL RETURNING ${COLUMNS}`,
    [ids],
  );
  return rows;
});
