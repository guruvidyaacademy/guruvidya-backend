// Isolated private-link sender. Never use the generic CRM template sender here:
// it records template variables and provider responses in integration logs.
import { requireBookingLinkDeliveryReady } from './booking-link-delivery.js';

const MOBILE = /^[6-9][0-9]{9}$/;
const REF = /^[A-Za-z0-9_-]{6,80}$/;
const TOKEN = /^[A-Za-z0-9_-]{24,256}$/;

export function createPrivateBookingLink({publicOrigin, bookingRef, token}) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/')
    throw new Error('Invalid booking public origin');
  if (!REF.test(bookingRef) || !TOKEN.test(token)) throw new Error('Invalid booking link parameters');
  // The fragment is not sent to the web server in HTTP requests. Treat it as a
  // bearer credential nonetheless: never put this URL in logs or analytics.
  return `${origin.origin}/booking#${new URLSearchParams({ref:bookingRef,token}).toString()}`;
}

// The caller must verify the exact template's button parameter semantics with
// the provider in staging. No provider API shape is assumed by this module.
// The injected transport MUST be independently reviewed for token redaction.
export async function sendPrivateBookingLink({config, recipient, bookingRef, token, transport}) {
  requireBookingLinkDeliveryReady(config);
  if (typeof transport !== 'function') throw new Error('Private booking transport not configured');
  if (recipient?.verified !== true || recipient?.optedIn !== true || !MOBILE.test(String(recipient?.mobile || '')))
    throw new Error('Booking recipient authorization failed');
  const url = createPrivateBookingLink({publicOrigin:config.publicOrigin,bookingRef,token});
  try {
    // Deliberately no provider response, URL, token, mobile, or exception text
    // in the returned result. Caller must never persist raw transport payloads.
    const outcome = await transport({mobile:`91${recipient.mobile}`,url,templateId:config.templateId});
    return {status:outcome?.accepted === true ? 'accepted' : 'unknown',
      note:'Provider acceptance is not delivery; uncertain outcomes require manual review.'};
  } catch {
    return {status:'unknown',note:'Provider outcome uncertain; do not automatically retry.'};
  }
}
