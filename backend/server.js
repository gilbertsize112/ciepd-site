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
import Report from "./models/report.js";
import reportRoutes from "./routes/reportRoutes.js";

// EMAIL (Nodemailer)
import nodemailer from "nodemailer";

// ⭐ NEW — AI IMPORT
import OpenAI from "openai";


// ⭐ NEW — SCRAPER
import axios from "axios";
import * as cheerio from "cheerio";


let scraperRunning = false;
let scraperInterval = null;

dotenv.config();
console.log("🔑 OPENAI KEY LOADED?", process.env.OPENAI_API_KEY ? "YES" : "NO");


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
      "https://ciepdcwc.onrender.com",
      "https://ciepd.org"
    ],
    credentials: true,
  })
);


app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api/report", reportRoutes);

app.use("/api/reports", reportRoutes);

// ⭐ FIX 404 ERROR — ADD THIS HERE
app.get("/api/alerts", (req, res) => {
  res.json({ message: "Alerts endpoint working!" });
});


// ==========================
// SESSION (REQUIRED ON RENDER)
// ==========================
app.use(
  session({
    secret: process.env.SESSION_SECRET || "ciepd_secret_key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
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

const SubscriptionSchema = new mongoose.Schema({
  phone: String,
  email: String,
  location: String,
  method: String,
  createdAt: { type: Date, default: Date.now },
});

const Subscription = mongoose.model("Subscription", SubscriptionSchema);


// ==========================
// ⭐ NEW — HATE ALERT SCHEMA
// ==========================
const HateAlertSchema = new mongoose.Schema({
  text: String,
  url: String,
  timestamp: { type: Date, default: Date.now },
});
const HateAlert = mongoose.model("HateAlert", HateAlertSchema);

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
      createdAt: new Date(item["INCIDENT DATE"] || Date.now()),
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

connectDB().then(ensureAdmin);

if (process.argv.includes("--import")) {
  importCSV().then(cleanDuplicates);
}

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

function normalizeStateName(s) {
  if (!s) return "";
  return s.toLowerCase().replace(/state/gi, "").trim();
}

function locationMatchesState(newsLocation, subLocation) {
  if (!newsLocation || !subLocation) return false;
  const nl = newsLocation.toLowerCase();
  const sl = subLocation.toLowerCase();
  return nl.includes(sl) || sl.includes(nl);
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  function toRad(x) {
    return (x * Math.PI) / 180;
  }
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon1 - lon2);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const STATE_COORDS = {
  rivers: { lat: 4.85, lon: 6.99 },
  delta: { lat: 5.9, lon: 6.3 },
  edo: { lat: 6.34, lon: 5.62 },
  "akwa ibom": { lat: 4.99, lon: 7.93 },
  bayelsa: { lat: 4.93, lon: 6.27 },
  imo: { lat: 5.49, lon: 7.03 },
  abia: { lat: 5.53, lon: 7.44 },
  ondo: { lat: 7.1, lon: 5.2 },
  "cross river": { lat: 5.96, lon: 8.32 },
};

// ==========================
// LOGIN ROUTE
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
  const location = req.query.location || "";

  let filter = {};

  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
      { content: { $regex: search, $options: "i" } },
      { location: { $regex: search, $options: "i" } },
    ];
  }

  if (location && location.trim() !== "") {
    filter.location = location;
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
// GET SINGLE NEWS
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

/*  
===========================================================
 ⭐ FIXED — NEW OPENAI RESPONSE API (2025)
===========================================================
*/

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/api/ai/analyze-report", async (req, res) => {
  try {
    const { title, description, location, categories } = req.body;

    const prompt = `
You are a crisis-analysis AI for a peace & conflict early-warning system.
Analyze this community report and return short actionable insights.

Report:
- Title: ${title}
- Description: ${description}
- Location: ${location}
- Categories: ${categories}

Return:
1. Risk Level (Low • Medium • High)
2. Why (2–3 sentences)
3. Immediate Advice for local authorities
4. Whether escalation is likely
`;

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
    });

    let text =
      response.output_text ||
      response?.output?.[0]?.content?.[0]?.text ||
      response?.output?.[0]?.content?.[0]?.message?.text ||
      response?.response_text ||
      "";

    if (!text || text.trim() === "") {
      text = "AI returned no analysis.";
    }

    return res.json({ analysis: text });
  } catch (err) {
    console.error("AI ERROR:", err.message || err);
    return res.status(500).json({ error: "AI processing failed" });
  }
});

/* =========================================================
   NEW: Get latest news route
   ========================================================= */
app.get("/get-news", async (req, res) => {
  try {
    const items = await News.find().sort({ createdAt: -1 }).limit(200);
    res.json(items);
  } catch (err) {
    console.error("GET-NEWS ERROR:", err);
    res.status(500).json([]);
  }
});

