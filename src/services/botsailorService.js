const axios = require('axios');
const IntegrationLog = require('../models/IntegrationLog');

function getBotSailorEndpoint(config = {}) {
  // Replace this from BotSailor dashboard if your account gives a different Send API URL.
  return config.sendApiUrl || process.env.BOTSailor_BASE_URL || 'https://www.botsailor.com/api/v1';
}

async function writeLog(data) {
  try { await IntegrationLog.create(data); } catch (err) { console.error('Log write failed:', err.message); }
}

async function sendWhatsAppMessage({ config, to, message, templateId, source = 'Action Panel' }) {
  if (!config?.apiToken) throw new Error('BotSailor API token missing');
  if (!config?.instanceId) throw new Error('BotSailor Instance ID / Phone Number ID missing');
  if (!to) throw new Error('Recipient phone number missing');

  const payload = {
    apiToken: config.apiToken,
    phoneNumberID: config.instanceId,
    botTemplateID: templateId || config.defaultTemplateId || '',
    sendToPhoneNumber: to,
    message: message || 'Hello from Guruvidya Academy CRM',
  };

  const url = `${getBotSailorEndpoint(config).replace(/\/$/, '')}/send-message`;

  try {
    const { data } = await axios.post(url, payload, { timeout: 15000 });
    await writeLog({ integrationKey: 'botsailor', channel: 'whatsapp', event: 'send_whatsapp', status: 'success', requestPayload: { ...payload, apiToken: '***' }, responsePayload: data, source, message: 'WhatsApp trigger sent' });
    return data;
  } catch (err) {
    const responsePayload = err.response?.data || { error: err.message };
    await writeLog({ integrationKey: 'botsailor', channel: 'whatsapp', event: 'send_whatsapp', status: 'failed', requestPayload: { ...payload, apiToken: '***' }, responsePayload, source, message: err.message });
    throw new Error(responsePayload?.message || err.message || 'BotSailor send failed');
  }
}

async function testBotSailorConnection(config = {}) {
  if (!config.apiToken) throw new Error('API Token missing');
  if (!config.instanceId) throw new Error('Instance ID missing');
  if (!config.testPhone) throw new Error('Test phone number missing');
  return sendWhatsAppMessage({ config, to: config.testPhone, message: 'Guruvidya CRM BotSailor test message', source: 'Integration Test' });
}

module.exports = { sendWhatsAppMessage, testBotSailorConnection };
