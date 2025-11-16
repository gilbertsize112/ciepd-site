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

// -------------------------
// Basic Setup
// -------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "super-secret",
    resave: false,
    saveUninitialized: false,
  })
);

// -------------------------
// MongoDB Connection
// -------------------------
mongoose
  .connect(process.env.MONGO_URI, { dbName: "CIEPD" })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB Error:", err));

// -------------------------
// Schemas
// -------------------------
const UserSchema = new mongoose.Schema({
  username: String,
  password: String,
});

const NewsSchema = new mongoose.Schema({
  id: String,
  title: String,
  content: String,
  date: String,
  image: String,
  verified: { type: Boolean, default: false },
  approved: { type: Boolean, default: false }
});

const ReportSchema = new mongoose.Schema({
  id: String,
  title: String,
  description: String,
  date: String,
  file: String,
});

const User = mongoose.model("User", UserSchema);
const News = mongoose.model("News", NewsSchema);
const Report = mongoose.model("Report", ReportSchema);

// -------------------------
// Multer Setup
// -------------------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const folder = file.fieldname === "newsImage" ? "uploads/news" : "uploads/reports";
    cb(null, folder);
  },
  filename: function (req, file, cb) {
    cb(null, uuidv4() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

// -------------------------
// Auth Middleware
// -------------------------
function isLoggedIn(req, res, next) {
  if (req.session.userId) return next();
  return res.status(401).json({ message: "Unauthorized" });
}

// -------------------------
// AUTH ROUTES
// -------------------------

// Register Admin (one-time)
app.post("/register-admin", async (req, res) => {
  const { username, password } = req.body;

  const exists = await User.findOne({ username });
  if (exists) return res.status(400).json({ message: "Admin already exists" });

  const hashed = await bcrypt.hash(password, 10);
  await User.create({ username, password: hashed });

  res.json({ message: "Admin registered successfully" });
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const admin = await User.findOne({ username });
  if (!admin) return res.status(404).json({ message: "User not found" });

  const match = await bcrypt.compare(password, admin.password);
  if (!match) return res.status(400).json({ message: "Incorrect password" });

  req.session.userId = admin._id;
  res.json({ message: "Login successful" });
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.json({ message: "Logged out" });
});

// -------------------------
// NEWS ROUTES
// -------------------------

// Add News
app.post("/add-news", isLoggedIn, upload.single("newsImage"), async (req, res) => {
  const id = uuidv4();
  const { title, content, date } = req.body;

  const image = req.file ? `/uploads/news/${req.file.filename}` : "";

  const news = new News({ id, title, content, date, image });
  await news.save();

  res.json({ message: "News added successfully" });
});

// Get News (for frontend)
app.get("/news", async (req, res) => {
  const news = await News.find().sort({ _id: -1 });
  res.json(news);
});

// ADMIN DASHBOARD: Get All Reports with verification
app.get("/api/news", async (req, res) => {
  const news = await News.find().sort({ _id: -1 });
  res.json(news);
});

// Verify Report
app.put("/api/news/verify/:id", async (req, res) => {
  await News.updateOne({ id: req.params.id }, { verified: true });
  res.json({ message: "Report verified" });
});

// Approve Report
app.put("/api/news/approve/:id", async (req, res) => {
  await News.updateOne({ id: req.params.id }, { approved: true });
  res.json({ message: "Report approved" });
});

// Delete Report (Dashboard delete)
app.delete("/api/news/delete/:id", async (req, res) => {
  await News.deleteOne({ id: req.params.id });
  res.json({ message: "Report deleted" });
});

// Delete News
app.delete("/news/:id", isLoggedIn, async (req, res) => {
  const { id } = req.params;

  const item = await News.findOne({ id });
  if (!item) return res.status(404).json({ message: "News not found" });

  if (item.image) {
    fs.unlink("." + item.image, () => {});
  }

  await News.deleteOne({ id });
  res.json({ message: "News deleted" });
});

// -------------------------
// REPORT ROUTES
// -------------------------

// Upload Report
app.post("/add-report", isLoggedIn, upload.single("reportFile"), async (req, res) => {
  const id = uuidv4();
  const { title, description, date } = req.body;

  const file = req.file ? `/uploads/reports/${req.file.filename}` : "";

  await Report.create({ id, title, description, date, file });

  res.json({ message: "Report uploaded successfully" });
});

// Get Reports
app.get("/reports", async (req, res) => {
  const reports = await Report.find().sort({ _id: -1 });
  res.json(reports);
});

// Delete Report
app.delete("/reports/:id", isLoggedIn, async (req, res) => {
  const { id } = req.params;

  const report = await Report.findOne({ id });
  if (!report) return res.status(404).json({ message: "Report not found" });

  if (report.file) {
    fs.unlink("." + report.file, () => {});
  }

  await Report.deleteOne({ id });
  res.json({ message: "Report deleted" });
});

// -------------------------
// Static Files
// -------------------------
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static(path.join(__dirname, "public")));

// -------------------------
// Start Server
// -------------------------
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
