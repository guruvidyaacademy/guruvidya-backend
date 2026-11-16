Guruvidya CRM Phase 3 — Meta button action links (limited patch)
Baseline: 16 Nov 2026 7:25 PM backend.
Changed files: server.js; booking/meta-whatsapp-webhook.js
Scope: recorded Meta manual-test Reschedule and Cancel clicks attempt to send existing signed open-action links through BotSailor text sender, after matching exact test/recipient/booking. No booking mutation on click.
NOT IMPLEMENTED: Yes/No stage-specific confirmation and final locks. Do not consider this a full finished workflow.
Checks: node --check on both JS files; existing Meta recognition tests passed. Live provider/database integration NOT tested.
Deploy only after review, preserving existing Render environment. Check GV META SMART ACTION LINK logs; accepted:true indicates provider accepted, not delivery.
