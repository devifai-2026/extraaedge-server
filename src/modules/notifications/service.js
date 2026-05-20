import { EventEmitter } from 'node:events';
import * as repo from './repo.js';

// In-process SSE emitter. Broadcasts notifications to connected streams for the same user.
// In multi-node setups, swap to Redis pub/sub transparently via this emitter.
const bus = new EventEmitter();
bus.setMaxListeners(1000);

const key = (tenantId, userId) => `${tenantId}:${userId}`;

export const listMine = (tenant, user_id, query) => repo.list(tenant, user_id, query);
export const markRead = (tenant, user_id, id) => repo.markRead(tenant, user_id, id);
export const markAllRead = (tenant, user_id) => repo.markAllRead(tenant, user_id);
export const deleteAll = (tenant, user_id) => repo.deleteAll(tenant, user_id);

export const pushNotification = async (tenant, input) => {
  const row = await repo.insert(tenant, input);
  bus.emit(key(tenant.id, input.user_id), row);
  return row;
};

export const subscribe = (tenant_id, user_id, listener) => {
  const k = key(tenant_id, user_id);
  bus.on(k, listener);
  return () => bus.off(k, listener);
};
