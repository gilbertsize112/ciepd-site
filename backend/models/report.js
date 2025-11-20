import mongoose from "mongoose";

const reportSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    content: { type: String, required: true },
    categories: { type: [String], required: true },
    location: { type: String, required: true },

    firstName: { type: String },
    lastName: { type: String },
    email: { type: String },

    aiAnalysis: { type: String, default: "" }
  },
  { timestamps: true }
);

export default mongoose.model("Report", reportSchema);
