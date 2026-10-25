// Step 35: UNMOUNTED provider-neutral contract. No HTTP route, DB execution or sends.
import {verifySignedRawPayload, validateClickEvent} from './smart-reminder-click-ingestion.js';
const MAX_BATCH = 100;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
export function authorizeCallbackEnvelope({raw,signature,secret,providerVerified=false,enabled=false}={}) {
  if (!enabled || process.env.GV_SMART_REMINDER_CALLBACK_MAPPING !== 'enabled') return {ok:false,reason:'callback_hold'};
  if (!providerVerified) return {ok:false,reason:'provider_contract_unverified'};
  if (!verifySignedRawPayload(raw,signature,secret)) return {ok:false,reason:'signature_invalid'};
  return {ok:true};
}
export function mapTrustedClick({verifiedEnvelope, providerMessageId, providerEventId, buttonKey, clickedAt, resolvedDelivery}={}) {
  if (!verifiedEnvelope?.ok) throw new Error('Callback not authenticated');
  if (typeof providerMessageId !== 'string' || !KEY_RE.test(providerMessageId)) throw new Error('Invalid provider message ID');
  if (!resolvedDelivery || resolvedDelivery.providerMessageId !== providerMessageId || !Number.isSafeInteger(resolvedDelivery.id) || resolvedDelivery.id < 1) throw new Error('Trusted delivery lookup required');
  // Caller-supplied deliveryId is never used; resolvedDelivery must come from a server-side lookup.
  return validateClickEvent({deliveryId:resolvedDelivery.id,providerEventId,buttonKey,clickedAt});
}
export function retentionBatchPlan({limit=100, schemaVerified=false, enabled=false}={}) {
  if (!enabled || process.env.GV_SMART_REMINDER_RETENTION_CLEANUP !== 'enabled') return {skipped:true,reason:'retention_hold',deleted:0};
  if (!schemaVerified) return {skipped:true,reason:'migration_unverified',deleted:0};
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) throw new Error('Invalid retention batch limit');
  // Return a review-only plan, NEVER execute SQL here.
  return {skipped:true,reason:'execution_hold',deleted:0,limit,requires:['dedicated transaction','ordered row locking','FK cascade verification','post-migration approval']};
}
