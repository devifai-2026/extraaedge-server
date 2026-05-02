import { RESPONSE_CODES } from '../config/constants.js';

// Functional error factories — no class hierarchies.
// Use `throw appError(...)` in services; `middleware/error.js` maps them to HTTP.

export const appError = ({ status = 500, code = RESPONSE_CODES.INTERNAL, message = 'Internal error', details = undefined, cause = undefined } = {}) => {
  const err = new Error(message);
  err.isAppError = true;
  err.status = status;
  err.code = code;
  err.details = details;
  if (cause) err.cause = cause;
  return err;
};

export const validationError = (details) =>
  appError({ status: 400, code: RESPONSE_CODES.VALIDATION_FAILED, message: 'Validation failed', details });

export const unauthenticated = (message = 'Authentication required') =>
  appError({ status: 401, code: RESPONSE_CODES.UNAUTHENTICATED, message });

export const forbidden = (message = 'Forbidden', details = undefined) =>
  appError({ status: 403, code: RESPONSE_CODES.FORBIDDEN, message, details });

export const notFound = (message = 'Resource not found', details = undefined) =>
  appError({ status: 404, code: RESPONSE_CODES.NOT_FOUND, message, details });

export const conflict = (message, details = undefined) =>
  appError({ status: 409, code: RESPONSE_CODES.CONFLICT, message, details });

export const concurrentModification = (currentUpdatedAt) =>
  appError({
    status: 409,
    code: RESPONSE_CODES.CONCURRENT_MODIFICATION,
    message: 'The record was modified by someone else. Refresh and retry.',
    details: { current_updated_at: currentUpdatedAt },
  });

export const rateLimited = (retryAfterSeconds) =>
  appError({
    status: 429,
    code: RESPONSE_CODES.RATE_LIMITED,
    message: 'Too many requests',
    details: { retry_after_seconds: retryAfterSeconds },
  });

export const duplicateDetected = (matches) =>
  appError({
    status: 409,
    code: RESPONSE_CODES.DUPLICATE_DETECTED,
    message: 'A lead with the same phone or email already exists',
    details: { matches },
  });

export const fieldReadonly = (fields) =>
  appError({
    status: 403,
    code: RESPONSE_CODES.FIELD_READONLY,
    message: 'One or more fields are read-only for your role',
    details: { fields },
  });

export const sessionIdle = () =>
  appError({
    status: 401,
    code: RESPONSE_CODES.SESSION_IDLE,
    message: 'Session idle timeout exceeded — please log in again',
  });

export const tenantSuspended = () =>
  appError({
    status: 403,
    code: RESPONSE_CODES.TENANT_SUSPENDED,
    message: 'This tenant is suspended',
  });

export const tenantNotFound = () =>
  appError({
    status: 404,
    code: RESPONSE_CODES.TENANT_NOT_FOUND,
    message: 'Tenant not found or inactive',
  });

export const notImplemented = (message = 'Not implemented yet') =>
  appError({ status: 501, code: RESPONSE_CODES.NOT_IMPLEMENTED, message });

export const noOptin = (channel, lead_id) =>
  appError({
    status: 403,
    code: RESPONSE_CODES.NO_OPTIN,
    message: `Lead has not opted in to ${channel}`,
    details: { channel, lead_id },
  });

export const suppressed = (channel, address) =>
  appError({
    status: 403,
    code: RESPONSE_CODES.SUPPRESSED,
    message: 'Recipient is on the suppression list',
    details: { channel, address },
  });

export const isAppError = (err) => err && err.isAppError === true;
