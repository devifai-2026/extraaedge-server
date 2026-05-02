import { concurrentModification } from '../lib/errors.js';

// Checks If-Match header before letting mutation through. Loader returns current updated_at ISO.
// Usage:
//   router.put('/leads/:id', optimisticLock(loadLeadUpdatedAt), handler)
export const optimisticLock = (loadCurrentUpdatedAt) => async (req, _res, next) => {
  try {
    const ifMatch = req.headers['if-match'];
    if (!ifMatch) return next();
    const current = await loadCurrentUpdatedAt(req);
    if (!current) return next();
    const sameInstant = new Date(String(ifMatch)).getTime() === new Date(current).getTime();
    if (!sameInstant) {
      return next(concurrentModification(current));
    }
    next();
  } catch (err) {
    next(err);
  }
};
