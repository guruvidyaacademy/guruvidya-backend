const store = require("./store");
const { sendBotsailorMessage } = require("./botsailorService");
const { sendPushNotification } = require("./pushService");

function canUseWhatsApp() {
  const s = store.settings;
  return s.whatsappFallback && s.currentWhatsappUsage < s.monthlyWhatsappLimit;
}

function addAdminAlert(type, title, payload = {}) {
  store.alerts.unshift({
    id: Date.now().toString(),
    type,
    title,
    payload,
    created_at: new Date().toISOString()
  });
  store.alerts = store.alerts.slice(0, 300);
}

function notify({ userId, mobile, title, message, whatsappCost = 5 }) {
  if (store.settings.appPushFirst) {
    const push = sendPushNotification({ userId, mobile, title, message });
    if (push.success) return { success: true, channel: "app_push" };
  }
  if (canUseWhatsApp()) {
    store.settings.currentWhatsappUsage += whatsappCost;
    const wa = sendBotsailorMessage({ mobile, message });
    return { success: !!wa.success, channel: "whatsapp" };
  }
  return { success: false, channel: "none", reason: "No channel available" };
}

module.exports = { addAdminAlert, notify };
