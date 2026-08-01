import express from 'express';
import * as controller from './controller.js';
import { validate } from '../../middleware/validate.js';
import { authRequired } from '../../middleware/auth.js';
import { loginLimiter, passwordResetLimiter, otpLimiter } from '../../middleware/rateLimit.js';
import {
  loginSchema, refreshSchema, changePasswordSchema,
  mobileOtpRequestSchema, mobileOtpVerifySchema,
  webOtpRequestSchema, webOtpVerifySchema, loginMethodsQuery,
} from './schema.js';

const router = express.Router();

router.post('/login', loginLimiter, validate({ body: loginSchema }), controller.login);
// Which sign-in form to render for a tenant (password is demo-only once
// OTP_LOGIN_ENFORCED is on).
router.get('/login-methods', validate({ query: loginMethodsQuery }), controller.loginMethods);
// Passwordless web login: email + registered phone -> 4-digit WhatsApp OTP.
router.post('/otp/request', otpLimiter, validate({ body: webOtpRequestSchema }), controller.webRequestOtp);
router.post('/otp/verify', otpLimiter, validate({ body: webOtpVerifySchema }), controller.webVerifyOtp);
// Counsellor recorder app: OTP login by institute code + profile phone.
router.post('/mobile/request-otp', otpLimiter, validate({ body: mobileOtpRequestSchema }), controller.mobileRequestOtp);
router.post('/mobile/verify-otp', otpLimiter, validate({ body: mobileOtpVerifySchema }), controller.mobileVerifyOtp);
router.post('/refresh', validate({ body: refreshSchema }), controller.refresh);
router.post('/logout', authRequired, controller.logout);
router.get('/me', authRequired, controller.me);
router.get('/session', authRequired, controller.heartbeat);
router.post('/session/heartbeat', authRequired, controller.heartbeat);
router.post('/change-password', authRequired, passwordResetLimiter, validate({ body: changePasswordSchema }), controller.changePassword);

export default router;
