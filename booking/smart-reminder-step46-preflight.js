// Step 46: OFFLINE preflight only. Unmounted. Never starts a scheduler, SQL, or transport.
const HOLD = Object.freeze({ready:false,activationAllowed:false,sent:0,deleted:0,reason:'integration_hold'});
const required = ['booking','claim','delivery'];
const validStages = new Set(['4h','2h','1h','5min']);
const validChannels = new Set(['whatsapp','email']);
const validRecipients = new Set(['student','parent']);
const activeStatuses = new Set(['requested','approved','confirmed','rescheduled']);
export function reviewSchedulerDeliveryBoundary(input={}) {
  const reasons=[];
  for(const key of required) if(!input[key] || typeof input[key] !== 'object') reasons.push(`missing_${key}`);
  const {booking,claim,delivery}=input;
  if (booking && claim && delivery) {
    const equal=(...values)=>values.every(v=>v!=null && String(v)===String(values[0]));
    if (!equal(booking.id,claim.bookingId,delivery.booking_id) ||
        !equal(booking.appointment_revision,claim.revision,delivery.appointment_revision) ||
        !equal(claim.recipient,delivery.recipient_type) ||
        !equal(claim.stage,delivery.stage) || !equal(claim.channel,delivery.channel)) reasons.push('identity_mismatch');
    if(!validStages.has(claim.stage) || !validChannels.has(claim.channel) || !validRecipients.has(claim.recipient)) reasons.push('invalid_dimension');
    if(claim.stage==='5min' && (claim.mode!=='online'||booking.mode!=='online')) reasons.push('invalid_online_stage');
    if(booking.trashed_at!=null || !activeStatuses.has(String(booking.status).toLowerCase())) reasons.push('inactive_booking');
    if(!Number.isFinite(Date.parse(booking.starts_at)) || Date.parse(booking.starts_at)!==Date.parse(claim.expectedStartsAt)) reasons.push('appointment_time_mismatch');
    if(delivery.status!=='claimed') reasons.push('invalid_delivery_status');
    if(claim.status!=='claimed') reasons.push('invalid_claim_status');
  }
  if(input.migrationVerified!==true) reasons.push('migration_unverified');
  if(input.providerVerified!==true) reasons.push('provider_unverified');
  // Always HOLD even when caller asserts all checks verified.
  return {...HOLD,reasons:Object.freeze([...new Set(reasons)])};
}
export function reviewMigrationUpgradeEvidence(evidence={}) {
  const checks=['live_schema_inventory','versioned_upgrade_script','foreign_keys_verified','index_duplicates_checked','backfill_verified','rollback_reviewed','postgres_transaction_tests'];
  return {...HOLD,blockers:Object.freeze(checks.filter(k=>evidence[k]!==true)),reason:'migration_review_only'};
}
export async function disabledSchedulerToDelivery() {return {...HOLD};}