app.post("/api/improve", (req, res, next) => {
  req.url = "/api/ai/analyze-report";
  return app._router.handle(req, res, next);
});

/* =========================================================
   NEW: Subscribe alert endpoint
   ========================================================= */
app.post("/subscribe-alert", async (req, res) => {
  try {
    let { phone, email, location, method } = req.body;

    if (!phone || !location) {
      return res.status(400).json({ message: "phone and location required" });
    }

    phone = String(phone).trim();
    if (!phone.startsWith("+")) {
      if (phone.startsWith("0")) {
        phone = "+234" + phone.substring(1);
      } else {
        phone = "+234" + phone;
      }
    }

    const sub = await Subscription.create({ phone, email, location, method });
    console.log("New subscription:", sub);

    res.json({ success: true, subscriptionId: sub._id });
  } catch (err) {
    console.error("SUBSCRIBE ERROR:", err);
    res.status(500).json({ message: "Subscription failed" });
  }
});

/* =========================================================
   NEW: submit-report endpoint
   ========================================================= */
app.post("/api/submit-report", async (req, res) => {
  try {
    const { title, content, category, location, firstName, lastName, email } =
      req.body;

    if (!title || !content || !location) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const doc = {
      id: `web-${Date.now()}`,
      title,
      description: content.slice(0, 200),
      content,
      location,
      categories: Array.isArray(category) ? category : [category].filter(Boolean),
      image: "",
      verified: false,
      approved: false,
      createdAt: new Date(),
    };

    const created = await News.create(doc);

    try {
      io.emit("news:created", created);
    } catch {}

    notifySubscribers(created).catch((err) => {
      console.error("notifySubscribers error:", err);
    });

    return res.json({ success: true, news: created });
  } catch (err) {
    console.error("SUBMIT REPORT ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to submit report" });
  }
});

/* =========================================================
   EMAIL + WHATSAPP HELPERS
========================================================= */

async function sendEmail(to, subject, text) {
  try {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.FROM_EMAIL || process.env.SMTP_USER;

    if (!host || !port || !user || !pass) {
      console.log(`[Email mock] To: ${to} | Subject: ${subject} | Text: ${text}`);
      return { ok: true, mock: true };
    }

    const transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: Number(port) === 465,
      auth: {
        user,
        pass,
      },
    });

    const info = await transporter.sendMail({
      from: from,
      to,
      subject,
      text,
    });

    console.log("Email sent:", info.messageId);
    return { ok: true, info };
  } catch (err) {
    console.error("sendEmail error:", err);
    return { ok: false, error: err.message || err };
  }
}

