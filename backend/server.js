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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// -------------------
// Config
// -------------------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/ciepd";
const SESSION_SECRET = process.env.SESSION_SECRET || "secretKey";

// -------------------
// Middleware
// -------------------

// SAME-DOMAIN, so CORS should be *simple*
app.use(
  cors({
    origin: "*",
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // using http on Render free plan
      sameSite: "lax",
    },
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// -------------------
// Database
// -------------------
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err));

// -------------------
// User Schema
// -------------------
const userSchema = new mongoose.Schema({
  username: String,
  email: String,
  password: String,
  resetToken: String,
  role: { type: String, default: "user" },
});
const User = mongoose.model("User", userSchema);

// -------------------
// Ensure Admin User
// -------------------
(async () => {
  try {
    const adminEmail = "admin@ciepd.com";
    const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

    let admin = await User.findOne({ email: adminEmail });
    if (!admin) {
      const hash = await bcrypt.hash(adminPassword, 10);
      admin = new User({
        username: "Admin",
        email: adminEmail,
        password: hash,
        role: "admin",
      });
      await admin.save();
      console.log("✅ Admin created");
    } else {
      console.log("✅ Admin already exists");
    }
  } catch (err) {
    console.error("Admin error:", err);
  }
})();

// -------------------
// Auth Routes
// -------------------
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user) return res.status(400).send("User not found");

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).send("Incorrect password");

    req.session.userId = user._id;
    req.session.role = user.role;

    res.json({ message: "Logged in", role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).send("Login error");
  }
});

app.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const user = new User({ username, email, password: hash });
    await user.save();
    res.send("Registered!");
  } catch (err) {
    res.status(500).send("Registration error");
  }
});

// -------------------
// Pages
// -------------------
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "home.html"))
);

const pages = ["admin.html", "login.html", "report.html", "submit.html"];
pages.forEach((p) =>
  app.get(`/${p}`, (req, res) =>
    res.sendFile(path.join(__dirname, "public", p))
  )
);

// -------------------
// Start
// -------------------
server.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
