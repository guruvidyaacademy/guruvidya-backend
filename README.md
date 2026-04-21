# Guruvidya Next Level Backend

## Added in this version
- Admin actions on leads / admissions / appointments / support / faculty
- Botsailor service stub
- Push notification service stub
- Status update APIs
- Notes / owner assignment
- Alerts feed

## Run
```bash
npm install
npm start
```

## Main APIs
### Admin data
- GET /api/admin/leads
- GET /api/admin/admissions
- GET /api/admin/appointments
- GET /api/admin/support
- GET /api/admin/faculty
- GET /api/admin/alerts

### Admin actions
- POST /api/admin/leads/:id/action
- POST /api/admin/admissions/:id/action
- POST /api/admin/appointments/:id/action
- POST /api/admin/support/:id/action
- POST /api/admin/faculty/:id/action

### Automation
- POST /api/automation/send-whatsapp
- POST /api/automation/send-push
- GET /api/automation/settings
- POST /api/automation/settings
