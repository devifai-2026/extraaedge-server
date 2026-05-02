import * as repo from './repo.js';
import { notFound, validationError } from '../../lib/errors.js';

export const listByType = (tenant, type) => repo.listByType(tenant, type);

export const createItem = async (tenant, type, input) => {
  const info = repo.getTableForType(type);
  if (!info) throw notFound('Unknown dropdown type');
  if (type === 'sub-stages' && !input.stage_id) throw validationError([{ path: 'stage_id', message: 'stage_id required for sub-stages' }]);
  if (type === 'states' && !input.country_id) throw validationError([{ path: 'country_id', message: 'country_id required for states' }]);
  if (type === 'degrees' && !input.level) throw validationError([{ path: 'level', message: 'level required for degrees' }]);
  return repo.insert(tenant, type, input);
};

export const updateItem = async (tenant, type, id, updates) => {
  const row = await repo.update(tenant, type, id, updates);
  if (!row) throw notFound('Dropdown item not found');
  return row;
};

export const removeItem = async (tenant, type, id) => repo.remove(tenant, type, id);
export const reorderItems = (tenant, type, order) => repo.reorder(tenant, type, order);
