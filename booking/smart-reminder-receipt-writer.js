// Step 41: UNMOUNTED, disabled by default. No provider calls or automatic database access.
import {validateProviderIdentity,validateResolvedProviderEvent,proposeDeliveryTransition} from './smart-reminder-delivery-state-contract.js';
const HOLD=Object.freeze({updated:false,sent:0,reason:'receipt_writer_hold'});
const statusField=Object.freeze({sent:'sent_at',delivered:'delivered_at',read:'read_at',opened:'opened_at',clicked:'clicked_at'});
const allowedByChannel=Object.freeze({whatsapp:new Set(['sent','delivered','read','clicked']),email:new Set(['sent','delivered','opened','clicked'])});
const eventRank=Object.freeze({sent:1,delivered:2,read:3,opened:3,clicked:4});
export function disabledReceiptWriter(){return {...HOLD};}
export async function reviewReceiptWithClient(client,identity,receipt,{enabled=false,migrationVerified=false,providerVerified=false}={}) {
  if(!enabled || !migrationVerified || !providerVerified)return {...HOLD};
  // Fail closed before any transaction or provider lookup; never trust caller-provided identity.
  validateProviderIdentity(identity);
  if(!client || typeof client.query!=='function')throw new Error('missing_transaction_client');
  if(!receipt || !Object.hasOwn(statusField,receipt.to) || !allowedByChannel[identity.channel].has(receipt.to))throw new Error('unsupported_receipt_state');
  if(typeof receipt.eventAt!=='string' || !Number.isFinite(Date.parse(receipt.eventAt)))throw new Error('invalid_event_timestamp');
  let active=false;
  try {
    await client.query('BEGIN');active=true;
    const r=await client.query(`SELECT id,booking_id AS "bookingId",appointment_revision AS "appointmentRevision",recipient_type AS "recipientType",stage,channel,provider_account_id AS "providerAccountId",provider_message_id AS "providerMessageId",status,sent_at,delivered_at,read_at,opened_at,clicked_at FROM booking_smart_reminder_deliveries WHERE channel=$1 AND provider_account_id=$2 AND provider_message_id=$3 FOR UPDATE`,[identity.channel,identity.providerAccountId,identity.providerMessageId]);
    if(r.rows?.length!==1){await client.query('ROLLBACK');active=false;return {updated:false,sent:0,reason:'unresolved_provider_receipt'};}
    const row=r.rows[0];validateResolvedProviderEvent(identity,{...row,mode:identity.mode});
    const field=statusField[receipt.to];
    const eventMs=typeof receipt.eventAt==='string'?Date.parse(receipt.eventAt):NaN;
    if(!Number.isFinite(eventMs))throw new Error('invalid_event_timestamp');
    const previous=row[field];
    if(previous!=null && !Number.isFinite(Date.parse(previous)))throw new Error('invalid_stored_timestamp');
    const sameState=row.status===receipt.to;
    if(sameState && previous!=null && eventMs<=Date.parse(previous)){
      await client.query('COMMIT');active=false;return {updated:false,sent:0,reason:'duplicate_or_stale_receipt'};
    }
    // A later-ranked state cannot be overwritten by a delayed earlier receipt.
    if(eventRank[row.status]!=null && eventRank[receipt.to]<eventRank[row.status]){
      await client.query('COMMIT');active=false;return {updated:false,sent:0,reason:'stale_state_receipt'};
    }
    if(!sameState)proposeDeliveryTransition({channel:identity.channel,from:row.status,to:receipt.to,eventAt:receipt.eventAt,previousAt:previous});
    // No receipt may predate the latest already-recorded channel milestone.
    const milestones=identity.channel==='whatsapp'?['sent_at','delivered_at','read_at','clicked_at']:['sent_at','delivered_at','opened_at','clicked_at'];
    const latest=Math.max(...milestones.map(k=>row[k]==null?-Infinity:Date.parse(row[k])));
    if(Number.isNaN(latest))throw new Error('invalid_stored_timestamp');
    if(eventMs<latest){await client.query('COMMIT');active=false;return {updated:false,sent:0,reason:'out_of_order_receipt'};}
    const updated=await client.query(`UPDATE booking_smart_reminder_deliveries SET status=$2, ${field}=CASE WHEN ${field} IS NULL THEN $3::timestamptz ELSE GREATEST(${field},$3::timestamptz) END,updated_at=NOW() WHERE id=$1 RETURNING id`,[row.id,receipt.to,new Date(eventMs).toISOString()]);
    if(updated.rowCount!==1)throw new Error('receipt_update_conflict');
    await client.query('COMMIT');active=false;
    return {updated:true,sent:0,reason:'receipt_recorded_review_only'};
  }catch(err){if(active){try{await client.query('ROLLBACK')}catch{}}throw err;}
}
