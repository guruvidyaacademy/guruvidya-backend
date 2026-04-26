const mongoose = require('mongoose');

const integrationLogSchema = new mongoose.Schema({
  integrationKey: { type: String, required: true },
  channel: { type: String, default: 'whatsapp' },
  event: { type: String, required: true },
  status: { type: String, enum: ['success', 'failed', 'info'], default: 'info' },
  requestPayload: { type: Object, default: {} },
  responsePayload: { type: Object, default: {} },
  message: { type: String, default: '' },
  source: { type: String, default: 'admin' },
}, { timestamps: true });

module.exports = mongoose.model('IntegrationLog', integrationLogSchema);
