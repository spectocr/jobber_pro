#!/usr/bin/env node
/**
 * Jobber Pro - Cloud Version with MongoDB & Authentication
 * Field Service Management System
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcrypt');
const { MongoClient, ObjectId } = require('mongodb');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const emailService = require('./email-service');
const calendarService = require('./calendar-service');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'jobber_pro';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';

// Twilio setup
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio SMS enabled');
} else {
    console.log('⚠️  Twilio not configured - SMS features disabled');
}

// AWS S3 setup
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

let s3Client = null;
if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && S3_BUCKET_NAME) {
    s3Client = new S3Client({
        region: AWS_REGION,
        credentials: {
            accessKeyId: AWS_ACCESS_KEY_ID,
            secretAccessKey: AWS_SECRET_ACCESS_KEY
        }
    });
    console.log('✅ AWS S3 enabled - Bucket:', S3_BUCKET_NAME);
} else {
    console.log('⚠️  AWS S3 not configured - Attachments will be stored in MongoDB');
}

let db = null;
let client = null;

// Connect to MongoDB
async function connectDB() {
    try {
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(DB_NAME);
        console.log('✅ Connected to MongoDB');

        // Create indexes
        await db.collection('users').createIndex({ email: 1 }, { unique: true });
        await db.collection('clients').createIndex({ name: 1 });
        await db.collection('jobs').createIndex({ scheduledDate: 1 });
        await db.collection('jobs').createIndex({ clientId: 1 });
        await db.collection('team').createIndex({ name: 1 });

        // Check if admin user exists
        const adminCount = await db.collection('users').countDocuments({ role: 'admin' });
        if (adminCount === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await db.collection('users').insertOne({
                email: 'admin@jobber.pro',
                password: hashedPassword,
                name: 'Admin User',
                role: 'admin',
                createdAt: new Date()
            });
            console.log('👤 Default admin created: admin@jobber.pro / admin123');
            console.log('⚠️  CHANGE THIS PASSWORD IMMEDIATELY!');
        }

        // Initialize default data if collections are empty
        const teamCount = await db.collection('team').countDocuments();
        if (teamCount === 0) {
            await db.collection('team').insertMany([
                { name: 'John Smith', role: 'Technician', phone: '555-0101', email: 'john@example.com', active: true, createdAt: new Date() },
                { name: 'Sarah Johnson', role: 'Technician', phone: '555-0102', email: 'sarah@example.com', active: true, createdAt: new Date() }
            ]);
        }

        const settingsCount = await db.collection('settings').countDocuments();
        if (settingsCount === 0) {
            await db.collection('settings').insertOne({
                companyName: 'Your Company',
                companyAddress: '123 Main St\nYour City, NJ 12345',
                companyPhone: '(555) 123-4567',
                companyEmail: 'info@yourcompany.com',
                hourlyRate: 75,
                taxRate: 0.06625,
                companyLogo: '',
                createdAt: new Date()
            });
        }
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

// Middleware to check if user is authenticated
function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}

function isAdmin(req, res, next) {
    if (req.session && req.session.userId && req.session.userRole === 'admin') {
        return next();
    }
    res.status(403).json({ error: 'Forbidden - Admin access required' });
}

// SMS Helper Function
async function sendSMS(to, message) {
    if (!twilioClient) {
        console.log('SMS not sent (Twilio not configured):', to, message);
        return { success: false, error: 'Twilio not configured' };
    }

    try {
        // Format phone number
        let phoneNumber = to.replace(/\D/g, '');
        if (phoneNumber.length === 10) {
            phoneNumber = '+1' + phoneNumber;
        } else if (phoneNumber.length === 11 && phoneNumber.startsWith('1')) {
            phoneNumber = '+' + phoneNumber;
        } else if (!phoneNumber.startsWith('+')) {
            phoneNumber = '+' + phoneNumber;
        }

        const result = await twilioClient.messages.create({
            body: message,
            from: TWILIO_PHONE_NUMBER,
            to: phoneNumber
        });

        console.log('✅ SMS sent to', phoneNumber, '- SID:', result.sid);
        return { success: true, sid: result.sid };
    } catch (error) {
        console.error('❌ SMS error:', error.message);
        return { success: false, error: error.message };
    }
}

// S3 Helper Functions
async function uploadToS3(fileBuffer, fileName, contentType) {
    if (!s3Client) {
        throw new Error('S3 not configured');
    }

    const key = `jobber-attachments/${Date.now()}-${fileName}`;
    const command = new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType
    });

    try {
        await s3Client.send(command);
        console.log('✅ File uploaded to S3:', key);
        return key;
    } catch (error) {
        console.error('❌ S3 upload error:', error);
        throw error;
    }
}

async function getS3SignedUrl(key, expiresIn = 3600) {
    if (!s3Client) {
        throw new Error('S3 not configured');
    }

    const command = new GetObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key
    });

    try {
        const url = await getSignedUrl(s3Client, command, { expiresIn });
        return url;
    } catch (error) {
        console.error('❌ S3 signed URL error:', error);
        throw error;
    }
}

async function deleteFromS3(key) {
    if (!s3Client) {
        throw new Error('S3 not configured');
    }

    const command = new DeleteObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key
    });

    try {
        await s3Client.send(command);
        console.log('✅ File deleted from S3:', key);
    } catch (error) {
        console.error('❌ S3 delete error:', error);
        throw error;
    }
}

// Load HTML template
console.log('Loading HTML template...');
const originalFile = fs.readFileSync(path.join(__dirname, 'jobber-pro-server.js'), 'utf8');
const templateStart = 'const HTML_TEMPLATE = `';
const templateEnd = '</html>`;\n\n// API Routes';
const htmlStart = originalFile.indexOf(templateStart);
const htmlEnd = originalFile.indexOf(templateEnd);
let HTML_TEMPLATE = originalFile.substring(htmlStart + templateStart.length, htmlEnd + 7);
HTML_TEMPLATE = HTML_TEMPLATE.replace(/\\`/g, '`').replace(/\\\$/g, '$');
console.log('✅ HTML template loaded (' + HTML_TEMPLATE.length + ' chars)');

// Login page HTML
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login - Jobber Pro</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .login-container {
            background: white;
            padding: 3rem;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            width: 100%;
            max-width: 400px;
        }
        h1 {
            color: #667eea;
            margin-bottom: 0.5rem;
            font-size: 2rem;
        }
        p {
            color: #718096;
            margin-bottom: 2rem;
        }
        .form-group {
            margin-bottom: 1.5rem;
        }
        label {
            display: block;
            margin-bottom: 0.5rem;
            color: #4a5568;
            font-weight: 600;
        }
        input {
            width: 100%;
            padding: 0.75rem;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 1rem;
            transition: border-color 0.3s;
        }
        input:focus {
            outline: none;
            border-color: #667eea;
        }
        .btn {
            width: 100%;
            padding: 0.875rem;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
        }
        .error {
            color: #e53e3e;
            background: #fff5f5;
            border: 1px solid #feb2b2;
            padding: 0.75rem;
            border-radius: 8px;
            margin-bottom: 1rem;
            display: none;
        }
        .error.show {
            display: block;
        }
        .register-link {
            text-align: center;
            margin-top: 1.5rem;
            color: #718096;
        }
        .register-link a {
            color: #667eea;
            text-decoration: none;
            font-weight: 600;
        }
        .register-link a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <h1>⚡ Jobber Pro</h1>
        <p>Sign in to your account</p>

        <div id="error" class="error"></div>

        <form id="loginForm">
            <div class="form-group">
                <label for="email">Email Address</label>
                <input type="email" id="email" name="email" required autocomplete="email">
            </div>
            <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password" required autocomplete="current-password">
            </div>
            <button type="submit" class="btn">Sign In</button>
        </form>

        <div class="register-link">
            Don't have an account? <a href="/register">Sign up</a>
        </div>
    </div>

    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const error = document.getElementById('error');
            error.classList.remove('show');

            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;

            try {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json();

                if (response.ok) {
                    window.location.href = '/';
                } else {
                    error.textContent = data.error || 'Invalid credentials';
                    error.classList.add('show');
                }
            } catch (err) {
                error.textContent = 'Connection error. Please try again.';
                error.classList.add('show');
            }
        });
    </script>
</body>
</html>`;

// Register page HTML
const REGISTER_HTML = LOGIN_HTML.replace('Sign in to your account', 'Create your account')
    .replace('Sign In', 'Sign Up')
    .replace('/api/auth/login', '/api/auth/register')
    .replace('loginForm', 'registerForm')
    .replace("Don't have an account? <a href=\"/register\">Sign up</a>", 'Already have an account? <a href="/login">Sign in</a>')
    .replace('<input type="email" id="email"', '<div class="form-group"><label for="name">Full Name</label><input type="text" id="name" name="name" required></div><div class="form-group"><label for="email">Email Address</label><input type="email" id="email"');

// Start Express app
const app = express();

// Trust proxy (Heroku uses load balancer)
app.set('trust proxy', 1);

// Middleware - increase limit for base64 file uploads (50MB max)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Function to setup routes (called after session middleware is ready)
function setupRoutes() {
// Routes
app.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.send(LOGIN_HTML);
});

app.get('/register', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.send(REGISTER_HTML);
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Check if user exists
        const existing = await db.collection('users').findOne({ email: email.toLowerCase() });
        if (existing) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const result = await db.collection('users').insertOne({
            name,
            email: email.toLowerCase(),
            password: hashedPassword,
            role: 'user',
            createdAt: new Date()
        });

        req.session.userId = result.insertedId;
        req.session.userEmail = email;
        req.session.userName = name;

        // Save session before responding
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Registration failed' });
            }
            res.json({ success: true });
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await db.collection('users').findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Update last login time
        await db.collection('users').updateOne(
            { _id: user._id },
            { $set: { lastLogin: new Date() } }
        );

        req.session.userId = user._id;
        req.session.userEmail = user.email;
        req.session.userName = user.name;
        req.session.userRole = user.role || 'user';

        // Save session before responding
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Login failed' });
            }
            res.json({ success: true });
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.json({ success: true });
    });
});

app.get('/api/auth/me', isAuthenticated, async (req, res) => {
    const user = await db.collection('users').findOne(
        { _id: new ObjectId(req.session.userId) },
        { projection: { password: 0 } }
    );
    res.json(user);
});

// Change password
app.post('/api/auth/change-password', isAuthenticated, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }

        const user = await db.collection('users').findOne({ _id: new ObjectId(req.session.userId) });

        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.collection('users').updateOne(
            { _id: new ObjectId(req.session.userId) },
            { $set: { password: hashedPassword, updatedAt: new Date() } }
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Password change error:', error);
        res.status(500).json({ error: 'Password change failed' });
    }
});

// Get all users (admin only)
app.get('/api/users', isAuthenticated, async (req, res) => {
    try {
        const currentUser = await db.collection('users').findOne({ _id: new ObjectId(req.session.userId) });

        if (currentUser.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const users = await db.collection('users')
            .find({}, { projection: { password: 0 } })
            .sort({ createdAt: -1 })
            .toArray();

        res.json(users);
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Create new user (admin only)
app.post('/api/users', isAuthenticated, async (req, res) => {
    try {
        const currentUser = await db.collection('users').findOne({ _id: new ObjectId(req.session.userId) });

        if (currentUser.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { name, email, password, role } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const existing = await db.collection('users').findOne({ email: email.toLowerCase() });
        if (existing) {
            return res.status(400).json({ error: 'Email already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await db.collection('users').insertOne({
            name,
            email: email.toLowerCase(),
            password: hashedPassword,
            role: role || 'user',
            createdAt: new Date()
        });

        res.json({
            success: true,
            userId: result.insertedId
        });
    } catch (error) {
        console.error('Create user error:', error);
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// Update user (admin only)
app.put('/api/users/:id', isAuthenticated, async (req, res) => {
    try {
        const currentUser = await db.collection('users').findOne({ _id: new ObjectId(req.session.userId) });

        if (currentUser.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const userIdToUpdate = req.params.id;
        const { name, email, password, role } = req.body;

        if (!name || !email) {
            return res.status(400).json({ error: 'Name and email are required' });
        }

        // Check if email is being changed to one that already exists
        const existing = await db.collection('users').findOne({
            email: email.toLowerCase(),
            _id: { $ne: new ObjectId(userIdToUpdate) }
        });
        if (existing) {
            return res.status(400).json({ error: 'Email already exists' });
        }

        const updateData = {
            name,
            email: email.toLowerCase(),
            role: role || 'user',
            updatedAt: new Date()
        };

        // Only update password if provided
        if (password) {
            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }
            updateData.password = await bcrypt.hash(password, 10);
        }

        await db.collection('users').updateOne(
            { _id: new ObjectId(userIdToUpdate) },
            { $set: updateData }
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// Delete user (admin only)
app.delete('/api/users/:id', isAuthenticated, async (req, res) => {
    try {
        const currentUser = await db.collection('users').findOne({ _id: new ObjectId(req.session.userId) });

        if (currentUser.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const userIdToDelete = req.params.id;

        // Prevent self-deletion
        if (userIdToDelete === req.session.userId.toString()) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        await db.collection('users').deleteOne({ _id: new ObjectId(userIdToDelete) });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Privacy Policy page (public)
app.get('/privacy', async (req, res) => {
    const settings = await db.collection('settings').findOne() || {};
    const companyName = settings.companyName || 'Jobber Pro';
    const companyEmail = settings.companyEmail || 'contact@jobber-pro.com';
    const companyPhone = settings.companyPhone || '(555) 555-5555';
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Privacy Policy - ${companyName}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; background: #f5f5f5; }
        .container { max-width: 900px; margin: 0 auto; padding: 40px 20px; background: white; min-height: 100vh; }
        h1 { color: #667eea; font-size: 2.5em; margin-bottom: 0.5em; }
        h2 { color: #667eea; font-size: 1.8em; margin-top: 1.5em; margin-bottom: 0.5em; }
        h3 { color: #555; font-size: 1.3em; margin-top: 1.2em; margin-bottom: 0.4em; }
        p { margin-bottom: 1em; }
        ul { margin-left: 2em; margin-bottom: 1em; }
        li { margin-bottom: 0.5em; }
        .updated { color: #888; font-size: 0.9em; margin-bottom: 2em; }
        .footer { margin-top: 3em; padding-top: 2em; border-top: 2px solid #e2e8f0; text-align: center; color: #888; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Privacy Policy</h1>
        <p class="updated">Last Updated: ${new Date().toLocaleDateString()}</p>

        <p>At ${companyName}, we are committed to protecting your privacy and ensuring the security of your personal information. This Privacy Policy explains how we collect, use, share, and protect your information when you use our services.</p>

        <h2>1. Information We Collect</h2>

        <h3>Personal Information</h3>
        <p>We collect information that you provide directly to us, including:</p>
        <ul>
            <li><strong>Contact Information:</strong> Name, email address, phone number, and mailing address</li>
            <li><strong>Account Information:</strong> Username, password, and account preferences</li>
            <li><strong>Service Information:</strong> Details about the services you request, job history, quotes, and invoices</li>
            <li><strong>Payment Information:</strong> Payment method details (processed securely through our payment processors)</li>
            <li><strong>Communication Data:</strong> Messages, notes, and other communications with us</li>
        </ul>

        <h3>Automatically Collected Information</h3>
        <ul>
            <li><strong>Usage Data:</strong> How you interact with our services</li>
            <li><strong>Device Information:</strong> IP address, browser type, operating system</li>
            <li><strong>Cookies:</strong> We use cookies to maintain your session and improve your experience</li>
        </ul>

        <h2>2. How We Use Your Information</h2>
        <p>We use your information to:</p>
        <ul>
            <li>Provide, maintain, and improve our services</li>
            <li>Process and fulfill service requests</li>
            <li>Send you quotes, invoices, and service updates</li>
            <li>Communicate with you about your account and services</li>
            <li>Send appointment reminders and service notifications via SMS</li>
            <li>Respond to your inquiries and provide customer support</li>
            <li>Analyze usage patterns to improve our platform</li>
            <li>Comply with legal obligations and enforce our terms</li>
        </ul>

        <h2>3. SMS/Text Messaging</h2>
        <p>By providing your phone number, you consent to receive text messages from us regarding:</p>
        <ul>
            <li>Service appointment confirmations and reminders</li>
            <li>Job status updates</li>
            <li>Invoice and payment notifications</li>
            <li>Important account information</li>
        </ul>
        <p><strong>Opting Out:</strong> You may opt out of receiving text messages at any time by replying STOP to any message or contacting us directly. Message and data rates may apply.</p>

        <h2>4. Information Sharing</h2>
        <p>We do not sell your personal information. We may share your information with:</p>
        <ul>
            <li><strong>Service Providers:</strong> Third parties who perform services on our behalf (email, SMS, payment processing)</li>
            <li><strong>Legal Requirements:</strong> When required by law or to protect our rights</li>
            <li><strong>Business Transfers:</strong> In connection with a merger, sale, or acquisition</li>
        </ul>

        <h2>5. Data Security</h2>
        <p>We implement appropriate security measures to protect your personal information, including:</p>
        <ul>
            <li>Encryption of sensitive data</li>
            <li>Secure servers and databases</li>
            <li>Access controls and authentication</li>
            <li>Regular security assessments</li>
        </ul>

        <h2>6. Your Rights</h2>
        <p>You have the right to:</p>
        <ul>
            <li><strong>Access:</strong> Request a copy of your personal information</li>
            <li><strong>Correction:</strong> Update or correct your information</li>
            <li><strong>Deletion:</strong> Request deletion of your information</li>
            <li><strong>Opt-Out:</strong> Unsubscribe from marketing communications or SMS messages</li>
            <li><strong>Data Portability:</strong> Request your data in a portable format</li>
        </ul>

        <h2>7. Data Retention</h2>
        <p>We retain your information for as long as necessary to provide our services and comply with legal obligations. You may request deletion of your data at any time, subject to legal retention requirements.</p>

        <h2>8. Children's Privacy</h2>
        <p>Our services are not intended for individuals under 18 years of age. We do not knowingly collect personal information from children.</p>

        <h2>9. Changes to This Policy</h2>
        <p>We may update this Privacy Policy from time to time. We will notify you of any material changes by posting the new policy on this page and updating the "Last Updated" date.</p>

        <h2>10. Contact Us</h2>
        <p>If you have questions about this Privacy Policy or wish to exercise your privacy rights, please contact us:</p>
        <ul>
            <li>Email: ${companyEmail}</li>
            <li>Phone: ${companyPhone}</li>
        </ul>

        <div class="footer">
            <p>&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
        </div>
    </div>
</body>
</html>
    `);
});

// Terms and Conditions page (public)
app.get('/terms', async (req, res) => {
    const settings = await db.collection('settings').findOne() || {};
    const companyName = settings.companyName || 'Jobber Pro';
    const companyEmail = settings.companyEmail || 'contact@jobber-pro.com';
    const companyPhone = settings.companyPhone || '(555) 555-5555';
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Terms and Conditions - ${companyName}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; background: #f5f5f5; }
        .container { max-width: 900px; margin: 0 auto; padding: 40px 20px; background: white; min-height: 100vh; }
        h1 { color: #667eea; font-size: 2.5em; margin-bottom: 0.5em; }
        h2 { color: #667eea; font-size: 1.8em; margin-top: 1.5em; margin-bottom: 0.5em; }
        h3 { color: #555; font-size: 1.3em; margin-top: 1.2em; margin-bottom: 0.4em; }
        p { margin-bottom: 1em; }
        ul { margin-left: 2em; margin-bottom: 1em; }
        li { margin-bottom: 0.5em; }
        .updated { color: #888; font-size: 0.9em; margin-bottom: 2em; }
        .footer { margin-top: 3em; padding-top: 2em; border-top: 2px solid #e2e8f0; text-align: center; color: #888; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Terms and Conditions</h1>
        <p class="updated">Last Updated: ${new Date().toLocaleDateString()}</p>

        <p>Welcome to ${companyName}. By accessing or using our services, you agree to be bound by these Terms and Conditions. Please read them carefully.</p>

        <h2>1. Acceptance of Terms</h2>
        <p>By using our platform, mobile application, or services, you accept and agree to these Terms and Conditions and our Privacy Policy. If you do not agree, you may not use our services.</p>

        <h2>2. Description of Services</h2>
        <p>${companyName} provides a field service management platform that enables:</p>
        <ul>
            <li>Job scheduling and management</li>
            <li>Quote creation and approval</li>
            <li>Invoicing and payment processing</li>
            <li>Client communication via SMS and email</li>
            <li>Service history tracking</li>
        </ul>

        <h2>3. User Accounts</h2>

        <h3>Account Creation</h3>
        <ul>
            <li>You must provide accurate and complete information</li>
            <li>You are responsible for maintaining the confidentiality of your account credentials</li>
            <li>You are responsible for all activities under your account</li>
            <li>You must notify us immediately of any unauthorized access</li>
        </ul>

        <h3>Account Termination</h3>
        <p>We reserve the right to suspend or terminate accounts that violate these terms or engage in fraudulent, abusive, or illegal activities.</p>

        <h2>4. SMS/Text Messaging Terms</h2>

        <h3>Consent to Receive Messages</h3>
        <p>By providing your phone number, you expressly consent to receive text messages from us regarding:</p>
        <ul>
            <li>Service appointments and reminders</li>
            <li>Job status updates</li>
            <li>Invoice and payment notifications</li>
            <li>Account-related information</li>
        </ul>

        <h3>Message Frequency</h3>
        <p>Message frequency varies based on your service activity. You may receive multiple messages per week during active service periods.</p>

        <h3>Opt-Out</h3>
        <p>You may opt out at any time by:</p>
        <ul>
            <li>Replying STOP to any text message</li>
            <li>Contacting us directly to update your preferences</li>
            <li>Updating your communication preferences in your account settings</li>
        </ul>

        <h3>Carrier Charges</h3>
        <p>Message and data rates may apply. Please check with your mobile carrier for details about your messaging plan.</p>

        <h2>5. Payment Terms</h2>
        <ul>
            <li>Payment is due according to the terms specified on your invoice</li>
            <li>Late payments may be subject to fees or service suspension</li>
            <li>We accept various payment methods as indicated on invoices</li>
            <li>All prices are in USD unless otherwise stated</li>
        </ul>

        <h2>6. Service Quotes</h2>
        <ul>
            <li>Quotes are valid for the period specified on the quote</li>
            <li>Prices may change after quote expiration</li>
            <li>Final costs may vary based on actual work performed</li>
            <li>Quote acceptance constitutes agreement to proceed with services</li>
        </ul>

        <h2>7. Cancellation and Refund Policy</h2>
        <ul>
            <li>Cancellations must be made at least 24 hours before scheduled service</li>
            <li>Late cancellations may be subject to fees</li>
            <li>Refunds are handled on a case-by-case basis</li>
            <li>Service credits may be offered in lieu of refunds</li>
        </ul>

        <h2>8. User Conduct</h2>
        <p>You agree not to:</p>
        <ul>
            <li>Use the service for any illegal purpose</li>
            <li>Attempt to gain unauthorized access to our systems</li>
            <li>Interfere with or disrupt the service</li>
            <li>Impersonate others or provide false information</li>
            <li>Transmit viruses, malware, or harmful code</li>
            <li>Scrape, copy, or duplicate content without permission</li>
        </ul>

        <h2>9. Intellectual Property</h2>
        <p>All content, features, and functionality of our platform are owned by ${companyName} and protected by copyright, trademark, and other intellectual property laws.</p>

        <h2>10. Limitation of Liability</h2>
        <p>To the fullest extent permitted by law:</p>
        <ul>
            <li>We provide services "as is" without warranties of any kind</li>
            <li>We are not liable for indirect, incidental, or consequential damages</li>
            <li>Our total liability is limited to the amount you paid for services</li>
            <li>We are not responsible for third-party content or services</li>
        </ul>

        <h2>11. Indemnification</h2>
        <p>You agree to indemnify and hold harmless ${companyName} from any claims, damages, or expenses arising from your use of our services or violation of these terms.</p>

        <h2>12. Dispute Resolution</h2>
        <p>Any disputes will be resolved through:</p>
        <ul>
            <li>Good faith negotiation</li>
            <li>Mediation if negotiation fails</li>
            <li>Binding arbitration as a final resort</li>
        </ul>

        <h2>13. Modifications to Terms</h2>
        <p>We reserve the right to modify these terms at any time. Changes will be effective upon posting. Continued use of our services constitutes acceptance of modified terms.</p>

        <h2>14. Governing Law</h2>
        <p>These terms are governed by the laws of the jurisdiction in which our business operates, without regard to conflict of law principles.</p>

        <h2>15. Severability</h2>
        <p>If any provision of these terms is found to be unenforceable, the remaining provisions will remain in full force and effect.</p>

        <h2>16. Contact Information</h2>
        <p>For questions about these Terms and Conditions:</p>
        <ul>
            <li>Email: ${companyEmail}</li>
            <li>Phone: ${companyPhone}</li>
        </ul>

        <h2>17. Acknowledgment</h2>
        <p>By using ${companyName}, you acknowledge that you have read, understood, and agree to be bound by these Terms and Conditions and our Privacy Policy.</p>

        <div class="footer">
            <p>&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
            <p><a href="/privacy" style="color: #667eea; text-decoration: none;">Privacy Policy</a></p>
        </div>
    </div>
</body>
</html>
    `);
});

// Main app (protected)
app.get('/', (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.redirect('/login');
    }
    res.send(HTML_TEMPLATE);
});

// Protected API routes
app.get('/api/dashboard', isAuthenticated, async (req, res) => {
    const jobs = await db.collection('jobs').find().toArray();
    const clients = await db.collection('clients').find().toArray();
    const settings = await db.collection('settings').findOne() || {};

    // Map _id to id for frontend compatibility
    const jobsWithId = jobs.map(j => ({ ...j, id: j._id.toString() }));
    const clientsWithId = clients.map(c => ({ ...c, id: c._id.toString() }));

    const today = new Date().toISOString().split('T')[0];
    const thisMonth = new Date().toISOString().slice(0, 7);
    const taxRate = settings.taxRate || 0.06625;

    // Map jobs with proper ID conversion
    const jobsMapped = jobsWithId.map(j => ({
        ...j,
        id: j._id.toString(),
        clientId: (j.clientId && j.clientId !== 'undefined' && typeof j.clientId === 'object') ? j.clientId.toString() : null,
        assignedTo: (j.assignedTo && j.assignedTo !== 'undefined' && typeof j.assignedTo === 'object') ? j.assignedTo.toString() : null
    }));

    // job.total is already stored WITH tax included (or without if taxWaived)
    const completedJobsThisMonth = jobsMapped
        .filter(j => (j.status === 'invoiced' || j.status === 'completed') && j.scheduledDate && j.scheduledDate.startsWith(thisMonth));

    const totalRevenue = completedJobsThisMonth.reduce((sum, j) => sum + (parseFloat(j.total) || 0), 0);

    // Calculate profit (revenue - material costs)
    const totalMaterialCosts = completedJobsThisMonth.reduce((sum, j) => {
        if (j.materialItems && Array.isArray(j.materialItems)) {
            return sum + j.materialItems.reduce((mSum, item) => mSum + ((item.quantity || 0) * (item.price || 0)), 0);
        }
        return sum;
    }, 0);

    const totalProfit = totalRevenue - totalMaterialCosts;

    // Accounts Receivable calculation
    const totalAccountsReceivable = jobsMapped
        .filter(j => j.status === 'completed' || j.status === 'invoiced')
        .reduce((sum, j) => {
            const total = j.totalWithTax || parseFloat(j.total) || 0;
            const paid = parseFloat(j.totalPaid) || 0;
            return sum + Math.max(0, total - paid);
        }, 0);

    const accountsReceivableJobs = jobsMapped
        .filter(j => {
            if (j.status !== 'completed' && j.status !== 'invoiced') return false;
            const total = j.totalWithTax || parseFloat(j.total) || 0;
            const paid = parseFloat(j.totalPaid) || 0;
            const balance = total - paid;
            return balance > 0.01; // Exclude if balance is less than 1 cent (handles floating point precision)
        })
        .map(j => ({
            ...j,
            balanceOwed: (j.totalWithTax || parseFloat(j.total) || 0) - (parseFloat(j.totalPaid) || 0)
        }))
        .sort((a, b) => b.balanceOwed - a.balanceOwed);

    const stats = {
        totalClients: clientsWithId.length,
        totalJobs: jobsMapped.length,
        jobsToday: jobsMapped.filter(j => j.scheduledDate === today).length,
        jobsThisMonth: jobsMapped.filter(j => j.scheduledDate && j.scheduledDate.startsWith(thisMonth)).length,
        prospecting: jobsMapped.filter(j => j.status === 'prospecting').length,
        toBeScheduled: jobsMapped.filter(j => j.status === 'to_be_scheduled').length,
        scheduled: jobsMapped.filter(j => j.status === 'scheduled').length,
        inProgress: jobsMapped.filter(j => j.status === 'in_progress').length,
        completed: jobsMapped.filter(j => j.status === 'completed').length,
        invoiced: jobsMapped.filter(j => j.status === 'invoiced').length,
        bidLost: jobsMapped.filter(j => j.status === 'bid_lost').length,
        revenueThisMonth: totalRevenue,
        profitThisMonth: totalProfit,
        totalAccountsReceivable: totalAccountsReceivable,
        accountsReceivableJobs: accountsReceivableJobs,
        upcomingJobs: jobsMapped
            .filter(j => j.status === 'scheduled' && j.scheduledDate >= today)
            .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate)),
        inProgressJobs: jobsMapped
            .filter(j => j.status === 'in_progress')
            .sort((a, b) => (b.scheduledDate || '').localeCompare(a.scheduledDate || '')),
        completedLast30Days: jobsMapped
            .filter(j => j.status === 'completed' || j.status === 'invoiced')
            .sort((a, b) => {
                const aDate = a.completedDate || a.scheduledDate || '';
                const bDate = b.completedDate || b.scheduledDate || '';
                return bDate.localeCompare(aDate);
            })
            .slice(0, 20)
    };

    res.json(stats);
});

app.get('/api/clients', isAuthenticated, async (req, res) => {
    const clients = await db.collection('clients').find().toArray();
    // Map _id to id for frontend compatibility
    const clientsWithId = clients.map(c => ({ ...c, id: c._id.toString() }));
    res.json(clientsWithId);
});

app.post('/api/clients', isAuthenticated, async (req, res) => {
    const client = req.body;

    // Hash portal password if provided
    if (client.portalPassword) {
        client.portalPassword = await bcrypt.hash(client.portalPassword, 10);
    } else if (client.portalPassword === null) {
        // Explicitly remove portal access
        client.portalPassword = null;
    }

    if (client._id) {
        const { _id, ...updateData } = client;
        await db.collection('clients').updateOne(
            { _id: new ObjectId(_id) },
            { $set: { ...updateData, updatedAt: new Date() } }
        );
        res.json({ success: true, id: _id });
    } else {
        client.createdAt = new Date();
        const result = await db.collection('clients').insertOne(client);
        res.json({ success: true, id: result.insertedId.toString() });
    }
});

app.delete('/api/clients/:id', isAuthenticated, async (req, res) => {
    await db.collection('clients').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
});

app.post('/api/clients/send-portal-info', isAuthenticated, async (req, res) => {
    try {
        const { clientId } = req.body;

        const client = await db.collection('clients').findOne({ _id: new ObjectId(clientId) });
        if (!client) {
            return res.status(404).json({ error: 'Client not found' });
        }

        if (!client.email) {
            return res.status(400).json({ error: 'Client does not have an email address' });
        }

        if (!client.portalPassword) {
            return res.status(400).json({ error: 'Client does not have portal access enabled' });
        }

        const settings = await db.collection('settings').findOne({});
        const companyName = settings?.companyName || 'Your Company';

        // Get portal URL
        const portalUrl = `${process.env.APP_URL}/client-login`;

        // Note: We cannot retrieve the plaintext password since it's hashed
        // So we include instructions to contact support if they forgot it
        const subject = `Your ${companyName} Client Portal Access`;
        const html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #667eea; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border: 1px solid #ddd; border-radius: 0 0 8px 8px; }
        .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        .info-box { background: white; padding: 15px; border-left: 4px solid #667eea; margin: 20px 0; }
        .footer { text-align: center; color: #888; font-size: 12px; margin-top: 30px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Welcome to Your Client Portal</h1>
        </div>
        <div class="content">
            <p>Dear ${client.name},</p>
            <p>Your client portal has been set up! You can now view your quotes, jobs, and invoices online anytime.</p>

            <div class="info-box">
                <p><strong>📧 Your Email:</strong> ${client.email}</p>
                <p><strong>🔐 Your Access Code:</strong> The last 4 digits of your phone number on file</p>
            </div>

            <div style="text-align: center;">
                <a href="${portalUrl}" class="button">Access Your Portal</a>
            </div>

            <p><strong>What you can do in the portal:</strong></p>
            <ul>
                <li>View and approve quotes</li>
                <li>Track job progress</li>
                <li>View and download invoices</li>
                <li>See your complete service history</li>
            </ul>

            <p>If you have any questions or need assistance, please don't hesitate to contact us.</p>
        </div>
        <div class="footer">
            <p>${companyName}</p>
            <p>This is an automated notification</p>
        </div>
    </div>
</body>
</html>
        `;

        await emailService.sendEmail({
            to: client.email,
            subject: subject,
            html: html,
            text: `${companyName} Client Portal Access\n\nYour client portal is ready! Access it at: ${portalUrl}\n\nEmail: ${client.email}\nAccess Code: The last 4 digits of your phone number on file`
        });

        await db.collection('email_logs').insertOne({
            type: 'portal_access',
            to: client.email,
            toName: client.name,
            subject: subject,
            trigger: 'Portal access email sent manually',
            relatedId: client._id,
            relatedTitle: client.name,
            sentBy: req.session.userName || 'admin',
            sentAt: new Date(),
            status: 'sent'
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Send portal info error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/jobs', isAuthenticated, async (req, res) => {
    const jobs = await db.collection('jobs').find().toArray();
    const settings = await db.collection('settings').findOne() || {};
    const taxRate = settings.taxRate || 0.06625;

    // Map _id to id and ObjectId references to strings for frontend compatibility
    const jobsWithId = jobs.map(j => {
        // job.total is already stored WITH tax included (or without if taxWaived)
        // So totalWithTax should just be the stored total
        const totalWithTax = parseFloat(j.total) || 0;
        return {
            ...j,
            _id: j._id.toString(), // Keep _id as string for invoice links
            id: j._id.toString(),
            clientId: (j.clientId && j.clientId !== 'undefined' && typeof j.clientId === 'object') ? j.clientId.toString() : null,
            assignedTo: (j.assignedTo && j.assignedTo !== 'undefined' && typeof j.assignedTo === 'object') ? j.assignedTo.toString() : null,
            totalWithTax: totalWithTax
        };
    });
    res.json(jobsWithId);
});

// File upload endpoint - receives base64 data, uploads to S3, returns S3 key
app.post('/api/upload', isAuthenticated, async (req, res) => {
    try {
        const { fileName, fileType, fileData } = req.body;

        if (!fileName || !fileType || !fileData) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // If S3 is configured, upload to S3
        if (s3Client) {
            // Extract base64 data (remove data:image/png;base64, prefix)
            const base64Data = fileData.replace(/^data:[^;]+;base64,/, '');
            const fileBuffer = Buffer.from(base64Data, 'base64');

            // Upload to S3
            const s3Key = await uploadToS3(fileBuffer, fileName, fileType);

            res.json({
                success: true,
                s3Key: s3Key,
                fileName: fileName,
                fileType: fileType,
                size: fileBuffer.length
            });
        } else {
            // Fallback: return the base64 data to store in MongoDB
            res.json({
                success: true,
                data: fileData,
                fileName: fileName,
                fileType: fileType,
                size: Buffer.from(fileData.replace(/^data:[^;]+;base64,/, ''), 'base64').length
            });
        }
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to upload file' });
    }
});

// Get signed URL for S3 file
app.get('/api/file/:s3Key(*)', isAuthenticated, async (req, res) => {
    try {
        const s3Key = req.params.s3Key;

        if (!s3Client) {
            return res.status(400).json({ error: 'S3 not configured' });
        }

        // Generate signed URL (valid for 1 hour)
        const signedUrl = await getS3SignedUrl(s3Key, 3600);
        res.json({ url: signedUrl });
    } catch (error) {
        console.error('Get file error:', error);
        res.status(500).json({ error: 'Failed to get file URL' });
    }
});

// Delete file from S3
app.delete('/api/file/:s3Key(*)', isAuthenticated, async (req, res) => {
    try {
        const s3Key = req.params.s3Key;

        if (s3Client) {
            await deleteFromS3(s3Key);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Delete file error:', error);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

app.post('/api/jobs', isAuthenticated, async (req, res) => {
    const job = req.body;
    let isUpdate = !!job._id;
    let oldJob = null;

    // Get old job data if updating (for status change detection)
    if (isUpdate) {
        oldJob = await db.collection('jobs').findOne({ _id: new ObjectId(job._id) });
    }

    // Convert clientId to ObjectId or remove if invalid
    if (job.clientId && job.clientId !== 'undefined' && typeof job.clientId === 'string' && job.clientId.length === 24) {
        job.clientId = new ObjectId(job.clientId);
    } else if (!job.clientId || job.clientId === 'undefined' || job.clientId === '') {
        delete job.clientId;
    }

    // Convert assignedTo to ObjectId or remove if invalid
    if (job.assignedTo && job.assignedTo !== 'undefined' && typeof job.assignedTo === 'string' && job.assignedTo.length === 24) {
        job.assignedTo = new ObjectId(job.assignedTo);
    } else if (!job.assignedTo || job.assignedTo === 'undefined' || job.assignedTo === '') {
        delete job.assignedTo;
    }

    if (job._id) {
        const { _id, ...updateData } = job;

        // Add audit log entry if status changed
        if (oldJob && oldJob.status !== job.status) {
            const auditEntry = {
                timestamp: new Date(),
                userName: req.session.userName,
                userId: new ObjectId(req.session.userId),
                action: 'status_change',
                oldStatus: oldJob.status,
                newStatus: job.status,
                note: `Status changed from ${oldJob.status} to ${job.status}`
            };

            // Initialize audit log if doesn't exist
            if (!updateData.auditLog) {
                updateData.auditLog = oldJob.auditLog || [];
            }
            updateData.auditLog.push(auditEntry);
        }

        await db.collection('jobs').updateOne(
            { _id: new ObjectId(_id) },
            { $set: { ...updateData, updatedAt: new Date() } }
        );
    } else {
        job.createdAt = new Date();

        // Add initial audit log entry
        job.auditLog = [{
            timestamp: new Date(),
            userName: req.session.userName,
            userId: new ObjectId(req.session.userId),
            action: 'created',
            newStatus: job.status || 'prospecting',
            note: `Job created with status: ${job.status || 'prospecting'}`
        }];

        await db.collection('jobs').insertOne(job);
    }

    // Send SMS notifications
    try {
        const client = job.clientId ? await db.collection('clients').findOne({ _id: job.clientId }) : null;

        if (client && client.phone) {
            const settings = await db.collection('settings').findOne({});
            const companyName = settings?.companyName || 'Jobber Pro';

            // New job scheduled
            if (!isUpdate && job.status === 'scheduled') {
                const date = new Date(job.scheduledDate).toLocaleDateString();
                const time = job.scheduledTime || 'TBD';
                await sendSMS(client.phone,
                    companyName + ': Your job "' + job.title + '" is scheduled for ' + date + ' at ' + time + '.');
            }

            // Status changed
            if (isUpdate && oldJob && oldJob.status !== job.status) {
                if (job.status === 'scheduled') {
                    const date = new Date(job.scheduledDate).toLocaleDateString();
                    await sendSMS(client.phone,
                        companyName + ': Job "' + job.title + '" scheduled for ' + date + '.');
                } else if (job.status === 'in_progress') {
                    await sendSMS(client.phone,
                        companyName + ': We\'re starting work on "' + job.title + '" now.');
                } else if (job.status === 'completed') {
                    await sendSMS(client.phone,
                        companyName + ': Job "' + job.title + '" is complete! Invoice will follow shortly.');
                } else if (job.status === 'invoiced') {
                    await sendSMS(client.phone,
                        companyName + ': Invoice ready for "' + job.title + '". Total: $' + (job.total || 0).toFixed(2) + '.');
                }
            }
        }
    } catch (smsError) {
        console.error('SMS notification error:', smsError);
        // Don't fail the job save if SMS fails
    }

    res.json({ success: true });
});

app.delete('/api/jobs/:id', isAuthenticated, async (req, res) => {
    await db.collection('jobs').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
});

// Quotes API
app.get('/api/quotes', isAuthenticated, async (req, res) => {
    const quotes = await db.collection('quotes').find().sort({ createdAt: -1 }).toArray();
    const quotesWithId = quotes.map(q => ({
        ...q,
        id: q._id.toString(),
        clientId: q.clientId ? q.clientId.toString() : null
    }));
    res.json(quotesWithId);
});

app.post('/api/quotes', isAuthenticated, async (req, res) => {
    const quote = req.body;
    const isUpdate = !!quote._id;

    // Generate quote number if new
    if (!isUpdate) {
        const year = new Date().getFullYear();
        const count = await db.collection('quotes').countDocuments({}) + 1;
        quote.quoteNumber = `Q-${year}-${String(count).padStart(3, '0')}`;
    }

    // Generate secure token for public viewing
    if (!quote.secureToken) {
        const crypto = require('crypto');
        quote.secureToken = crypto.randomUUID();
    }

    // Convert clientId to ObjectId
    if (quote.clientId && typeof quote.clientId === 'string' && quote.clientId.length === 24) {
        quote.clientId = new ObjectId(quote.clientId);
    }

    // Get client name
    if (quote.clientId) {
        const client = await db.collection('clients').findOne({ _id: quote.clientId });
        quote.clientName = client ? client.name : '';
    }

    // Set created/updated timestamps and user
    quote.createdByName = req.session.userName;
    quote.createdBy = new ObjectId(req.session.userId);

    if (quote._id) {
        const { _id, ...updateData } = quote;

        // Get existing quote to check for status change
        const existingQuote = await db.collection('quotes').findOne({ _id: new ObjectId(_id) });

        // Add audit log entry if status changed
        if (existingQuote && existingQuote.status !== quote.status) {
            const auditEntry = {
                timestamp: new Date(),
                userName: req.session.userName,
                userId: new ObjectId(req.session.userId),
                action: 'status_change',
                oldStatus: existingQuote.status,
                newStatus: quote.status,
                note: `Status changed from ${existingQuote.status} to ${quote.status}`
            };

            // Initialize audit log if doesn't exist
            if (!updateData.auditLog) {
                updateData.auditLog = existingQuote.auditLog || [];
            }
            updateData.auditLog.push(auditEntry);
        }

        await db.collection('quotes').updateOne(
            { _id: new ObjectId(_id) },
            { $set: { ...updateData, updatedAt: new Date() } }
        );
        res.json({ success: true, id: _id });
    } else {
        quote.createdAt = new Date();
        quote.status = quote.status || 'draft';

        // Add initial audit log entry
        quote.auditLog = [{
            timestamp: new Date(),
            userName: req.session.userName,
            userId: new ObjectId(req.session.userId),
            action: 'created',
            newStatus: quote.status,
            note: `Quote created with status: ${quote.status}`
        }];

        const result = await db.collection('quotes').insertOne(quote);
        res.json({ success: true, id: result.insertedId.toString() });
    }
});

app.delete('/api/quotes/:id', isAuthenticated, async (req, res) => {
    await db.collection('quotes').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
});

app.post('/api/quotes/send-email', isAuthenticated, async (req, res) => {
    try {
        const { quoteId } = req.body;

        const quote = await db.collection('quotes').findOne({ _id: new ObjectId(quoteId) });
        if (!quote) {
            return res.status(404).json({ error: 'Quote not found' });
        }

        const client = await db.collection('clients').findOne({ _id: quote.clientId });
        if (!client || !client.email) {
            return res.status(400).json({ error: 'Client email not found' });
        }

        const settings = await db.collection('settings').findOne({});
        const companyName = settings?.companyName || 'Your Company';

        // Get quote URL
        const quoteUrl = `${process.env.APP_URL}/quote-view/${quote.secureToken}`;

        // Send email
        const subject = `Quote #${quote.quoteNumber} from ${companyName}`;
        const html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #667eea; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border: 1px solid #ddd; border-radius: 0 0 8px 8px; }
        .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        .footer { text-align: center; color: #888; font-size: 12px; margin-top: 30px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Quote from ${companyName}</h1>
        </div>
        <div class="content">
            <p>Dear ${client.name},</p>
            <p>Thank you for your interest! We've prepared a quote for: <strong>${quote.title}</strong></p>
            <p><strong>Quote Total:</strong> $${parseFloat(quote.total || 0).toFixed(2)}</p>
            <p><strong>Valid Until:</strong> ${quote.validUntil}</p>
            <a href="${quoteUrl}" class="button">View Full Quote & Approve</a>
            <p>Click the button above to view the complete quote and approve it online.</p>
        </div>
        <div class="footer">
            <p>${companyName}</p>
            <p>This is an automated quote notification</p>
        </div>
    </div>
</body>
</html>
        `;

        await emailService.sendEmail({
            to: client.email,
            subject: subject,
            html: html,
            text: `Quote #${quote.quoteNumber} from ${companyName}\n\nView quote: ${quoteUrl}\n\nTotal: $${parseFloat(quote.total || 0).toFixed(2)}\nValid until: ${quote.validUntil}`
        });

        await db.collection('email_logs').insertOne({
            type: 'quote',
            to: client.email,
            toName: client.name,
            subject: subject,
            trigger: `Quote #${quote.quoteNumber} — ${quote.title}`,
            relatedId: quote._id,
            relatedTitle: quote.title,
            sentBy: req.session.userName || 'admin',
            sentAt: new Date(),
            status: 'sent'
        });

        // Update quote status to sent and add audit log
        const auditEntry = {
            timestamp: new Date(),
            userName: req.session.userName,
            userId: new ObjectId(req.session.userId),
            action: 'sent_email',
            oldStatus: quote.status,
            newStatus: 'sent',
            note: `Quote emailed to ${client.email}`
        };

        await db.collection('quotes').updateOne(
            { _id: new ObjectId(quoteId) },
            {
                $set: { status: 'sent', sentAt: new Date() },
                $push: { auditLog: auditEntry }
            }
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Send quote email error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/quotes/:id/convert', isAuthenticated, async (req, res) => {
    try {
        const quote = await db.collection('quotes').findOne({ _id: new ObjectId(req.params.id) });
        if (!quote) {
            return res.status(404).json({ error: 'Quote not found' });
        }

        if (quote.status !== 'approved' && quote.status !== 'in_review') {
            return res.status(400).json({ error: 'Only approved or in-review quotes can be converted to jobs' });
        }

        // Create job from quote with "prospecting" status (needs review/scheduling)
        const job = {
            clientId: quote.clientId,
            title: quote.title,
            description: quote.description,
            laborItems: quote.laborItems || [],
            materialItems: quote.materialItems || [],
            taxWaived: quote.taxWaived || false,
            total: quote.total,
            totalPaid: 0,
            balanceOwed: quote.total,
            status: 'prospecting',
            scheduledDate: '',
            payments: [],
            touchPoints: [],
            attachments: [],
            createdAt: new Date(),
            notes: `Converted from Quote #${quote.quoteNumber}\n\nNeeds scheduling review.\n\n${quote.notes || ''}`
        };

        if (quote.serviceLocationId) {
            job.serviceLocationId = quote.serviceLocationId;
        }

        const result = await db.collection('jobs').insertOne(job);

        // Mark quote as converted and add audit log
        const auditEntry = {
            timestamp: new Date(),
            userName: req.session.userName,
            userId: new ObjectId(req.session.userId),
            action: 'converted_to_job',
            oldStatus: quote.status,
            newStatus: 'approved',
            note: `Quote converted to Job #${result.insertedId.toString().slice(-6)}`
        };

        await db.collection('quotes').updateOne(
            { _id: new ObjectId(req.params.id) },
            {
                $set: { convertedToJobId: result.insertedId, status: 'approved' },
                $push: { auditLog: auditEntry }
            }
        );

        res.json({ success: true, jobId: result.insertedId.toString() });
    } catch (error) {
        console.error('Convert quote error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Backfill audit logs for existing quotes
app.post('/api/quotes/migrate-audit-logs', isAuthenticated, async (req, res) => {
    try {
        const quotes = await db.collection('quotes').find({ auditLog: { $exists: false } }).toArray();
        let updated = 0;

        for (const quote of quotes) {
            const initialEntry = {
                timestamp: quote.createdAt || new Date(),
                userName: quote.createdByName || 'System',
                userId: quote.createdBy || null,
                action: 'created',
                newStatus: quote.status || 'draft',
                note: `Quote created (backfilled audit log)`
            };

            await db.collection('quotes').updateOne(
                { _id: quote._id },
                { $set: { auditLog: [initialEntry] } }
            );
            updated++;
        }

        res.json({ success: true, quotesUpdated: updated });
    } catch (error) {
        console.error('Migrate audit logs error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Backfill audit logs for existing jobs
app.post('/api/jobs/migrate-audit-logs', isAuthenticated, async (req, res) => {
    try {
        const jobs = await db.collection('jobs').find({ auditLog: { $exists: false } }).toArray();
        let updated = 0;

        for (const job of jobs) {
            const initialEntry = {
                timestamp: job.createdAt || new Date(),
                userName: 'System',
                userId: null,
                action: 'created',
                newStatus: job.status || 'prospecting',
                note: `Job created (backfilled audit log)`
            };

            await db.collection('jobs').updateOne(
                { _id: job._id },
                { $set: { auditLog: [initialEntry] } }
            );
            updated++;
        }

        res.json({ success: true, jobsUpdated: updated });
    } catch (error) {
        console.error('Migrate job audit logs error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/team', isAuthenticated, async (req, res) => {
    const team = await db.collection('team').find().toArray();
    const users = await db.collection('users').find().toArray();

    // Map _id to id and link userId if possible
    const teamWithId = team.map(t => {
        const teamMember = { ...t, id: t._id.toString() };

        // If no userId but has email, try to find matching user
        if (!teamMember.userId && teamMember.email) {
            const matchingUser = users.find(u => u.email === teamMember.email);
            if (matchingUser) {
                teamMember.userId = matchingUser._id.toString();
            }
        }

        return teamMember;
    });

    res.json(teamWithId);
});

app.post('/api/team', isAuthenticated, async (req, res) => {
    const member = req.body;
    let userCreated = false;
    let userUpdated = false;

    // Handle user login creation
    if (member.createUserLogin && member.loginEmail && member.loginPassword) {
        // Check if email already exists
        const existingUser = await db.collection('users').findOne({ email: member.loginEmail });
        if (existingUser) {
            return res.status(400).json({ error: 'A user with this email already exists' });
        }

        // Create user account
        const hashedPassword = await bcrypt.hash(member.loginPassword, 10);
        const newUser = {
            name: member.name,
            email: member.loginEmail,
            password: hashedPassword,
            role: 'user',
            isAdmin: false,
            createdAt: new Date(),
            createdBy: req.session.userName
        };

        const result = await db.collection('users').insertOne(newUser);
        userCreated = true;

        // Link the userId to the team member
        member.userId = result.insertedId.toString();

        // Remove login fields from member object before saving
        delete member.createUserLogin;
        delete member.loginEmail;
        delete member.loginPassword;
    }

    // Handle user login update
    if (member.updateUserLogin) {
        let userId = member.userId;

        // If no userId but has email, try to find user by email
        if (!userId && member.email) {
            const existingUser = await db.collection('users').findOne({ email: member.email });
            if (existingUser) {
                userId = existingUser._id.toString();
                member.userId = userId; // Link it
            }
        }

        if (userId) {
            const updateFields = {
                email: member.loginEmail,
                name: member.name,
                updatedAt: new Date()
            };

            // Only update password if provided
            if (member.loginPassword) {
                updateFields.password = await bcrypt.hash(member.loginPassword, 10);
            }

            await db.collection('users').updateOne(
                { _id: new ObjectId(userId) },
                { $set: updateFields }
            );
            userUpdated = true;
        }

        // Remove login fields from member object before saving
        delete member.updateUserLogin;
        delete member.loginEmail;
        delete member.loginPassword;
    }

    if (member._id) {
        const { _id, ...updateData } = member;
        await db.collection('team').updateOne(
            { _id: new ObjectId(_id) },
            { $set: { ...updateData, updatedAt: new Date() } }
        );
    } else {
        member.createdAt = new Date();
        member.active = true;
        await db.collection('team').insertOne(member);
    }
    res.json({ success: true, userCreated: userCreated, userUpdated: userUpdated });
});

app.delete('/api/team/:id', isAuthenticated, async (req, res) => {
    await db.collection('team').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
});

app.get('/api/settings', isAuthenticated, async (req, res) => {
    const settings = await db.collection('settings').findOne();
    res.json(settings || {});
});

app.post('/api/settings', isAuthenticated, async (req, res) => {
    const settings = req.body;
    const existing = await db.collection('settings').findOne();
    if (existing) {
        await db.collection('settings').updateOne(
            { _id: existing._id },
            { $set: { ...settings, updatedAt: new Date() } }
        );
    } else {
        settings.createdAt = new Date();
        await db.collection('settings').insertOne(settings);
    }
    res.json({ success: true });
});

// Email Configuration API
app.get('/api/email/config', isAuthenticated, async (req, res) => {
    try {
        const settings = await db.collection('settings').findOne({});

        res.json({
            configured: !!(process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY && process.env.SES_FROM_EMAIL),
            fromEmail: process.env.SES_FROM_EMAIL || '',
            fromName: process.env.SES_FROM_NAME || '',
            provider: 'AWS SES',
            templates: settings?.emailTemplates || {},
            calendar: settings?.calendarSettings || {}
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/email/config', isAuthenticated, async (req, res) => {
    try {
        const emailConfig = req.body;

        const updateFields = {};
        if (emailConfig.emailTemplates) updateFields.emailTemplates = emailConfig.emailTemplates;
        if (emailConfig.calendarSettings) updateFields.calendarSettings = emailConfig.calendarSettings;

        if (Object.keys(updateFields).length > 0) {
            await db.collection('settings').updateOne(
                {},
                { $set: updateFields },
                { upsert: true }
            );
        }

        await calendarService.initialize();

        res.json({ success: true, message: 'Email configuration updated' });
    } catch (error) {
        console.error('Email config save error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/email/templates', isAuthenticated, async (req, res) => {
    try {
        const templates = req.body;

        // Update templates in database
        await db.collection('settings').updateOne(
            {},
            { $set: { emailTemplates: templates } },
            { upsert: true }
        );

        res.json({ success: true, message: 'Email templates updated' });
    } catch (error) {
        console.error('Email templates save error:', error);
        res.status(500).json({ error: error.message });
    }
});


app.post('/api/email/test', isAuthenticated, async (req, res) => {
    try {
        const { to } = req.body;
        if (!to) {
            return res.status(400).json({ error: 'Email recipient required' });
        }

        await emailService.sendTestEmail(to);

        await db.collection('email_logs').insertOne({
            type: 'test',
            to: to,
            toName: to,
            subject: 'GSD Handyman Service — Email Test',
            trigger: 'Manual test email sent from settings',
            relatedId: null,
            relatedTitle: null,
            sentBy: req.session.userName || 'admin',
            sentAt: new Date(),
            status: 'sent'
        });

        res.json({ success: true, message: 'Test email sent' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/email/send-credentials', isAuthenticated, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }

        // Get user from database
        const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get settings for company name
        const settings = await db.collection('settings').findOne({});
        const companyName = settings?.companyName || 'Your Company';

        // Generate temp password if not already set
        const tempPassword = user.tempPassword || 'ChangeMe123!';

        // Get login URL - use request host or fallback to Heroku domain
        const loginUrl = `${process.env.APP_URL}/`;

        // Get custom email templates if configured
        const customSubject = settings?.emailTemplates?.credentialsSubject;
        const customBody = settings?.emailTemplates?.credentialsBody;

        await emailService.sendUserCredentials({
            to: user.email,
            name: user.name,
            email: user.email,
            tempPassword: tempPassword,
            companyName: companyName,
            loginUrl: loginUrl,
            customSubject: customSubject,
            customBody: customBody
        });

        await db.collection('email_logs').insertOne({
            type: 'credentials',
            to: user.email,
            toName: user.name,
            subject: `Your ${companyName} Account Credentials`,
            trigger: `Login credentials sent to team member ${user.name}`,
            relatedId: user._id,
            relatedTitle: user.name,
            sentBy: req.session.userName || 'admin',
            sentAt: new Date(),
            status: 'sent'
        });

        res.json({ success: true, message: 'Credentials email sent to ' + user.email });
    } catch (error) {
        console.error('Send credentials error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/email/send-invoice', isAuthenticated, async (req, res) => {
    try {
        const { jobId } = req.body;
        if (!jobId) {
            return res.status(400).json({ error: 'Job ID required' });
        }

        // Get job from database
        const job = await db.collection('jobs').findOne({ _id: new ObjectId(jobId) });
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        // Get client
        const client = await db.collection('clients').findOne({ _id: new ObjectId(job.clientId) });
        if (!client || !client.email) {
            return res.status(400).json({ error: 'Client email not found' });
        }

        // Get settings
        const settings = await db.collection('settings').findOne({});
        const companyName = settings?.companyName || 'Your Company';

        // Calculate total
        const total = job.total || 0;

        // Generate invoice number
        const invoiceNumber = job.invoiceNumber || `INV-${job._id.toString().slice(-8).toUpperCase()}`;

        // Get invoice URL - use request host or fallback to Heroku domain
        const invoiceUrl = `${process.env.APP_URL}/invoice/${job._id}`;

        // Get custom email templates if configured
        const customSubject = settings?.emailTemplates?.invoiceSubject;
        const customBody = settings?.emailTemplates?.invoiceBody;

        await emailService.sendInvoice({
            to: client.email,
            clientName: client.name,
            invoiceNumber: invoiceNumber,
            jobTitle: job.title,
            total: total,
            invoiceUrl: invoiceUrl,
            pdfBuffer: null,
            companyName: companyName,
            customSubject: customSubject,
            customBody: customBody
        });

        await db.collection('email_logs').insertOne({
            type: 'invoice',
            to: client.email,
            toName: client.name,
            subject: `Your job summary from ${companyName} — ${job.title}`,
            trigger: `Invoice #${invoiceNumber} for job "${job.title}" — $${parseFloat(total).toFixed(2)}`,
            relatedId: job._id,
            relatedTitle: job.title,
            sentBy: req.session.userName || 'admin',
            sentAt: new Date(),
            status: 'sent'
        });

        res.json({ success: true, message: 'Invoice email sent to ' + client.email });
    } catch (error) {
        console.error('Send invoice error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Email Logs
app.get('/api/email-logs', isAuthenticated, async (req, res) => {
    try {
        const logs = await db.collection('email_logs')
            .find()
            .sort({ sentAt: -1 })
            .limit(500)
            .toArray();
        res.json(logs.map(l => ({ ...l, id: l._id.toString(), _id: l._id.toString() })));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Google Calendar API
app.post('/api/calendar/create-event', isAuthenticated, async (req, res) => {
    try {
        const { jobId, sendInvite } = req.body;
        if (!jobId) {
            return res.status(400).json({ error: 'Job ID required' });
        }

        // Get job from database
        const job = await db.collection('jobs').findOne({ _id: new ObjectId(jobId) });
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        // Get client
        const client = await db.collection('clients').findOne({ _id: new ObjectId(job.clientId) });

        // Get settings
        const settings = await db.collection('settings').findOne({});
        const companyName = settings?.companyName || 'Your Company';

        // Create calendar event
        const result = await calendarService.createJobEvent({
            job: job,
            client: client,
            companyName: companyName,
            sendInvite: sendInvite || false
        });

        // Save event ID to job
        await db.collection('jobs').updateOne(
            { _id: new ObjectId(jobId) },
            { $set: { calendarEventId: result.eventId, calendarEventLink: result.eventLink } }
        );

        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Create calendar event error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/calendar/update-event', isAuthenticated, async (req, res) => {
    try {
        const { jobId, sendUpdate } = req.body;
        if (!jobId) {
            return res.status(400).json({ error: 'Job ID required' });
        }

        const job = await db.collection('jobs').findOne({ _id: new ObjectId(jobId) });
        if (!job || !job.calendarEventId) {
            return res.status(404).json({ error: 'Job or calendar event not found' });
        }

        const client = await db.collection('clients').findOne({ _id: new ObjectId(job.clientId) });
        const settings = await db.collection('settings').findOne({});
        const companyName = settings?.companyName || 'Your Company';

        await calendarService.updateJobEvent({
            eventId: job.calendarEventId,
            job: job,
            client: client,
            companyName: companyName,
            sendUpdate: sendUpdate || false
        });

        res.json({ success: true, message: 'Calendar event updated' });
    } catch (error) {
        console.error('Update calendar event error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/calendar/delete-event', isAuthenticated, async (req, res) => {
    try {
        const { jobId, sendUpdate } = req.body;
        if (!jobId) {
            return res.status(400).json({ error: 'Job ID required' });
        }

        const job = await db.collection('jobs').findOne({ _id: new ObjectId(jobId) });
        if (!job || !job.calendarEventId) {
            return res.status(404).json({ error: 'Job or calendar event not found' });
        }

        await calendarService.deleteJobEvent(job.calendarEventId, sendUpdate || false);

        // Remove event ID from job
        await db.collection('jobs').updateOne(
            { _id: new ObjectId(jobId) },
            { $unset: { calendarEventId: '', calendarEventLink: '' } }
        );

        res.json({ success: true, message: 'Calendar event deleted' });
    } catch (error) {
        console.error('Delete calendar event error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/calendar/send-invite', isAuthenticated, async (req, res) => {
    try {
        const { jobId } = req.body;
        if (!jobId) {
            return res.status(400).json({ error: 'Job ID required' });
        }

        const job = await db.collection('jobs').findOne({ _id: new ObjectId(jobId) });
        if (!job || !job.calendarEventId) {
            return res.status(404).json({ error: 'Job or calendar event not found' });
        }

        const client = await db.collection('clients').findOne({ _id: new ObjectId(job.clientId) });
        if (!client || !client.email) {
            return res.status(400).json({ error: 'Client email not found' });
        }

        await calendarService.sendInviteToClient({
            eventId: job.calendarEventId,
            clientEmail: client.email
        });

        res.json({ success: true, message: 'Calendar invite sent to ' + client.email });
    } catch (error) {
        console.error('Send calendar invite error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/calendar/settings', isAuthenticated, async (req, res) => {
    try {
        const calendarSettings = req.body;

        // Update calendar settings in database
        await db.collection('settings').updateOne(
            {},
            { $set: { calendarSettings: calendarSettings } },
            { upsert: true }
        );

        res.json({ success: true, message: 'Calendar settings updated' });
    } catch (error) {
        console.error('Calendar settings save error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Time Entries API
app.get('/api/timeentries', isAuthenticated, async (req, res) => {
    const entries = await db.collection('timeentries').find().sort({ clockIn: -1 }).toArray();
    const entriesWithId = entries.map(e => ({ ...e, id: e._id.toString() }));
    res.json(entriesWithId);
});

app.post('/api/timeentries/clockin', isAuthenticated, async (req, res) => {
    const { jobId, jobName } = req.body;
    const entry = {
        userId: req.session.userId.toString(),
        userName: req.session.userName,
        jobId: jobId,
        jobName: jobName,
        clockIn: new Date(),
        clockOut: null,
        duration: null,
        status: 'active',
        createdAt: new Date()
    };
    const result = await db.collection('timeentries').insertOne(entry);
    res.json({ ...entry, id: result.insertedId.toString() });
});

app.post('/api/timeentries/clockout', isAuthenticated, async (req, res) => {
    const { entryId } = req.body;
    const entry = await db.collection('timeentries').findOne({
        _id: new ObjectId(entryId),
        status: 'active'
    });

    if (entry) {
        const clockOut = new Date();
        const duration = Math.round((clockOut - entry.clockIn) / 1000); // seconds

        await db.collection('timeentries').updateOne(
            { _id: new ObjectId(entryId) },
            {
                $set: {
                    clockOut: clockOut,
                    status: 'pending',
                    approvalStatus: 'pending',
                    duration: duration,
                    updatedAt: new Date()
                }
            }
        );

        const updated = await db.collection('timeentries').findOne({ _id: new ObjectId(entryId) });
        res.json({ ...updated, id: updated._id.toString() });
    } else {
        res.status(404).json({ error: 'Active time entry not found' });
    }
});

// Edit time entry (admin only)
app.put('/api/timeentries/:id', isAdmin, async (req, res) => {
    const { clockIn, clockOut, duration, jobId, jobName, status, approvalStatus, paymentAmount } = req.body;

    // Get current time entry
    const timeEntry = await db.collection('timeentries').findOne({ _id: new ObjectId(req.params.id) });
    if (!timeEntry) {
        return res.status(404).json({ error: 'Time entry not found' });
    }

    // Validate payment amount if approving
    if (status === 'approved' && (!paymentAmount || paymentAmount <= 0)) {
        return res.status(400).json({ error: 'Payment amount is required to approve time entry' });
    }

    const updates = {
        updatedAt: new Date()
    };

    if (clockIn) updates.clockIn = new Date(clockIn);
    if (clockOut) updates.clockOut = new Date(clockOut);
    if (duration !== undefined) updates.duration = duration;
    if (jobId) updates.jobId = jobId;
    if (jobName) updates.jobName = jobName;
    if (status) {
        updates.status = status;
        updates.approvalStatus = status;
        if (status === 'approved') {
            updates.approvedBy = req.session.userName;
            updates.approvedAt = new Date();
        }
    }
    if (paymentAmount !== undefined) updates.paymentAmount = paymentAmount;

    await db.collection('timeentries').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: updates }
    );

    // Create expense if approving and this wasn't already approved
    if (status === 'approved' && timeEntry.status !== 'approved' && paymentAmount > 0) {
        const expense = {
            date: new Date(),
            category: 'Labor',
            description: `Labor payment for ${timeEntry.jobName} - ${timeEntry.userName}`,
            amount: parseFloat(paymentAmount),
            paymentMethod: 'labor_payment',
            notes: `Auto-generated from time entry approval. Worker: ${timeEntry.userName}, Job: ${timeEntry.jobName}, Duration: ${Math.floor((duration || timeEntry.duration) / 3600)}h ${Math.floor(((duration || timeEntry.duration) % 3600) / 60)}m`,
            createdBy: req.session.userName,
            createdAt: new Date(),
            timeEntryId: req.params.id
        };

        await db.collection('expenses').insertOne(expense);
    }

    const updated = await db.collection('timeentries').findOne({ _id: new ObjectId(req.params.id) });
    res.json({ ...updated, id: updated._id.toString() });
});

app.delete('/api/timeentries/:id', isAdmin, async (req, res) => {
    await db.collection('timeentries').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
});

// Approve time entry
app.post('/api/timeentries/:id/approve', isAdmin, async (req, res) => {
    const { paymentAmount } = req.body;
    const amount = parseFloat(paymentAmount);

    // Validate payment amount is required
    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Payment amount is required to approve time entry' });
    }

    // Get the time entry details
    const timeEntry = await db.collection('timeentries').findOne({ _id: new ObjectId(req.params.id) });
    if (!timeEntry) {
        return res.status(404).json({ error: 'Time entry not found' });
    }

    // Update the time entry
    await db.collection('timeentries').updateOne(
        { _id: new ObjectId(req.params.id) },
        {
            $set: {
                approvalStatus: 'approved',
                status: 'approved',
                paymentAmount: amount,
                approvedBy: req.session.userName,
                approvedAt: new Date(),
                updatedAt: new Date()
            }
        }
    );

    // Create expense entry
    const expense = {
        date: new Date(),
        category: 'Labor',
        description: `Labor payment for ${timeEntry.jobName} - ${timeEntry.userName}`,
        amount: amount,
        paymentMethod: 'labor_payment',
        notes: `Auto-generated from time entry approval. Worker: ${timeEntry.userName}, Job: ${timeEntry.jobName}, Duration: ${Math.floor(timeEntry.duration / 3600)}h ${Math.floor((timeEntry.duration % 3600) / 60)}m`,
        createdBy: req.session.userName,
        createdAt: new Date(),
        timeEntryId: req.params.id
    };

    await db.collection('expenses').insertOne(expense);

    const updated = await db.collection('timeentries').findOne({ _id: new ObjectId(req.params.id) });
    res.json({ ...updated, id: updated._id.toString() });
});

// Reject time entry
app.post('/api/timeentries/:id/reject', isAdmin, async (req, res) => {
    const { reason } = req.body;

    await db.collection('timeentries').updateOne(
        { _id: new ObjectId(req.params.id) },
        {
            $set: {
                approvalStatus: 'rejected',
                status: 'rejected',
                rejectionReason: reason || '',
                rejectedBy: req.session.userName,
                rejectedAt: new Date(),
                updatedAt: new Date()
            }
        }
    );

    const updated = await db.collection('timeentries').findOne({ _id: new ObjectId(req.params.id) });
    res.json({ ...updated, id: updated._id.toString() });
});

app.get('/api/calendar', isAuthenticated, async (req, res) => {
    const { year, month } = req.query;
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const data = await db.collection('jobs').find({
        scheduledDate: { $regex: `^${monthStr}` }
    }).toArray();
    // Map _id to id and ObjectId references to strings for frontend compatibility
    const dataWithId = data.map(j => ({
        ...j,
        id: j._id.toString(),
        clientId: (j.clientId && j.clientId !== 'undefined' && typeof j.clientId === 'object') ? j.clientId.toString() : null,
        assignedTo: (j.assignedTo && j.assignedTo !== 'undefined' && typeof j.assignedTo === 'object') ? j.assignedTo.toString() : null
    }));
    res.json(dataWithId);
});

// Expenses endpoints
app.get('/api/expenses', isAuthenticated, async (req, res) => {
    const expenses = await db.collection('expenses').find().toArray();
    const expensesWithId = expenses.map(e => ({ ...e, id: e._id.toString() }));
    res.json(expensesWithId);
});

app.post('/api/expenses', isAuthenticated, isAdmin, async (req, res) => {
    const expense = req.body;

    if (expense._id) {
        // Update existing
        const { _id, ...updateData } = expense;
        await db.collection('expenses').updateOne(
            { _id: new ObjectId(_id) },
            { $set: updateData }
        );
        res.json({ success: true });
    } else {
        // Create new
        delete expense._id;
        const result = await db.collection('expenses').insertOne(expense);
        res.json({ success: true, id: result.insertedId });
    }
});

app.delete('/api/expenses/:id', isAuthenticated, isAdmin, async (req, res) => {
    await db.collection('expenses').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
});

// SMS API Endpoints
app.post('/api/sms/send', isAuthenticated, async (req, res) => {
    const { to, message, clientId, jobId } = req.body;

    if (!to || !message) {
        return res.status(400).json({ error: 'Phone number and message required' });
    }

    const result = await sendSMS(to, message);

    // Log the SMS
    if (result.success) {
        await db.collection('sms_log').insertOne({
            to,
            message,
            clientId: clientId ? new ObjectId(clientId) : null,
            jobId: jobId ? new ObjectId(jobId) : null,
            sentBy: req.session.userId,
            sentAt: new Date(),
            sid: result.sid
        });
    }

    res.json(result);
});

app.get('/api/sms/status', isAuthenticated, (req, res) => {
    res.json({
        enabled: !!twilioClient,
        configured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER)
    });
});

// Send appointment reminders (can be called manually or by cron)
app.post('/api/sms/reminders', isAuthenticated, async (req, res) => {
    // Check if user is admin
    console.log('SMS reminders - User role:', req.session.userRole, 'User ID:', req.session.userId);
    if (req.session.userRole !== 'admin') {
        console.log('Access denied - not admin');
        return res.status(403).json({ error: 'Admin access required', role: req.session.userRole });
    }
    try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        const jobs = await db.collection('jobs').find({
            scheduledDate: tomorrowStr,
            status: 'scheduled'
        }).toArray();

        const settings = await db.collection('settings').findOne({});
        const companyName = settings?.companyName || 'Jobber Pro';
        let sentCount = 0;

        for (const job of jobs) {
            if (job.clientId) {
                const client = await db.collection('clients').findOne({ _id: job.clientId });
                if (client && client.phone) {
                    const time = job.scheduledTime || 'TBD';
                    const message = companyName + ' Reminder: Your appointment "' + job.title +
                        '" is tomorrow at ' + time + '. Reply CONFIRM or call us if you need to reschedule.';

                    const result = await sendSMS(client.phone, message);
                    if (result.success) {
                        sentCount++;
                        await db.collection('sms_log').insertOne({
                            to: client.phone,
                            message,
                            clientId: job.clientId,
                            jobId: job._id,
                            type: 'reminder',
                            sentAt: new Date(),
                            sid: result.sid
                        });
                    }
                }
            }
        }

        res.json({ success: true, sent: sentCount, total: jobs.length });
    } catch (error) {
        console.error('Error sending reminders:', error);
        res.status(500).json({ error: error.message });
    }
});

// Invoice generation (protected)
app.get('/invoice/:jobId', async (req, res) => {
    let job = null;
    try {
        // Try to find job by ObjectId
        job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.jobId) });
    } catch (e) {
        // If ObjectId fails, try as string
        console.error('Error parsing jobId as ObjectId:', e.message);
        return res.status(404).send('<h1>Invoice not found - Invalid job ID</h1>');
    }

    if (!job) {
        return res.status(404).send('<h1>Invoice not found</h1>');
    }

    // Handle clientId as either ObjectId or string
    let client = null;
    if (job.clientId) {
        try {
            // Try as ObjectId first
            if (typeof job.clientId === 'string' && job.clientId.length === 24) {
                client = await db.collection('clients').findOne({ _id: new ObjectId(job.clientId) });
            } else {
                client = await db.collection('clients').findOne({ _id: job.clientId });
            }
        } catch (e) {
            console.error('Error finding client:', e);
            // Try direct match as fallback
            client = await db.collection('clients').findOne({ _id: job.clientId });
        }
    }

    const settings = await db.collection('settings').findOne() || {};

    // Calculate subtotal from line items
    const laborSubtotal = (job.laborItems || []).reduce((sum, item) => sum + (item.hours * item.rate), 0);
    const materialSubtotal = (job.materialItems || []).reduce((sum, item) => sum + (item.quantity * item.price), 0);
    const subtotal = laborSubtotal + materialSubtotal;

    // Calculate tax (0 if waived)
    const taxWaived = job.taxWaived || false;
    const tax = taxWaived ? 0 : subtotal * (settings.taxRate || 0.06625);
    const total = subtotal + tax;

    // Calculate if paid in full
    const totalPaid = (job.payments || []).reduce((sum, payment) => sum + (parseFloat(payment.amount) || 0), 0);
    const balance = total - totalPaid;
    const isPaidInFull = Math.abs(balance) < 0.01; // Consider paid if balance is less than 1 cent

    // Format money with commas and 2 decimals
    const formatMoney = (amount) => {
        return parseFloat(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    // Format phone numbers
    const formatPhone = (phone) => {
        if (!phone) return '';
        const cleaned = phone.replace(/\D/g, '');
        if (cleaned.length === 10) {
            return `(${cleaned.slice(0,3)})${cleaned.slice(3,6)}-${cleaned.slice(6)}`;
        }
        return phone;
    };

    const invoiceHTML = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Invoice #${job._id.toString().slice(-6)}</title>
    <style>
        @media print { .no-print { display: none !important; } }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; background: white; position: relative; }
        .invoice-header { display: flex; justify-content: space-between; margin-bottom: 40px; padding-bottom: 20px; border-bottom: 3px solid #667eea; }
        .company-info h1 { color: #667eea; font-size: 2em; margin-bottom: 10px; }
        .company-info p { line-height: 1.6; color: #666; }
        .invoice-meta { text-align: right; }
        .invoice-meta h2 { font-size: 2em; color: #333; margin-bottom: 10px; }
        .invoice-meta p { line-height: 1.8; color: #666; }
        .bill-to { margin-bottom: 30px; padding: 20px; background: #f8f9fa; border-radius: 8px; }
        .bill-to h3 { color: #667eea; margin-bottom: 10px; }
        .bill-to p { line-height: 1.6; color: #333; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
        thead { background: #667eea; color: white; }
        th { padding: 15px; text-align: left; font-weight: 600; }
        td { padding: 15px; border-bottom: 1px solid #e2e8f0; }
        .totals { margin-left: auto; width: 300px; }
        .totals-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
        .totals-row.total { font-size: 1.3em; font-weight: 700; border-top: 2px solid #333; border-bottom: 3px double #333; margin-top: 10px; padding-top: 15px; }
        .footer { margin-top: 50px; padding-top: 20px; border-top: 2px solid #e2e8f0; text-align: center; color: #999; font-size: 0.9em; }
        .print-button { position: fixed; top: 20px; right: 20px; padding: 12px 24px; background: #667eea; color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        .print-button:hover { background: #5568d3; }
        .status-badge { display: inline-block; padding: 5px 12px; border-radius: 12px; font-size: 0.85em; font-weight: 600; text-transform: uppercase; }
        .status-invoiced { background: #e9d8fd; color: #553c9a; }
        .status-completed { background: #c6f6d5; color: #22543d; }
        .status-in_progress { background: #feebc8; color: #7c2d12; }
        .status-scheduled { background: #bee3f8; color: #2c5282; }
        .watermark {
            position: fixed;
            top: 40%;
            left: 50%;
            transform: translate(-50%, -50%) rotate(-45deg);
            font-size: 4.5em;
            font-weight: 900;
            color: rgba(72, 187, 120, 0.25);
            z-index: 999;
            white-space: nowrap;
            pointer-events: none;
            letter-spacing: 0.15em;
            border: 6px solid rgba(72, 187, 120, 0.2);
            padding: 30px 50px;
            border-radius: 15px;
        }
        @media print {
            .watermark {
                position: absolute;
                top: 400px;
                left: 50%;
                transform: translate(-50%, -50%) rotate(-45deg);
                font-size: 3.5em;
                color: rgba(72, 187, 120, 0.25);
                border: 5px solid rgba(72, 187, 120, 0.2);
                padding: 20px 40px;
            }
        }
    </style>
</head>
<body>
    ${isPaidInFull ? '<div class="watermark">PAID IN FULL</div>' : ''}
    <button class="print-button no-print" onclick="window.print()">🖨️ Print Invoice</button>

    <div class="invoice-header">
        <div class="company-info">
            ${settings.companyLogo ? `<img src="${settings.companyLogo}" alt="Company Logo" style="max-width: 200px; max-height: 80px; margin-bottom: 1rem;">` : ''}
            <h1>${settings.companyName || 'Your Company'}</h1>
            <p>${(settings.companyAddress || 'Add company address in settings').replace(/\n/g, '<br>')}</p>
            <p>Phone: ${formatPhone(settings.companyPhone) || 'Add phone'}</p>
            <p>Email: ${settings.companyEmail || 'Add email'}</p>
        </div>
        <div class="invoice-meta">
            <h2>INVOICE</h2>
            <p><strong>Invoice #:</strong> ${job._id.toString().slice(-6)}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>Status:</strong> <span class="status-badge status-${job.status}">${job.status.replace('_', ' ')}</span></p>
        </div>
    </div>

    <div class="bill-to">
        <h3>Bill To:</h3>
        <p><strong>${client ? client.name : 'Unknown Client'}</strong></p>
        ${client && client.address ? `<p>${client.address.replace(/\n/g, '<br>')}</p>` : ''}
        ${client && client.phone ? `<p>Phone: ${formatPhone(client.phone)}</p>` : ''}
        ${client && client.email ? `<p>Email: ${client.email}</p>` : ''}
    </div>

    <div style="margin-bottom: 20px;">
        <p><strong>Job:</strong> ${job.title}</p>
        <p><strong>Description:</strong> ${job.description || 'N/A'}</p>
        <p><strong>Date:</strong> ${job.scheduledDate || ''} ${job.scheduledTime || ''}</p>
    </div>

    ${(job.laborItems && job.laborItems.length > 0) ? `
    <h3 style="color: #667eea; margin-top: 30px; margin-bottom: 15px;">Labor</h3>
    <table>
        <thead>
            <tr>
                <th>Description</th>
                <th style="text-align: right;">Amount</th>
            </tr>
        </thead>
        <tbody>
            ${job.laborItems.map(item => `
            <tr>
                <td>${item.description}</td>
                <td style="text-align: right;">$${formatMoney(item.hours * item.rate)}</td>
            </tr>
            `).join('')}
        </tbody>
    </table>
    ` : ''}

    ${(job.materialItems && job.materialItems.length > 0) ? `
    <h3 style="color: #667eea; margin-top: 30px; margin-bottom: 15px;">Materials</h3>
    <table>
        <thead>
            <tr>
                <th>Description</th>
                <th style="text-align: center;">Quantity</th>
                <th style="text-align: right;">Price</th>
                <th style="text-align: right;">Amount</th>
            </tr>
        </thead>
        <tbody>
            ${job.materialItems.map(item => `
            <tr>
                <td>${item.description}</td>
                <td style="text-align: center;">${item.quantity}</td>
                <td style="text-align: right;">$${formatMoney(item.price)}</td>
                <td style="text-align: right;">$${formatMoney(item.quantity * item.price)}</td>
            </tr>
            `).join('')}
        </tbody>
    </table>
    ` : ''}

    ${(job.payments && job.payments.length > 0) ? `
    <h3 style="color: #667eea; margin-top: 30px; margin-bottom: 15px;">Payments Received</h3>
    <table>
        <thead>
            <tr>
                <th>Date</th>
                <th>Method</th>
                <th style="text-align: right;">Amount</th>
            </tr>
        </thead>
        <tbody>
            ${job.payments.map(payment => `
            <tr>
                <td>${payment.date || 'N/A'}</td>
                <td>${payment.method ? payment.method.charAt(0).toUpperCase() + payment.method.slice(1) : 'N/A'}</td>
                <td style="text-align: right;">$${formatMoney(payment.amount || 0)}</td>
            </tr>
            `).join('')}
        </tbody>
    </table>
    ` : ''}

    <div class="totals">
        <div class="totals-row">
            <span>Subtotal:</span>
            <span>$${formatMoney(subtotal)}</span>
        </div>
        <div class="totals-row">
            <span>Tax ${taxWaived ? '(EXEMPT)' : `(${((settings.taxRate || 0.06625) * 100).toFixed(3)}%)`}:</span>
            <span>$${formatMoney(tax)}</span>
        </div>
        <div class="totals-row total">
            <span>Total Due:</span>
            <span>$${formatMoney(total)}</span>
        </div>
        ${totalPaid > 0 ? `
        <div class="totals-row" style="color: #48bb78;">
            <span>Payments Received:</span>
            <span>-$${formatMoney(totalPaid)}</span>
        </div>
        <div class="totals-row total" style="color: ${balance > 0.01 ? '#e53e3e' : '#48bb78'};">
            <span>Balance ${balance < 0.01 ? '(PAID IN FULL)' : 'Due'}:</span>
            <span>$${formatMoney(balance)}</span>
        </div>
        ` : ''}
    </div>

    ${settings.contractTerms ? `
    <div style="margin-top: 40px; padding: 20px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #667eea;">
        <h3 style="color: #667eea; margin-bottom: 15px;">Terms & Conditions</h3>
        <p style="white-space: pre-wrap; line-height: 1.6; color: #333; font-size: 0.9em;">${settings.contractTerms}</p>
    </div>
    ` : ''}

    <div style="margin-top: 60px; padding-top: 30px; border-top: 2px solid #e2e8f0;">
        <div style="display: flex; justify-content: space-between; align-items: flex-end;">
            <div style="flex: 1;">
                <p style="margin-bottom: 10px; color: #666; font-weight: 600;">Customer Signature:</p>
                <div style="border-bottom: 2px solid #333; width: 300px; margin-bottom: 8px;"></div>
                <p style="color: #999; font-size: 0.85em;">Signature</p>
            </div>
            <div style="flex: 1; text-align: right;">
                <p style="margin-bottom: 10px; color: #666; font-weight: 600;">Date:</p>
                <div style="border-bottom: 2px solid #333; width: 200px; margin-left: auto; margin-bottom: 8px;"></div>
                <p style="color: #999; font-size: 0.85em;">Date</p>
            </div>
        </div>
    </div>

    <div class="footer" style="margin-top: 40px;">
        <p>Thank you for your business!</p>
        <p>Please remit payment within 30 days.</p>
    </div>
</body>
</html>`;

    res.send(invoiceHTML);
});

// Public Quote Viewing (no authentication required)
app.get('/quote-view/:token', async (req, res) => {
    try {
        const quote = await db.collection('quotes').findOne({ secureToken: req.params.token });

        if (!quote) {
            return res.status(404).send('<h1>Quote not found</h1><p>This quote may have been deleted or the link is invalid.</p>');
        }

        const client = await db.collection('clients').findOne({ _id: quote.clientId });
        const settings = await db.collection('settings').findOne({});

        const companyName = settings?.companyName || 'Your Company';
        const companyLogo = settings?.companyLogo || '';

        const subtotal = quote.subtotal || 0;
        const taxAmount = quote.taxAmount || 0;
        const total = quote.total || 0;

        const validUntil = new Date(quote.validUntil);
        const isExpired = validUntil < new Date() && quote.status === 'sent';

        const statusBadge = quote.status === 'approved' ? '<span style="background: #48bb78; color: white; padding: 0.5rem 1rem; border-radius: 6px; font-weight: 600;">✓ APPROVED</span>' :
                           quote.status === 'rejected' ? '<span style="background: #e53e3e; color: white; padding: 0.5rem 1rem; border-radius: 6px; font-weight: 600;">✗ REJECTED</span>' :
                           isExpired ? '<span style="background: #f59e0b; color: white; padding: 0.5rem 1rem; border-radius: 6px; font-weight: 600;">⚠ EXPIRED</span>' :
                           '<span style="background: #667eea; color: white; padding: 0.5rem 1rem; border-radius: 6px; font-weight: 600;">📋 PENDING</span>';

        const showButtons = quote.status === 'sent' && !isExpired;

        const quoteHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Quote #${quote.quoteNumber} - ${companyName}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #333; padding: 2rem; background: #f7fafc; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 2rem; padding-bottom: 2rem; border-bottom: 3px solid #667eea; }
        .logo { max-width: 200px; margin-bottom: 1rem; }
        h1 { color: #667eea; margin-bottom: 0.5rem; }
        .status { text-align: center; margin: 2rem 0; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin: 2rem 0; }
        .info-section h3 { color: #667eea; margin-bottom: 0.5rem; font-size: 1rem; }
        .info-section p { margin: 0.25rem 0; }
        table { width: 100%; border-collapse: collapse; margin: 2rem 0; }
        thead { background: #667eea; color: white; }
        th, td { padding: 1rem; text-align: left; border-bottom: 1px solid #e2e8f0; }
        th { font-weight: 600; }
        .totals { background: #f7fafc; padding: 1.5rem; border-radius: 8px; margin: 2rem 0; }
        .totals-row { display: flex; justify-content: space-between; margin: 0.5rem 0; }
        .totals-row.total { font-weight: bold; font-size: 1.5rem; color: #667eea; padding-top: 1rem; border-top: 2px solid #cbd5e0; }
        .actions { text-align: center; margin: 2rem 0; display: flex; gap: 1rem; justify-content: center; }
        .btn { padding: 1rem 2rem; font-size: 1.1rem; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; text-decoration: none; display: inline-block; }
        .btn-approve { background: #48bb78; color: white; }
        .btn-reject { background: #e53e3e; color: white; }
        .btn:hover { opacity: 0.9; }
        .notes { background: #fffacd; padding: 1rem; border-left: 4px solid #f59e0b; margin: 2rem 0; border-radius: 4px; }
        .footer { text-align: center; color: #718096; font-size: 0.9rem; margin-top: 3rem; padding-top: 2rem; border-top: 1px solid #e2e8f0; }
        @media (max-width: 768px) {
            body { padding: 1rem; }
            .container { padding: 1rem; }
            .info-grid { grid-template-columns: 1fr; gap: 1rem; }
            .actions { flex-direction: column; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            ${companyLogo ? `<img src="${companyLogo}" alt="${companyName}" class="logo">` : `<h1>${companyName}</h1>`}
            <h2>Quote #${quote.quoteNumber}</h2>
        </div>

        <div class="status">
            ${statusBadge}
        </div>

        <div class="info-grid">
            <div class="info-section">
                <h3>Quote For:</h3>
                <p><strong>${client ? client.name : 'Client'}</strong></p>
                ${client?.email ? `<p>${client.email}</p>` : ''}
                ${client?.phone ? `<p>${client.phone}</p>` : ''}
                ${client?.address ? `<p>${client.address}</p>` : ''}
            </div>
            <div class="info-section">
                <h3>Quote Details:</h3>
                <p><strong>Date:</strong> ${new Date(quote.createdAt).toLocaleDateString()}</p>
                <p><strong>Valid Until:</strong> ${validUntil.toLocaleDateString()}</p>
                ${quote.createdByName ? `<p><strong>Prepared By:</strong> ${quote.createdByName}</p>` : ''}
            </div>
        </div>

        <div>
            <h3 style="color: #667eea; margin: 2rem 0 1rem 0;">${quote.title}</h3>
            ${quote.description ? `<p style="margin-bottom: 2rem;">${quote.description}</p>` : ''}
        </div>

        ${quote.laborItems && quote.laborItems.length > 0 ? `
        <h3 style="color: #667eea; margin-top: 2rem;">Labor</h3>
        <table>
            <thead>
                <tr>
                    <th>Description</th>
                    <th style="text-align: center;">Hours</th>
                    <th style="text-align: right;">Rate</th>
                    <th style="text-align: right;">Amount</th>
                </tr>
            </thead>
            <tbody>
                ${quote.laborItems.map(item => `
                <tr>
                    <td>${item.description}</td>
                    <td style="text-align: center;">${item.hours}</td>
                    <td style="text-align: right;">$${parseFloat(item.rate).toFixed(2)}</td>
                    <td style="text-align: right;">$${(item.hours * item.rate).toFixed(2)}</td>
                </tr>
                `).join('')}
            </tbody>
        </table>
        ` : ''}

        ${quote.materialItems && quote.materialItems.length > 0 ? `
        <h3 style="color: #667eea; margin-top: 2rem;">Materials</h3>
        <table>
            <thead>
                <tr>
                    <th>Description</th>
                    <th style="text-align: center;">Quantity</th>
                    <th style="text-align: right;">Price</th>
                    <th style="text-align: right;">Amount</th>
                </tr>
            </thead>
            <tbody>
                ${quote.materialItems.map(item => `
                <tr>
                    <td>${item.description}</td>
                    <td style="text-align: center;">${item.quantity}</td>
                    <td style="text-align: right;">$${parseFloat(item.price).toFixed(2)}</td>
                    <td style="text-align: right;">$${(item.quantity * item.price).toFixed(2)}</td>
                </tr>
                `).join('')}
            </tbody>
        </table>
        ` : ''}

        <div class="totals">
            <div class="totals-row">
                <span>Subtotal:</span>
                <span>$${subtotal.toFixed(2)}</span>
            </div>
            <div class="totals-row">
                <span>Tax ${quote.taxWaived ? '(EXEMPT)' : `(${((settings?.taxRate || 0.06625) * 100).toFixed(3)}%)`}:</span>
                <span>$${taxAmount.toFixed(2)}</span>
            </div>
            <div class="totals-row total">
                <span>Total:</span>
                <span>$${total.toFixed(2)}</span>
            </div>
        </div>

        ${quote.clientNotes ? `
        <div class="notes">
            <h4 style="margin-bottom: 0.5rem;">Notes:</h4>
            <p style="white-space: pre-wrap;">${quote.clientNotes}</p>
        </div>
        ` : ''}

        ${showButtons ? `
        <div class="actions">
            <button class="btn btn-approve" onclick="approveQuote()">✓ Approve Quote</button>
            <button class="btn btn-reject" onclick="rejectQuote()">✗ Decline Quote</button>
        </div>
        ` : ''}

        <div class="footer">
            <p>Thank you for considering ${companyName}</p>
            <p>Quote generated on ${new Date(quote.createdAt).toLocaleDateString()}</p>
        </div>
    </div>

    <script>
        async function approveQuote() {
            if (!confirm('Approve this quote?')) return;

            try {
                const response = await fetch('/quote-action/${quote.secureToken}/approve', {
                    method: 'POST'
                });

                if (response.ok) {
                    alert('✅ Quote approved! ${companyName} will be in touch shortly.');
                    location.reload();
                } else {
                    alert('Failed to approve quote. Please try again or contact us directly.');
                }
            } catch (error) {
                alert('Error: ' + error.message);
            }
        }

        async function rejectQuote() {
            const reason = prompt('Optional: Let us know why you declined (or leave blank):');

            try {
                const response = await fetch('/quote-action/${quote.secureToken}/reject', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason: reason || '' })
                });

                if (response.ok) {
                    alert('Quote declined. Thank you for your time.');
                    location.reload();
                } else {
                    alert('Failed to decline quote. Please try again or contact us directly.');
                }
            } catch (error) {
                alert('Error: ' + error.message);
            }
        }
    </script>
</body>
</html>`;

        res.send(quoteHTML);
    } catch (error) {
        console.error('Quote view error:', error);
        res.status(500).send('<h1>Error loading quote</h1>');
    }
});

// Quote approval/rejection actions (public)
app.post('/quote-action/:token/approve', async (req, res) => {
    try {
        const quote = await db.collection('quotes').findOne({ secureToken: req.params.token });
        if (!quote) {
            return res.status(404).json({ error: 'Quote not found' });
        }

        // Update quote to in_review status
        await db.collection('quotes').updateOne(
            { _id: quote._id },
            { $set: { status: 'in_review', approvedAt: new Date() } }
        );

        // Get client info
        const client = await db.collection('clients').findOne({ _id: new ObjectId(quote.clientId) });

        // Create admin message notification
        await db.collection('client_messages').insertOne({
            clientId: new ObjectId(quote.clientId),
            clientName: client?.name || 'Unknown Client',
            clientEmail: client?.email || '',
            message: `Client approved quote ${quote.quoteNumber} - "${quote.title}"\n\nTotal: $${parseFloat(quote.total || 0).toFixed(2)}\n\nQuote is now in review status. Please review and schedule the work.`,
            subject: 'quote',
            reference: quote.quoteNumber,
            createdAt: new Date(),
            read: false
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/quote-action/:token/reject', async (req, res) => {
    try {
        const quote = await db.collection('quotes').findOne({ secureToken: req.params.token });
        if (!quote) {
            return res.status(404).json({ error: 'Quote not found' });
        }

        const { reason } = req.body;

        await db.collection('quotes').updateOne(
            { _id: quote._id },
            { $set: {
                status: 'rejected',
                rejectedAt: new Date(),
                rejectionReason: reason || ''
            }}
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Client Portal Routes
app.get('/client-login', (req, res) => {
    const fs = require('fs');
    const html = fs.readFileSync('./client-login.html', 'utf8');
    res.send(html);
});

app.get('/client-portal', (req, res) => {
    if (!req.session.clientId) {
        return res.redirect('/client-login');
    }
    const fs = require('fs');
    const html = fs.readFileSync('./client-portal.html', 'utf8');
    res.send(html);
});

// Client Portal API - Login
app.post('/api/client-portal/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find client by email
        const client = await db.collection('clients').findOne({ email: email.toLowerCase() });

        if (!client) {
            return res.status(401).json({ error: 'Invalid email or access code' });
        }

        // Check if client has portal access set up
        if (!client.portalPassword) {
            return res.status(401).json({ error: 'Portal access not set up. Contact us to enable portal access.' });
        }

        // Verify password
        const passwordMatch = await bcrypt.compare(password, client.portalPassword);

        if (!passwordMatch) {
            return res.status(401).json({ error: 'Invalid email or access code' });
        }

        // Set session
        req.session.clientId = client._id.toString();
        req.session.clientName = client.name;
        req.session.isClientPortal = true;

        res.json({ success: true });
    } catch (error) {
        console.error('Client portal login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Client Portal API - Get client data
app.get('/api/client-portal/me', async (req, res) => {
    try {
        if (!req.session.clientId || !req.session.isClientPortal) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const clientId = new ObjectId(req.session.clientId);

        // Get client
        const client = await db.collection('clients').findOne({ _id: clientId });
        if (!client) {
            return res.status(404).json({ error: 'Client not found' });
        }

        // Get client's quotes
        const quotes = await db.collection('quotes')
            .find({ clientId: clientId })
            .sort({ createdAt: -1 })
            .toArray();

        // Get client's jobs
        const jobs = await db.collection('jobs')
            .find({ clientId: clientId })
            .sort({ scheduledDate: -1 })
            .toArray();

        // Get settings for branding
        const settings = await db.collection('settings').findOne({}) || {};

        // Add id field for frontend
        const quotesWithId = quotes.map(q => ({ ...q, id: q._id.toString() }));
        const jobsWithId = jobs.map(j => ({ ...j, id: j._id.toString() }));

        res.json({
            client: {
                name: client.name,
                email: client.email,
                phone: client.phone
            },
            quotes: quotesWithId,
            jobs: jobsWithId,
            settings: {
                appName: settings.appName || 'Jobber Pro',
                favicon: settings.favicon || '',
                companyName: settings.companyName || 'Your Company'
            }
        });
    } catch (error) {
        console.error('Get client data error:', error);
        res.status(500).json({ error: 'Failed to load data' });
    }
});

// Client Portal API - Send message
app.post('/api/client-portal/message', async (req, res) => {
    try {
        if (!req.session.clientId || !req.session.isClientPortal) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const { message, subject, reference } = req.body;
        const clientId = new ObjectId(req.session.clientId);

        // Get client
        const client = await db.collection('clients').findOne({ _id: clientId });

        // Save message to database
        await db.collection('client_messages').insertOne({
            clientId: clientId,
            clientName: client.name,
            clientEmail: client.email,
            message: message,
            subject: subject || '',
            reference: reference || '',
            createdAt: new Date(),
            read: false
        });

        // TODO: Send notification to admin (SMS/Email)

        res.json({ success: true });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Admin Messages API - Get all client messages
app.get('/api/client-messages', isAuthenticated, async (req, res) => {
    try {
        const messages = await db.collection('client_messages')
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        res.json(messages.map(msg => ({
            id: msg._id.toString(),
            clientId: msg.clientId.toString(),
            clientName: msg.clientName,
            clientEmail: msg.clientEmail,
            message: msg.message,
            subject: msg.subject || '',
            reference: msg.reference || '',
            createdAt: msg.createdAt,
            read: msg.read || false
        })));
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

// Admin Messages API - Mark as read
app.post('/api/client-messages/:id/read', isAuthenticated, async (req, res) => {
    try {
        const messageId = new ObjectId(req.params.id);

        await db.collection('client_messages').updateOne(
            { _id: messageId },
            { $set: { read: true } }
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ error: 'Failed to mark message as read' });
    }
});

// Admin Messages API - Delete message
app.delete('/api/client-messages/:id', isAuthenticated, async (req, res) => {
    try {
        const messageId = new ObjectId(req.params.id);

        await db.collection('client_messages').deleteOne({ _id: messageId });

        res.json({ success: true });
    } catch (error) {
        console.error('Delete message error:', error);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// Client Portal API - Logout
app.post('/api/client-portal/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

} // End setupRoutes

// Start server
connectDB().then(async () => {
    // Load Google Calendar OAuth credentials from database
    try {
        const settings = await db.collection('settings').findOne({});
        if (settings) {
            if (settings.gmailClientId) process.env.GMAIL_CLIENT_ID = settings.gmailClientId;
            if (settings.gmailClientSecret) process.env.GMAIL_CLIENT_SECRET = settings.gmailClientSecret;
            if (settings.gmailRefreshToken) process.env.GMAIL_REFRESH_TOKEN = settings.gmailRefreshToken;
            if (settings.gmailUser) process.env.GMAIL_USER = settings.gmailUser;
        }
    } catch (error) {
        console.error('❌ Failed to load Google Calendar credentials from database:', error);
    }

    // Initialize email service
    await emailService.initialize();
    await calendarService.initialize();

    // Setup session middleware after DB connection
    app.use(session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        store: MongoStore.create({
            client: client,
            dbName: DB_NAME,
            touchAfter: 24 * 3600
        }),
        cookie: {
            maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production'
        }
    }));

    // Setup routes after session middleware
    setupRoutes();

    app.listen(PORT, () => {
        console.log('='.repeat(60));
        console.log('🚀 Jobber Pro - Authenticated Cloud Version');
        console.log('='.repeat(60));
        console.log(`📡 Server: http://localhost:${PORT}`);
        console.log(`🗄️  Database: MongoDB Atlas`);
        console.log(`🔐 Authentication: Enabled`);
        console.log('');
        console.log('💡 Press Ctrl+C to stop');
        console.log('='.repeat(60));
    });

    process.on('SIGINT', async () => {
        console.log('\n\n👋 Shutting down...');
        await client.close();
        console.log('✅ MongoDB connection closed');
        process.exit(0);
    });
}).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
