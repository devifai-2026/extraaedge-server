import { logger } from '../lib/logger.js';
import { isAppError } from '../lib/errors.js';
import { RESPONSE_CODES } from '../config/constants.js';

export const notFoundHandler = (req, res) => {
  res.status(404).json({
    error: { code: RESPONSE_CODES.NOT_FOUND, message: `No route ${req.method} ${req.path}` },
    meta: { requestId: req.id },
  });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, _next) => {
  const requestId = req.id;
  if (isAppError(err)) {
    if (err.status >= 500) {
      logger.error({ requestId, err: err.message, details: err.details, code: err.code }, 'app error');
    } else {
      logger.debug({ requestId, code: err.code, status: err.status }, 'client error');
    }
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
      meta: { requestId },
    });
  }
  logger.error({ requestId, err: err.message, stack: err.stack }, 'unhandled error');
  return res.status(500).json({
    error: { code: RESPONSE_CODES.INTERNAL, message: 'Internal server error' },
    meta: { requestId },
  });
};
