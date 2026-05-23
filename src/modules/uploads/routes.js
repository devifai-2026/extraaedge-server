import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';
import { presignSchema, confirmSchema, idParam } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

router.post('/presign', validate({ body: presignSchema }), controller.presign);
router.post('/confirm', validate({ body: confirmSchema }), controller.confirm);
// Lookup by r2_key — must come BEFORE /:id/signed-url so the UUID
// param matcher doesn't claim the path. No params validation here;
// the controller asserts r2_key is present.
router.get('/by-key/signed-url', controller.signedByKey);
router.get('/:id/signed-url', validate({ params: idParam }), controller.signed);
router.delete('/:id', validate({ params: idParam }), controller.remove);

export default router;
