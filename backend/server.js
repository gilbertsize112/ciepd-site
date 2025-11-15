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
import csv from "csv-parser";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
    session({
        secret: "ciepd_secret_key",
        resave: false,
        saveUninitialized: true,
    })
);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Models
import Admin from "./models/admin.js";
import User from "./models/User.js";
import News from "./models/news.js";

// ===============================================
// MONGODB + AUTO CREATE DEFAULT ADMIN
// ===============================================
mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log("MongoDB Connected");

        // AUTO CREATE DEFAULT ADMIN
        const existing = await Admin.findOne({ email: "ciepdngo@gmail.com" });
        if (!existing) {
            const hashed = await bcrypt.hash("Admin@123", 10);
            await Admin.create({
                email: "ciepdngo@gmail.com",
                password: hashed
            });
            console.log("Default admin created: ciepdngo@gmail.com / Admin@123");
        } else {
            console.log("Default admin already exists.");
        }
    })
    .catch((err) => console.error(err));

// ===============================================
// ADMIN LOGIN
// ===============================================
app.post("/admin/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        console.log("Login attempt:", email);

        const admin = await Admin.findOne({ email });
        if (!admin) return res.status(400).json({ message: "Invalid email" });

        const match = await bcrypt.compare(password, admin.password);
        if (!match) return res.status(400).json({ message: "Incorrect password" });

        req.session.admin = admin._id;

        res.json({ message: "Login successful", role: "admin" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error during login" });
    }
});

// ===============================================
// LOGOUT
// ===============================================
app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/login.html");
    });
});

// ===============================================
// NEWS API
// ===============================================
app.get("/api/news", async (req, res) => {
    const news = await News.find().sort({ createdAt: -1 });
    res.json(news);
});

app.post("/api/news", async (req, res) => {
    const { title, description, content, author, location, categories } = req.body;

    const news = new News({
        title,
        description,
        content,
        author,
        location,
        categories,
        verified: false,
        approved: false,
        createdAt: new Date()
    });

    await news.save();
    io.emit("news-updated");

    res.json({ message: "News submitted successfully" });
});

app.put("/api/news/verify/:id", async (req, res) => {
    const news = await News.findByIdAndUpdate(
        req.params.id,
        { verified: true },
        { new: true }
    );
    io.emit("news-updated");
    res.json({ message: "News verified", news });
});

app.put("/api/news/approve/:id", async (req, res) => {
    const news = await News.findByIdAndUpdate(
        req.params.id,
        { approved: true },
        { new: true }
    );
    io.emit("news-updated");
    res.json({ message: "News approved", news });
});

app.delete("/api/news/delete/:id", async (req, res) => {
    await News.findByIdAndDelete(req.params.id);
    io.emit("news-updated");
    res.json({ message: "News deleted" });
});

// ===============================================
// USER REGISTRATION
// ===============================================
app.post("/register", async (req, res) => {
    const { fullname, phone, lga } = req.body;

    const user = new User({ fullname, phone, lga });
    await user.save();

    res.json({ message: "User registered successfully" });
});

// ===============================================
// PAGE ROUTES
// ===============================================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// TEMPORARY: SHOW ALL ADMINS IN DATABASE
app.get("/debug/admins", async (req, res) => {
    const admins = await Admin.find();
    res.json(admins);
});


// ===============================================
// 404 HANDLER
// ===============================================
app.use((req, res) => {
    res.status(404).send("Page Not Found");
});

// ===============================================
// START SERVER
// ===============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
