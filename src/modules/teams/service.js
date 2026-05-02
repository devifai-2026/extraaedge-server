import * as repo from './repo.js';
import { notFound } from '../../lib/errors.js';

export const listTeams = (tenant) => repo.list(tenant);
export const getTeam = async (tenant, id) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('Team not found');
  return row;
};
export const createTeam = (tenant, input) => repo.insert(tenant, input);
export const updateTeam = (tenant, id, updates) => repo.update(tenant, id, updates);
export const deleteTeam = (tenant, id) => repo.softDelete(tenant, id);
export const addMember = repo.addMember;
export const removeMember = repo.removeMember;
export const listMembers = repo.listMembers;
export const listLeads = repo.listLeads;
