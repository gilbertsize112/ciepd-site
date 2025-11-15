import mongoose from "mongoose";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import Admin from "./models/admin.js";

dotenv.config();

async function createAdmin() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("Connected to MongoDB");

        const email = "admin@ciepd.com";
        const password = "admin123";

        // Check if admin already exists
        const existing = await Admin.findOne({ email });
        if (existing) {
            console.log("Admin already exists:", email);
            process.exit();
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        const admin = new Admin({
            email,
            password: hashedPassword
        });

        await admin.save();

        console.log("Admin created successfully:");
        console.log("Email:", email);
        console.log("Password:", password);

        process.exit();
    } catch (err) {
        console.error(err);
        process.exit();
    }
}

createAdmin();
