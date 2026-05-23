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

// Sibling to `signed`: looks up the row by r2_key (querystring) instead
// of by uploads.id. The admission pages store r2_key on the lead, not
// the PK, so this is the lookup they actually need.
export const signedByKey = async (req, res, next) => {
  try {
    const r2Key = req.query.r2_key;
    if (!r2Key) {
      const e = new Error('r2_key is required');
      e.status = 400;
      throw e;
    }
    res.json({
      data: await service.getSignedDownloadByKey(req.tenant, req.user, String(r2Key)),
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try { await service.deleteUpload(req.tenant, req.user, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};
