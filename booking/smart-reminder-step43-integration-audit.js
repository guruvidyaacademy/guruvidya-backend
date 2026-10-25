// Step 43: isolated, unmounted, no-side-effect integration preflight.
// It NEVER invokes scheduler, claim, delivery writer, retention or webhook code.
import { SMART_REMINDER_DELIVERY_ENABLED } from './smart-reminder-step10-bridge.js';
import { validateHandoffIdentity } from './smart-reminder-claim-delivery-handoff.js';
import { validateProviderIdentity } from './smart-reminder-delivery-state-contract.js';
import { retentionBatchPlan } from './smart-reminder-callback-safety.js';
const HOLD = Object.freeze({ready:false, claimed:0, linked:0, sent:0, deleted:0});
const stages = new Set(['4h','2h','1h','5min']);
export function auditIntegrationPlan({booking, claim, delivery, providerIdentity, migrationVerified=false, providerContractVerified=false, masterEnabled=false, schedulerEnabled=false, transportEnabled=false}={}) {
  const reasons=[];
  if (!migrationVerified) reasons.push('migration_unverified');
  if (!providerContractVerified) reasons.push('provider_contract_unverified');
  if (!masterEnabled) reasons.push('master_off');
  if (!schedulerEnabled) reasons.push('scheduler_hold');
  if (!transportEnabled || SMART_REMINDER_DELIVERY_ENABLED !== true) reasons.push('transport_hold');
  if (!booking || !claim || !delivery) reasons.push('missing_trusted_records');
  else {
    try { validateHandoffIdentity(claim); } catch { reasons.push('invalid_claim_identity'); }
    const tuple = [
      [booking.id, claim.bookingId, delivery.booking_id],
      [booking.appointment_revision, claim.revision, delivery.appointment_revision],
      [claim.recipient, delivery.recipient_type],
      [claim.stage, delivery.stage],
      [claim.channel, delivery.channel]
    ];
    if (tuple.some(group => group.some(v => v == null || String(v) !== String(group[0])))) reasons.push('identity_mismatch');
    if (claim.stage === '5min' && (claim.mode !== 'online' || booking.mode !== 'online')) reasons.push('invalid_online_stage');
    if (!stages.has(claim.stage)) reasons.push('invalid_stage');
    if (booking.trashed_at || ['cancelled','canceled','completed'].includes(String(booking.status).toLowerCase())) reasons.push('inactive_booking');
    if (Date.parse(booking.starts_at) !== Date.parse(claim.expectedStartsAt) || !Number.isFinite(Date.parse(booking.starts_at))) reasons.push('appointment_time_mismatch');
    if (delivery.status !== 'claimed') reasons.push('unexpected_delivery_state');
  }
  if (providerIdentity != null) {
    try { validateProviderIdentity(providerIdentity); } catch { reasons.push('invalid_provider_identity'); }
    if (delivery && (providerIdentity.providerAccountId !== delivery.provider_account_id || providerIdentity.providerMessageId !== delivery.provider_message_id || providerIdentity.channel !== delivery.channel)) reasons.push('provider_identity_mismatch');
  }
  return {...HOLD, reasons:[...new Set(reasons)], reason:'integration_hold'};
}
export function auditRetentionPlan({limit=100}={}) {
  // Force disabled: even external environment flags cannot activate deletion.
  const plan=retentionBatchPlan({limit,enabled:false,schemaVerified:false});
  return {...HOLD,reason:plan.reason,limit,requiresPostgresFkVerification:true};
}
export async function runDisabledIntegration() { return {...HOLD,reason:'integration_hold'}; }
