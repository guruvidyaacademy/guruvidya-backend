// Operational state only. Enabled means dispatcher is configured, not that a message was delivered.
export function bookingDeliveryState(env = process.env) {
  const id = String(env.BOOKING_REMINDER_TEMPLATE_ID || '');
  const reviewed = String(env.BOOKING_REMINDER_STATIC_TEMPLATE_REVIEWED_ID || '');
  const requested = env.BOOKING_REMINDER_DELIVERY_ENABLED === 'true';
  const templateConfigured = /^[\w-]{1,100}$/.test(id);
  const reviewedIdMatches = templateConfigured && reviewed === id;
  return {
    whatsapp_dispatch_requested: requested,
    whatsapp_dispatch_configured: requested && templateConfigured && reviewedIdMatches,
    template_id_configured: templateConfigured,
    static_template_review_id_matches: reviewedIdMatches,
    email_delivery_enabled: false,
    booking_admin_alert_push_enabled: false,
    note: 'Configured does not mean approved-template metadata passed, provider accepted, or handset delivered. Inspect per-message status and provider receipts.'
  };
}
