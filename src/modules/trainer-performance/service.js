import * as repo from './repo.js';
import { LMS_TENANT_ROLES, ADMIN_TIER_ROLES } from '../../config/constants.js';

// Who sees whose rows. A trainer sees ONLY their own — this is a performance
// report, and letting one trainer browse another's overdue modules is a
// different product decision than the one asked for. Head trainers, branch
// managers and admins see everyone and can filter by trainer / course / module.
const SEES_EVERYONE = [...ADMIN_TIER_ROLES, LMS_TENANT_ROLES.HEAD_TRAINER];

const scopeFor = (actor, query = {}) => {
  if (SEES_EVERYONE.includes(actor.role)) {
    return {
      trainerId: query.trainer_id || null,
      programId: query.program_id || null,
      moduleName: query.module || null,
      trainerName: query.trainer || null,
    };
  }
  // Forced to self, ignoring any trainer_id the client sent.
  return {
    trainerId: actor.id,
    programId: query.program_id || null,
    moduleName: query.module || null,
  };
};

export const report = async (tenant, actor, query) => repo.report(tenant, scopeFor(actor, query));

export const summary = async (tenant, actor, query) => repo.summary(tenant, scopeFor(actor, query));

export const canSeeEveryone = (actor) => SEES_EVERYONE.includes(actor.role);
