import pino from 'pino';
import { env, isProduction } from '../config/env.js';
import { SENSITIVE_HEADER_KEYS } from '../config/constants.js';

const redactPaths = [
  ...SENSITIVE_HEADER_KEYS.map((h) => `req.headers["${h}"]`),
  'req.body.password',
  'req.body.current_password',
  'req.body.new_password',
  'req.body.otp',
  'req.body.refresh_token',
  '*.password',
  '*.password_hash',
  '*.refresh_token',
  '*.refresh_token_hash',
  '*.credentials_encrypted',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'extraaedge-backend', env: env.NODE_ENV },
  redact: { paths: redactPaths, remove: true },
  transport:
    !isProduction() && env.LOG_PRETTY
      ? { target: 'pino-pretty', options: { colorize: true, singleLine: false, translateTime: 'SYS:HH:MM:ss.l' } }
      : undefined,
});

export const childLogger = (bindings) => logger.child(bindings);
