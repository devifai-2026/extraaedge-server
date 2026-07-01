// Phone-number normalization shared across lead matching.
//
// The canonical match key is the LAST 10 DIGITS of a number with all non-digit
// characters stripped. This mirrors:
//   - the `leads_unique_phone_digits` UNIQUE index
//     (migration 1700000052000_leads_unique_phone_guard.cjs), and
//   - the app-level dedup in modules/leads/repo.js (`last10Digits`).
// Keep this identical to those so "+91 98765-43210" and "9876543210" collide.
//
// The matching SQL expression that pairs with this is:
//   right(regexp_replace(coalesce(<col>,''), '\D', '', 'g'), 10) = $1
export const last10Digits = (v) => {
  const d = String(v ?? '').replace(/\D+/g, '');
  return d.length > 10 ? d.slice(-10) : d;
};
