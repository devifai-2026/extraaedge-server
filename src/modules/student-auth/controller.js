import * as service from './service.js';

// Public tenant branding (logo + name + colors) for the student login screen,
// resolved from the x-tenant-slug header via tenantRequired. No auth needed.
export const branding = async (req, res, next) => {
  try {
    const t = req.tenant || {};
    res.json({
      data: {
        slug: t.slug,
        name: t.brand_name || t.company_name || t.name || null,
        logo_url: t.logo_url || null,
        brand_primary_color: t.brand_primary_color || null,
        brand_secondary_color: t.brand_secondary_color || null,
      },
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
};

export const login = async (req, res, next) => {
  try {
    const data = await service.login(req.tenant, req.body);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const setPassword = async (req, res, next) => {
  try {
    const data = await service.setPassword(req.tenant, req.body);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const requestReset = async (req, res, next) => {
  try {
    const data = await service.requestReset(req.tenant, req.body);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const me = async (req, res, next) => {
  try {
    const data = await service.me(req.tenant, req.student.id);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

// ---- Profile (student) ----
export const getProfile = async (req, res, next) => {
  try { res.json({ data: await service.getProfile(req.tenant, req.student.id), meta: { requestId: req.id } }); } catch (e) { next(e); }
};
export const updateProfile = async (req, res, next) => {
  try { res.json({ data: await service.updateProfile(req.tenant, req.student.id, req.body), meta: { requestId: req.id } }); } catch (e) { next(e); }
};
export const presign = async (req, res, next) => {
  try { res.json({ data: await service.presign(req.tenant, req.student.id, req.body), meta: { requestId: req.id } }); } catch (e) { next(e); }
};
export const setCv = async (req, res, next) => {
  try { res.json({ data: await service.setCv(req.tenant, req.student.id, req.body.r2_key, req.body.filename), meta: { requestId: req.id } }); } catch (e) { next(e); }
};

// ---- Trainer view (staff) ----
export const trainerViewProfile = async (req, res, next) => {
  try { res.json({ data: await service.trainerViewProfile(req.tenant, req.user, req.params.studentId), meta: { requestId: req.id } }); } catch (e) { next(e); }
};
