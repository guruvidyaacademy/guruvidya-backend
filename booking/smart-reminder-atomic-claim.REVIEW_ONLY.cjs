'use strict';
// REVIEW-ONLY isolated coordinator. This module is NOT mounted in server.js.
// Never sends a message, and is disabled by default. DB interactions require a
// deliberately supplied client (tests supply an in-memory mock).
const allowedStatuses = new Set(['requested','approved','confirmed','rescheduled']);
const channels = new Set(['whatsapp','email']);
const recipients = new Set(['student','parent']);
const stages = new Set(['4h','2h','1h','5min']);
const HOLD = Object.freeze({claimed:false, sent:0, reason:'transport_hold'});
function validate(x) {
  if (!Number.isSafeInteger(x?.bookingId)||x.bookingId<1 || !Number.isSafeInteger(x?.revision)||x.revision<1) throw Error('invalid_identity');
  if (!channels.has(x.channel)||!recipients.has(x.recipient)||!stages.has(x.stage)) throw Error('invalid_claim_dimension');
  if (!['online','offline'].includes(x.mode)|| (x.stage==='5min'&&x.mode!=='online')) throw Error('invalid_mode');
  if (!Number.isFinite(Date.parse(x.expectedStartsAt))) throw Error('invalid_start');
}
async function reviewClaimWithClient(client, x, {masterEnabled=false, migrationVerified=false, now=Date.now()}={}) {
  if (!masterEnabled || !migrationVerified) return {claimed:false,sent:0,reason:'disabled_or_migration_unverified'};
  validate(x);
  let begun=false;
  try {
    await client.query('BEGIN'); begun=true;
    // Match booking writer ordering: booking-scoped advisory lock BEFORE row lock.
    if (x.bookingId > 2147483647) throw Error('invalid_booking_lock_id');
    await client.query('SELECT pg_advisory_xact_lock($1,$2)',[75201948,x.bookingId]);
    const r=await client.query('SELECT id, appointment_revision, starts_at, status, mode, trashed_at FROM student_bookings WHERE id=$1 FOR UPDATE',[x.bookingId]);
    const b=r.rows?.[0];
    if (!b || b.trashed_at != null || !allowedStatuses.has(String(b.status).toLowerCase()) || b.appointment_revision!==x.revision || Date.parse(b.starts_at)!==Date.parse(x.expectedStartsAt) || Date.parse(b.starts_at)<=now || b.mode!==x.mode) {
      await client.query('ROLLBACK'); begun=false;
      return {claimed:false,sent:0,reason:'stale_or_ineligible'};
    }
    const insert=await client.query(`INSERT INTO booking_smart_reminder_claims
      (booking_id,appointment_revision,recipient,channel,stage,mode,status)
      VALUES ($1,$2,$3,$4,$5,$6,'claimed')
      ON CONFLICT (booking_id,appointment_revision,recipient,channel,stage)
      DO NOTHING RETURNING id`,[x.bookingId,x.revision,x.recipient,x.channel,x.stage,x.mode]);
    await client.query('COMMIT'); begun=false;
    // No dispatch. Claim creation is a bookkeeping operation only.
    return {claimed:insert.rowCount===1,sent:0,reason:insert.rowCount===1?'claimed_delivery_disabled':'duplicate'};
  } catch(e) {
    if(begun) { try {await client.query('ROLLBACK');} catch (_) {} }
    throw e;
  }
}
async function deliveryDisabledCoordinator(pool,x,opts={}) {
  // Unconditional transport hold: never touch the database in this callable entrypoint.
  return {...HOLD};
}
module.exports={validate,reviewClaimWithClient,deliveryDisabledCoordinator};
