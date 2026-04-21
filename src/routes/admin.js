const express = require("express");
const db = require("../db");
const store = require("../services/store");
const { addAdminAlert, notify } = require("../services/notificationService");
const router = express.Router();

const tables = { leads: "leads", admissions: "admissions", appointments: "appointments", support: "support", faculty: "faculty" };

Object.entries(tables).forEach(([key, table]) => {
  router.get(`/${key}`, (req,res)=>{
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id DESC`).all();
    res.json({success:true,data:rows});
  });
});

router.get("/alerts", (req,res)=> res.json({success:true,data:store.alerts}));

function actionHandler(tableName, label) {
  return (req,res) => {
    const { action, owner = "", note = "", sendNotification = false } = req.body;
    const row = db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ success:false, message: `${label} not found` });

    const status = action || row.status;
    const noteField = tableName === "admissions" || tableName === "faculty" ? "admin_note" : "note";

    db.prepare(`UPDATE ${tableName} SET status = ?, owner = ?, ${noteField} = ? WHERE id = ?`)
      .run(status, owner, note, req.params.id);

    const updated = db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(req.params.id);
    addAdminAlert(`${tableName}_action`, `${label} updated`, { id: updated.id, action: status, owner, note });

    let notifyResult = null;
    if (sendNotification && updated.mobile) {
      notifyResult = notify({
        mobile: updated.mobile,
        title: `Guruvidya ${label} update`,
        message: `Your ${label.toLowerCase()} status is now: ${status}`
      });
    }

    res.json({ success:true, message: `${label} updated`, data: updated, notifyResult });
  };
}

router.post("/leads/:id/action", actionHandler("leads", "Lead"));
router.post("/admissions/:id/action", actionHandler("admissions", "Admission"));
router.post("/appointments/:id/action", actionHandler("appointments", "Appointment"));
router.post("/support/:id/action", actionHandler("support", "Support"));
router.post("/faculty/:id/action", actionHandler("faculty", "Faculty"));

module.exports=router;
