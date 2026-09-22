// Build 52: opt-in, fail-closed BotSailor template transport preparation.
// This module does not install a route, schedule dispatch, or enable WhatsApp.
import { requireBookingTemplateMapping } from './booking-template-mapping.js';
import { createBotSailorBookingLinkTransport } from './booking-botsailor-link-adapter.js';

const MOBILE = /^91[6-9][0-9]{9}$/;
const HTTPS = /^https:\/\//i;

/**
 * Only use a payload builder independently verified against the account's
 * approved template in staging. Never send payloads through generic CRM logs.
 * A dynamic URL button must preserve the private fragment in the actual
 * WhatsApp link; provider URL suffix rewriting must be verified in staging.
 */
export function createApprovedBookingTransport({ mapping, provider, verifiedPayloadBuilder, stagingApproval }) {
  const approved = requireBookingTemplateMapping(mapping, provider?.templateId);
  if (stagingApproval !== true || typeof verifiedPayloadBuilder !== 'function')
    throw Error('Staging-approved provider payload builder required');
  if (provider?.buildPayload !== undefined)
    throw Error('Use verifiedPayloadBuilder instead of an unchecked provider builder');
  const buildPayload = ({mobile,url,templateId,instanceId,apiToken}) => {
    if (!MOBILE.test(String(mobile)) || !HTTPS.test(String(url)) || templateId !== approved.templateId)
      throw Error('Invalid private booking delivery parameters');
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.protocol !== 'https:' || parsed.search ||
        parsed.hash.length < 2 || parsed.pathname !== '/booking')
      throw Error('Invalid private booking link');
    const payload = verifiedPayloadBuilder({mobile,url,templateId,instanceId,apiToken,
      buttonIndex:approved.buttonIndex,variableMode:approved.variableMode});
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw Error('Invalid approved provider payload');
    return payload;
  };
  return createBotSailorBookingLinkTransport({...provider,buildPayload});
}
