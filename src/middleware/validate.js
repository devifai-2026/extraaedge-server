import { validationError } from '../lib/errors.js';

// Usage: router.post('/x', validate({ body: leadCreateSchema, params: idSchema }), handler)
export const validate = ({ body, params, query, headers } = {}) => (req, _res, next) => {
  try {
    if (body) req.body = body.parse(req.body ?? {});
    if (params) req.params = params.parse(req.params ?? {});
    if (query) req.query = query.parse(req.query ?? {});
    if (headers) headers.parse(req.headers);
    next();
  } catch (err) {
    if (err?.issues) {
      const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return next(validationError(details));
    }
    next(err);
  }
};
