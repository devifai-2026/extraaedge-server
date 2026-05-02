// Generic condition/action JSON evaluator — pure functions, unit-testable.
// Shape:
//   condition_json: { all?: [clause], any?: [clause] }
//   clause: { field: 'lead.stage_name', op: 'eq'|'neq'|'in'|'not_in'|'gt'|'gte'|'lt'|'lte'|'contains'|'exists'|'not_exists', value: <any> }
//   action_json: [{ type: 'assign'|'notify'|'send_message'|'schedule_follow_up'|'add_score'|'set_field', ... }]

const getPath = (ctx, path) => {
  const parts = String(path).split('.');
  let cur = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
};

const cmp = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  not_in: (a, b) => Array.isArray(b) && !b.includes(a),
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  contains: (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase().includes(b.toLowerCase()),
  exists: (a) => a !== undefined && a !== null && a !== '',
  not_exists: (a) => a === undefined || a === null || a === '',
};

const evaluateClause = (clause, ctx) => {
  const fn = cmp[clause.op];
  if (!fn) return false;
  const value = getPath(ctx, clause.field);
  return fn(value, clause.value);
};

export const evaluateCondition = (condition, ctx) => {
  if (!condition || typeof condition !== 'object') return true;
  const { all, any } = condition;
  let ok = true;
  if (Array.isArray(all) && all.length) ok = ok && all.every((c) => evaluateClause(c, ctx));
  if (Array.isArray(any) && any.length) ok = ok && any.some((c) => evaluateClause(c, ctx));
  return ok;
};

export const ACTIONS = {
  assign: 'assign',
  notify: 'notify',
  send_message: 'send_message',
  schedule_follow_up: 'schedule_follow_up',
  add_score: 'add_score',
  set_field: 'set_field',
  add_tag: 'add_tag',
};

// Parse the action list and expand dynamic tokens like {lead.id} into concrete values from ctx.
export const materializeActions = (actions, ctx) => {
  if (!Array.isArray(actions)) return [];
  const sub = (v) => {
    if (typeof v !== 'string') return v;
    return v.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, k) => {
      const x = getPath(ctx, k);
      return x === undefined ? '' : String(x);
    });
  };
  return actions.map((a) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(a)) out[k] = sub(v);
    return out;
  });
};
