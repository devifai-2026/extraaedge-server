// {{Lead.FullName}} | {{Counsellor.Name}} | {{Tenant.CompanyName}} | %Lead.Email%
// Supports both Mustache-style {{ }} and legacy percent-style %Key%.

const PERCENT_RE = /%([A-Za-z][A-Za-z0-9_.]*)%/g;
const MUSTACHE_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g;

const getPath = (ctx, path) => {
  const parts = path.split('.');
  let cur = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    // Allow case-insensitive lookup on first-level keys: `Lead.FullName` -> ctx.lead.fullName
    const keyExact = p;
    const keyLower = p.toLowerCase();
    const keySnake = p.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    cur = cur[keyExact] ?? cur[keyLower] ?? cur[keySnake];
  }
  return cur;
};

export const render = (template, context) => {
  if (!template) return '';
  const missing = new Set();
  const resolve = (_match, key) => {
    const v = getPath(context, key);
    if (v === undefined || v === null) {
      missing.add(key);
      return '';
    }
    return String(v);
  };
  const out = template.replace(MUSTACHE_RE, resolve).replace(PERCENT_RE, resolve);
  return { rendered: out, missing: [...missing] };
};

export const extractVariables = (template) => {
  if (!template) return [];
  const set = new Set();
  template.replace(MUSTACHE_RE, (_m, k) => set.add(k));
  template.replace(PERCENT_RE, (_m, k) => set.add(k));
  return [...set];
};

// Context shape expected by the renderer. Workers populate this per message.
export const buildContext = ({ lead, counsellor, tenant, program, campaign, extra = {} }) => ({
  Lead: lead
    ? {
        FullName: lead.name,
        FirstName: lead.first_name,
        LastName: lead.last_name,
        Email: lead.email,
        Phone: lead.phone,
        WhatsApp: lead.whatsapp_number,
        City: lead.city,
        State: lead.state,
        Program: program?.name,
        Stage: lead.stage_name,
      }
    : {},
  Counsellor: counsellor
    ? { Name: counsellor.name, Email: counsellor.email, Phone: counsellor.phone }
    : {},
  Tenant: tenant
    ? { Name: tenant.name, CompanyName: tenant.company_name, LogoUrl: tenant.logo_url, Website: tenant.website }
    : {},
  Program: program || {},
  Campaign: campaign || {},
  ...extra,
});
