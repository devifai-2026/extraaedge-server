// Payroll arithmetic. A PURE function: structure + units + attendance in,
// components out. No database, no clock, no I/O — so it can be reasoned about
// and tested with fixtures, which matters because a bug here is money.
//
// Money is handled as integer PAISE internally and converted back at the edge.
// Doing it in rupees with floats lets 0.1 + 0.2 style drift accumulate until
// gross stops equalling the sum of its components.

const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
const toRupees = (paise) => Number((paise / 100).toFixed(2));

// Half-up at a SINGLE point, so gross always equals the sum of the parts.
const pct = (basePaise, percent) => Math.round((basePaise * Number(percent || 0)) / 100);

/**
 * @param {object} input
 *   components      [{ code, name, kind, calc_type, amount, percent, rate, units, affects_lop }]
 *   workingDays     days in the payroll month the employee was expected to work
 *   lopDays         unpaid days (absent without leave, or unpaid leave)
 *   slabsFor        (code, units) => { amount_per_unit, flat_amount } | null
 */
export const computePayslip = ({ components = [], workingDays = 30, lopDays = 0, slabsFor = () => null }) => {
  const lines = [];

  // ---- 1. fixed earnings, and the basic they key off ----------------------
  const basicRow = components.find((c) => c.code === 'BASIC');
  const basicFull = toPaise(basicRow?.amount ?? 0);

  // ---- 2. LOP applies only to heads that opted in -------------------------
  // A per-unit earning (an extra class actually taught) is NOT reduced by
  // unpaid days — the work happened. Only the standing salary is pro-rated.
  const payableRatio = workingDays > 0
    ? Math.max(0, (workingDays - lopDays)) / workingDays
    : 1;

  const proRate = (paise, affectsLop) => (affectsLop ? Math.round(paise * payableRatio) : paise);

  let grossPaise = 0;
  let deductionPaise = 0;

  for (const c of components) {
    const affectsLop = c.affects_lop !== false;
    let valuePaise = 0;
    let detail = {};

    switch (c.calc_type) {
      case 'percent_of_basic':
        valuePaise = pct(basicFull, c.percent ?? c.amount ?? 0);
        detail = { percent: Number(c.percent ?? c.amount ?? 0), of: 'BASIC' };
        break;

      case 'per_unit': {
        // The trainer case: 500 x 3 extra classes = 1500.
        const units = Number(c.units ?? c.default_units ?? 0);
        const rate = toPaise(c.rate ?? c.amount ?? 0);
        valuePaise = Math.round(rate * units);
        detail = { units, rate: toRupees(rate) };
        break;
      }

      case 'incentive_slab': {
        // The sales case: N admissions resolved against a slab table.
        const units = Number(c.units ?? 0);
        const slab = slabsFor(c.code, units);
        if (slab) {
          valuePaise = toPaise(slab.flat_amount) + Math.round(toPaise(slab.amount_per_unit) * units);
          detail = { units, per_unit: Number(slab.amount_per_unit || 0), flat: Number(slab.flat_amount || 0) };
        } else {
          // No slab configured -> fall back to the component's own rate, so a
          // half-configured tenant still pays something explicable rather than
          // silently zero.
          const rate = toPaise(c.rate ?? c.amount ?? 0);
          valuePaise = Math.round(rate * units);
          detail = { units, rate: toRupees(rate), slab: 'none' };
        }
        break;
      }

      case 'percent_of_gross':
        // Deferred: resolved after gross is known, below.
        lines.push({ ...c, _deferred: true, detail: { percent: Number(c.percent ?? 0), of: 'GROSS' } });
        continue;

      case 'fixed':
      default:
        valuePaise = toPaise(c.amount ?? c.default_value ?? 0);
        break;
    }

    const finalPaise = c.kind === 'earning' ? proRate(valuePaise, affectsLop) : valuePaise;
    if (c.kind === 'earning') grossPaise += finalPaise;
    else if (c.kind === 'deduction') deductionPaise += finalPaise;

    lines.push({
      code: c.code,
      name: c.name,
      kind: c.kind,
      calc_type: c.calc_type,
      amount: toRupees(finalPaise),
      ...detail,
      ...(affectsLop && c.kind === 'earning' && lopDays > 0
        ? { pro_rated: true, payable_ratio: Number(payableRatio.toFixed(4)) }
        : {}),
    });
  }

  // ---- 3. percent-of-gross heads, now that gross is known -----------------
  for (const l of lines) {
    if (!l._deferred) continue;
    const v = pct(grossPaise, l.percent ?? 0);
    l.amount = toRupees(v);
    l.kind = l.kind || 'deduction';
    if (l.kind === 'earning') grossPaise += v; else deductionPaise += v;
    delete l._deferred;
  }

  // ---- 4. LOP shown as an explicit line, not a silent shrink --------------
  // The pro-rating above already removed the money; this line exists so the
  // payslip SAYS why gross is lower, which is the first thing anyone queries.
  if (lopDays > 0) {
    lines.push({
      code: 'LOP_INFO',
      name: 'Loss of Pay (days)',
      kind: 'info',
      calc_type: 'per_unit',
      amount: 0,
      units: lopDays,
      note: `${lopDays} unpaid day(s) of ${workingDays}`,
    });
  }

  return {
    components: lines,
    gross_earnings: toRupees(grossPaise),
    total_deductions: toRupees(deductionPaise),
    net_pay: toRupees(grossPaise - deductionPaise),
    working_days: workingDays,
    lop_days: lopDays,
    payable_ratio: Number(payableRatio.toFixed(4)),
  };
};

export default computePayslip;
