// Cross-tenant WhatsApp console for the product_owner: view any tenant's
// messages (read-only), edit its WhatsApp config/webhook, and manage its
// locally-registered templates. PRODUCT_OWNER only — exposes tenant PII.
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import * as repo from './repo.js';

const router = express.Router();
router.use(authRequired, requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER));

const tenantParam = z.object({ tenantId: z.string().uuid() });
const tenantPhoneParam = tenantParam.extend({ phone: z.string().min(6).max(20) });
const tenantIdParam = tenantParam.extend({ id: z.string().uuid() });

// Settings (view + edit).
router.get('/:tenantId/settings', validate({ params: tenantParam }), async (req, res, next) => {
  try { res.json({ data: await repo.getSettings(req.params.tenantId), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  app_key: z.string().max(200).optional(),
  auth_key: z.string().max(400).optional(),
  device_id: z.string().max(200).optional(),
  business_phone: z.string().max(20).optional(),
});
router.put('/:tenantId/settings', validate({ params: tenantParam, body: settingsSchema }), async (req, res, next) => {
  try { res.json({ data: await repo.saveSettings(req.params.tenantId, req.body), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

// Messages (read-only).
router.get('/:tenantId/chats', validate({ params: tenantParam }), async (req, res, next) => {
  try { res.json({ data: await repo.listChats(req.params.tenantId), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});
router.get('/:tenantId/chats/:phone/messages', validate({ params: tenantPhoneParam }), async (req, res, next) => {
  try { res.json({ data: await repo.listMessages(req.params.tenantId, req.params.phone), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

// Templates.
router.get('/:tenantId/templates', validate({ params: tenantParam }), async (req, res, next) => {
  try { res.json({ data: await repo.listTemplates(req.params.tenantId), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});
const templateSchema = z.object({
  template_id: z.string().min(1).max(200),
  label: z.string().min(1).max(120),
  body: z.string().min(1).max(4096),
  category: z.string().max(40).optional(),
});
router.post('/:tenantId/templates', validate({ params: tenantParam, body: templateSchema }), async (req, res, next) => {
  try { res.status(201).json({ data: await repo.addTemplate(req.params.tenantId, req.body), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});
router.delete('/:tenantId/templates/:id', validate({ params: tenantIdParam }), async (req, res, next) => {
  try { await repo.deleteTemplate(req.params.tenantId, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
});

export default router;
