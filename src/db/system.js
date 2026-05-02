import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool } = pg;

let pool;

export const getSystemPool = () => {
  if (!pool) {
    pool = new Pool({
      host: env.SYSTEM_DB_HOST,
      port: env.SYSTEM_DB_PORT,
      database: env.SYSTEM_DB_NAME,
      user: env.SYSTEM_DB_USER,
      password: env.SYSTEM_DB_PASSWORD,
      ssl: env.SYSTEM_DB_SSL ? { rejectUnauthorized: false } : false,
      max: env.SYSTEM_DB_MAX_POOL,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => logger.error({ err: err.message }, 'system pg pool error'));
  }
  return pool;
};

export const sysQuery = (text, params) => getSystemPool().query(text, params);

export const sysTx = async (fn) => {
  const client = await getSystemPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

export const closeSystemPool = async () => {
  if (pool) await pool.end();
  pool = null;
};
