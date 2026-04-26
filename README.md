# Guruvidya CRM Backend - Phase 3

## Features
- Central Integration Panel API
- BotSailor WhatsApp settings
- Enable/disable WhatsApp
- Test API endpoint
- Action Panel WhatsApp trigger connected
- Logs system
- Future-ready entries: Razorpay, YouTube, MyOperator, AI API

## Setup
```bash
npm install
cp .env.example .env
npm run dev
```

## Main APIs
- GET `/api/integrations`
- PUT `/api/integrations/botsailor`
- POST `/api/integrations/botsailor/test`
- GET `/api/integrations/logs/all`
- POST `/api/actions/whatsapp/send`
