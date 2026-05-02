import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';
import { listQuery, idParam } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

router.get('/', validate({ query: listQuery }), controller.list);
router.get('/stream', controller.stream);
router.post('/:id/read', validate({ params: idParam }), controller.markRead);
router.post('/read-all', controller.readAll);

export default router;
