function sendBotsailorMessage({ mobile, message }) {
  console.log("[BOTSAILOR STUB]", { mobile, message });
  return { success: true, provider: "botsailor_stub" };
}
module.exports = { sendBotsailorMessage };
