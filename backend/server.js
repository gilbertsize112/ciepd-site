// server.js

import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import session from "express-session";
import MongoStore from "connect-mongo";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import http from "http";
import { Server } from "socket.io";
import csv from "csvtojson";
import fs from "fs";

import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import AWS from "aws-sdk";
import multerS3 from "multer-s3";

import Report from "./models/report.js";
import HateAlert from "./models/HateAlert.js";
import User from "./models/User.js";

import reportRoutes from "./routes/reportRoutes.js";
import hateAlertRoutes from "./routes/hateAlertRoutes.js";
import authRoutes from "./routes/auth.js";

// EMAIL (Nodemailer)
import nodemailer from "nodemailer";

// AI IMPORT
import OpenAI from "openai";

// SCRAPER
import axios from "axios";
import * as cheerio from "cheerio";

// ⭐ DIAGNOSTIC LOG TRAP
console.log("SERVER START: BEFORE DOTENV CONFIGURATION");

dotenv.config();
console.log("🔑 OPENAI KEY LOADED?", process.env.OPENAI_API_KEY ? "YES" : "NO");


// ==========================
// FILE STORAGE CONFIGURATION
// ==========================
let storage;

const isS3Configured = process.env.S3_BUCKET_NAME && process.env.AWS_ACCESS_KEY_ID;

if (isS3Configured) {
    console.log("☁️ Using AWS S3 for file storage.");

    AWS.config.update({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION,
    });

    const s3 = new AWS.S3();

    storage = multerS3({
        s3: s3,
        bucket: process.env.S3_BUCKET_NAME,
        acl: "public-read",
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            cb(null, "reports/" + uuidv4() + path.extname(file.originalname));
        },
    });
} else {
    console.warn("💾 Using Local Disk Storage (Not suitable for Render/Cloud deployment).");

    storage = multer.diskStorage({
        destination: function (req, file, cb) {
            const uploadPath = process.env.MULTER_STORAGE_PATH || "./public/uploads";
            if (process.env.VERCEL) {
                return cb(new Error("Local uploads not supported on Vercel. Use S3."));
            }
            if (!fs.existsSync(uploadPath)) {
                fs.mkdirSync(uploadPath, { recursive: true });
            }
            cb(null, uploadPath);
        },
        filename: function (req, file, cb) {
            const extension = path.extname(file.originalname);
            cb(null, uuidv4() + extension);
        },
    });
}

const upload = multer({ storage: storage });
// ==========================
// END FILE STORAGE CONFIGURATION
// ==========================


// ==========================
// BASIC SETUP
// ==========================
const app = express();
const server = http.createServer(app);
const io = process.env.VERCEL ? { emit: () => {} } : new Server(server);

// TRUST PROXY (Required for Vercel/HTTPS cookies)
app.set('trust proxy', 1);

mongoose.set("strictQuery", false);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// ==========================
// CORS
// ==========================
app.use(
    cors({
        origin: function(origin, callback) {
            const allowed = [
                "http://localhost:3000",
                "http://localhost:5500",
                "http://127.0.0.1:5500",
                "https://ciepdcwc.onrender.com",
                "https://ciepd.org",
                "https://ciepdcwc.vercel.app"
            ];
            if (!origin || allowed.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                callback(new Error("CORS: Not allowed — " + origin));
            }
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"]
    })
);


// ==========================
// SESSION
// ==========================
app.use(
    session({
        secret: process.env.SESSION_SECRET || "ciepd_secret_key",
        resave: false,
        saveUninitialized: false,
        store: MongoStore.create({
            mongoUrl: process.env.MONGODB_URI,
            dbName: "ciepd",
            ttl: 14 * 24 * 60 * 60,
        }),
        cookie: {
            secure: true,
            httpOnly: true,
            sameSite: "none",
        },
    })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ==========================
// DATABASE
// ==========================
const ConfigSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: mongoose.Schema.Types.Mixed,
    updatedAt: { type: Date, default: Date.now },
});
const Config = mongoose.model("Config", ConfigSchema);

async function connectDB() {
    if (mongoose.connection.readyState >= 1) return;
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
    photos: [String],
    videoLink: String,
    reporterName: String,
    reporterEmail: String,
    escalated: { type: Boolean, default: false },
    newsSource: String,
    verified: { type: Boolean, default: false },
    approved: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
});

const News = mongoose.model("News", NewsSchema);

const SubscriptionSchema = new mongoose.Schema({
    phone: String,
    email: String,
    location: String,
    method: String,
    createdAt: { type: Date, default: Date.now },
});

const Subscription = mongoose.model("Subscription", SubscriptionSchema);


