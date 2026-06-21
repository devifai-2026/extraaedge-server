import * as service from './service.js';

export const get = async (req, res, next) => {
  try {
    const data = await service.getForLead(req.tenant, req.params.leadId);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const apply = async (req, res, next) => {
  try {
    const data = await service.applyDiscount(req.tenant, req.user, req.params.leadId, req.body);
    res.status(201).json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const decide = async (req, res, next) => {
  try {
    const data = await service.decideDiscount(req.tenant, req.user, req.params.leadId, req.body);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const pending = async (req, res, next) => {
  try {
    const data = await service.listPending(req.tenant, req.user);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
