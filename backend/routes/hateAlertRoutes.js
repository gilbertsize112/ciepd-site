import express from "express";
import HateAlert from "../models/HateAlert.js";

const router = express.Router();

// GET ALL HISTORY
router.get("/hatealert-history", async (req, res) => {
  try {
    const all = await HateAlert.find().sort({ timestamp: -1 });
    res.json(all);
  } catch (err) {
    console.error("History error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE ONE ALERT
router.delete("/hatealert/:id", async (req, res) => {
  try {
    await HateAlert.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Failed to delete" });
  }
});

export default router;
