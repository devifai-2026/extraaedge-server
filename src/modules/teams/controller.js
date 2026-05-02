import * as service from './service.js';

export const list = async (req, res, next) => {
  try { res.json({ data: await service.listTeams(req.tenant), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const get = async (req, res, next) => {
  try { res.json({ data: await service.getTeam(req.tenant, req.params.id), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const create = async (req, res, next) => {
  try {
    const row = await service.createTeam(req.tenant, req.body);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const row = await service.updateTeam(req.tenant, req.params.id, req.body);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try { await service.deleteTeam(req.tenant, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};

export const addMember = async (req, res, next) => {
  try {
    await service.addMember(req.tenant, req.params.id, req.body.user_id);
    res.status(204).end();
  } catch (err) { next(err); }
};

export const removeMember = async (req, res, next) => {
  try {
    await service.removeMember(req.tenant, req.params.id, req.params.user_id);
    res.status(204).end();
  } catch (err) { next(err); }
};

export const listMembers = async (req, res, next) => {
  try { res.json({ data: await service.listMembers(req.tenant, req.params.id), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const listLeads = async (req, res, next) => {
  try {
    const rows = await service.listLeads(req.tenant, req.params.id, req.query);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