// ==========================
// CSV IMPORTER
// ==========================
async function importCSV() {
    try {
        const isSeeded = await Config.findOne({ key: "csvDataSeeded" });
        if (isSeeded) {
            console.log("✨ Data already imported. Skipping CSV import.");
            return;
        }

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

        const existingItems = await News.find().select("id").lean();
        const existingIds = new Set(existingItems.map((item) => String(item.id)));

        const newItemsToInsert = [];

        for (const [index, item] of jsonArray.entries()) {
            const itemId =
                item["#"] && item["#"].trim() !== ""
                    ? String(item["#"])
                    : `csv-${index}-${Date.now()}`;

            if (!existingIds.has(itemId)) {
                newItemsToInsert.push({
                    id: itemId,
                    title: item["INCIDENT TITLE"],
                    description: item["DESCRIPTION"]?.slice(0, 200),
                    content: item["DESCRIPTION"],
                    location: item["LOCATION"],
                    categories: [item["CATEGORY"]].filter(Boolean),
                    photos: [],
                    videoLink: "",
                    verified: item["VERIFIED"] === "YES",
                    approved: item["APPROVED"] === "YES",
                    createdAt: new Date(item["INCIDENT DATE"] || Date.now()),
                });
            }
        }

        if (newItemsToInsert.length > 0) {
            console.log(`⚡ Inserting ${newItemsToInsert.length} new items in bulk...`);
            await News.insertMany(newItemsToInsert, { ordered: false, timeout: 60000 });
        } else {
            console.log("👍 All items already exist. No new items to insert.");
        }

        await Config.create({ key: "csvDataSeeded", value: true });
        console.log("✅ CSV Import (Bulk) Completed Successfully! (Will skip on next run)");
    } catch (err) {
        console.error("❌ CSV Import Error (Bulk Insert Failed):", err.message || err);
    }
}


// ==========================
// REMOVE DUPLICATES
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
    if (!email || !password) return;

    const exist = await User.findOne({ email });
    if (!exist) {
        const hashed = await bcrypt.hash(password, 10);
        await User.create({ email, password: hashed });
        console.log(`👤 Default Admin Created: ${email}`);
    } else {
        console.log("🔐 Admin Already Exists");
    }
}