async function sendWhatsApp(to, message) {
  try {
    const token = process.env.WHATSAPP_API_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    if (!token || !phoneId) {
      console.log(`[WhatsApp mock] To: ${to} — Message: ${message}`);
      return { ok: true, mock: true };
    }

    const url = `https://graph.facebook.com/v17.0/${phoneId}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to: to.replace("+", ""),
      type: "text",
      text: { body: message },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const json = await r.json();
    if (!r.ok) {
      console.error("WHATSAPP API ERROR:", json);
      return { ok: false, error: json };
    }
    return { ok: true, result: json };
  } catch (err) {
    console.error("sendWhatsApp error:", err);
    return { ok: false, error: err.message || err };
  }
}

async function notifySubscribers(news) {
  try {
    if (!news || !news.location) return;

    const subs = await Subscription.find().lean();
    const newsLoc = String(news.location || "").toLowerCase();

    const message = `CIEPD Alert — ${news.title}
Location: ${news.location}
Categories: ${
      Array.isArray(news.categories) ? news.categories.join(", ") : news.categories
    }
Date: ${new Date(news.createdAt).toLocaleString()}

Details: ${news.description || (news.content || "").slice(0, 150)}
`;

    for (let s of subs) {
      try {
        const subLoc = String(s.location || "").toLowerCase().trim();
        if (!subLoc) continue;

        if (
          newsLoc.includes(subLoc) ||
          subLoc.includes(newsLoc) ||
          locationMatchesState(news.location, s.location)
        ) {
          if (s.method && s.method.toLowerCase().includes("email")) {
            const to = s.email || s.phone;
            if (!to) continue;

            const subject = `CIEPD Alert — ${news.title}`;
            const text = `${message}\nVisit admin for more.`;
            const sent = await sendEmail(to, subject, text);
            console.log("Email notify:", to, sent.ok);
          } else if (s.method && s.method.toLowerCase().includes("whatsapp")) {
            const to = s.phone || "";
            const sent = await sendWhatsApp(to, message);
            console.log("WA notify:", to, sent.ok);
          } else if (s.method && s.method.toLowerCase().includes("sms")) {
            console.log(`[SMS mock] To: ${s.phone} — ${message}`);
          } else {
            if (s.email) {
              const to = s.email;
              const subject = `CIEPD Alert — ${news.title}`;
              const text = `${message}\nVisit admin for more.`;
              const sent = await sendEmail(to, subject, text);
              console.log("Default email notify:", to, sent.ok);
            }
          }
        }
      } catch (innerErr) {
        console.error("notifySubscribers inner error:", s, innerErr);
      }
    }
  } catch (err) {
    console.error("notifySubscribers ERROR:", err);
  }
}

/* =========================================================
   ⭐⭐ NEW: SAVE REPORTS TO SHOW IN admin.html + report.html
========================================================= */

app.post("/api/report", async (req, res) => {
  try {
    const saved = await Report.create(req.body);

    io.emit("new-report", saved); // 🔥 real-time update for admin

    res.json({ success: true, message: "Report submitted" });
  } catch (err) {
    console.error("SAVE REPORT ERROR:", err);
    res.status(500).json({ success: false })
  }
});

app.get("/api/reports", async (req, res) => {
  try {
    const reports = await Report.find().sort({ date: -1 });
    res.json(reports);
  } catch (err) {
    console.error("GET REPORTS ERROR:", err);
    res.status(500).json([]);
  }
});


// ==========================
// SOCKET.IO — ADMIN SCRAPER CONTROL
// ==========================
io.on("connection", (socket) => {
  console.log("admin connected");

socket.on("start-scraper", () => {
  scraperRunning = true;
  unifiedScraper();  // Only this exists
});

  socket.on("stop-scraper", () => {
    scraperRunning = false;
  });
});



// =========================================
// HATE-SPEECH SCRAPER (SERVER SIDE)
// =========================================

async function scrapeWebsites() {
  try {
    const FEEDS = [
      "https://www.vanguardngr.com/feed/",
      "https://punchng.com/feed/",
      "https://www.icirnigeria.org/feed/",
    ];

    const KEYWORDS = [
      "kill", "attack", "hate", "violence", "threat",
      "clash", "fight", "herder", "conflict", "riot",
      "militant", "beheaded",
    ];

    let matches = [];

    for (let url of FEEDS) {
     const response = await axios.get(url, {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  },
});

      const $ = cheerio.load(response.data);

      $("item").each(function () {
        const title = $(this).find("title").text();
        const link = $(this).find("link").text();
        const desc = $(this).find("description").text();

        const combined = (title + " " + desc).toLowerCase();

        const found = KEYWORDS.some(k => combined.includes(k.toLowerCase()));

        if (found) {
          const alert = {
            text: title,
            url: link,
            timestamp: new Date(),
          };

          matches.push(alert);

          HateAlert.create(alert);

          io.emit("newServerMatch", alert);

          console.log("🔥 SERVER MATCH:", title);
        }
      });
    }

    return matches;
  } catch (err) {
    console.error("❌ SCRAPER ERROR:", err);
    return [];
  }
}
// ===========================================================
// UNIFIED HATE-SPEECH SCRAPER (RSS + Real-time Alerts)
// ===========================================================

async function unifiedScraper() {
  if (!scraperRunning) return;

  console.log("🔎 Running unified scraper...");

  const FEEDS = [
    "https://www.vanguardngr.com/feed/",
    "https://punchng.com/feed/",
    "https://www.icirnigeria.org/feed/",
  ];

  const KEYWORDS = [
    "niger delta",
    "militant",
    "pipeline",
    "oil bunkering",
    "attack",
    "kidnap",
    "kill",
    "conflict",
    "hate",
    "gunmen",
    "riverine",
    "hostage",
    "herder",
    "clash",
    "violence",
    "bomb",
    "explosion",
    "cultists"
  ];

  try {
    for (let feedUrl of FEEDS) {

      // ✅ FIX: Add headers to bypass 403
      const response = await axios.get(feedUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept": "text/xml,application/xml,application/rss+xml,text/html;q=0.9,*/*;q=0.8"
        }
      });

      const $ = cheerio.load(response.data);

      $("item").each(async function () {
        const title = $(this).find("title").text().trim();
        const link = $(this).find("link").text().trim();
        const desc = $(this).find("description").text().trim();

        const combined = `${title} ${desc}`.toLowerCase();

        const found = KEYWORDS.some(k => combined.includes(k.toLowerCase()));

        if (found) {
          const alert = {
            text: title,
            url: link,
            timestamp: new Date(),
          };

          const exists = await HateAlert.findOne({ text: title });

          if (!exists) {
            await HateAlert.create(alert);
            io.emit("hate-alert", alert);
            console.log("🔥 Niger Delta Alert:", title);
          }
        }
      });
    }
  } catch (err) {
    console.error("❌ Unified scraper error:", err.message);
  }

  // Re-run every 60 seconds
  setTimeout(unifiedScraper, 60 * 1000);
}

/*  
===========================================================
  START SERVER
===========================================================
*/

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
