// import.js – Import old CSV news into MongoDB

import mongoose from "mongoose";
import csv from "csv-parser";
import fs from "fs";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

console.log("Using MONGODB_URI:", process.env.MONGODB_URI);

// ========== CONNECT TO MONGO ==========
mongoose.connect(process.env.MONGODB_URI, {
  dbName: "ciepd"
})
.then(() => console.log("✅ Connected to MongoDB"))
.catch(err => console.error("❌ MongoDB error:", err));


// ========== NEWS MODEL ==========
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


// ========== IMPORT FUNCTION ==========
const results = [];

fs.createReadStream("1763130381.csv")
  .pipe(csv())
  .on("data", (row) => {
    
    const newsItem = {
      id: uuidv4(),

      title: row["INCIDENT TITLE"] || "Untitled Incident",
      description: row["DESCRIPTION"] || "",
      content:
        `${row["INCIDENT TITLE"] || ""}\n\n${row["DESCRIPTION"] || ""}`.trim(),

      location: row["LOCATION"] || "",
      categories: row["CATEGORY"] ? [row["CATEGORY"]] : [],

      approved: row["APPROVED"]?.trim().toLowerCase() === "yes",
      verified: row["VERIFIED"]?.trim().toLowerCase() === "yes",

      createdAt: row["INCIDENT DATE"]
        ? new Date(row["INCIDENT DATE"])
        : new Date(),
    };

    results.push(newsItem);
  })
  .on("end", async () => {
    console.log(`📦 CSV Loaded. Importing ${results.length} records...`);

    try {
      await News.insertMany(results);
      console.log("✅ Import completed successfully!");
      process.exit();
    } catch (error) {
      console.error("❌ Import error:", error);
      process.exit(1);
    }
  });
