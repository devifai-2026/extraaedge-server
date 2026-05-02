// Plan business logic — calls repo, projects rows for the API.
import * as repo from './repo.js';
import { notFound } from '../../lib/errors.js';

// Project a raw plan row into the public shape (lifts `features_json.list` to `features`).
const projectPlan = (row) => ({
  ...row,
  features: Array.isArray(row.features_json?.list) ? row.features_json.list : [],
});

export const listPlans = async () => {
  const rows = await repo.findAll();
  return rows.map(projectPlan);
};

export const getPlan = async (id) => {
  const row = await repo.findById(id);
  if (!row) throw notFound('Plan not found');
  return projectPlan(row);
};