// ==========================
// HELPERS
// ==========================
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
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
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
// ROUTE MIDDLEWARE
// ==========================
app.use("/api/report", reportRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api", hateAlertRoutes);

app.get("/api/alerts", (req, res) => {
    res.json({ message: "Alerts endpoint working!" });
});


// ==========================
// LOGIN ROUTE
// ==========================
app.post("/api/login", async (req, res) => {
    try {
        await connectDB();
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

        req.session.user = { id: user._id, email: user.email, role: user.role || "admin" };
        return res.json({ success: true, redirect: "/admin.html", user: { email: user.email, role: user.role || "admin" } });
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
// HELPERS (News & Reports)
// ==========================
async function findNews(id) {
    if (mongoose.Types.ObjectId.isValid(id)) {
        const item = await News.findById(id);
        if (item) return item;
    }
    return await News.findOne({ id: id });
}

async function findReport(id) {
    if (mongoose.Types.ObjectId.isValid(id)) {
        return await Report.findById(id);
    }
    return null;
}


// ==========================
// NEWS ACTIONS
// ==========================

// 1. ESCALATE
app.put("/api/news/escalate/:id", async (req, res) => {
    try {
        const item = await findNews(req.params.id);
        if (!item) return res.status(404).json({ error: "News item not found in database" });

        item.verified = true;
        item.approved = true;
        item.escalated = true;
        await item.save();

        io.emit("news:updated", item);

        res.json({ success: true, message: "Item successfully escalated and alerts dispatched." });
    } catch (err) {
        console.error("ESCALATE ERROR:", err);
        res.status(500).json({ error: "Escalate failed" });
    }
});

// 2. VERIFY NEWS
app.put("/api/news/verify/:id", async (req, res) => {
    try {
        const item = await findNews(req.params.id);
        if (!item) return res.status(404).json({ error: "News item not found" });

        item.verified = true;
        await item.save();

        res.json({ success: true, message: "News verified successfully" });
    } catch (err) {
        console.error("VERIFY ERROR:", err);
        res.status(500).json({ error: "Verification failed" });
    }
});

// 3. DELETE NEWS
app.delete("/api/news/delete/:id", async (req, res) => {
    try {
        const item = await findNews(req.params.id);
        if (!item) return res.status(404).json({ error: "News item not found" });

        await News.deleteOne({ _id: item._id });
        res.json({ success: true, message: "News deleted successfully" });
    } catch (err) {
        console.error("DELETE ERROR:", err);
        res.status(500).json({ error: "Deletion failed" });
    }
});

// 4. URGENT QUEUE API
app.get("/api/news/urgent", async (req, res) => {
    try {
        const urgentItems = await News.find({
            $or: [{ verified: true, approved: true }, { escalated: true }],
        }).sort({ createdAt: -1 });

        console.log(`Urgent Queue Polled: Found ${urgentItems.length} items.`);
        res.json(urgentItems);
    } catch (err) {
        console.error("URGENT FETCH ERROR:", err);
        res.status(500).json([]);
    }
});

// 5. GENERIC ID ROUTE (must be below all specific /api/news/* routes)
app.get("/api/news/:id", async (req, res) => {
    try {
        const item = await findNews(req.params.id);
        if (!item) return res.status(404).json({ error: "News not found" });
        res.json(item);
    } catch (err) {
        res.status(500).json({ error: "Failed to load article" });
    }
});

// 6. CREATE NEWS
app.post("/api/news", async (req, res) => {
    try {
        const {
            title,
            content,
            location,
            categories,
            reporterName,
            reporterEmail,
            escalated,
            newsSource,
            videoLink,
        } = req.body;

        const newsDoc = new News({
            id: `user-${Date.now()}`,
            title,
            content,
            description: content ? content.substring(0, 200) : "",
            location,
            categories: Array.isArray(categories) ? categories : [categories].filter(Boolean),
            reporterName,
            reporterEmail,
            escalated: escalated === true || escalated === "true",
            newsSource,
            videoLink,
            verified: false,
            approved: escalated === true || escalated === "true",
            createdAt: new Date(),
        });

        const saved = await newsDoc.save();

        appendToCSV(saved);
        io.emit("news:created", saved);

        if (saved.escalated) {
            notifySubscribers(saved).catch((err) => console.error("Notification error:", err));
        }

        res.status(201).json({ success: true, item: saved });
    } catch (err) {
        console.error("SUBMISSION ERROR:", err);
        res.status(500).json({ success: false, error: "Failed to process submission" });
    }
});


// ==========================
// AI INITIALIZATION
// ==========================
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});


// ==========================
// AI ANALYSIS ROUTE 1 — by :id param
// ==========================
app.post("/api/ai/analyze-report/:id", async (req, res) => {
    try {
        const itemId = req.params.id;

        let item = await News.findById(itemId);
        if (!item) {
            item = await Report.findById(itemId);
        }

        if (!item) {
            return res.status(404).json({ error: "Item not found for analysis" });
        }

        const title = item.title || item.incidentType || "Untitled Report";
        const content = item.content || item.description || item.details || "No content available.";
        const location = item.location || item.state || "Unknown Location";
        const categories = (item.categories || item.tags || []).filter((c) => c).join(", ");

        const prompt = `
You are a crisis-analysis AI for a peace & conflict early-warning system in Nigeria.
Analyze this incident report and return a structured JSON response.

Incident Details:
- Title: ${title}
- Content: ${content}
- Location: ${location}
- Categories: ${categories}

Return ONLY the JSON object, following this exact format and structure. Do not add any text before or after the JSON.
{
    "severity": [NUMBER 1-10, where 10 is highest risk/severity],
    "incidentType": "[Concise type, e.g., Communal Clash, Oil Theft, Kidnapping]",
    "summary": "[One concise paragraph summarizing the crisis, its cause, potential impact, and a brief recommendation.]"
}
`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are an expert crisis analyst. Your output must ONLY be a valid JSON object matching the requested schema. The JSON object must contain only the fields: severity, incidentType, and summary.",
                },
                { role: "user", content: prompt },
            ],
            response_format: { type: "json_object" },
        });

        const jsonText = completion.choices[0].message.content;

        let result;
        try {
            result = JSON.parse(jsonText);
        } catch (e) {
            console.error("JSON PARSING ERROR:", jsonText);
            throw new Error("AI returned invalid JSON: " + jsonText.substring(0, 50));
        }

        return res.json(result);
    } catch (err) {
        console.error("AI ANALYSIS ERROR (Route :id):", err.message || err);
        return res.status(500).json({
            error: "AI processing failed",
            message: err.message || "An unknown error occurred during AI processing.",
        });
    }
});


