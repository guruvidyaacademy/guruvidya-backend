// Build 37: bounded, read-only operational summary. No recipient data or dispatch.
const STATES=['blocked','ready','sending','accepted','delivered','failed','unknown','cancelled'];
export function validateSummaryLimit(limit=1000){
 if(!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new Error('invalid_summary_limit');
 return limit;
}
export async function summarizeBookingLinkDelivery(pool,{limit=1000}={}){
 validateSummaryLimit(limit);
 // Bound the source rows, not only the output. The report is a sample, not a global count.
 const result=await pool.query(`SELECT id, status FROM booking_private_link_outbox ORDER BY id DESC LIMIT $1`,[limit]);
 const counts=Object.fromEntries(STATES.map(s=>[s,0]));
 for(const row of result.rows){
  const status=STATES.includes(row.status)?row.status:'unknown';
  counts[status]++;
 }
 return {sampled:result.rows.length,limit,counts,
  requiresManualReview:counts.sending+counts.unknown+counts.failed,
  // Provider acceptance is not customer delivery.
  confirmedDelivered:counts.delivered,
  incomplete:result.rows.length===limit};
}
