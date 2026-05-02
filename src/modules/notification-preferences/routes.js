import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';
import { updatePrefsSchema } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

router.get('/', controller.get);
router.put('/', validate({ body: updatePrefsSchema }), controller.update);

export default router;
