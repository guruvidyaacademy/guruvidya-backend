GURUVIDYA SMART REMINDERS — 4H EMAIL DESIGN PATCH (LIMITED SCOPE)

Changed backend files:
- server.js (only new isolated HTML builder, logo route and 4h manual EMAIL HTML selection)
- booking/smart-reminder-original-logo.png (exact original uploaded logo)

This is NOT the complete cross-channel confirmation or live 2h/1h dispatch integration.
The 4h manual EMAIL test now has the approved premium HTML appearance and reuses the existing booking email footer/social URLs.
IMPORTANT: This safe design-only patch intentionally does NOT render attendance/reschedule/cancel buttons in the manual email until verified email-scoped secure action handling is implemented. Do not claim they work.
The existing 4h WhatsApp flow and all other booking flows are unchanged.

DEPLOYMENT HOLD: This server.js is based on the 8 Nov 1:13 AM full backend. Before deploying, compare/merge it with the CURRENT GitHub server.js to avoid overwriting changes made after that baseline. Do NOT blindly replace server.js. Keep Master Automation OFF.

Validation: node --check server.js passed. No live provider or database integration tests performed.