// ==========================
// AI ANALYSIS ROUTE 2 — by request body
// ==========================
app.post("/api/ai/analyze-item", async (req, res) => {
    try {
        const { id: itemId, title: bodyTitle, content: bodyContent } = req.body;

        let item = null;
        if (itemId) {
            item = await News.findById(itemId);
            if (!item) {
                item = await Report.findById(itemId);
            }
        }

        if (!item) {
            console.warn(`Item ID ${itemId} not found in DB for analysis. Using raw content.`);
        }

        const incidentTitle = item?.title || item?.incidentType || bodyTitle || "Untitled Report";
        const incidentContent = item?.content || item?.description || item?.details || bodyContent || "No content available.";
        const location = item?.location || item?.state || "Unknown Location";
        const categories = (item?.categories || item?.tags || []).filter((c) => c).join(", ");

        const prompt = `
You are a crisis-analysis AI for a peace & conflict early-warning system in Nigeria.
Analyze this incident report and return a structured JSON response.

Incident Details:
- Title: ${incidentTitle}
- Content: ${incidentContent}
- Location: ${location}
- Categories: ${categories}

Return ONLY the JSON object, following this exact format and structure. Do not add any text before or after the JSON.
{
    "severity": [NUMBER 1-10, where 10 is highest risk/severity],
    "incidentType": "[Concise type, e.g., Communal Clash, Oil Theft, Kidnapping]",
    "summary": "[One concise paragraph summarizing the crisis, its cause, potential impact, and a brief recommendation.]"
}
`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are an expert crisis analyst. Your output must ONLY be a valid JSON object matching the requested schema. The JSON object must contain only the fields: severity, incidentType, and summary.",
                },
                { role: "user", content: prompt },
            ],
            response_format: { type: "json_object" },
        });

        const jsonText = completion.choices[0].message.content;

        let result;
        try {
            result = JSON.parse(jsonText);
        } catch (e) {
            console.error("JSON PARSING ERROR:", jsonText);
            throw new Error("AI returned invalid JSON: " + jsonText.substring(0, 50));
        }

        return res.json(result);
    } catch (err) {
        console.error("AI ANALYSIS ERROR (Route /analyze-item):", err.message || err);
        return res.status(500).json({
            error: "AI processing failed",
            message: err.message || "An unknown error occurred during AI processing.",
        });
    }
});


// ==========================
// GET LATEST NEWS
// ==========================
app.get("/get-news", async (req, res) => {
    try {
        const items = await News.find().sort({ createdAt: -1 }).limit(200);
        res.json(items);
    } catch (err) {
        console.error("GET-NEWS ERROR:", err);
        res.status(500).json([]);
    }
});


// ==========================
// SUBSCRIBE ALERT
// ==========================
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


// ==========================
// SUBMIT REPORT
// ==========================
app.post("/api/submit-report", async (req, res) => {
    try {
        const { title, content, category, location } = req.body;

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
            photos: [],
            videoLink: "",
            verified: false,
            approved: false,
            createdAt: new Date(),
        };

        const created = await News.create(doc);

        appendToCSV(created);

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


// ==========================
// EMAIL HELPER
// ==========================
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
            auth: { user, pass },
        });

        const info = await transporter.sendMail({ from, to, subject, text });
        console.log("Email sent:", info.messageId);
        return { ok: true, info };
    } catch (err) {
        console.error("sendEmail error:", err);
        return { ok: false, error: err.message || err };
    }
}


// ==========================
// WHATSAPP HELPER
// ==========================
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


// ==========================
// NOTIFY SUBSCRIBERS
// ==========================
async function notifySubscribers(news) {
    try {
        if (!news || !news.location) return;

        const subs = await Subscription.find().lean();
        const newsLoc = String(news.location || "").toLowerCase();

        const message = `CIEPD Alert — ${news.title}\nLocation: ${news.location}\nCategories: ${Array.isArray(news.categories) ? news.categories.join(", ") : news.categories}\nDate: ${new Date(news.createdAt).toLocaleString()}\n\nDetails: ${news.description || (news.content || "").slice(0, 150)}`;

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
                    }
                }
            } catch (err) {
                console.error("Notify single sub error:", err);
            }
        }
    } catch (err) {
        console.error("notifySubscribers overall error:", err);
    }
}


// ==========================
// CSV AUTO-BACKUP HELPER
// ==========================
const appendToCSV = (item) => {
    if (process.env.VERCEL) return;

    const filePath = path.join(__dirname, "news.csv");
    const row = `\n"${item.id}","${item.title}","${item.description}","${item.location}","${item.categories?.[0] || ""}","${item.verified ? "YES" : "NO"}","${item.approved ? "YES" : "NO"}","${item.createdAt}"`;

    fs.appendFile(filePath, row, (err) => {
        if (err) console.error("❌ Failed to backup to CSV:", err);
        else console.log("💾 News backed up to news.csv");
    });
};


// ==========================
// STATIC FILES
// ==========================
app.use(express.static(path.join(__dirname, "public")));


// ==========================
// SERVER START
// ==========================
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
    server.listen(PORT, async () => {
        console.log(`🚀 Local Server running on port ${PORT}`);
        await connectDB();
        await ensureAdmin();
        await importCSV();
    });
} else {
    connectDB().then(() => {
        ensureAdmin().catch(e => console.error("Admin check failed", e));
    });
}

export default app;