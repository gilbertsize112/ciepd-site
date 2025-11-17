// server.js

import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import session from "express-session";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import http from "http";
import { Server } from "socket.io";
import csv from "csvtojson";
import fs from "fs";

dotenv.config();

// ==========================
// BASIC SETUP
// ==========================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

mongoose.set("strictQuery", false);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================
// CORS (UPDATED FOR LOGIN)
// ==========================
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5500",
      "https://ciepd-backend.onrender.com",
      "https://ciepd.org",
      "*",
    ],
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================
// SESSION (REQUIRED ON RENDER)
// ==========================
app.use(
  session({
    secret: process.env.SESSION_SECRET || "ciepd_secret_key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // RENDER HTTPS WILL STILL WORK
      httpOnly: true,
      sameSite: "lax",
    },
  })
);

// STATIC FILES
app.use(express.static(path.join(__dirname, "public")));

// ==========================
// DATABASE
// ==========================
async function connectDB() {
  try {
    console.log("DEBUG:: MONGODB_URI =", process.env.MONGODB_URI);

    await mongoose.connect(process.env.MONGODB_URI, {
      dbName: "ciepd",
      serverSelectionTimeoutMS: 30000,
    });

    console.log("✅ MongoDB Connected Successfully");
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err);
  }
}

// ==========================
// SCHEMAS
// ==========================
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
  createdAt: { type: Date, default: Date.now },
});

const News = mongoose.model("News", NewsSchema);

const UserSchema = new mongoose.Schema({
  email: String,
  password: String,
});

const User = mongoose.model("User", UserSchema);

// ==========================
// CSV IMPORTER — FIXED!
// ==========================
async function importCSV() {
  try {
    const filePath = path.join(__dirname, "news.csv");

    if (!fs.existsSync(filePath)) {
      console.log("⚠️ news.csv not found. Skipping CSV import.");
      return;
    }

    const jsonArray = await csv().fromFile(filePath);
    if (!jsonArray.length) {
      console.log("⚠️ CSV file is empty.");
      return;
    }

    console.log(`📥 Importing ${jsonArray.length} items...`);

    const formatted = jsonArray.map((item, index) => ({
      id:
        item["#"] && item["#"].trim() !== ""
          ? item["#"]
          : `csv-${index}-${Date.now()}`,
      title: item["INCIDENT TITLE"],
      description: item["DESCRIPTION"]?.slice(0, 200),
      content: item["DESCRIPTION"],
      location: item["LOCATION"],
      categories: [item["CATEGORY"]],
      image: "",
      verified: item["VERIFIED"] === "YES",
      approved: item["APPROVED"] === "YES",
      createdAt: new Date(item["INCIDENT DATE"]),
    }));

    for (let row of formatted) {
      const exists = await News.findOne({ id: row.id });
      if (!exists) {
        await News.create(row);
      }
    }

    console.log("✅ CSV Imported Correctly!");
  } catch (err) {
    console.error("❌ CSV Import Error:", err);
  }
}

// ==========================
// REMOVE DUPLICATES — FIX
// ==========================
async function cleanDuplicates() {
  try {
    const items = await News.find().lean();
    const seen = new Set();

    for (let item of items) {
      if (seen.has(item.id)) {
        await News.deleteOne({ _id: item._id });
      } else {
        seen.add(item.id);
      }
    }

    console.log("🧹 Duplicate news cleaned!");
  } catch (err) {
    console.error("Duplicate-clean error:", err);
  }
}

// ==========================
// CREATE ADMIN
// ==========================
async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  const exist = await User.findOne({ email });
  if (!exist) {
    const hashed = await bcrypt.hash(password, 10);
    await User.create({ email, password: hashed });
    console.log(`👤 Default Admin Created: ${email} | pass: ${password}`);
  } else {
    console.log("🔐 Admin Already Exists");
  }
}

connectDB().then(importCSV).then(cleanDuplicates).then(ensureAdmin);

// ==========================
// HELPERS
// ==========================
async function findNews(id) {
  if (mongoose.Types.ObjectId.isValid(id)) {
    let item = await News.findById(id);
    if (item) return item;
  }
  return await News.findOne({ id });
}

// ==========================
// ⭐⭐ LOGIN ROUTE (ADDED)
// ==========================
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log("LOGIN ATTEMPT:", email);

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: "Invalid login details" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: "Invalid login details" });
    }

    req.session.user = { id: user._id, email: user.email };

    return res.json({ success: true, redirect: "/admin.html" });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ==========================
// CATEGORY LIST API
// ==========================
app.get("/api/news/categories", async (req, res) => {
  try {
    const cats = await News.distinct("categories");
    res.json(cats.filter((c) => c && c.trim() !== ""));
  } catch (err) {
    res.status(500).json({ error: "Could not load categories" });
  }
});

// ==========================
// SEARCH & FILTER API
// ==========================
app.get("/api/news", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  const search = req.query.search?.toLowerCase() || "";
  const category = req.query.category || "";

  let filter = {};

  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
      { content: { $regex: search, $options: "i" } },
      { location: { $regex: search, $options: "i" } },
    ];
  }

  if (category && category.trim() !== "") {
    filter.categories = category;
  }

  const totalItems = await News.countDocuments(filter);
  const totalPages = Math.ceil(totalItems / limit);

  const items = await News.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  res.json({
    items,
    totalItems,
    totalPages,
    currentPage: page,
  });
});

// ==========================
// VERIFY NEWS
// ==========================
app.put("/api/news/verify/:id", async (req, res) => {
  try {
    const item = await findNews(req.params.id);
    if (!item) return res.status(404).json({ error: "News not found" });

    item.verified = true;
    await item.save();

    res.json({ success: true });
  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verify failed" });
  }
});

// ==========================
// APPROVE NEWS
// ==========================
app.put("/api/news/approve/:id", async (req, res) => {
  try {
    const item = await findNews(req.params.id);
    if (!item) return res.status(404).json({ error: "News not found" });

    item.approved = true;
    await item.save();

    res.json({ success: true });
  } catch (err) {
    console.error("APPROVE ERROR:", err);
    res.status(500).json({ error: "Approve failed" });
  }
});

// ==========================
// DELETE NEWS
// ==========================
app.delete("/api/news/delete/:id", async (req, res) => {
  try {
    const item = await findNews(req.params.id);
    if (!item) return res.status(404).json({ error: "News not found" });

    await item.deleteOne();

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

// ==========================
// GET SINGLE NEWS (WORKING)
// ==========================
app.get("/api/news/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const item = await findNews(id);
    if (!item) {
      return res.status(404).json({ error: "News not found" });
    }

    res.json(item);
  } catch (err) {
    console.error("GET SINGLE NEWS ERROR:", err);
    res.status(500).json({ error: "Failed to load article" });
  }
});

// ==========================
// START SERVER
// ==========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
