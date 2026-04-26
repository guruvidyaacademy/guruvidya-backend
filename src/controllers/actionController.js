const IntegrationSetting = require('../models/IntegrationSetting');
const IntegrationLog = require('../models/IntegrationLog');
const { sendWhatsAppMessage } = require('../services/botsailorService');

exports.sendWhatsAppFromActionPanel = async (req, res) => {
  const { leadId, phone, message, templateId } = req.body;
  const integration = await IntegrationSetting.findOne({ key: 'botsailor' });

  if (!integration || !integration.enabled || integration.config?.whatsapp === false) {
    await IntegrationLog.create({ integrationKey: 'botsailor', channel: 'whatsapp', event: 'action_panel_trigger', status: 'failed', requestPayload: { leadId, phone }, message: 'BotSailor WhatsApp disabled', source: 'Action Panel' });
    return res.status(400).json({ success: false, message: 'BotSailor WhatsApp is disabled in Integration Panel' });
  }

  try {
    const result = await sendWhatsAppMessage({ config: integration.config, to: phone, message, templateId, source: 'Action Panel' });
    res.json({ success: true, message: 'WhatsApp message sent via BotSailor', data: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};
