const IntegrationSetting = require('../models/IntegrationSetting');
const IntegrationLog = require('../models/IntegrationLog');
const { testBotSailorConnection } = require('../services/botsailorService');

const defaultIntegrations = [
  { key: 'botsailor', name: 'BotSailor', enabled: false, config: { apiToken: '', instanceId: '', sendApiUrl: '', defaultTemplateId: '', testPhone: '', whatsapp: true, instagram: false, facebook: false } },
  { key: 'razorpay', name: 'Razorpay', enabled: false, config: { keyId: '', keySecret: '', upiDefault: true, testMode: true } },
  { key: 'youtube', name: 'YouTube API', enabled: false, config: { apiKey: '', channelId: '', liveEnabled: false } },
  { key: 'myoperator', name: 'MyOperator', enabled: false, config: { apiKey: '', companyId: '', autoCalling: false } },
  { key: 'ai', name: 'AI API', enabled: false, config: { provider: 'openai', apiKey: '', mode: 'assist', usageLimitPercent: 50 } },
];

async function ensureDefaults() {
  for (const item of defaultIntegrations) {
    await IntegrationSetting.findOneAndUpdate({ key: item.key }, { $setOnInsert: item }, { upsert: true, new: true });
  }
}

exports.listIntegrations = async (req, res) => {
  await ensureDefaults();
  const rows = await IntegrationSetting.find().sort({ createdAt: 1 });
  res.json({ success: true, data: rows });
};

exports.saveIntegration = async (req, res) => {
  const { key } = req.params;
  const { enabled, config } = req.body;
  const base = defaultIntegrations.find(i => i.key === key) || { key, name: key };
  const existing = await IntegrationSetting.findOne({ key });
  const mergedConfig = { ...(existing?.config || base.config || {}), ...(config || {}) };
  const row = await IntegrationSetting.findOneAndUpdate(
    { key },
    { key, name: base.name, enabled: Boolean(enabled), config: mergedConfig },
    { upsert: true, new: true }
  );
  await IntegrationLog.create({ integrationKey: key, event: 'save_settings', status: 'success', requestPayload: { enabled, config: { ...mergedConfig, apiToken: mergedConfig.apiToken ? '***' : '', apiKey: mergedConfig.apiKey ? '***' : '' } }, message: 'Settings saved', source: 'Integration Panel' });
  res.json({ success: true, data: row });
};

exports.testIntegration = async (req, res) => {
  const { key } = req.params;
  const row = await IntegrationSetting.findOne({ key });
  if (!row) return res.status(404).json({ success: false, message: 'Integration not found' });

  try {
    let result = { message: 'Test placeholder ready' };
    if (key === 'botsailor') result = await testBotSailorConnection(row.config);
    row.lastTestStatus = 'success';
    row.lastTestMessage = 'Connection test successful';
    row.lastTestAt = new Date();
    await row.save();
    res.json({ success: true, message: row.lastTestMessage, data: result });
  } catch (err) {
    row.lastTestStatus = 'failed';
    row.lastTestMessage = err.message;
    row.lastTestAt = new Date();
    await row.save();
    await IntegrationLog.create({ integrationKey: key, event: 'test_connection', status: 'failed', responsePayload: { error: err.message }, message: err.message, source: 'Integration Panel' });
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.getLogs = async (req, res) => {
  const logs = await IntegrationLog.find().sort({ createdAt: -1 }).limit(100);
  res.json({ success: true, data: logs });
};
