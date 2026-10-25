// Step 42 offline-only composition. NOT imported by server, scheduler, or webhook routes.
import {authorizeCallbackEnvelope,mapTrustedClick,retentionBatchPlan} from './smart-reminder-callback-safety.js';
import {validateProviderIdentity,validateResolvedProviderEvent} from './smart-reminder-delivery-state-contract.js';
const HOLD=Object.freeze({skipped:true,reason:'provider_contract_unverified',sent:0,deleted:0});
const EVENT_ID=/^[A-Za-z0-9_.:-]{1,200}$/;
export function reviewTrustedCallback({raw,signature,secret,providerVerified=false,enabled=false,identity,resolvedDelivery,event}={}) {
  // Never enable provisional signature verification until BotSailor contract is independently verified.
  if(!providerVerified)return {...HOLD};
  const auth=authorizeCallbackEnvelope({raw,signature,secret,providerVerified,enabled});
  if(!auth.ok)return {skipped:true,reason:auth.reason,sent:0,deleted:0};
  validateProviderIdentity(identity);
  if(!resolvedDelivery || typeof resolvedDelivery!=='object')throw new Error('trusted_delivery_lookup_required');
  validateResolvedProviderEvent(identity,resolvedDelivery);
  if(!event || !EVENT_ID.test(event.providerEventId||''))throw new Error('invalid_provider_event_id');
  const click=mapTrustedClick({verifiedEnvelope:auth,providerMessageId:identity.providerMessageId,providerEventId:event.providerEventId,buttonKey:event.buttonKey,clickedAt:event.clickedAt,resolvedDelivery:{...resolvedDelivery,providerMessageId:identity.providerMessageId}});
  // Validation only: no INSERT, no HTTP, no provider calls.
  return {skipped:true,reason:'ingestion_unmounted',sent:0,deleted:0,validated:true,click};
}
export function reviewRetention({limit=100,schemaVerified=false,enabled=false}={}) {
  return retentionBatchPlan({limit,schemaVerified,enabled});
}
export function deliveryHold(){return {skipped:true,reason:'delivery_hold',sent:0,deleted:0};}
