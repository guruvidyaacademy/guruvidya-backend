// Build 36: bounded, privacy-safe operator review of notification intents.
// Read-only by design: no implicit release of blocked intents or provider calls.
const STATES = Object.freeze(['blocked','ready','sending','accepted','delivered','failed','unknown','cancelled']);
export function validateReviewPage({afterId=0,limit=25}={}) {
  if (!Number.isSafeInteger(afterId)||afterId<0) throw new Error('invalid_review_cursor');
  if (!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('invalid_review_limit');
  return {afterId,limit};
}
export function safeDeliveryState(status) {
  return STATES.includes(status)?status:'unknown';
}
export async function reviewBookingLinkDelivery(pool,options={}) {
  const {afterId,limit}=validateReviewPage(options);
  const result=await pool.query(`SELECT id, booking_id, kind, event, status
    FROM booking_private_link_outbox WHERE id>$1 ORDER BY id LIMIT $2`,[afterId,limit]);
  const rows=result.rows.map(row=>({
    id:Number(row.id),bookingId:Number(row.booking_id),
    recipientKind:row.kind==='parent'?'parent':'student',
    event:['created','approved','confirmed','rescheduled'].includes(row.event)?row.event:'unknown',
    status:safeDeliveryState(row.status)
  }));
  return {rows,nextCursor:rows.length?rows.at(-1).id:afterId,hasMore:rows.length===limit,
    // Provider acceptance does not prove customer delivery.
    deliveryConfirmed:rows.filter(row=>row.status==='delivered').length,
    needsReview:rows.filter(row=>['unknown','sending','failed'].includes(row.status)).length};
}
