const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("./db");

const publicRoutes = require("./routes/public");
const adminRoutes = require("./routes/admin");
const automationRoutes = require("./routes/automation");

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.get("/", (req,res)=>res.send("Guruvidya Next Level Backend Running"));
app.get("/health", (req,res)=>res.json({success:true,message:"OK"}));

app.use("/api/public", publicRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/automation", automationRoutes);

app.listen(5000, ()=>console.log("Server running on 5000"));
