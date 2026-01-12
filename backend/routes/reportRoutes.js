import express from "express";
import Report from "../models/report.js";

const router = express.Router();

// 1. SUBMIT REPORT (Matches /api/reports)
router.post("/", async (req, res) => {
  try {
    const report = new Report(req.body);
    await report.save();

    // Notify the Admin Dashboard in real-time
    const io = req.app.get("socketio");
    if (io) {
      io.emit("report:new", report);
    }

    res.json({ success: true, message: "Report submitted successfully!" });
  } catch (err) {
    console.error("REPORT SAVE ERROR:", err);
    res.status(500).json({ error: "Failed to submit report." });
  }
});

// 2. VERIFY REPORT
router.put("/verify/:id", async (req, res) => {
  try {
    const item = await Report.findById(req.params.id);
    if (!item) return res.status(404).json({ error: "Report not found" });

    item.verified = true;
    await item.save();

    res.json({ success: true, message: "Report verified successfully" });
  } catch (err) {
    console.error("REPORT VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// 3. DELETE REPORT
router.delete("/delete/:id", async (req, res) => {
  try {
    const item = await Report.findById(req.params.id);
    if (!item) return res.status(404).json({ error: "Report not found" });

    await Report.deleteOne({ _id: item._id });
    res.json({ success: true, message: "Report deleted successfully" });
  } catch (err) {
    console.error("REPORT DELETE ERROR:", err);
    res.status(500).json({ error: "Deletion failed" });
  }
});

// 4. ESCALATE REPORT (Critical Alert)
router.put("/escalate/:id", async (req, res) => {
  try {
    const item = await Report.findById(req.params.id);
    if (!item) return res.status(404).json({ error: "Report not found" });

    item.verified = true;
    item.approved = true; 
    await item.save();

    const io = req.app.get("socketio");
    if (io) io.emit("report:updated", item);
    
    res.json({ success: true, message: "Report escalated successfully." });
  } catch (err) {
    console.error("REPORT ESCALATE ERROR:", err);
    res.status(500).json({ error: "Escalate failed" });
  }
});

// 5. GET ALL REPORTS (For Admin Dashboard)
router.get("/", async (req, res) => {
  try {
    const reports = await Report.find().sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch reports" });
  }
});

export default router;