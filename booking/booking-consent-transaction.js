// Build 61: transaction boundary for a trusted consent-collection integration.
// The caller must supply authenticated actor, trusted booking loader, and a verifier
// that atomically consumes independently issued one-time evidence using this client.
// This is NOT a public endpoint, OTP issuer, or authorization implementation.
import {collectBookingConsent,revokeBookingConsent} from './booking-consent-service.js';

function requireFn(value,name) { if(typeof value!=='function') throw Error(name+'_required'); }
function requireId(value) { if(!Number.isSafeInteger(value)||value<1) throw Error('invalid_booking'); }
async function transaction(pool,work) {
  if(!pool || typeof pool.connect!=='function') throw Error('database_pool_required');
  const client=await pool.connect();
  let began=false;
  try {
    await client.query('BEGIN'); began=true;
    const result=await work(client);
    await client.query('COMMIT'); began=false;
    return result;
  } catch(err) {
    if(began) { try { await client.query('ROLLBACK'); } catch { /* preserve original error */ } }
    throw err;
  } finally { client.release(); }
}
export async function collectConsentTransaction({pool,actor,input,loadBookingForUpdate,consumeEvidence}={}) {
  requireFn(loadBookingForUpdate,'booking_loader');
  requireFn(consumeEvidence,'evidence_consumer');
  requireId(input?.bookingId);
  if (!actor || actor.authenticated !== true || typeof actor.id !== 'string' || !actor.id.length) throw Error('authentication_required');
  return transaction(pool,async client=> {
    // Lock booking before verification; verifier must consume evidence in this transaction.
    const booking=await loadBookingForUpdate(client,input.bookingId,actor);
    return collectBookingConsent({db:client,actor,booking,input,
      verifyEvidence:args=>consumeEvidence(client,args)});
  });
}
export async function revokeConsentTransaction({pool,actor,bookingId,kind,loadBookingForUpdate,authorizeRevocation}={}) {
  requireFn(loadBookingForUpdate,'booking_loader');
  requireFn(authorizeRevocation,'revocation_authorizer');
  requireId(bookingId);
  if (!actor || actor.authenticated !== true || typeof actor.id !== 'string' || !actor.id.length) throw Error('authentication_required');
  return transaction(pool,async client=> {
    const booking=await loadBookingForUpdate(client,bookingId,actor);
    return revokeBookingConsent({db:client,actor,booking,bookingId,kind,
      authorizeRevocation:args=>authorizeRevocation(client,args)});
  });
}
