// Build 47: bounded, read-only, privacy-safe booking notification monitoring.
// No admin route, credentials, dispatch or provider callback is enabled here.
const STATES = Object.freeze(['blocked','ready','sending','accepted','delivered','read','failed','unknown','cancelled']);
const STATE_SET = new Set(STATES);
export function validateMonitorOptions({limit=100,afterId=0}={}) {
  if (!Number.isSafeInteger(limit)||limit<1||limit>100) throw Error('invalid_monitor_limit');
  if (!Number.isSafeInteger(afterId)||afterId<0) throw Error('invalid_monitor_cursor');
  return Object.freeze({limit,afterId});
}
export async function bookingNotificationMonitor(pool, options={}) {
  const {limit,afterId}=validateMonitorOptions(options);
  if (!pool||typeof pool.query!=='function') throw Error('invalid_monitor_database');
  // Select ONLY safe columns. Never fetch recipient numbers, private URLs or tokens.
  const result=await pool.query('SELECT id, status FROM booking_private_link_outbox WHERE id>$1 ORDER BY id ASC LIMIT $2',[afterId,limit+1]);
  const rows=result?.rows;
  if (!Array.isArray(rows)||rows.length>limit+1) throw Error('invalid_monitor_result');
  for (let i=0;i<rows.length;i++) {
    const row=rows[i];
    if (!row||!Number.isSafeInteger(row.id)||row.id<=afterId||(i&&row.id<=rows[i-1].id)||typeof row.status!=='string') throw Error('invalid_monitor_result');
  }
  const page=rows.slice(0,limit);
  const counts=Object.fromEntries(STATES.map(s=>[s,0]));
  for(const row of page) counts[STATE_SET.has(row.status)?row.status:'unknown']++;
  return Object.freeze({sampled:page.length,counts:Object.freeze(counts),nextAfterId:page.length?page[page.length-1].id:afterId,hasMore:rows.length>limit,requiresManualReview:counts.sending+counts.failed+counts.unknown,providerAcceptedNotDelivered:counts.accepted,snapshotOnly:true,dispatchEnabled:false,scope:'page_only'});
}
