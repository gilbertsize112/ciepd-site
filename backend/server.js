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

// EMAIL (Nodemailer)
import nodemailer from "nodemailer";

// ⭐ NEW — AI IMPORT
import OpenAI from "openai";

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

/* ===== New: Subscription schema for Get Alerts =====
   We store subscriber phone/email, chosen state/location, preferred method, createdAt.
*/
const SubscriptionSchema = new mongoose.Schema({
  phone: String, // E.164 format expected (+234...)
  email: String,
  location: String, // e.g. "Rivers State" (the labels used in front-end)
  method: String, // "WhatsApp" | "SMS" | "Email"
  createdAt: { type: Date, default: Date.now },
});

const Subscription = mongoose.model("Subscription", SubscriptionSchema);

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

// RUN ONLY ONCE, NOT EVERY SERVER START
connectDB().then(ensureAdmin);

// If you ever want to re-import CSV manually, run:
//   node server.js --import
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

/* ===== NEW: small utility helpers ===== */

/**
 * normalizeStateName
 * makes comparisons case-insensitive and trims common words.
 */
function normalizeStateName(s) {
  if (!s) return "";
  return s.toLowerCase().replace(/state/gi, "").trim();
}

/**
 * quick contains-match for state names in a news location string
 */
function locationMatchesState(newsLocation, subLocation) {
  if (!newsLocation || !subLocation) return false;
  const nl = newsLocation.toLowerCase();
  const sl = subLocation.toLowerCase();
  return nl.includes(sl) || sl.includes(nl);
}

/**
 * A minimal haversine function in case you add coordinates later.
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  function toRad(x) {
    return (x * Math.PI) / 180;
  }
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Small map of relevant Niger Delta state centroids (for future distance-based logic)
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

/*  
===========================================================
 ⭐ NEW — AI SAFETY SUGGESTION API (OPENAI 2025 FIX)
===========================================================
*/

// ✅ New OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ⭐ Updated AI Endpoint (2025 syntax)
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

    // ⭐ NEW — REQUIRED 2025 RESPONSE API
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
    });

    const text = response.output_text || "No response";

    res.json({ analysis: text });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI processing failed" });
  }
});

/* =========================================================
   NEW: Get latest news route used by getalert front-end
   (keeps compatibility with your front-end which calls /get-news)
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

/* =========================================================
   NEW: Subscribe alert endpoint
   Body: { phone, email, location, method }
   - Normalizes phone to E.164 (+234...) automatically for local numbers
   ========================================================= */
app.post("/subscribe-alert", async (req, res) => {
  try {
    let { phone, email, location, method } = req.body;

    if (!phone || !location) {
      return res.status(400).json({ message: "phone and location required" });
    }

    phone = String(phone).trim();
    // auto add +234 if user typed local 0xxxxx or without +
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
   NEW: submit-report endpoint (used by submit.html)
   Creates a News document and triggers notifySubscribers(news)
   ========================================================= */
app.post("/api/submit-report", async (req, res) => {
  try {
    const { title, content, category, location, firstName, lastName, email } =
      req.body;

    // basic validation
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

    // Emit via socket.io to admin UI if connected
    try {
      io.emit("news:created", created);
    } catch (e) {
      // ignore socket errors
    }

    // Notify subscribers (async, fire-and-forget)
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
   Helper: sendEmail - uses Nodemailer when SMTP env configured
   Env vars used (optional but required for real email):
     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL
   If not configured the message is logged instead of sent.
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

    // Create transporter
    const transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: Number(port) === 465, // true for 465, false for other ports
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

/* =========================================================
   Helper: sendWhatsApp - uses WhatsApp Cloud API if configured
   Env vars used (optional):
     WHATSAPP_API_TOKEN, WHATSAPP_PHONE_ID
   If not configured the message is logged instead of sent.
   (Left here for completeness in case you later enable WhatsApp)
   ========================================================= */
async function sendWhatsApp(to, message) {
  try {
    const token = process.env.WHATSAPP_API_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    if (!token || !phoneId) {
      console.log(`[WhatsApp mock] To: ${to} — Message: ${message}`);
      return { ok: true, mock: true };
    }

    // Node 18+ has global fetch
    const url = `https://graph.facebook.com/v17.0/${phoneId}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to: to.replace("+", ""), // whatsapp expects numbers without + in this endpoint
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

/* =========================================================
   notifySubscribers(news)
   - Matches subscriptions by state name inclusion (simple and reliable for current data)
   - For each matched subscription, attempts to send Email (option C) or logs SMS/WhatsApp mocks
   ========================================================= */
async function notifySubscribers(news) {
  try {
    if (!news || !news.location) return;

    // Get all subscriptions for all states (could be filtered)
    const subs = await Subscription.find().lean();

    // Build simple normalized news location
    const newsLoc = String(news.location || "").toLowerCase();

    // Message body
    const message = `CIEPD Alert — ${news.title}
Location: ${news.location}
Categories: ${Array.isArray(news.categories) ? news.categories.join(", ") : news.categories}
Date: ${new Date(news.createdAt).toLocaleString()}

Details: ${news.description || (news.content || "").slice(0, 150)}
`;

    // For each sub, check if news location mentions their chosen location/state
    for (let s of subs) {
      try {
        const subLoc = String(s.location || "").toLowerCase().trim();
        if (!subLoc) continue;

        // If the subscriber location is included in the news location string -> notify
        if (
          newsLoc.includes(subLoc) ||
          subLoc.includes(newsLoc) ||
          locationMatchesState(news.location, s.location)
        ) {
          // Send according to method
          if (s.method && s.method.toLowerCase().includes("email")) {
            // Send real email using nodemailer (Option C)
            const to = s.email || s.phone; // prefer email, fall back to phone as identifier
            if (!to) {
              console.log("Skipping email notify, no recipient:", s);
              continue;
            }
            const subject = `CIEPD Alert — ${news.title}`;
            const text = `${message}\nVisit admin for more.`;
            const sent = await sendEmail(to, subject, text);
            console.log("Email notify result:", to, sent.ok ? "ok" : sent.error || "failed");
          } else if (s.method && s.method.toLowerCase().includes("whatsapp")) {
            // WhatsApp not configured by default in Option C — log/mock
            const to = s.phone || "";
            const sent = await sendWhatsApp(to, message);
            console.log("WhatsApp notify result:", s.phone, sent.ok ? "ok" : sent.error || "failed");
          } else if (s.method && s.method.toLowerCase().includes("sms")) {
            // SMS not implemented — log for now
            console.log(`[SMS mock] To: ${s.phone} — ${message}`);
            // You can plug in Twilio or another SMS provider here if needed
          } else {
            // Default: email if available, else log
            if (s.email) {
              const to = s.email;
              const subject = `CIEPD Alert — ${news.title}`;
              const text = `${message}\nVisit admin for more.`;
              const sent = await sendEmail(to, subject, text);
              console.log("Default notify (Email) result:", to, sent.ok ? "ok" : sent.error || "failed");
            } else {
              console.log("No contact method for subscriber:", s);
            }
          }
        }
      } catch (innerErr) {
        console.error("notifySubscribers inner error for sub:", s, innerErr);
      }
    }
  } catch (err) {
    console.error("notifySubscribers ERROR:", err);
  }
}

/* =========================================================
   Optional: When CSV import or other data pipelines create news,
   you may want to trigger notifySubscribers() there as well.
   For now submit-report triggers notifications.
   ========================================================= */

/*  
===========================================================
  START SERVER
===========================================================
*/
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
