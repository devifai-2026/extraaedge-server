// Platform audit log business logic.
import * as repo from './repo.js';

export const listEntries = (filter) => repo.listAndCount(filter);
