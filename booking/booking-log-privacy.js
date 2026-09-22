// Privacy helper for legacy booking_delivery_logs.detail. No provider delivery.
// Remove only fields that clearly contain recipient contact details; preserve audit metadata.
const contactKey = /^(?:student|parent|recipient|customer|guardian)?_?(?:mobile|phone|phone_number|mobile_number|whatsapp|email|email_address)$/i;
const contactKeys = new Set(['studentmobile','parentmobile','recipientmobile','customermobile','guardianmobile','studentphone','parentphone','recipientphone','studentemail','parentemail','recipientemail']);
export function scrubBookingDetail(value) {
  if (Array.isArray(value)) return value.map(scrubBookingDetail);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !contactKey.test(key) && !contactKeys.has(key.toLowerCase().replace(/[_-]/g,'')))
      .map(([key, entry]) => [key, scrubBookingDetail(entry)]));
  }
  return value;
}
export function sanitizeBookingDetail(raw) {
  if (typeof raw !== 'string') return {changed:false, value:raw, parseable:false};
  let parsed;
  try { parsed=JSON.parse(raw); } catch { return {changed:false,value:raw,parseable:false}; }
  if (!parsed || typeof parsed !== 'object') return {changed:false,value:raw,parseable:true};
  const sanitized=JSON.stringify(scrubBookingDetail(parsed));
  return {changed:JSON.stringify(parsed)!==sanitized,value:sanitized,parseable:true};
}
