// import.js

import mongoose from "mongoose";
import fs from "fs";
import csv from "csv-parser";
import dotenv from "dotenv";
dotenv.config();

// === MONGOOSE FIX: Prevent buffering timeout ===
mongoose.set("strictQuery", false);

// === Load News model ===
const NewsSchema = new mongoose.Schema({
  id: String,
  title: String,
  description: String,
  content: String,
  location: String,
  categories: [String],
  image: String,
  verified: { type: Boolean, default: false },
  approved: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const News = mongoose.model("News", NewsSchema);

// === CSV FILE (UPDATED TO YOUR REAL FILE NAME) ===
const CSV_FILE = "1763130381.csv";  // <-- YOUR FILE NAME

console.log("Using MONGODB_URI:", process.env.MONGODB_URI);

// === Connect properly WITH dbName & longer timeout ===
await mongoose.connect(process.env.MONGODB_URI, {
  dbName: "ciepd",
  serverSelectionTimeoutMS: 60000, // wait up to 60 sec
});

console.log("✅ Connected to MongoDB");

// === Read CSV ===
const rows = [];

fs.createReadStream(CSV_FILE)
  .pipe(csv())
  .on("data", (row) => {
    rows.push({
      id: row["FORM #"] || "",
      title: row["INCIDENT TITLE"] || "Untitled",
      description: row["DESCRIPTION"] || "",
      content: row["DESCRIPTION"] || "",
      location: row["LOCATION"] || "",
      categories: row["CATEGORY"] ? [row["CATEGORY"]] : [],
      image: "",
      verified: row["VERIFIED"]?.toString().toLowerCase() === "true",
      approved: row["APPROVED"]?.toString().toLowerCase() === "true",
      createdAt: row["INCIDENT DATE"] ? new Date(row["INCIDENT DATE"]) : new Date()
    });
  })
  .on("end", async () => {
    console.log(`📦 CSV Loaded. Total records: ${rows.length}`);

    try {
      // Insert in smaller batches (prevents overload)
      const batchSize = 300;

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        await News.insertMany(batch, { ordered: false });
        console.log(`📌 Inserted batch ${Math.floor(i / batchSize) + 1}`);
      }

      console.log("🎉 ALL DONE — Import successful.");
      process.exit(0);

    } catch (err) {
      console.error("❌ Import error:", err);
      process.exit(1);
    }
  })
  .on("error", (err) => {
    console.error("❌ File read error:", err);
  });
