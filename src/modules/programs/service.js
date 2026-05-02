import * as repo from './repo.js';
import { notFound } from '../../lib/errors.js';

export const listPrograms = (tenant, query) => repo.list(tenant, query);
export const getProgram = async (tenant, id) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('Program not found');
  return row;
};
export const createProgram = (tenant, input) => repo.insert(tenant, input);
export const updateProgram = async (tenant, id, updates) => {
  const row = await repo.update(tenant, id, updates);
  if (!row) throw notFound('Program not found');
  return row;
};
export const deleteProgram = (tenant, id) => repo.softDelete(tenant, id);
