// Build 27: fail-closed preflight for future private-link WhatsApp delivery.
// This module deliberately does NOT call the generic CRM template sender: it
// persists template variables and provider responses in integration logs.
import { URL } from 'node:url';

export function bookingLinkDeliveryPreflight(config = {}) {
  const reasons=[];
  if (config.enabled !== true) reasons.push('delivery_disabled');
  if (!config.recipientVerified) reasons.push('recipient_not_verified');
  if (!config.recipientOptedIn) reasons.push('recipient_opt_in_missing');
  if (!config.templateApproved) reasons.push('approved_url_button_template_missing');
  if (!config.buttonParameterVerified) reasons.push('url_button_parameter_unverified');
  if (!config.privateSenderVerified) reasons.push('token_redacted_sender_unverified');
  if (!config.providerCallbackVerified) reasons.push('provider_receipt_handling_unverified');
  try {
    const origin=new URL(config.publicOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') reasons.push('invalid_public_origin');
  } catch { reasons.push('invalid_public_origin'); }
  return {ready:reasons.length===0,reasons};
}

// Do not build/send a private URL here until the provider's URL-button semantics
// and the end-to-end token-redaction path have been verified in staging.
export function requireBookingLinkDeliveryReady(config) {
  const check=bookingLinkDeliveryPreflight(config);
  if (!check.ready) throw new Error('Booking link delivery blocked: '+check.reasons.join(','));
  return true;
}
