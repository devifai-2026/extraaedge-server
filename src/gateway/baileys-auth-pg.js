// Postgres-backed Baileys auth state — the SQL equivalent of Baileys'
// useMultiFileAuthState (whose own docs say: "would recommend writing an auth
// state for use with a proper SQL DB"). One row per (tenant, user, data_key)
// in the system-DB `wa_auth_state` table; blobs are (de)serialized with
// Baileys' BufferJSON so Buffers/Uint8Arrays round-trip correctly.
//
// data_key is 'creds' for the credentials, or '<category>-<id>' for each signal
// key (pre-key, session, sender-key, app-state-sync-key, …) — same naming the
// reference file store uses, minus the filesystem.
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { sysQuery } from '../db/system.js';

const readKey = async (tenantId, userId, dataKey) => {
  const { rows } = await sysQuery(
    `SELECT data_json FROM wa_auth_state WHERE tenant_id = $1 AND user_id = $2 AND data_key = $3`,
    [tenantId, userId, dataKey],
  );
  if (!rows[0]) return null;
  // data_json is stored as a JSON string (BufferJSON.replacer output) wrapped
  // in a jsonb column; parse it back through BufferJSON.reviver.
  const raw = typeof rows[0].data_json === 'string' ? rows[0].data_json : JSON.stringify(rows[0].data_json);
  return JSON.parse(raw, BufferJSON.reviver);
};

const writeKey = async (tenantId, userId, dataKey, value) => {
  const serialized = JSON.stringify(value, BufferJSON.replacer);
  await sysQuery(
    `INSERT INTO wa_auth_state (tenant_id, user_id, data_key, data_json, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (tenant_id, user_id, data_key)
       DO UPDATE SET data_json = EXCLUDED.data_json, updated_at = now()`,
    [tenantId, userId, dataKey, serialized],
  );
};

const removeKey = async (tenantId, userId, dataKey) => {
  await sysQuery(
    `DELETE FROM wa_auth_state WHERE tenant_id = $1 AND user_id = $2 AND data_key = $3`,
    [tenantId, userId, dataKey],
  );
};

// Returns { state, saveCreds } exactly like useMultiFileAuthState, so it drops
// straight into makeWASocket({ auth: state.creds/keys }).
export const usePostgresAuthState = async (tenantId, userId) => {
  const creds = (await readKey(tenantId, userId, 'creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readKey(tenantId, userId, `${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const dataKey = `${category}-${id}`;
              tasks.push(value ? writeKey(tenantId, userId, dataKey, value) : removeKey(tenantId, userId, dataKey));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeKey(tenantId, userId, 'creds', creds),
  };
};

// Wipe a user's entire session (used on logout so a re-connect starts fresh).
export const clearPostgresAuthState = async (tenantId, userId) => {
  await sysQuery(`DELETE FROM wa_auth_state WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
};

// user_ids with a persisted session, for restore-on-boot.
export const listConnectedUserIds = async (tenantId) => {
  const { rows } = await sysQuery(
    `SELECT DISTINCT user_id FROM wa_auth_state WHERE tenant_id = $1 AND data_key = 'creds'`,
    [tenantId],
  );
  return rows.map((r) => r.user_id);
};
