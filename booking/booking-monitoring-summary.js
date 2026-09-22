// Read-only database-wide aggregate. No customer fields are queried or returned.
export const MONITOR_STATES = Object.freeze(['queued','sending','accepted','delivered','read','failed','unknown','blocked']);
export async function getBookingMonitoringSummary(pool) {
  if (!pool || typeof pool.query !== 'function') throw new Error('invalid_monitor_database');
  // PostgreSQL COUNT returns bigint; avoid ::integer overflow on large tables.
  const result = await pool.query('SELECT status, COUNT(*) AS total FROM booking_delivery_logs GROUP BY status');
  if (!Array.isArray(result?.rows)) throw new Error('invalid_monitor_result');
  const counts = Object.fromEntries(MONITOR_STATES.map(state => [state, 0]));
  let other = 0;
  const seen = new Set();
  for (const row of result.rows) {
    const raw = row?.total;
    if (!(typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) &&
        !(typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw))) throw new Error('invalid_monitor_result');
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || typeof row?.status !== 'string' || !row.status.trim() || seen.has(row.status)) throw new Error('invalid_monitor_result');
    seen.add(row.status);
    if (Object.hasOwn(counts, row.status)) counts[row.status] += n;
    else other += n;
    if (!Number.isSafeInteger(Object.hasOwn(counts, row.status) ? counts[row.status] : other)) throw new Error('invalid_monitor_result');
  }
  const total = Object.values(counts).reduce((a,b)=>a+b,other);
  const manualReview = counts.sending+counts.unknown+counts.failed;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(manualReview)) throw new Error('invalid_monitor_result');
  return {counts, other, total, manualReview, scope:'all_booking_delivery_logs', providerAcceptedIsNotDelivered:true, dispatchEnabledByThisEndpoint:false};
}
