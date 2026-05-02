import * as service from './service.js';

export const getHours = async (req, res, next) => {
  try { res.json({ data: await service.listHours(req.tenant), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const putHours = async (req, res, next) => {
  try {
    const rows = await service.replaceHours(req.tenant, req.body.hours, req.body.timezone);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const listHolidays = async (req, res, next) => {
  try { res.json({ data: await service.listHolidays(req.tenant), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const addHoliday = async (req, res, next) => {
  try {
    const row = await service.addHoliday(req.tenant, req.body);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const deleteHoliday = async (req, res, next) => {
  try { await service.deleteHoliday(req.tenant, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};

export const nextMoment = async (req, res, next) => {
  try {
    const next = await service.nextBusinessMoment(req.tenant, req.query.from);
    res.json({ data: { next_business_moment: next }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
