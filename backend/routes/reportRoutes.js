import express from "express";
import Report from "../models/report.js";

const router = express.Router();

// SUBMIT REPORT
router.post("/submit", async (req, res) => {
  try {
    const report = new Report(req.body);
    await report.save();

    res.json({ success: true, message: "Report submitted successfully!" });
  } catch (err) {
    console.error("REPORT SAVE ERROR:", err);
    res.status(500).json({ error: "Failed to submit report." });
  }
});

export default router;


