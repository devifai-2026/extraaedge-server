import * as service from './service.js';

export const presign = async (req, res, next) => {
  try { res.json({ data: await service.presignUpload(req.tenant, req.user, req.body), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const confirm = async (req, res, next) => {
  try {
    const row = await service.confirmUpload(req.tenant, req.user, req.body);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const signed = async (req, res, next) => {
  try { res.json({ data: await service.getSignedDownload(req.tenant, req.user, req.params.id), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try { await service.deleteUpload(req.tenant, req.user, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};
