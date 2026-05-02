import express from 'express';
import * as controller from './controller.js';
import { validate } from '../../middleware/validate.js';
import { authRequired } from '../../middleware/auth.js';
import { loginLimiter, passwordResetLimiter } from '../../middleware/rateLimit.js';
import { loginSchema, refreshSchema, changePasswordSchema } from './schema.js';

const router = express.Router();

router.post('/login', loginLimiter, validate({ body: loginSchema }), controller.login);
router.post('/refresh', validate({ body: refreshSchema }), controller.refresh);
router.post('/logout', authRequired, controller.logout);
router.get('/me', authRequired, controller.me);
router.get('/session', authRequired, controller.heartbeat);
router.post('/session/heartbeat', authRequired, controller.heartbeat);
router.post('/change-password', authRequired, passwordResetLimiter, validate({ body: changePasswordSchema }), controller.changePassword);

export default router;
