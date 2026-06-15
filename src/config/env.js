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

const schema = z.object({
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
  TENANT_POOL_LRU_MAX: intFrom(50),
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

  BREVO_API_KEY: stringNonEmpty,
  BREVO_SENDER_EMAIL: z.string().email(),
  BREVO_SENDER_NAME: stringNonEmpty,
  BREVO_WEBHOOK_SECRET: stringNonEmpty,

  MESSAGECENTRAL_CUSTOMER_ID: stringNonEmpty,
  MESSAGECENTRAL_AUTH_TOKEN: stringNonEmpty,
  MESSAGECENTRAL_SENDER_ID: stringNonEmpty,
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

  RAZORPAY_KEY_ID: stringNonEmpty,
  RAZORPAY_KEY_SECRET: stringNonEmpty,
  RAZORPAY_WEBHOOK_SECRET: stringNonEmpty,

  EXOTEL_ACCOUNT_SID: stringNonEmpty,
  EXOTEL_API_KEY: stringNonEmpty,
  EXOTEL_API_TOKEN: stringNonEmpty,
  EXOTEL_SUBDOMAIN: stringNonEmpty.default('api.exotel.com'),
  EXOTEL_CALLER_ID: stringNonEmpty,
  EXOTEL_WEBHOOK_SECRET: stringNonEmpty,

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
    .map((o) => o.trim())
    .filter(Boolean);
