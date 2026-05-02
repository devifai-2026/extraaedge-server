import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { otpLimiter } from '../../middleware/rateLimit.js';
import { generateOtp, hashOtp, otpExpiryDate } from '../../lib/otp.js';
import { sendSms, sendOtp } from '../../lib/providers/sms-messagecentral.js';
import { sendEmail } from '../../lib/providers/email-brevo.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { notFound, forbidden } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();

// Public email-verify callback — no auth (signed link).
router.get('/verify/email/:token', async (req, res, next) => {
  try {
    const hash = sha256Hex(req.params.token);
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE otp_verifications SET verified_at = now() WHERE otp_hash = $1 AND purpose = 'email_verify' AND verified_at IS NULL AND expires_at > now() RETURNING lead_id`,
      [hash],
    );
    if (!rows[0]) return res.status(410).send('Verification link expired or already used');
    if (rows[0].lead_id) {
      await tenantQuery(req.tenant, `UPDATE leads SET email_verified_at = now() WHERE id = $1`, [rows[0].lead_id]);
    }
    res.send('Email verified successfully');
  } catch (err) { next(err); }
});

// All other raw-data endpoints are tenant-authed.
router.use(authRequired, tenantRequired);

const tabQuery = z.object({
  tab: z.enum(['all', 'cold', 'mobile_verified', 'email_verified', 'both', 'warm']).default('all'),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const idParam = z.object({ id: z.string().uuid() });
const verifyBodySchema = z.object({ otp: z.string().min(4) });

router.get('/', validate({ query: tabQuery }), async (req, res, next) => {
  try {
    const conds = ['deleted_at IS NULL'];
    const params = [];
    switch (req.query.tab) {
      case 'cold': conds.push('is_cold = true'); break;
      case 'mobile_verified': conds.push('mobile_verified_at IS NOT NULL'); break;
      case 'email_verified': conds.push('email_verified_at IS NOT NULL'); break;
      case 'both': conds.push('mobile_verified_at IS NOT NULL AND email_verified_at IS NOT NULL'); break;
      case 'warm': conds.push('(mobile_verified_at IS NOT NULL OR email_verified_at IS NOT NULL) AND is_cold = false'); break;
      default: break;
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      conds.push(`(name ILIKE $${params.length} OR email::text ILIKE $${params.length} OR phone ILIKE $${params.length})`);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT id, name, email, phone, whatsapp_number, is_cold, mobile_verified_at, email_verified_at, created_at
         FROM leads ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit } });
  } catch (err) { next(err); }
});

router.post('/:id/verify-mobile', otpLimiter, validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows: leadRows } = await tenantQuery(req.tenant, `SELECT id, phone FROM leads WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!leadRows[0] || !leadRows[0].phone) throw notFound('Lead or phone not found');
    const otp = generateOtp(6);
    const otp_hash = hashOtp(otp, leadRows[0].phone);
    const providerResp = await sendOtp({ to: leadRows[0].phone });
    await tenantQuery(
      req.tenant,
      `INSERT INTO otp_verifications (lead_id, user_id, purpose, channel, address, otp_hash, provider_verification_id, expires_at, max_attempts)
       VALUES ($1,$2,'mobile_verify','sms',$3,$4,$5,$6,3)`,
      [req.params.id, req.user.id, leadRows[0].phone, otp_hash, providerResp.verification_id ?? null, otpExpiryDate()],
    );
    // In dummy/dev mode, also send via standard SMS for the institute's developer testing.
    await sendSms({ to: leadRows[0].phone, body: `Your verification code is ${otp}` }).catch(() => {});
    res.json({ data: { sent: true }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/verify-mobile/confirm', validate({ params: idParam, body: verifyBodySchema }), async (req, res, next) => {
  try {
    const { rows: leadRows } = await tenantQuery(req.tenant, `SELECT phone FROM leads WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!leadRows[0]) throw notFound('Lead not found');
    const otp_hash = hashOtp(req.body.otp, leadRows[0].phone);
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE otp_verifications SET verified_at = now()
        WHERE lead_id = $1 AND purpose = 'mobile_verify' AND verified_at IS NULL AND expires_at > now() AND otp_hash = $2
        RETURNING id`,
      [req.params.id, otp_hash],
    );
    if (!rows[0]) {
      await tenantQuery(
        req.tenant,
        `UPDATE otp_verifications SET attempts = attempts + 1 WHERE lead_id = $1 AND purpose = 'mobile_verify' AND verified_at IS NULL`,
        [req.params.id],
      );
      throw forbidden('Invalid or expired OTP');
    }
    await tenantQuery(req.tenant, `UPDATE leads SET mobile_verified_at = now() WHERE id = $1`, [req.params.id]);
    res.json({ data: { verified: true }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/verify-email', otpLimiter, validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows: leadRows } = await tenantQuery(req.tenant, `SELECT email FROM leads WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!leadRows[0] || !leadRows[0].email) throw notFound('Lead or email not found');
    const token = randomToken(24);
    const otp_hash = sha256Hex(token);
    await tenantQuery(
      req.tenant,
      `INSERT INTO otp_verifications (lead_id, user_id, purpose, channel, address, otp_hash, expires_at, max_attempts)
       VALUES ($1,$2,'email_verify','email',$3,$4,$5,1)`,
      [req.params.id, req.user.id, leadRows[0].email, otp_hash, otpExpiryDate()],
    );
    const link = `${process.env.BASE_URL || ''}/api/v1/raw-data/verify/email/${token}`;
    await sendEmail({ to: leadRows[0].email, subject: 'Verify your email', html: `<p>Click to verify: <a href="${link}">${link}</a></p>`, text: `Verify: ${link}` });
    res.json({ data: { sent: true }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/promote', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    await tenantQuery(req.tenant, `UPDATE leads SET is_cold = false, last_activity_at = now() WHERE id = $1`, [req.params.id]);
    await tenantQuery(
      req.tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary) VALUES ($1,$2,'promoted','Raw lead promoted')`,
      [req.params.id, req.user.id],
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
