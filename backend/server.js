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
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// -------------------
// Config
// -------------------
const PORT = process.env.PORT || 3000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/ciepd";
const SESSION_SECRET = process.env.SESSION_SECRET || "secretKey";

// -------------------
// Middleware
// -------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// -------------------
// Connect to MongoDB
// -------------------
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

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
// Ensure Admin User Exists
// -------------------
(async () => {
  try {
    const adminEmail = "admin@ciepd.com";
    const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

    let admin = await User.findOne({ email: adminEmail });
    if (!admin) {
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      admin = new User({
        username: "Admin",
        email: adminEmail,
        password: hashedPassword,
        role: "admin",
      });
      await admin.save();
      console.log("✅ Admin user created automatically");
    } else {
      console.log("✅ Admin user already exists");
    }
  } catch (err) {
    console.error("Error ensuring admin user:", err);
  }
})();

// -------------------
// News Schema
// -------------------
const newsSchema = new mongoose.Schema({
  title: String,
  content: String,
  location: String,
  categories: [String],
  firstName: String,
  lastName: String,
  email: String,
  verified: { type: Boolean, default: false },
  approved: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
const News = mongoose.model("News", newsSchema);

// -------------------
// Auth Routes
// -------------------
app.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ username, email, password: hashed });
    await user.save();
    res.send("✅ Registered successfully!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error registering user");
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).send("User not found");

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).send("Incorrect password");

    req.session.userId = user._id;
    req.session.userEmail = user.email;
    req.session.role = user.role;

    res.json({
      message: "✅ Logged in successfully!",
      role: user.role,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Login error");
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).send("Error logging out");
    res.clearCookie("connect.sid");
    res.send("✅ Logged out successfully!");
  });
});

// -------------------
// Admin Middleware
// -------------------
function isAdmin(req, res, next) {
  if (!req.session.userId)
    return res.status(401).send("Please log in");
  if (req.session.role !== "admin")
    return res.status(403).send("Access denied");
  next();
}

// -------------------
// Serve Pages
// -------------------
const pages = [
  "admin.html",
  "settings.html",
  "admin-map.html",
  "home.html",
  "report.html",
  "submit.html",
  "getalert.html",
  "message.html",
];

pages.forEach((page) => {
  app.get(`/${page}`, (req, res) =>
    res.sendFile(path.join(__dirname, "public", page))
  );
});

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "home.html"))
);

// -------------------
// Password Reset
// -------------------
app.post("/reset-password-request", async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(400).send("User not found");
  const token = Math.random().toString(36).substring(2, 15);
  user.resetToken = token;
  await user.save();
  res.send(`Password reset token: ${token}`);
});

app.post("/reset-password", async (req, res) => {
  const { email, token, newPassword } = req.body;
  const user = await User.findOne({ email });
  if (!user || user.resetToken !== token)
    return res.status(400).send("Invalid token");
  user.password = await bcrypt.hash(newPassword, 10);
  user.resetToken = null;
  await user.save();
  res.send("✅ Password reset successfully!");
});

// -------------------
// News Routes
// -------------------
app.post("/submit-news", async (req, res) => {
  try {
    const { title, content, location, categories, first, last, email } =
      req.body;
    const news = new News({
      title,
      content,
      location,
      categories,
      firstName: first,
      lastName: last,
      email,
    });
    await news.save();

    // Emit new news to all connected clients
    io.emit("new-news", news);

    res.send("✅ Report submitted successfully!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error submitting report");
  }
});

app.get("/get-news", async (req, res) => {
  try {
    const newsList = await News.find().sort({ createdAt: -1 });
    res.json(newsList);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching reports");
  }
});

app.post("/verify/:id", isAdmin, async (req, res) => {
  try {
    const news = await News.findById(req.params.id);
    if (!news) return res.status(404).send("Report not found");
    news.verified = true;
    await news.save();
    res.send("✅ Report verified successfully!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error verifying report");
  }
});

app.post("/approve/:id", isAdmin, async (req, res) => {
  try {
    const news = await News.findById(req.params.id);
    if (!news) return res.status(404).send("Report not found");
    if (!news.verified)
      return res
        .status(400)
        .send("⚠️ Report must be verified before approval");
    news.approved = true;
    await news.save();
    res.send("✅ Report approved successfully!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error approving report");
  }
});

// -------------------
// Socket.IO
// -------------------
io.on("connection", (socket) => {
  console.log("🟢 Socket.IO client connected");
  socket.on("disconnect", () => console.log("🔴 Client disconnected"));
});

// -------------------
// Start Server
// -------------------
server.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
