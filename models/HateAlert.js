import mongoose from "mongoose";

const HateAlertSchema = new mongoose.Schema({
  text: { type: String, required: true },
  url: { type: String, default: "" },
  timestamp: { type: Date, default: Date.now }
});

export default mongoose.model("HateAlert", HateAlertSchema);
