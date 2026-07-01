import { env } from '../config/env.js';
import { safeEqual } from '../lib/crypto.js';
import { unauthenticated } from '../lib/errors.js';

// Guards the device-upload endpoint (POST /device-recordings) with a single
// fixed shared secret, sent by the Android call-recorder app as `X-Api-Key`.
//
// This is intentionally NOT per-user JWT auth: the device has no logged-in
// user, it just uploads recordings. The trade-off (a secret shipped in the
// APK is extractable, and rotation is global) is accepted — see the plan.
//
// When DEVICE_UPLOAD_API_KEY is unset the endpoint is effectively disabled:
// every request is rejected rather than silently allowed.
export const apiKeyRequired = (req, _res, next) => {
  const provided = req.headers['x-api-key'];
  const expected = env.DEVICE_UPLOAD_API_KEY;
  if (!expected || typeof provided !== 'string' || !safeEqual(provided, expected)) {
    return next(unauthenticated('Invalid API key'));
  }
  // Marks the actor as an unauthenticated device upload — there is no req.user,
  // so downstream handlers must not assume one (e.g. uploaded_by stays null).
  req.deviceUpload = true;
  next();
};
