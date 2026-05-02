import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let client = null;

export const getRedis = () => {
  if (!env.REDIS_URL) return null;
  if (client) return client;
  client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on('error', (err) => logger.error({ err: err.message }, 'redis error'));
  client.on('ready', () => logger.info('redis ready'));
  return client;
};

export const redisAvailable = () => Boolean(env.REDIS_URL);

export const closeRedis = async () => {
  if (client) {
    await client.quit();
    client = null;
  }
};
