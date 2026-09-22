// Build 77: opt-in trusted staging adapter. No OTP issuance, public routes or dispatch.
// The integrator must authenticate actor and authorize booking access in loadBookingForUpdate.
import {collectConsentTransaction,revokeConsentTransaction} from './booking-consent-transaction.js';
import {consumeBookingConsentEvidence} from './booking-consent-evidence-store.js';

function requireStaging(context) {
  if (context?.environment !== 'staging' || context?.stagingConfirmed !== true ||
      context?.whatsappDispatchEnabled !== false) throw Error('staging_consent_gate_required');
}
function requireTrustedLoader(loader) {
  if (typeof loader !== 'function') throw Error('authorized_booking_loader_required');
}
export async function collectStagingBookingConsent({context,pool,actor,input,loadBookingForUpdate}={}) {
  requireStaging(context);
  requireTrustedLoader(loadBookingForUpdate);
  return collectConsentTransaction({pool,actor,input,loadBookingForUpdate,
    consumeEvidence:consumeBookingConsentEvidence});
}
export async function revokeStagingBookingConsent({context,pool,actor,bookingId,kind,loadBookingForUpdate,authorizeRevocation}={}) {
  requireStaging(context);
  requireTrustedLoader(loadBookingForUpdate);
  if (typeof authorizeRevocation !== 'function') throw Error('revocation_authorizer_required');
  return revokeConsentTransaction({pool,actor,bookingId,kind,loadBookingForUpdate,authorizeRevocation});
}
