// Plan controllers — translate req → service → res. No SQL, no business logic.
import * as service from './service.js';

export const list = async (req, res, next) => {
  try {
    const data = await service.listPlans();
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const getOne = async (req, res, next) => {
  try {
    const data = await service.getPlan(req.params.id);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
