function sendPushNotification({ userId, mobile, title, message }) {
  console.log("[PUSH STUB]", { userId, mobile, title, message });
  return { success: true, provider: "push_stub" };
}
module.exports = { sendPushNotification };
