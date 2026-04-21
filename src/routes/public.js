const express = require("express");
const db = require("../db");
const { addAdminAlert, notify } = require("../services/notificationService");
const router = express.Router();

router.post("/enquiry",(req,res)=>{
 const {name,mobile,course}=req.body;
 const result = db.prepare("INSERT INTO leads (name,mobile,course) VALUES (?,?,?)").run(name||"",mobile||"",course||"");
 addAdminAlert("lead","New lead created",{id:result.lastInsertRowid,name,mobile,course});
 notify({ mobile, title: "Guruvidya enquiry received", message: `Hi ${name || ""}, thanks for your interest in ${course || "Guruvidya"}.` });
 res.json({success:true,message:"Enquiry saved"});
});

router.post("/admission-enquiry",(req,res)=>{
 const {name,mobile,email,course,note}=req.body;
 const result = db.prepare("INSERT INTO admissions (name,mobile,email,course,note) VALUES (?,?,?,?,?)")
   .run(name||"",mobile||"",email||"",course||"",note||"");
 addAdminAlert("admission","New admission enquiry",{id:result.lastInsertRowid,name,mobile,course});
 res.json({success:true,message:"Admission enquiry saved"});
});

router.post("/appointment-request",(req,res)=>{
 const {name,mobile,course,appointment_at}=req.body;
 const result = db.prepare("INSERT INTO appointments (name,mobile,course,datetime) VALUES (?,?,?,?)")
   .run(name||"",mobile||"",course||"",appointment_at||"");
 addAdminAlert("appointment","New appointment request",{id:result.lastInsertRowid,name,mobile,course,appointment_at});
 res.json({success:true,message:"Appointment request saved"});
});

router.post("/support-request",(req,res)=>{
 const {name,mobile,issue_type,description}=req.body;
 const result = db.prepare("INSERT INTO support (name,mobile,issue,description) VALUES (?,?,?,?)")
   .run(name||"",mobile||"",issue_type||"",description||"");
 addAdminAlert("support","New support request",{id:result.lastInsertRowid,name,mobile,issue_type});
 res.json({success:true,message:"Support request saved"});
});

router.post("/faculty-interest",(req,res)=>{
 const {name,mobile,course,mode,note}=req.body;
 const result = db.prepare("INSERT INTO faculty (name,mobile,course,mode,note) VALUES (?,?,?,?,?)")
   .run(name||"",mobile||"",course||"",mode||"",note||"");
 addAdminAlert("faculty","New faculty interest",{id:result.lastInsertRowid,name,mobile,course,mode});
 res.json({success:true,message:"Faculty interest saved"});
});

module.exports=router;
