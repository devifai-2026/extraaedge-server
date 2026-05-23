import * as service from './service.js';

export const get = async (req, res, next) => {
  try {
    const data = await service.getForLead(req.tenant, req.params.leadId);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const upsert = async (req, res, next) => {
  try {
    const data = await service.saveOffer(req.tenant, req.user, req.params.leadId, req.body);
    res.status(201).json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
