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
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";

dotenv.config();

// Setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Ensure uploads/news folder exists
const newsDir = path.join(__dirname, "uploads/news");
if (!fs.existsSync(newsDir)) {
    fs.mkdirSync(newsDir, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session
app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
  })
);

// Static Files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static(path.join(__dirname, "public")));

/* ============================
   MONGODB CONNECTION (FIXED)
============================ */

console.log("DEBUG:: MONGODB_URI =", process.env.MONGODB_URI);

mongoose
  .connect(process.env.MONGODB_URI, {
    dbName: "ciepd",
  })
  .then(() => console.log("✅ MongoDB Connected Successfully"))
  .catch((err) => console.log("❌ MongoDB Error:", err));

mongoose.connection.on("error", (err) => {
  console.log("❌ MongoDB Connection Failed:", err);
});

/* ============================
   USER MODEL
============================ */
const UserSchema = new mongoose.Schema({
  username: String,
  password: String,
});
const User = mongoose.model("User", UserSchema);

/* ============================
   NEWS MODEL
============================ */
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

/* ============================
   AUTH MIDDLEWARE
============================ */
function isLoggedIn(req, res, next) {
  if (req.session.user) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

/* ============================
   MULTER (UPLOAD IMAGES)
============================ */
const storageNews = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/news");
  },
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  },
});
const uploadNews = multer({ storage: storageNews });

/* ============================
   LOGIN ROUTE
============================ */
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const adminUser = await User.findOne({ username });
  if (!adminUser) return res.json({ error: "Invalid Username" });

  const match = await bcrypt.compare(password, adminUser.password);
  if (!match) return res.json({ error: "Invalid Password" });

  req.session.user = adminUser;
  res.json({ message: "Login successful" });
});

/* ============================
   ADD NEWS
============================ */
app.post("/add-news", isLoggedIn, uploadNews.single("newsImage"), async (req, res) => {
  const id = uuidv4();

  const { title, description, content, location, categories } = req.body;

  const image = req.file ? `/uploads/news/${req.file.filename}` : "";

  const news = new News({
    id,
    title,
    description,
    content,
    location,
    categories: categories ? categories.split(",").map(c => c.trim()) : [],
    image,
  });

  await news.save();
  io.emit("news-updated");

  res.json({ message: "News added successfully" });
});

/* ============================
   GET NEWS
============================ */
app.get("/api/news", async (req, res) => {
  const allNews = await News.find().sort({ createdAt: -1 });
  res.json(allNews);
});

/* ============================
   VERIFY NEWS
============================ */
app.put("/api/news/verify/:id", isLoggedIn, async (req, res) => {
  await News.findOneAndUpdate({ id: req.params.id }, { verified: true });
  io.emit("news-updated");
  res.json({ message: "News verified" });
});

/* ============================
   APPROVE NEWS
============================ */
app.put("/api/news/approve/:id", isLoggedIn, async (req, res) => {
  await News.findOneAndUpdate({ id: req.params.id }, { approved: true });
  io.emit("news-updated");
  res.json({ message: "News approved" });
});

/* ============================
   DELETE NEWS
============================ */
app.delete("/api/news/delete/:id", isLoggedIn, async (req, res) => {
  await News.findOneAndDelete({ id: req.params.id });
  io.emit("news-updated");
  res.json({ message: "News deleted" });
});

/* ============================
   ADMIN PAGE
============================ */
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public/admin.html"));
});

/* ============================
   START SERVER
============================ */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
