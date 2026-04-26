const mongoose = require('mongoose');

const integrationSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  enabled: { type: Boolean, default: false },
  config: { type: Object, default: {} },
  lastTestStatus: { type: String, enum: ['not_tested', 'success', 'failed'], default: 'not_tested' },
  lastTestMessage: { type: String, default: '' },
  lastTestAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('IntegrationSetting', integrationSettingSchema);
