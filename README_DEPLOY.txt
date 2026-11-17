Guruvidya — Dynamic Day 3 / Day 2 / Day 1 WhatsApp Graphic (manual test only)

Apply BACKEND/server.js and BACKEND/booking/activation-dynamic-media.js to corresponding backend repository paths.
Use with previously deployed Day 3/2/1 REAL Manual Test ZIP (18 Nov); existing booking/activation-test/day1.png,day2.png,day3.png must remain in backend.
No Admin files changed. Existing static Admin graphic previews are NOT dynamic; live WhatsApp test images are dynamic.
Uses sharp (already in backend package.json). Uses one configured existing secret: SMART_REMINDER_ACTION_SECRET, SMART_REMINDER_TOKEN_SECRET, BOOKING_LINK_SECRET, GV_BOOKING_ACTION_SECRET, or JWT_SECRET (>=24 characters). Set SMART_REMINDER_ACTION_SECRET to a strong random value if none is configured.
Signed media links expire after 15 minutes. BotSailor must fetch the URL within that window; media URL is deliberately not logged in full.
No automatic dispatch is enabled. Existing 4h/2h/1h and 4h approved template unchanged.
IMPORTANT: This is a code-level change. Test on a verified OPEN-window test number and inspect WhatsApp image before production use.
The green CTA inside original artwork is graphical, not a native WhatsApp reply button. Sending a real interactive reply button is a separate integration.
