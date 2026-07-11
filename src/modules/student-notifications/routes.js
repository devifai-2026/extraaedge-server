import express from 'express';
import { z } from 'zod';
import { studentAuthRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';

const router = express.Router();
router.use(studentAuthRequired, tenantRequired);

router.get('/', async (req, res, next) => {
  try {
    const [items, unread] = await Promise.all([
      service.list(req.tenant, req.student.id, { unreadOnly: req.query.unread === 'true', limit: 30 }),
      service.unreadCount(req.tenant, req.student.id),
    ]);
    res.json({ data: { items, unread }, meta: { requestId: req.id } });
  } catch (e) { next(e); }
});

router.post('/:id/read', validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res, next) => {
  try { await service.markRead(req.tenant, req.student.id, req.params.id); res.status(204).end(); } catch (e) { next(e); }
});

router.post('/read-all', async (req, res, next) => {
  try { await service.markAllRead(req.tenant, req.student.id); res.status(204).end(); } catch (e) { next(e); }
});

export default router;
