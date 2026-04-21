const express = require("express");
const store = require("../services/store");
const { notify, addAdminAlert } = require("../services/notificationService");
const router = express.Router();

router.get("/settings", (req,res) => {
  res.json({ success: true, data: store.settings });
});

router.post("/settings", (req,res) => {
  store.settings = { ...store.settings, ...req.body };
  res.json({ success: true, message: "Settings updated", data: store.settings });
});

router.post("/send-whatsapp", (req,res) => {
  const { mobile, message } = req.body;
  const result = notify({ mobile, title: "Guruvidya", message });
  addAdminAlert("automation", "Manual WhatsApp/push send", { mobile });
  res.json({ success: true, data: result });
});

router.post("/send-push", (req,res) => {
  const { mobile, title, message } = req.body;
  const result = notify({ mobile, title, message });
  addAdminAlert("automation", "Manual push/notification send", { mobile, title });
  res.json({ success: true, data: result });
});

router.post("/appointment-reminder", (req,res) => {
  const { name, mobile, datetime } = req.body;
  const result = notify({
    mobile,
    title: "Appointment Reminder",
    message: `Hi ${name || ""}, your Guruvidya appointment is scheduled at ${datetime}.`
  });
  addAdminAlert("appointment", "Appointment reminder processed", { name, mobile, datetime });
  res.json({ success: true, data: result });
});

module.exports = router;
