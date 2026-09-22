// Build 35: bounded, explicitly invoked maintenance. Never sends or unblocks messages.
import { reconcileBlockedBookingIntents } from './booking-link-outbox-reconcile.js';

export function validateMaintenanceLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_maintenance_limit');
  return limit;
}

// Scan only blocked rows; do not expose recipient details or private links.
// A per-booking reconciliation transaction rechecks current booking and consent.
// The cursor is an outbox id, not a booking id, so a large booking cannot starve others.
export async function reconcileBlockedIntentBatch(pool, {afterId=0, limit=25, now=new Date()}={}) {
  validateMaintenanceLimit(limit);
  if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('invalid_maintenance_cursor');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('invalid_maintenance_time');
  const found=await pool.query(`SELECT id, booking_id FROM booking_private_link_outbox
    WHERE status='blocked' AND id>$1 ORDER BY id LIMIT $2`,[afterId,limit]);
  const rows=found.rows;
  const bookingIds=[...new Set(rows.map(row=>Number(row.booking_id)))];
  let cancelled=0,retained=0;
  for (const bookingId of bookingIds) {
    if (!Number.isSafeInteger(bookingId) || bookingId < 1) throw new Error('invalid_outbox_booking_id');
    const result=await reconcileBlockedBookingIntents(pool,bookingId,{now});
    cancelled+=result.cancelled;
    retained+=result.retained;
  }
  return {scanned:rows.length,bookings:bookingIds.length,cancelled,retained,
    nextCursor:rows.length?Number(rows[rows.length-1].id):afterId,
    hasMore:rows.length===limit};
}
