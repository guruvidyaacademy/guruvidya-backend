// Build 72: explicit opt-in boundary for a staging-only BotSailor delivery trial.
// This does not create a route, job, provider payload, or production dispatch switch.
// The caller must independently verify consent and the approved provider template.
const allowed = new Set(['staging']);
export function createStagingBookingDispatchGate({ environment, stagingConfirmed, approvedTemplateVerified, consentVerified, recipientVerified, dispatchEnabled, transport }) {
  if (!allowed.has(environment) || stagingConfirmed !== true || approvedTemplateVerified !== true ||
      consentVerified !== true || recipientVerified !== true || dispatchEnabled !== true || typeof transport !== 'function') {
    throw new Error('Staging booking dispatch prerequisites not satisfied');
  }
  return async ({ mobile, url, templateId }) => {
    if (!/^91[6-9][0-9]{9}$/.test(String(mobile)) || !/^[A-Za-z0-9_-]{1,100}$/.test(String(templateId)))
      throw new Error('Invalid recipient or template');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid booking link'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search ||
        parsed.pathname !== '/booking' || parsed.hash.length < 2)
      throw new Error('Invalid booking link');
    // Return only an acceptance boolean. Never expose provider response or private URL.
    const result = await transport({mobile,url,templateId});
    return Object.freeze({accepted: result?.accepted === true});
  };
}
