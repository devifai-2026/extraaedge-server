// Speedup Hiring — business rules. Internal staff recruitment.
import * as repo from './repo.js';
import { notFound, validationError } from '../../lib/errors.js';

export * from './repo.js';

// ---------- import parsing ----------
// The source sheets are hand-kept, so every parser here has to survive the
// real mess: blank cells, "17,000/-", dd/mm/yy AND dd/mm/yyyy in the same
// column, and one row where the phone cell contains a name.

// dd/mm/yy or dd/mm/yyyy → ISO date. Two-digit years are 20xx: the data is
// recruitment activity, which is never historical enough to mean 19xx.
export const parseDate = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const iso = `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};

// "4.00 PM" + a date → timestamptz. Time is optional; a date alone still
// yields a usable scheduled_at.
export const parseDateTime = (dateVal, timeVal) => {
  const d = parseDate(dateVal);
  if (!d) return null;
  if (!timeVal) return `${d}T00:00:00`;
  const s = String(timeVal).trim().toUpperCase().replace(/\./g, ':');
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!m) return `${d}T00:00:00`;
  let h = Number(m[1]);
  const min = m[2] ?? '00';
  const ap = m[3];
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return `${d}T${String(h).padStart(2, '0')}:${min}:00`;
};

export const parseExperience = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('fresher')) return 'fresher';
  if (s.startsWith('exp')) return 'experienced';
  return null;
};

export const parseMode = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('online') || s.includes('virtual')) return 'online';
  if (s.startsWith('tele') || s.includes('phone')) return 'telephonic';
  if (s.includes('person') || s.includes('office') || s.includes('walk')) return 'in_person';
  return null;
};

// Resolve a free-text status name against the tenant's configured list.
// Unknown names are NOT auto-created: statuses are a deliberate configuration
// and a typo in a spreadsheet should not quietly become a new pipeline stage.
const statusResolver = (statuses) => {
  const byName = new Map(statuses.map((s) => [s.name.trim().toLowerCase(), s.id]));
  return (name) => {
    const s = String(name ?? '').trim().toLowerCase();
    if (!s) return { id: null, unknown: null };
    const id = byName.get(s);
    return id ? { id, unknown: null } : { id: null, unknown: String(name).trim() };
  };
};

// ---------- candidate import ----------
// Returns a per-row verdict rather than throwing: the recruiter needs to see
// which rows are bad and why, the same as the lead importer's failure report.
export const previewCandidates = async (tenant, { rows, position_id }) => {
  if (!Array.isArray(rows) || !rows.length) throw validationError('No rows to import');
  const statuses = await repo.listStatuses(tenant, { includeInactive: true });
  const resolve = statusResolver(statuses);
  const positions = await repo.listPositions(tenant);
  const posByTitle = new Map(positions.map((p) => [p.title.trim().toLowerCase(), p.id]));

  const ok = [];
  const failed = [];
  const unknownStatuses = new Set();

  rows.forEach((raw, i) => {
    const rowNo = i + 1;
    const name = String(raw.name ?? '').trim();
    const phoneRaw = String(raw.phone ?? '').trim();
    const key = repo.personKey(phoneRaw);

    if (!name) { failed.push({ row: rowNo, reason: 'Name is required', data: raw }); return; }
    // A phone that does not parse is surfaced, never silently dropped — in the
    // sample data one row has a NAME in the contact column.
    if (phoneRaw && !key) {
      failed.push({ row: rowNo, reason: `"${phoneRaw}" is not a usable phone number`, data: raw });
      return;
    }

    const posId = position_id
      ?? posByTitle.get(String(raw.position ?? '').trim().toLowerCase())
      ?? null;
    if (!posId) {
      failed.push({ row: rowNo, reason: `Unknown position "${raw.position ?? ''}"`, data: raw });
      return;
    }

    const st = resolve(raw.status);
    if (st.unknown) unknownStatuses.add(st.unknown);

    ok.push({
      position_id: posId,
      contacted_on: parseDate(raw.contacted_on),
      name,
      phone: phoneRaw || null,
      email: String(raw.email ?? '').trim() || null,
      location: String(raw.location ?? '').trim() || null,
      highest_qualification: String(raw.highest_qualification ?? '').trim() || null,
      stream: String(raw.stream ?? '').trim() || null,
      experience_level: parseExperience(raw.experience_level),
      current_area: String(raw.current_area ?? '').trim() || null,
      current_salary: repo.parseMoney(raw.current_salary),
      expected_salary: repo.parseMoney(raw.expected_salary),
      notice_period: String(raw.notice_period ?? '').trim() || null,
      status_id: st.id,
      remark: String(raw.remark ?? '').trim() || null,
      remark_2: String(raw.remark_2 ?? '').trim() || null,
    });
  });

  // Flag which valid rows will UPDATE rather than insert, so the preview can
  // say "12 new, 3 updates" instead of implying everything is new. Done after
  // the loop because the check hits the DB and the loop above is synchronous.
  for (const r of ok) {
    const existing = await repo.findByPersonKey(tenant, repo.personKey(r.phone), r.position_id);
    r._duplicate = Boolean(existing);
  }

  return {
    valid: ok.length,
    new_rows: ok.filter((r) => !r._duplicate).length,
    updates: ok.filter((r) => r._duplicate).length,
    failed,
    unknown_statuses: [...unknownStatuses],
    rows: ok,
  };
};

export const importCandidates = async (tenant, actor, { rows, position_id }) => {
  const preview = await previewCandidates(tenant, { rows, position_id });
  if (!preview.rows.length) {
    throw validationError('Nothing to import — every row failed validation');
  }
  const res = await repo.commitCandidates(tenant, preview.rows, actor?.id);
  return { ...res, failed: preview.failed, unknown_statuses: preview.unknown_statuses };
};

// ---------- interview import ----------
export const previewInterviews = async (tenant, { rows, position_id }) => {
  if (!Array.isArray(rows) || !rows.length) throw validationError('No rows to import');
  const statuses = await repo.listStatuses(tenant, { includeInactive: true });
  const resolve = statusResolver(statuses);
  const positions = await repo.listPositions(tenant);
  const posByTitle = new Map(positions.map((p) => [p.title.trim().toLowerCase(), p.id]));

  const ok = [];
  const failed = [];
  const unknownStatuses = new Set();

  rows.forEach((raw, i) => {
    const rowNo = i + 1;
    const name = String(raw.name ?? '').trim();
    const phoneRaw = String(raw.phone ?? '').trim();
    if (!name) { failed.push({ row: rowNo, reason: 'Name is required', data: raw }); return; }
    if (phoneRaw && !repo.personKey(phoneRaw)) {
      failed.push({ row: rowNo, reason: `"${phoneRaw}" is not a usable phone number`, data: raw });
      return;
    }
    const st = resolve(raw.status);
    if (st.unknown) unknownStatuses.add(st.unknown);
    ok.push({
      name,
      phone: phoneRaw || null,
      position_id: position_id
        ?? posByTitle.get(String(raw.position ?? '').trim().toLowerCase())
        ?? null,
      scheduled_at: parseDateTime(raw.interview_date, raw.interview_time),
      mode: parseMode(raw.mode),
      status_id: st.id,
      remark_1: String(raw.remark_1 ?? '').trim() || null,
      remark_2: String(raw.remark_2 ?? '').trim() || null,
    });
  });

  return {
    valid: ok.length, failed, unknown_statuses: [...unknownStatuses], rows: ok,
  };
};

export const importInterviews = async (tenant, actor, { rows, position_id }) => {
  const preview = await previewInterviews(tenant, { rows, position_id });
  if (!preview.rows.length) {
    throw validationError('Nothing to import — every row failed validation');
  }
  const res = await repo.commitInterviews(tenant, preview.rows, actor?.id);
  return { ...res, failed: preview.failed, unknown_statuses: preview.unknown_statuses };
};

// ---------- candidate status move ----------
export const setCandidateStatus = async (tenant, actor, id, { status_id, note }) => {
  const current = await repo.getCandidate(tenant, id);
  if (!current) throw notFound('Candidate not found');
  if (current.status_id === status_id) return current;
  await repo.updateCandidate(tenant, id, { status_id });
  await repo.recordStatusChange(tenant, {
    candidate_id: id,
    from_status_id: current.status_id,
    to_status_id: status_id,
    note,
    changed_by: actor?.id ?? null,
  });
  return repo.getCandidate(tenant, id);
};
