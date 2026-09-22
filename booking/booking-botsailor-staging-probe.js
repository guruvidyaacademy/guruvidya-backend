// Build 60: read-only staging connectivity probe. Never sends a WhatsApp message.
// Caller supplies a verified, non-dispatching BotSailor endpoint and credentials.
// Do not pass booking tokens, phone numbers or customer records to this probe.
const HOSTS = new Set(['botsailor.com', 'www.botsailor.com']);
// A read-only probe must never contact a message-send endpoint, even with GET.
const UNSAFE_SEGMENTS = /(?:^|\/)(?:send|dispatch|broadcast|campaign|message|messages|template-send|trigger|flow|webhook|delete|update|create)(?:\/|$)/i;
export function createBookingBotSailorStagingProbe({ endpoint, apiToken, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  const url = new URL(endpoint);
  // Reject encoded separators, dot segments and encoded unsafe verbs before any network access.
  // URL normalization alone must not turn a dispatch path into an apparently safe read-only path.
  const rawPath = url.pathname;
  let decodedPath;
  try { decodedPath = decodeURIComponent(rawPath); } catch { throw new Error('Invalid staging probe path'); }
  const unsafeEncoding = /%(?:2f|5c|2e|25|3f|23)/i.test(rawPath);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || !rawPath.startsWith('/api/') || unsafeEncoding || /\\/.test(decodedPath) || UNSAFE_SEGMENTS.test(decodedPath))
    throw new Error('Verified HTTPS BotSailor read-only API endpoint required');
  if (typeof apiToken !== 'string' || !apiToken.trim() || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000)
    throw new Error('Invalid staging probe configuration');
  return async () => {
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      });
      // Never parse or log provider response: it may contain account/customer data.
      const status = Number(response?.status);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('Invalid provider status');
      const ok = status >= 200 && status < 300;
      return Object.freeze({ reachable: ok, authenticated: ok, statusClass: Math.floor(status / 100) });
    } catch {
      return Object.freeze({ reachable: false, authenticated: false, statusClass: null });
    }
  };
}
