import 'dotenv/config';
import { z } from 'zod';

const boolLike = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())));

const intFrom = (defaultValue) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number(v)))
    .pipe(z.number().int().nonnegative());

const stringNonEmpty = z.string().min(1);

// The gateway process is a stripped-down service: it only holds WhatsApp
// sessions and needs the DB, JWT, encryption key, GCS, and WA_* config. It
// never sends email/SMS/payments/calls, so the provider keys (Brevo,
// MessageCentral, Razorpay, Exotel) that the API requires are OPTIONAL here.
// Set SERVICE_ROLE=gateway on the gateway service so it boots without them.
// The API leaves SERVICE_ROLE unset → full strict validation as before.
const IS_GATEWAY = process.env.SERVICE_ROLE === 'gateway';
// A field the API requires but the gateway doesn't: strict for the API,
// optional (empty-string default) for the gateway.
const apiOnly = (validator) => (IS_GATEWAY ? z.string().optional().default('') : validator);

const schema = z.object({
  SERVICE_ROLE: z.enum(['api', 'gateway']).optional().default('api'),
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: intFrom(4000),
  BASE_URL: stringNonEmpty.default('http://localhost:4000'),
  CORS_ORIGINS: z
    .string()
    .default(
      [
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:3000',
        'https://extraa-edge-admin.netlify.app',
        'https://extraaedge-product.netlify.app',
        // Render-hosted admin frontend.
        'https://extraaedge-admin.onrender.com',
        // Render-hosted product-owner (platform) portal.
        'https://extraaedge-product-owner.onrender.com',
      ].join(','),
    ),
  PUBLIC_TENANT_DOMAIN: stringNonEmpty.default('productivo.in'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: boolLike.default(true),

  JWT_SECRET: stringNonEmpty,
  JWT_SECRET_NEXT: z.string().optional().default(''),
  JWT_ACCESS_TTL_MINUTES: intFrom(15),
  JWT_REFRESH_TTL_DAYS: intFrom(7),
  JWT_ISSUER: stringNonEmpty.default('extraaedge'),

  IDLE_TIMEOUT_MINUTES: intFrom(15),
  SESSION_HEARTBEAT_INTERVAL_SECONDS: intFrom(60),

  SYSTEM_DB_HOST: stringNonEmpty,
  SYSTEM_DB_PORT: intFrom(5432),
  SYSTEM_DB_NAME: stringNonEmpty,
  SYSTEM_DB_USER: stringNonEmpty,
  SYSTEM_DB_PASSWORD: stringNonEmpty,
  SYSTEM_DB_SSL: boolLike.default(false),
  SYSTEM_DB_MAX_POOL: intFrom(10),

  TENANT_DB_HOST: stringNonEmpty,
  TENANT_DB_PORT: intFrom(5432),
  TENANT_DB_SUPERUSER: stringNonEmpty,
  TENANT_DB_SUPERUSER_PASSWORD: stringNonEmpty,
  TENANT_DB_SSL: boolLike.default(false),
  // Connection-budget guard. Postgres caps total connections (Render default
  // ~100). Worst case the API can open TENANT_POOL_LRU_MAX × TENANT_DB_POOL_MAX
  // connections at once, so these MUST multiply to well under the server's
  // max_connections (leaving headroom for workers + admin). Previous defaults
  // (50 × 15 = 750) blew past a 100-connection ceiling and caused "timeout
  // exceeded when trying to connect" pool-exhaustion outages. New defaults:
  // 10 × 4 = 40, comfortably under 100.
  TENANT_POOL_LRU_MAX: intFrom(10),
  TENANT_DB_POOL_MAX: intFrom(4),
  // Postgres kills any connection left "idle in transaction" longer than this
  // (ms), so a leaked/stuck transaction can't pin a pool slot forever. 0 = off.
  TENANT_DB_IDLE_TXN_TIMEOUT_MS: intFrom(30_000),
  TENANT_SECRET_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/u, 'TENANT_SECRET_ENCRYPTION_KEY must be 64 hex chars (256 bits)'),

  REDIS_URL: z.string().optional().default(''),
  QUEUE_DRIVER: z.enum(['bullmq', 'inprocess']).default('bullmq'),

  GCS_PROJECT_ID: stringNonEmpty,
  GCS_BUCKET: stringNonEmpty,
  GCS_KEY_FILE: z.string().optional().default(''),
  GCS_CREDENTIALS_JSON: z.string().optional().default(''),
  GCS_PUBLIC_BASE_URL: z.string().optional().default(''),
  GCS_SIGNED_URL_TTL_SECONDS: intFrom(300),

  BREVO_API_KEY: apiOnly(stringNonEmpty),
  BREVO_SENDER_EMAIL: apiOnly(z.string().email()),
  BREVO_SENDER_NAME: apiOnly(stringNonEmpty),
  BREVO_WEBHOOK_SECRET: apiOnly(stringNonEmpty),

  MESSAGECENTRAL_CUSTOMER_ID: apiOnly(stringNonEmpty),
  MESSAGECENTRAL_AUTH_TOKEN: apiOnly(stringNonEmpty),
  MESSAGECENTRAL_SENDER_ID: apiOnly(stringNonEmpty),
  MESSAGECENTRAL_COUNTRY_CODE: stringNonEmpty.default('91'),
  OTP_TTL_MINUTES: intFrom(5),
  OTP_MAX_ATTEMPTS: intFrom(3),

  // WhatsApp is now driven by the self-hosted whatsapp-web.js gateway
  // (per-user personal numbers), replacing the WABridge Business API.
  //   WA_GATEWAY_URL          API → gateway base (internal REST)
  //   WA_GATEWAY_PORT         gateway HTTP listen port
  //   WA_API_BASE_URL         gateway → API base for the /internal/wa/notify callback
  //   WA_GATEWAY_INTERNAL_SECRET  shared secret guarding both directions
  //   WA_PUPPETEER_EXECUTABLE_PATH  optional system Chromium (else bundled puppeteer)
  WA_GATEWAY_URL: z.string().optional().default('http://localhost:4100'),
  WA_GATEWAY_PORT: intFrom(4100),
  WA_API_BASE_URL: z.string().optional().default('http://localhost:4000/api/v1'),
  WA_GATEWAY_INTERNAL_SECRET: stringNonEmpty.default('dev-wa-internal-secret-change-me'),
  WA_PUPPETEER_EXECUTABLE_PATH: z.string().optional().default(''),
  // Persisted whatsapp-web.js RemoteAuth session blobs land in this GCS purpose
  // folder. Throttle how many Chromium clients we restore at once on boot.
  WA_SESSION_RESTORE_CONCURRENCY: intFrom(3),
  WA_SEND_RATE_PER_MINUTE: intFrom(20),

  RAZORPAY_KEY_ID: apiOnly(stringNonEmpty),
  RAZORPAY_KEY_SECRET: apiOnly(stringNonEmpty),
  RAZORPAY_WEBHOOK_SECRET: apiOnly(stringNonEmpty),

  EXOTEL_ACCOUNT_SID: apiOnly(stringNonEmpty),
  EXOTEL_API_KEY: apiOnly(stringNonEmpty),
  EXOTEL_API_TOKEN: apiOnly(stringNonEmpty),
  EXOTEL_SUBDOMAIN: stringNonEmpty.default('api.exotel.com'),
  EXOTEL_CALLER_ID: apiOnly(stringNonEmpty),
  EXOTEL_WEBHOOK_SECRET: apiOnly(stringNonEmpty),

  // Shared secret for the Android call-recorder app's device-upload endpoint
  // (POST /device-recordings). Sent by the device as the `X-Api-Key` header.
  // Optional: when unset, the device-upload endpoint rejects every request
  // (feature effectively off) rather than blocking server boot.
  DEVICE_UPLOAD_API_KEY: z.string().optional().default(''),

  // Counsellor recorder app login: when true the OTP is a fixed '1234' and no
  // message is sent. Flip to false to deliver real OTPs over WhatsApp — no app
  // or verify-path change needed (demo mode just stores the hash of '1234').
  MOBILE_OTP_DEMO: boolLike.default(true),

  // Platform-wide user-phone uniqueness. Soft rollout: while false, a phone
  // collision across tenants is logged but NOT rejected (existing data may
  // still have duplicates). Flip to true once backfill collisions are cleaned
  // up to start returning 409 on duplicate phones.
  PHONE_UNIQUENESS_ENFORCED: boolLike.default(false),

  // WABridge WhatsApp — used to send the phone-change OTP on the web profile.
  // baseUrl already includes /api; code appends /createmessage. When app/auth
  // keys are unset the OTP-send throws a clear "not configured" error.
  WABRIDGE_BASE_URL: z.string().optional().default('https://web.wabridge.com/api'),
  WABRIDGE_APP_KEY: z.string().optional().default(''),
  WABRIDGE_AUTH_KEY: z.string().optional().default(''),
  WABRIDGE_DEVICE_ID: z.string().optional().default(''),
  // Numeric template id for the OTP WhatsApp template (speedup_template).
  WABRIDGE_TEMPLATE_OTP: z.string().optional().default(''),

  // ── WhatsApp inbox (WABridge send + Meta Cloud API webhook receive) ──
  // Outbound goes through WABridge (above). Inbound + delivery status + media
  // download come from Meta's Cloud API webhook. All optional — the inbox
  // degrades gracefully when unset.
  //   WA_PHONE_NUMBER_ID       Meta WhatsApp phone-number id (for media download)
  //   WA_ACCESS_TOKEN          Meta long-lived access token
  //   WA_WEBHOOK_VERIFY_TOKEN  shared secret echoed on Meta's GET /webhook verify
  //   WA_API_VERSION           Graph API version
  //   WA_DEFAULT_TENANT_SLUG   tenant that owns inbound from unknown senders
  WA_PHONE_NUMBER_ID: z.string().optional().default(''),
  WA_ACCESS_TOKEN: z.string().optional().default(''),
  WA_WEBHOOK_VERIFY_TOKEN: z.string().optional().default('extraaedge-wa-webhook'),
  WA_API_VERSION: z.string().optional().default('v19.0'),
  WA_DEFAULT_TENANT_SLUG: z.string().optional().default('demo'),

  // Base URL of the admin/student web app — used to build absolute links (e.g.
  // the student set-password link) inside emails. (Brevo email keys are already
  // declared above: BREVO_API_KEY / BREVO_SENDER_EMAIL / BREVO_SENDER_NAME.)
  APP_WEB_URL: z.string().optional().default('http://localhost:5173'),

  RATE_LIMIT_GLOBAL_PER_MINUTE: intFrom(100),
  RATE_LIMIT_LOGIN_PER_15MIN: intFrom(10),
  RATE_LIMIT_PASSWORD_RESET_PER_HOUR: intFrom(3),

  AXIOM_API_TOKEN: z.string().optional().default(''),
  AXIOM_DATASET: z.string().optional().default(''),
  METRICS_ENABLED: boolLike.default(true),

  DEFAULT_TENANT_TIMEZONE: stringNonEmpty.default('Asia/Kolkata'),
  DEFAULT_TENANT_CURRENCY: stringNonEmpty.default('INR'),
  DEFAULT_TENANT_LANGUAGE: stringNonEmpty.default('en'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);

export const isProduction = () => env.NODE_ENV === 'production';
export const isDevelopment = () => env.NODE_ENV === 'development';

export const corsOrigins = () =>
  env.CORS_ORIGINS.split(',')
    // Strip whitespace AND stray literal escape sequences (a trailing "\n" —
    // backslash + n as two characters — can survive in an env value that was
    // exported/pasted with an encoded newline, and would make the last origin
    // never match). Trim real whitespace and any leading/trailing \r or \n
    // literals before comparing.
    .map((o) => o.trim().replace(/^(?:\\[rn])+|(?:\\[rn])+$/g, '').trim())
    .filter(Boolean);
