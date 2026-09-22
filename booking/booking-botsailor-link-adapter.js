// Build 29: opt-in BotSailor transport boundary for private booking URL buttons.
// The endpoint and payload builder MUST be verified against the account's actual
// approved template/button configuration. Never pass this through CRM logging.
import { sendPrivateBookingLink } from './booking-private-link-sender.js';

const TEMPLATE_ID=/^[A-Za-z0-9_-]{1,100}$/;
const HTTPS_URL=/^https:\/\//i;

export function createBotSailorBookingLinkTransport({endpoint, apiToken, instanceId, templateId, buildPayload, fetchImpl=globalThis.fetch, timeoutMs=10000}) {
  if (!HTTPS_URL.test(String(endpoint||''))) throw Error('HTTPS BotSailor endpoint required');
  const parsed=new URL(endpoint);
  if (parsed.username||parsed.password||parsed.hash||parsed.search||!['botsailor.com','www.botsailor.com'].includes(parsed.hostname)) throw Error('Unapproved BotSailor endpoint');
  if (!apiToken || !instanceId || !TEMPLATE_ID.test(String(templateId||''))) throw Error('Provider credentials/template missing');
  if (typeof buildPayload!=='function' || typeof fetchImpl!=='function') throw Error('Verified template payload builder and transport required');
  if (!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000) throw Error('Invalid timeout');
  return async ({mobile,url,templateId:requestedTemplate})=>{
    if(requestedTemplate!==templateId) throw Error('Template mismatch');
    // Builder must map the URL to the exact approved dynamic URL button.
    // The caller is responsible for independently verifying this mapping.
    const payload=buildPayload({mobile,url,templateId,instanceId,apiToken});
    if (!payload || typeof payload!=='object' || Array.isArray(payload)) throw Error('Invalid provider payload');
    const response=await fetchImpl(parsed.toString(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
    // HTTP 2xx is transport acceptance only, not proof of WhatsApp delivery.
    // Do not read or log response bodies: they may echo private button variables.
    return {accepted:response.status>=200 && response.status<300};
  };
}

// No route or scheduler invokes this automatically. All flags must be independently
// verified by the operator; credentials and management tokens must stay server-side.
export async function sendBotSailorBookingManagementLink({config,recipient,bookingRef,token,provider}) {
  const transport=createBotSailorBookingLinkTransport(provider);
  return sendPrivateBookingLink({config,recipient,bookingRef,token,transport});
}
