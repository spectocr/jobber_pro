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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
const emailService = require('./email-service');
const calendarService = require('./calendar-service');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
// fetch is available as a global in Node 18+ — no import needed
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'jobber_pro';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

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

async function seedDemoPortalAccount() {
    try {
        const demoClient = await db.collection('clients').findOne({ email: 'sample@sample.com' });
        if (!demoClient) return;

        // Ensure portal password is set (bcrypt of '1234')
        if (!demoClient.portalPassword) {
            const hashed = await bcrypt.hash('1234', 10);
            await db.collection('clients').updateOne(
                { _id: demoClient._id },
                { $set: { portalPassword: hashed } }
            );
            console.log('✅ Demo portal password set');
        }

    } catch (e) {
        console.warn('⚠️  Demo account seed skipped:', e.message);
    }
}

// Connect to MongoDB
async function connectDB() {
    // Connect with retry so a brief Mongo/network blip doesn't crash-loop the whole app
    for (let attempt = 1; ; attempt++) {
        try {
            client = new MongoClient(MONGODB_URI);
            await client.connect();
            db = client.db(DB_NAME);
            console.log('✅ Connected to MongoDB');
            break;
        } catch (error) {
            console.error(`❌ MongoDB connection attempt ${attempt} failed:`, error.message);
            if (attempt >= 6) {
                console.error('❌ Giving up after 6 attempts — exiting for a clean restart.');
                process.exit(1);
            }
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    // Indexes + seed — NON-FATAL. A data/index hiccup must never take the app down.
    try {
        // Create indexes
        await db.collection('users').createIndex({ email: 1 }, { unique: true });
        await db.collection('clients').createIndex({ name: 1 });
        await db.collection('jobs').createIndex({ scheduledDate: 1 });
        await db.collection('jobs').createIndex({ clientId: 1 });
        await db.collection('jobs').createIndex({ status: 1 });
        await db.collection('jobs').createIndex({ surveyToken: 1 }, { sparse: true });
        await db.collection('jobs').createIndex({ 'deposit.token': 1 }, { sparse: true });
        await db.collection('quotes').createIndex({ status: 1 });
        await db.collection('quotes').createIndex({ secureToken: 1 }, { sparse: true });
        // unique constraint may fail if pre-existing duplicates exist from before atomic counter fix — non-fatal
        try {
            await db.collection('quotes').createIndex({ quoteNumber: 1 }, { unique: true, sparse: true });
        } catch (idxErr) {
            console.warn('[startup] quoteNumber unique index skipped (duplicate data exists):', idxErr.message);
        }

        // Seed the atomic quote number counter from existing data (safe to run on every boot)
        const currentYear = new Date().getFullYear();
        const existingYearCount = await db.collection('quotes').countDocuments({
            quoteNumber: { $regex: `^Q-${currentYear}-` }
        });
        await db.collection('counters').updateOne(
            { _id: `quoteNumber_${currentYear}` },
            { $setOnInsert: { seq: existingYearCount } },
            { upsert: true }
        );

        await db.collection('leads').createIndex({ status: 1 });
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

        // Seed demo portal account with sample jobs for screenshot capture
        await seedDemoPortalAccount();

    } catch (setupErr) {
        console.warn('⚠️  Startup DB setup (indexes/seed) had a non-fatal issue — continuing:', setupErr.message);
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

function interpolate(template, vars) {
    return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
}

// SMS Helper Function
// True if a client with this phone number has opted out of SMS.
async function isSmsOptedOut(to) {
    try {
        if (!db) return false;
        const norm = (to || '').replace(/\D/g, '').slice(-10);
        if (!norm) return false;
        const optedOut = await db.collection('clients')
            .find({ smsOptOut: true }, { projection: { phone: 1 } }).toArray();
        return optedOut.some(c => (c.phone || '').replace(/\D/g, '').slice(-10) === norm);
    } catch (e) { return false; }
}

async function sendSMS(to, message, meta = {}) {
    const logEntry = {
        to,
        message,
        type: meta.type || 'system',
        clientName: meta.clientName || null,
        trigger: meta.trigger || null,
        sentAt: new Date(),
        success: false,
        sid: null,
        error: null
    };

    const writeLog = async () => {
        try {
            if (db) await db.collection('sms_log').insertOne({ ...logEntry });
        } catch (e) {
            console.error('SMS log write failed:', e.message);
        }
    };

    // Respect per-client SMS opt-out — blocks every automated text path centrally
    if (await isSmsOptedOut(to)) {
        console.log('SMS skipped (client opted out):', to);
        logEntry.error = 'Client opted out of SMS';
        logEntry.skipped = true;
        await writeLog();
        return { success: false, skipped: true, error: 'Client opted out of SMS' };
    }

    if (!twilioClient) {
        console.log('SMS not sent (Twilio not configured):', to, message);
        logEntry.error = 'Twilio not configured';
        await writeLog();
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
        logEntry.success = true;
        logEntry.sid = result.sid;
        logEntry.to = phoneNumber;
        await writeLog();
        return { success: true, sid: result.sid };
    } catch (error) {
        console.error('❌ SMS error:', error.message);
        logEntry.error = error.message;
        await writeLog();
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
    <title>Login - {{APP_NAME}}</title>
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
        <h1>⚡ {{APP_NAME}}</h1>
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

        <div class="register-link" style="margin-top: 1rem;">
            <a href="/forgot-password" style="color: #667eea; text-decoration: none; font-size: 0.9rem;">Forgot your password?</a>
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

const FORGOT_PASSWORD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Forgot Password</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; padding: 3rem; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); width: 100%; max-width: 400px; }
        h1 { color: #667eea; margin-bottom: 0.5rem; font-size: 1.75rem; }
        p { color: #718096; margin-bottom: 1.5rem; font-size: 0.95rem; }
        label { display: block; margin-bottom: 0.5rem; color: #4a5568; font-weight: 600; }
        input { width: 100%; padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 1rem; margin-bottom: 1.5rem; }
        input:focus { outline: none; border-color: #667eea; }
        .btn { width: 100%; padding: 0.875rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; }
        .message { padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem; display: none; }
        .message.success { background: #f0fff4; border: 1px solid #9ae6b4; color: #276749; display: block; }
        .message.error { background: #fff5f5; border: 1px solid #feb2b2; color: #c53030; display: block; }
        .back { text-align: center; margin-top: 1.5rem; }
        .back a { color: #667eea; text-decoration: none; font-size: 0.9rem; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Reset Password</h1>
        <p>Enter your email and we'll send you a link to reset your password.</p>
        <div id="message" class="message"></div>
        <form id="forgotForm">
            <label for="email">Email Address</label>
            <input type="email" id="email" required autocomplete="email" placeholder="you@example.com">
            <button type="submit" class="btn">Send Reset Link</button>
        </form>
        <div class="back"><a href="/login">← Back to sign in</a></div>
    </div>
    <script>
        document.getElementById('forgotForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const msg = document.getElementById('message');
            msg.className = 'message';
            try {
                const res = await fetch('/api/auth/forgot-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: document.getElementById('email').value })
                });
                msg.className = 'message success';
                msg.textContent = 'If that email exists, a reset link has been sent. Check your inbox.';
                document.getElementById('forgotForm').style.display = 'none';
            } catch (err) {
                msg.className = 'message error';
                msg.textContent = 'Something went wrong. Please try again.';
            }
        });
    </script>
</body>
</html>`;

const RESET_PASSWORD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Set New Password</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; padding: 3rem; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); width: 100%; max-width: 400px; }
        h1 { color: #667eea; margin-bottom: 0.5rem; font-size: 1.75rem; }
        p { color: #718096; margin-bottom: 1.5rem; font-size: 0.95rem; }
        label { display: block; margin-bottom: 0.5rem; color: #4a5568; font-weight: 600; }
        .form-group { margin-bottom: 1.25rem; }
        input { width: 100%; padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 1rem; }
        input:focus { outline: none; border-color: #667eea; }
        .btn { width: 100%; padding: 0.875rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 1rem; }
        .message { padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem; display: none; }
        .message.success { background: #f0fff4; border: 1px solid #9ae6b4; color: #276749; display: block; }
        .message.error { background: #fff5f5; border: 1px solid #feb2b2; color: #c53030; display: block; }
        .back { text-align: center; margin-top: 1.5rem; }
        .back a { color: #667eea; text-decoration: none; font-size: 0.9rem; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Set New Password</h1>
        <p>Choose a strong password for your account.</p>
        <div id="message" class="message"></div>
        <form id="resetForm">
            <div class="form-group">
                <label for="password">New Password</label>
                <input type="password" id="password" required minlength="8" placeholder="At least 8 characters">
            </div>
            <div class="form-group">
                <label for="confirm">Confirm Password</label>
                <input type="password" id="confirm" required placeholder="Repeat your password">
            </div>
            <button type="submit" class="btn">Set Password</button>
        </form>
        <div class="back"><a href="/login">← Back to sign in</a></div>
    </div>
    <script>
        const token = new URLSearchParams(window.location.search).get('token');
        if (!token) window.location.href = '/login';

        document.getElementById('resetForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const msg = document.getElementById('message');
            const password = document.getElementById('password').value;
            const confirm = document.getElementById('confirm').value;
            if (password !== confirm) {
                msg.className = 'message error';
                msg.textContent = 'Passwords do not match.';
                return;
            }
            try {
                const res = await fetch('/api/auth/reset-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, password })
                });
                const data = await res.json();
                if (res.ok) {
                    msg.className = 'message success';
                    msg.textContent = 'Password updated! Redirecting to login...';
                    document.getElementById('resetForm').style.display = 'none';
                    setTimeout(() => window.location.href = '/login', 2000);
                } else {
                    msg.className = 'message error';
                    msg.textContent = data.error || 'Reset failed. The link may have expired.';
                }
            } catch (err) {
                msg.className = 'message error';
                msg.textContent = 'Something went wrong. Please try again.';
            }
        });
    </script>
</body>
</html>`;

function buildOnboardingHtml(member, token, settings) {
    const appName = settings?.companyName || settings?.appName || 'GSD Property Services';
    const nameParts = (member.name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(-1)[0] || '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Employee Onboarding — ${appName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:2rem 1rem;}
.card{background:white;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:580px;width:100%;padding:2rem;}
.logo{text-align:center;margin-bottom:1.5rem;}
.logo h1{color:#667eea;font-size:1.4rem;}
.logo p{color:#718096;margin-top:0.25rem;font-size:0.95rem;}
.steps{display:flex;margin-bottom:2rem;border-radius:8px;overflow:hidden;border:2px solid #e2e8f0;}
.step-tab{flex:1;padding:0.6rem 0.25rem;text-align:center;font-size:0.78rem;font-weight:600;color:#718096;background:#f7fafc;border-right:1px solid #e2e8f0;}
.step-tab:last-child{border-right:none;}
.step-tab.active{background:#667eea;color:white;}
.step-tab.done{background:#c6f6d5;color:#276749;}
h3{color:#2d3748;margin-bottom:1.25rem;font-size:1.05rem;}
label{display:block;font-size:0.88rem;font-weight:600;color:#4a5568;margin-bottom:0.3rem;margin-top:0.9rem;}
label:first-of-type{margin-top:0;}
input[type=text],input[type=date],input[type=number],select{width:100%;padding:0.6rem 0.8rem;border:2px solid #e2e8f0;border-radius:8px;font-size:0.95rem;color:#2d3748;background:white;}
input:focus,select:focus{outline:none;border-color:#667eea;}
.two-col{display:grid;grid-template-columns:1fr 56px;gap:0.75rem;align-items:end;}
.note{background:#ebf8ff;border-left:3px solid #63b3ed;padding:0.7rem 1rem;border-radius:4px;font-size:0.83rem;color:#2c5282;margin-top:1rem;line-height:1.5;}
.warn{background:#fffbea;border-left:3px solid #f6e05e;padding:0.7rem 1rem;border-radius:4px;font-size:0.83rem;color:#744210;margin-top:1rem;line-height:1.5;}
.policy-item{display:flex;gap:0.75rem;align-items:flex-start;padding:0.9rem 1rem;border:2px solid #e2e8f0;border-radius:8px;margin-bottom:0.65rem;cursor:pointer;}
.policy-item:hover{border-color:#667eea;background:#f7f8ff;}
.policy-item.checked{border-color:#48bb78;background:#f0fff4;}
.policy-item input[type=checkbox]{margin-top:3px;flex-shrink:0;width:17px;height:17px;cursor:pointer;accent-color:#48bb78;}
.policy-item p{color:#2d3748;font-size:0.88rem;line-height:1.55;margin:0;pointer-events:none;}
.policy-item strong{display:block;margin-bottom:0.2rem;}
.btn-row{display:flex;gap:0.75rem;margin-top:1.75rem;}
.btn{padding:0.7rem 1.4rem;border-radius:8px;border:none;font-size:0.95rem;font-weight:600;cursor:pointer;}
.btn-primary{background:#667eea;color:white;flex:1;}
.btn-secondary{background:#e2e8f0;color:#4a5568;}
.err{color:#e53e3e;font-size:0.83rem;margin-top:0.5rem;display:none;}
.step-content{display:none;}
.step-content.active{display:block;}
.success-wrap{text-align:center;padding:1.5rem 0;}
.success-wrap .icon{font-size:3rem;margin-bottom:1rem;}
.success-wrap h3{color:#276749;font-size:1.25rem;margin-bottom:0.75rem;}
.success-wrap p{color:#4a5568;line-height:1.6;margin-bottom:0.5rem;}
.success-wrap ul{text-align:left;display:inline-block;color:#4a5568;line-height:2;margin-top:0.5rem;padding-left:1.25rem;}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>${appName}</h1>
    <p>Welcome, <strong>${member.name}</strong> — please complete your employment paperwork below.</p>
  </div>
  <div class="steps" id="stepTabs">
    <div class="step-tab active" data-step="1">1. Tax Info</div>
    <div class="step-tab" data-step="2">2. Eligibility</div>
    <div class="step-tab" data-step="3">3. Policies</div>
  </div>
  <div class="step-content active" id="step-1">
    <h3>W-4 Withholding Preferences</h3>
    <label for="filingStatus">Filing Status</label>
    <select id="filingStatus">
      <option value="single">Single or Married Filing Separately</option>
      <option value="married">Married Filing Jointly (or Qualifying Widow(er))</option>
      <option value="head">Head of Household</option>
    </select>
    <label for="dependentsAmt">Dependent Tax Credit Amount (annual $, optional)</label>
    <input type="number" id="dependentsAmt" placeholder="e.g. 2000 per child under 17" min="0" step="500">
    <label for="extraWithholding">Extra Withholding Per Pay Period (optional)</label>
    <input type="number" id="extraWithholding" placeholder="0" min="0" step="1">
    <div class="note">A paper W-4 will also be required on your first day. This helps your employer configure withholding in the payroll system.</div>
    <div class="btn-row"><button class="btn btn-primary" onclick="nextStep()">Next: Eligibility →</button></div>
  </div>
  <div class="step-content" id="step-2">
    <h3>Employment Eligibility (I-9)</h3>
    <div class="two-col">
      <div><label for="i9First">First Name</label><input type="text" id="i9First" placeholder="First name" value="${firstName}"></div>
      <div><label for="i9MI">MI</label><input type="text" id="i9MI" maxlength="1" placeholder="M"></div>
    </div>
    <label for="i9Last">Last Name</label>
    <input type="text" id="i9Last" placeholder="Last name" value="${lastName}">
    <label for="i9DOB">Date of Birth</label>
    <input type="date" id="i9DOB">
    <label for="citizenStatus">Citizenship / Immigration Status</label>
    <select id="citizenStatus">
      <option value="citizen">U.S. Citizen or U.S. National</option>
      <option value="permanent_resident">Lawful Permanent Resident</option>
      <option value="authorized">Alien Authorized to Work</option>
    </select>
    <div class="warn">You must present <strong>original identity documents</strong> on your first day — e.g., a U.S. Passport, or Driver's License + Social Security card. Photocopies are not accepted.</div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="prevStep()">← Back</button>
      <button class="btn btn-primary" onclick="nextStep()">Next: Policies →</button>
    </div>
  </div>
  <div class="step-content" id="step-3">
    <h3>Policy Acknowledgments</h3>
    <p style="color:#718096;font-size:0.88rem;margin-bottom:1.1rem;">Read and check each item to confirm you understand.</p>
    <div class="policy-item" onclick="togglePolicy('pol1')">
      <input type="checkbox" id="pol1">
      <p><strong>No Cash Payroll</strong>All wages are paid by check or direct deposit only. No cash payments will be made.</p>
    </div>
    <div class="policy-item" onclick="togglePolicy('pol2')">
      <input type="checkbox" id="pol2">
      <p><strong>Safety Expectations</strong>I agree to follow all safety requirements, use appropriate PPE, report hazards immediately, and follow safe work practices on all job sites.</p>
    </div>
    <div class="policy-item" onclick="togglePolicy('pol3')">
      <input type="checkbox" id="pol3">
      <p><strong>Tool Policy</strong>${appName} provides power tools and major equipment. Employees supply basic hand tools. Personal tools on job sites are the employee's own responsibility.</p>
    </div>
    <div class="policy-item" onclick="togglePolicy('pol4')">
      <input type="checkbox" id="pol4">
      <p><strong>Overtime</strong>Overtime (over 40 hrs/week) is paid at 1.5\xd7 my regular rate per NJ law and must be pre-approved.</p>
    </div>
    <div class="err" id="polErr">Please acknowledge all four policies before submitting.</div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="prevStep()">← Back</button>
      <button class="btn btn-primary" onclick="submitOnboarding()">✓ Submit Onboarding</button>
    </div>
  </div>
  <div class="step-content" id="step-success">
    <div class="success-wrap">
      <div class="icon">✅</div>
      <h3>You're all set, ${firstName}!</h3>
      <p>Your onboarding information has been submitted. Your employer will follow up with next steps.</p>
      <p style="margin-top:1rem;font-weight:600;color:#2d3748;">Please bring on your first day:</p>
      <ul>
        <li>Original ID documents (U.S. Passport, or Driver's License + SS card)</li>
        <li>Voided check if setting up direct deposit</li>
        <li>Paper W-4 (your employer will have one ready)</li>
      </ul>
    </div>
  </div>
</div>
<script>
var cur=1,tok='${token}';
function nextStep(){
  if(cur===2){if(!document.getElementById('i9First').value.trim()||!document.getElementById('i9Last').value.trim()||!document.getElementById('i9DOB').value){alert('Please complete your name and date of birth.');return;}}
  if(cur<3){setTab(cur,'done');cur++;document.getElementById('step-'+cur).classList.add('active');setTab(cur,'active');document.getElementById('step-'+(cur-1)).classList.remove('active');}
}
function prevStep(){
  if(cur>1){setTab(cur,'');cur--;document.getElementById('step-'+cur).classList.add('active');setTab(cur,'active');document.getElementById('step-'+(cur+1)).classList.remove('active');}
}
function setTab(n,s){var t=document.querySelector('[data-step="'+n+'"]');t.className='step-tab'+(s?' '+s:'');}
function togglePolicy(id){var c=document.getElementById(id);c.checked=!c.checked;c.closest('.policy-item').classList.toggle('checked',c.checked);}
async function submitOnboarding(){
  var all=['pol1','pol2','pol3','pol4'].every(function(id){return document.getElementById(id).checked;});
  if(!all){document.getElementById('polErr').style.display='block';return;}
  document.getElementById('polErr').style.display='none';
  var body={w4:{filingStatus:document.getElementById('filingStatus').value,dependentsAmt:parseFloat(document.getElementById('dependentsAmt').value)||0,extraWithholding:parseFloat(document.getElementById('extraWithholding').value)||0},i9:{firstName:document.getElementById('i9First').value.trim(),middleInitial:document.getElementById('i9MI').value.trim(),lastName:document.getElementById('i9Last').value.trim(),dob:document.getElementById('i9DOB').value,citizenStatus:document.getElementById('citizenStatus').value},policies:{acknowledged:true}};
  try{
    var r=await fetch('/api/onboarding/'+tok,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok)throw new Error();
    document.getElementById('step-3').classList.remove('active');
    document.getElementById('stepTabs').style.display='none';
    document.getElementById('step-success').classList.add('active');
  }catch(e){alert('Error submitting. Please try again or contact your employer.');}
}
</script>
</body>
</html>`;
}

// Start Express app
const app = express();

// ── Global safety net ────────────────────────────────────────────────────────
// A stray unhandled rejection / exception would otherwise terminate the whole
// process (Node default) and crash-loop the app. Log loudly and stay alive.
process.on('unhandledRejection', (reason) => {
    console.error('⚠️  Unhandled promise rejection (app kept alive):', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️  Uncaught exception (app kept alive):', err && err.stack ? err.stack : err);
});

// Trust proxy (Heroku uses load balancer)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
    contentSecurityPolicy: false // disabled — inline scripts/styles in the app HTML
}));

// Rate limiters
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

const publicApiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Try again later.' }
});

// Body parsing — 50mb for upload routes, 10kb everywhere else
const LARGE_BODY_PATHS = ['/api/upload', '/api/public/quote-request', '/api/client-portal/quote-request', '/api/expenses', '/api/settings', '/api/portfolio', '/api/compliance-docs', '/api/quotes', '/api/jobs', '/api/taxes/confirmations'];
app.use((req, res, next) => {
    const limit = LARGE_BODY_PATHS.some(p => req.path.startsWith(p)) ? '50mb' : '10kb';
    express.json({ limit })(req, res, next);
});
app.use((req, res, next) => {
    const limit = LARGE_BODY_PATHS.some(p => req.path.startsWith(p)) ? '50mb' : '10kb';
    express.urlencoded({ extended: true, limit })(req, res, next);
});

// ─── Portfolio: module-level S3 client + page generators ─────────────────────

const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL || 'https://d2ludoxusetr9v.cloudfront.net';

function portfolioPhotoUrl(s3Key) {
    if (!s3Key) return '';
    if (s3Key.startsWith('http')) return s3Key;
    return `${CLOUDFRONT_URL}/${s3Key}`;
}

function _pfParseType(key) {
    const name = key.split('/').pop();
    if (name.startsWith('before-')) return 'before';
    if (name.startsWith('after-'))  return 'after';
    return 'other';
}
const PUBLIC_S3_BUCKET = process.env.PUBLIC_S3_BUCKET;

let publicS3Client = null;
if (process.env.PUBLIC_S3_KEY && process.env.PUBLIC_S3_SECRET && PUBLIC_S3_BUCKET) {
    publicS3Client = new S3Client({
        region: 'us-east-1',
        credentials: {
            accessKeyId: process.env.PUBLIC_S3_KEY,
            secretAccessKey: process.env.PUBLIC_S3_SECRET
        }
    });
    console.log('✅ Public S3 client enabled - Bucket:', PUBLIC_S3_BUCKET);
}

// Function to setup routes (called after session middleware is ready)
function setupRoutes() {
// Routes
async function buildAuthHtml(html) {
    try {
        const settings = await db.collection('settings').findOne({});
        const appName = settings?.appName || 'GSD Property Services';
        return html.replace(/\{\{APP_NAME\}\}/g, appName);
    } catch {
        return html.replace(/\{\{APP_NAME\}\}/g, 'GSD Property Services');
    }
}

app.get('/login', async (req, res) => {
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.send(await buildAuthHtml(LOGIN_HTML));
});

app.get('/register', (req, res) => res.redirect('/login'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/forgot-password', (req, res) => res.send(FORGOT_PASSWORD_HTML));
app.get('/reset-password', (req, res) => res.send(RESET_PASSWORD_HTML));

app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });

        const user = await db.collection('users').findOne({ email: email.toLowerCase() });
        // Always return success to avoid user enumeration
        if (!user) return res.json({ success: true });

        const token = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await db.collection('users').updateOne(
            { _id: user._id },
            { $set: { resetToken: token, resetTokenExpiry: expiry } }
        );

        const settings = await db.collection('settings').findOne({});
        const appName = settings?.appName || 'GSD Property Services';
        const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}`;

        await emailService.sendEmail({
            to: user.email,
            subject: `${appName} — Password Reset`,
            html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:2rem;">
                <h2 style="color:#667eea;">Reset Your Password</h2>
                <p>Hi ${user.name},</p>
                <p>Click the button below to reset your password. This link expires in 1 hour.</p>
                <div style="text-align:center;margin:2rem 0;">
                    <a href="${resetUrl}" style="display:inline-block;background-color:#667eea;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;font-family:Arial,sans-serif;">Reset Password</a>
                </div>
                <p style="color:#718096;font-size:0.85rem;">Or copy and paste this link into your browser:<br><a href="${resetUrl}" style="color:#667eea;">${resetUrl}</a></p>
                <p style="color:#718096;font-size:0.85rem;margin-top:1rem;">If you didn't request this, you can safely ignore this email.</p>
            </div>`,
            text: `Reset your password: ${resetUrl}\n\nThis link expires in 1 hour.`
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ error: 'Failed to send reset email' });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

        const user = await db.collection('users').findOne({
            resetToken: token,
            resetTokenExpiry: { $gt: new Date() }
        });

        if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

        const hashed = await bcrypt.hash(password, 10);
        await db.collection('users').updateOne(
            { _id: user._id },
            { $set: { password: hashed }, $unset: { resetToken: '', resetTokenExpiry: '', tempPassword: '' } }
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

app.post('/api/auth/register', (req, res) => res.status(403).json({ error: 'Registration is not available' }));

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await db.collection('users').findOne({ email: email.toLowerCase() });
        if (!user) {
            await db.collection('login_logs').insertOne({ type: 'business', email: email.toLowerCase(), at: new Date(), ip, success: false, reason: 'User not found' });
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            await db.collection('login_logs').insertOne({ type: 'business', targetId: user._id, email: user.email, at: new Date(), ip, success: false, reason: 'Wrong password' });
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        await db.collection('login_logs').insertOne({ type: 'business', targetId: user._id, email: user.email, at: new Date(), ip, success: true, reason: null });

        // Capture previous login time as briefing baseline, then update
        const prevLogin = user.lastLogin || null;
        await db.collection('users').updateOne(
            { _id: user._id },
            { $set: { lastLogin: new Date() } }
        );

        req.session.userId = user._id;
        req.session.userEmail = user.email;
        req.session.userName = user.name;
        req.session.userRole = user.role || 'user';
        req.session.briefingSince = prevLogin ? prevLogin.toISOString() : null;

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

// Clover public config — safe to expose, these are client-side keys
app.get('/api/clover-config', isAuthenticated, (req, res) => {
    res.json({
        publicKey: process.env.CLOVER_PUBLIC_KEY || '',
        merchantId: process.env.CLOVER_MERCHANT_ID || ''
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
app.get('/api/users/:id/login-log', isAdmin, async (req, res) => {
    const logs = await db.collection('login_logs')
        .find({ type: 'business', targetId: new ObjectId(req.params.id) })
        .sort({ at: -1 }).limit(50).toArray();
    res.json(logs);
});

app.get('/api/clients/:id/login-log', isAdmin, async (req, res) => {
    const logs = await db.collection('login_logs')
        .find({ type: 'client', targetId: new ObjectId(req.params.id) })
        .sort({ at: -1 }).limit(50).toArray();
    res.json(logs);
});

app.post('/api/clients/:id/set-portal-password', isAdmin, async (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 1) return res.status(400).json({ error: 'Password required' });
    const hashed = await bcrypt.hash(password, 10);
    await db.collection('clients').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { portalPassword: hashed, updatedAt: new Date() } }
    );
    res.json({ success: true });
});

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

// Public quote request page (embedded as iframe on gsdhandymanservice.com)
app.get('/request-quote', (req, res) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
    const { utm_source='', utm_medium='', utm_campaign='', ref='', entry='' } = req.query;
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Request a Quote</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #fff; color: #1f2937; padding: 1.25rem 1.25rem 1rem; overflow-x: hidden; }
  h2 { font-size: 1.1rem; font-weight: 700; color: #0f1c2e; margin-bottom: 0.2rem; }
  .subtitle { color: #6b7280; font-size: 0.8rem; margin-bottom: 1rem; }
  .form-group { margin-bottom: 0.65rem; }
  label { display: block; font-size: 0.78rem; font-weight: 600; color: #374151; margin-bottom: 0.2rem; }
  input, select, textarea {
    width: 100%; padding: 0.45rem 0.65rem;
    border: 1.5px solid #e5e7eb; border-radius: 6px;
    font-size: 0.875rem; font-family: inherit; color: #1f2937;
    outline: none; transition: border-color 0.2s;
  }
  input:focus, select:focus, textarea:focus { border-color: #1d6fa4; }
  textarea { resize: none; height: 70px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
  .submit-btn {
    width: 100%; padding: 0.65rem;
    background: #0f1c2e; color: white;
    border: none; border-radius: 6px;
    font-size: 0.9rem; font-weight: 600;
    cursor: pointer; margin-top: 0.25rem;
    transition: background 0.2s;
  }
  .submit-btn:hover { background: #1a2f4a; }
  .submit-btn:disabled { background: #9ca3af; cursor: not-allowed; }
  .success { text-align: center; padding: 2rem 1rem; display: none; }
  .success .check { font-size: 2.5rem; margin-bottom: 0.75rem; }
  .success h3 { font-size: 1.1rem; font-weight: 700; color: #0f1c2e; margin-bottom: 0.4rem; }
  .success p { color: #6b7280; font-size: 0.85rem; }
  .error-msg { color: #dc2626; font-size: 0.75rem; margin-top: 0.35rem; display: none; }

  /* Photo upload */
  .photo-hint {
    background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px;
    padding: 0.5rem 0.65rem; margin-bottom: 0.65rem;
    font-size: 0.78rem; color: #1e40af; display: flex; gap: 0.4rem; align-items: flex-start;
    word-break: break-word; overflow-wrap: break-word; min-width: 0;
  }
  .photo-hint span { flex-shrink: 0; }
  .photo-hint .hint-text { flex: 1; min-width: 0; }
  .upload-zone {
    border: 2px dashed #d1d5db; border-radius: 8px;
    padding: 0.75rem; text-align: center;
    cursor: pointer; transition: border-color 0.2s, background 0.2s;
    position: relative;
  }
  .upload-zone:hover, .upload-zone.drag-over { border-color: #1d6fa4; background: #f0f7ff; }
  .upload-zone input[type="file"] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
  .upload-zone-inner { pointer-events: none; }
  .upload-icon { font-size: 1.4rem; margin-bottom: 0.2rem; }
  .upload-zone p { font-size: 0.78rem; color: #6b7280; margin: 0; }
  .upload-zone strong { color: #1d6fa4; }
  .upload-zone .max-note { font-size: 0.7rem; color: #9ca3af; margin-top: 0.15rem; }
  .photo-previews { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
  .photo-thumb {
    position: relative; width: 64px; height: 64px;
    border-radius: 6px; overflow: hidden; border: 1.5px solid #e5e7eb;
    flex-shrink: 0;
  }
  .photo-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .photo-thumb .remove-photo {
    position: absolute; top: 2px; right: 2px;
    background: rgba(0,0,0,0.6); color: white;
    border: none; border-radius: 50%; width: 16px; height: 16px;
    font-size: 9px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    line-height: 1;
  }
  .photo-thumb .compressing {
    position: absolute; inset: 0; background: rgba(255,255,255,0.8);
    display: flex; align-items: center; justify-content: center;
    font-size: 0.6rem; color: #6b7280;
  }
  .photo-count { font-size: 0.72rem; color: #6b7280; margin-top: 0.3rem; }
  .sms-consent {
    display: flex; align-items: flex-start; gap: 0.55rem;
    background: #f8fafc; border: 1.5px solid #e5e7eb; border-radius: 6px;
    padding: 0.65rem 0.75rem; margin-bottom: 0.65rem;
  }
  .sms-consent input[type="checkbox"] {
    width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px;
    accent-color: #0f1c2e; cursor: pointer;
  }
  .sms-consent label {
    font-size: 0.75rem; font-weight: 400; color: #4b5563;
    line-height: 1.45; cursor: pointer; margin: 0;
  }
  .sms-consent label a { color: #1d6fa4; text-decoration: underline; }
</style>
</head>
<body>
<div id="formWrap">
  <h2>Request a Free Quote</h2>
  <p class="subtitle">We'll get back to you within a few hours.</p>
  <form id="quoteForm">
    <div class="row">
      <div class="form-group">
        <label>First Name *</label>
        <input type="text" name="firstName" required placeholder="John">
      </div>
      <div class="form-group">
        <label>Last Name *</label>
        <input type="text" name="lastName" required placeholder="Smith">
      </div>
    </div>
    <div class="row">
      <div class="form-group">
        <label>Phone *</label>
        <input type="tel" name="phone" required placeholder="856-555-1234">
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" name="email" placeholder="john@email.com">
      </div>
    </div>
    <div class="row">
      <div class="form-group">
        <label>Service *</label>
        <select name="service" required>
          <option value="">Select...</option>
          <option>Electrical</option>
          <option>Plumbing</option>
          <option>Carpentry / Wood</option>
          <option>General Handyman</option>
          <option>Other</option>
        </select>
      </div>
      <div class="form-group">
        <label>City / Town</label>
        <input type="text" name="city" placeholder="Vineland...">
      </div>
    </div>
    <div class="form-group">
      <label>Describe the Work</label>
      <textarea name="description" placeholder="Tell us what needs to be done..."></textarea>
    </div>

    <div class="form-group">
      <label>Photos <span style="font-weight:400;color:#9ca3af;">(optional)</span></label>
      <div class="photo-hint">
        <span>📸</span>
        <span class="hint-text">Adding photos helps us give you a more accurate estimate — snap the area that needs work before submitting.</span>
      </div>
      <div class="upload-zone" id="uploadZone">
        <input type="file" id="photoInput" accept="image/*" multiple>
        <div class="upload-zone-inner">
          <div class="upload-icon">📷</div>
          <p><strong>Tap to add photos</strong> or drag & drop</p>
          <p class="max-note">Up to 5 photos · JPG, PNG, HEIC</p>
        </div>
      </div>
      <div class="photo-previews" id="photoPreviews"></div>
      <div class="photo-count" id="photoCount"></div>
    </div>

    <div class="form-group">
      <label>Best Way to Reach You</label>
      <select name="contactPref">
        <option value="phone">Phone call</option>
        <option value="text">Text message</option>
        <option value="email">Email</option>
      </select>
    </div>
    <div class="form-group">
      <label>How did you find us? <span style="font-weight:400;color:#9ca3af;">(optional)</span></label>
      <select name="foundUs">
        <option value="">Select...</option>
        <option value="google_search">Google Search</option>
        <option value="google_maps">Google Maps</option>
        <option value="facebook">Facebook</option>
        <option value="nextdoor">Nextdoor</option>
        <option value="referral">Friend or Neighbor</option>
        <option value="flyer_sign">Flyer / Yard Sign</option>
        <option value="returning">Returning Customer</option>
        <option value="other">Other</option>
      </select>
    </div>
    <input type="hidden" name="utmSource" value="${utm_source}">
    <input type="hidden" name="utmMedium" value="${utm_medium}">
    <input type="hidden" name="utmCampaign" value="${utm_campaign}">
    <input type="hidden" name="referer" value="${ref}">
    <input type="hidden" name="entryPage" value="${entry}">
    <div class="sms-consent">
      <input type="checkbox" id="smsConsent" name="smsConsent">
      <label for="smsConsent">I agree to receive text messages from GSD Property Services regarding my quote, appointment reminders, and job updates. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out or HELP for help. No mobile information will be shared with third parties. <a href="https://gsdhandymanservice.com/privacy" target="_blank">Privacy Policy</a></label>
    </div>
    <p class="error-msg" id="errorMsg">Something went wrong. Please try again or call 856-872-4636.</p>
    <button type="submit" class="submit-btn" id="submitBtn">Submit Request</button>
  </form>
</div>
<div class="success" id="successMsg">
  <div class="check">✅</div>
  <h3>Request Received!</h3>
  <p>Thanks! We'll be in touch shortly.<br>Call us at <strong>856-872-4636</strong>.</p>
</div>
<script>
function notifyHeight() {
  window.parent.postMessage({ type: 'quoteFormHeight', height: document.body.scrollHeight }, '*');
}
window.addEventListener('load', notifyHeight);
new ResizeObserver(notifyHeight).observe(document.body);

// ── Photo handling ──────────────────────────────────────────────
const MAX_PHOTOS = 5;
const MAX_DIM = 1200;
const QUALITY = 0.72;
let compressedPhotos = []; // array of base64 strings

function compressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > MAX_DIM || h > MAX_DIM) {
          if (w >= h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
          else { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', QUALITY));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderPreviews() {
  const wrap = document.getElementById('photoPreviews');
  const count = document.getElementById('photoCount');
  wrap.innerHTML = '';
  compressedPhotos.forEach((b64, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'photo-thumb';
    thumb.innerHTML = \`<img src="\${b64}"><button type="button" class="remove-photo" aria-label="Remove photo">✕</button>\`;
    thumb.querySelector('.remove-photo').addEventListener('click', () => {
      compressedPhotos.splice(i, 1);
      renderPreviews();
    });
    wrap.appendChild(thumb);
  });
  const remaining = MAX_PHOTOS - compressedPhotos.length;
  count.textContent = compressedPhotos.length > 0
    ? \`\${compressedPhotos.length} photo\${compressedPhotos.length > 1 ? 's' : ''} added\${remaining > 0 ? \` · \${remaining} more allowed\` : ' (max reached)'}\`
    : '';
  // show/hide upload zone
  document.getElementById('uploadZone').style.display = compressedPhotos.length >= MAX_PHOTOS ? 'none' : '';
  notifyHeight();
}

async function handleFiles(files) {
  const toAdd = Array.from(files).slice(0, MAX_PHOTOS - compressedPhotos.length);
  if (!toAdd.length) return;

  // Add placeholder thumbs while compressing
  const startIdx = compressedPhotos.length;
  toAdd.forEach(() => compressedPhotos.push(null));
  renderPreviews();
  // Show spinner in placeholders
  document.querySelectorAll('.photo-thumb img').forEach((img, i) => {
    if (i >= startIdx) img.closest('.photo-thumb').innerHTML += '<div class="compressing">...</div>';
  });

  const compressed = await Promise.all(toAdd.map(compressImage));
  compressed.forEach((b64, i) => { compressedPhotos[startIdx + i] = b64; });
  renderPreviews();
}

const photoInput = document.getElementById('photoInput');
photoInput.addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});

// ── Form submit ────────────────────────────────────────────────
document.getElementById('quoteForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const err = document.getElementById('errorMsg');
  btn.disabled = true;
  btn.textContent = compressedPhotos.filter(Boolean).length > 0 ? 'Sending photos...' : 'Sending...';
  err.style.display = 'none';
  const data = Object.fromEntries(new FormData(this));
  data.photos = compressedPhotos.filter(Boolean);
  try {
    const res = await fetch('/api/public/quote-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error();
    window.top.location.href = 'https://gsdhandymanservice.com/thank-you';
  } catch {
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Submit Request';
  }
});
</script>
</body>
</html>`);
});

// Public quote request API
app.post('/api/public/quote-request', publicApiLimiter, async (req, res) => {
    try {
        const { firstName, lastName, phone, email, service, description, city, contactPref, photos, foundUs, utmSource, utmMedium, utmCampaign, referer, entryPage, smsConsent } = req.body;
        if (!firstName || !lastName || !phone || !service) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const validPhotos = Array.isArray(photos) ? photos.filter(p => typeof p === 'string' && p.startsWith('data:image/')).slice(0, 5) : [];

        // Upload photos to S3 under leads/ channel, fall back to base64 if S3 unavailable
        let photoKeys = [];
        if (validPhotos.length > 0 && s3Client) {
            const ts = Date.now();
            const uploads = await Promise.all(validPhotos.map(async (dataUrl, i) => {
                const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/);
                if (!match) return null;
                const [, contentType, rawExt] = match;
                const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
                const key = `leads/${ts}-${i}.${ext}`;
                const buffer = Buffer.from(match[3], 'base64');
                const command = new PutObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key, Body: buffer, ContentType: contentType });
                await s3Client.send(command);
                return key;
            }));
            photoKeys = uploads.filter(Boolean);
        }

        const lead = {
            firstName, lastName,
            name: `${firstName} ${lastName}`,
            phone, email: email || '',
            service, description: description || '',
            city: city || '',
            contactPref: contactPref || 'phone',
            photos: photoKeys.length ? photoKeys : validPhotos,
            source: 'website',
            foundUs: foundUs || '',
            tracking: {
                utmSource: utmSource || '',
                utmMedium: utmMedium || '',
                utmCampaign: utmCampaign || '',
                referer: referer || '',
                entryPage: entryPage || ''
            },
            smsConsent: smsConsent === 'on' || smsConsent === true,
            status: 'new',
            createdAt: new Date()
        };

        await db.collection('leads').insertOne(lead);

        // Email notification to Franz
        if (emailService.initialized) {
            // Generate 24h signed URLs for email so images render
            const emailPhotoUrls = photoKeys.length
                ? await Promise.all(photoKeys.map(k => getS3SignedUrl(k, 86400)))
                : validPhotos;
            const photoHtml = emailPhotoUrls.length > 0
                ? `<tr><td style="padding:8px 0;font-weight:600;color:#374151;vertical-align:top;">Photos</td><td><div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px;">${emailPhotoUrls.map(p => `<img src="${p}" style="width:120px;height:90px;object-fit:cover;border-radius:4px;border:1px solid #e5e7eb;">`).join('')}</div></td></tr>`
                : '';
            await emailService.sendEmail({
                to: 'info@gsdhandymanservice.com',
                subject: `New Quote Request — ${service} — ${firstName} ${lastName}${validPhotos.length ? ` (${validPhotos.length} photo${validPhotos.length > 1 ? 's' : ''})` : ''}`,
                html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                    <h2 style="color:#0f1c2e;">New Quote Request</h2>
                    <table style="width:100%;border-collapse:collapse;">
                        <tr><td style="padding:8px 0;font-weight:600;color:#374151;width:140px;">Name</td><td>${firstName} ${lastName}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:600;color:#374151;">Phone</td><td><a href="tel:${phone}">${phone}</a></td></tr>
                        ${email ? `<tr><td style="padding:8px 0;font-weight:600;color:#374151;">Email</td><td>${email}</td></tr>` : ''}
                        <tr><td style="padding:8px 0;font-weight:600;color:#374151;">Service</td><td>${service}</td></tr>
                        ${city ? `<tr><td style="padding:8px 0;font-weight:600;color:#374151;">Location</td><td>${city}</td></tr>` : ''}
                        <tr><td style="padding:8px 0;font-weight:600;color:#374151;">Contact Via</td><td>${contactPref}</td></tr>
                        ${description ? `<tr><td style="padding:8px 0;font-weight:600;color:#374151;vertical-align:top;">Description</td><td>${description}</td></tr>` : ''}
                        ${photoHtml}
                    </table>
                    <p style="margin-top:20px;color:#6b7280;font-size:0.85rem;">Submitted via gsdhandymanservice.com</p>
                </div>`,
                text: `New Quote Request\n\nName: ${firstName} ${lastName}\nPhone: ${phone}\nEmail: ${email || 'N/A'}\nService: ${service}\nLocation: ${city || 'N/A'}\nContact Via: ${contactPref}\nPhotos: ${validPhotos.length}\n\n${description || ''}`
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Quote request error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Google Reviews proxy — keeps API key server-side, caches 1hr
let reviewsCache = null;
let reviewsCachedAt = 0;
// bump this when the fetch logic changes to force a cache miss on next request

app.get('/api/public/reviews', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'https://gsdhandymanservice.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 'no-store');

    const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
    // Only serve cache that has the full review shape (must include `text`);
    // rejects any stale/partial shape so it re-fetches Google instead of blanking the site.
    const cacheUsable = (c) => c && Array.isArray(c.reviews) && (c.reviews.length === 0 || typeof c.reviews[0].text === 'string');

    // L1: in-memory cache (fastest)
    if (reviewsCache && cacheUsable(reviewsCache) && Date.now() - reviewsCachedAt < CACHE_TTL) {
        return res.json(reviewsCache);
    }

    // L2: MongoDB cache — survives dyno restarts/deploys so those don't trigger Google calls
    try {
        const doc = await db.collection('reviews_cache').findOne({ _id: 'google' });
        if (doc && doc.data && cacheUsable(doc.data) && Date.now() - new Date(doc.cachedAt).getTime() < CACHE_TTL) {
            reviewsCache = doc.data;
            reviewsCachedAt = new Date(doc.cachedAt).getTime();
            return res.json(reviewsCache);
        }
    } catch (e) { /* fall through to Google */ }

    const apiKey = process.env.GOOGLE_API_KEY;
    const placeId = process.env.GOOGLE_PLACE_ID;

    if (!apiKey || !placeId) {
        return res.status(503).json({ error: 'Reviews not configured' });
    }

    try {
        const https = require('https');
        const url = `https://places.googleapis.com/v1/places/${placeId}?fields=rating,userRatingCount,reviews&key=${apiKey}&languageCode=en`;

        const data = await new Promise((resolve, reject) => {
            https.get(url, { headers: { 'X-Goog-FieldMask': 'rating,userRatingCount,reviews' } }, (r) => {
                let body = '';
                r.on('data', chunk => body += chunk);
                r.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
                });
            }).on('error', reject);
        });

        if (data.error) {
            console.error('Google Places error:', data.error.status, data.error.message);
            // Degrade gracefully instead of 502 (which spams the browser console):
            // serve last-known-good reviews (memory, then DB) if we have them.
            if (reviewsCache) return res.json({ ...reviewsCache, stale: true });
            try {
                const doc = await db.collection('reviews_cache').findOne({ _id: 'google' });
                if (doc && doc.data) return res.json({ ...doc.data, stale: true });
            } catch (e) { /* ignore */ }
            return res.json({ rating: null, total: 0, reviews: [], unavailable: true });
        }

        const reviews = (data.reviews || [])
            .filter(r => r.rating >= 4)
            .sort((a, b) => new Date(b.publishTime || 0) - new Date(a.publishTime || 0))
            .map(r => ({
                author: (() => {
                    const name = r.authorAttribution?.displayName || 'Anonymous';
                    const parts = name.trim().split(/\s+/);
                    return parts.length > 1 ? parts[0] + ' ' + parts[parts.length - 1][0] + '.' : name;
                })(),
                rating: r.rating,
                text: r.text?.text || '',
                time: r.relativePublishTimeDescription || '',
                photoUrl: r.authorAttribution?.photoUri || null
            }));

        reviewsCache = { rating: data.rating, total: data.userRatingCount, reviews };
        reviewsCachedAt = Date.now();
        // Persist so restarts/deploys read from DB instead of re-calling Google
        try {
            await db.collection('reviews_cache').updateOne(
                { _id: 'google' },
                { $set: { data: reviewsCache, cachedAt: new Date() } },
                { upsert: true }
            );
        } catch (e) { /* non-fatal */ }
        res.json(reviewsCache);
    } catch (err) {
        console.error('Reviews fetch error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin-only: force a LIVE Google reviews call (bypasses cache) for real-time testing.
// On success it also refreshes the cache, so a passing test instantly updates the site.
app.get('/api/reviews/test', isAuthenticated, async (req, res) => {
    const apiKey = process.env.GOOGLE_API_KEY;
    const placeId = process.env.GOOGLE_PLACE_ID;
    if (!apiKey || !placeId) {
        return res.json({ ok: false, reason: 'Not configured', hasKey: !!apiKey, hasPlaceId: !!placeId });
    }
    try {
        const https = require('https');
        const url = `https://places.googleapis.com/v1/places/${placeId}?fields=rating,userRatingCount,reviews&key=${apiKey}&languageCode=en`;
        const started = Date.now();
        const data = await new Promise((resolve, reject) => {
            https.get(url, { headers: { 'X-Goog-FieldMask': 'rating,userRatingCount,reviews' } }, (r) => {
                let body = ''; r.on('data', c => body += c); r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
            }).on('error', reject);
        });
        const ms = Date.now() - started;
        if (data.error) {
            // Dig out the precise reason (SERVICE_DISABLED, BILLING_DISABLED, etc.) + any activation URL
            const info = (data.error.details || []).find(d => d.reason || (d['@type'] || '').includes('ErrorInfo')) || {};
            const help = (data.error.details || []).find(d => (d['@type'] || '').includes('Help'));
            return res.json({
                ok: false, liveCall: true, ms,
                googleStatus: data.error.status, googleCode: data.error.code, googleMessage: data.error.message,
                reason: info.reason || null,
                service: info.metadata?.service || info.metadata?.serviceTitle || null,
                activationUrl: info.metadata?.activationUrl || help?.links?.[0]?.url || null,
                rawDetails: data.error.details || null
            });
        }
        // Build the SAME full shape the public endpoint uses, so refreshing the
        // cache here can't blank the homepage (which needs review.text).
        const reviews = (data.reviews || []).filter(r => r.rating >= 4).map(r => ({
            author: (() => {
                const name = r.authorAttribution?.displayName || 'Anonymous';
                const parts = name.trim().split(/\s+/);
                return parts.length > 1 ? parts[0] + ' ' + parts[parts.length - 1][0] + '.' : name;
            })(),
            rating: r.rating,
            text: r.text?.text || '',
            time: r.relativePublishTimeDescription || '',
            photoUrl: r.authorAttribution?.photoUri || null
        }));
        // Refresh both caches so a successful test lights up the live site immediately
        reviewsCache = { rating: data.rating, total: data.userRatingCount, reviews };
        reviewsCachedAt = Date.now();
        try {
            await db.collection('reviews_cache').updateOne({ _id: 'google' }, { $set: { data: reviewsCache, cachedAt: new Date() } }, { upsert: true });
        } catch (e) { /* non-fatal */ }
        return res.json({ ok: true, liveCall: true, ms, rating: data.rating, totalRatings: data.userRatingCount, reviewsReturned: reviews.length, cacheRefreshed: true });
    } catch (err) {
        return res.json({ ok: false, error: err.message });
    }
});

// Leads API
// ── Vendors ──────────────────────────────────────────────────────────────────
app.get('/api/vendors', isAuthenticated, async (req, res) => {
    const vendors = await db.collection('vendors').find().sort({ name: 1 }).toArray();
    res.json(vendors.map(v => ({ ...v, id: v._id.toString() })));
});

app.post('/api/vendors', isAuthenticated, async (req, res) => {
    const { id, name, category, accountNumber, phone, email, website, contact, address, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const doc = { name, category: category || '', accountNumber: accountNumber || '', phone: phone || '', email: email || '', website: website || '', contact: contact || '', address: address || '', notes: notes || '', updatedAt: new Date() };

    if (id) {
        await db.collection('vendors').updateOne({ _id: new ObjectId(id) }, { $set: doc });
        res.json({ success: true });
    } else {
        doc.createdAt = new Date();
        const result = await db.collection('vendors').insertOne(doc);
        res.json({ success: true, id: result.insertedId.toString() });
    }
});

app.delete('/api/vendors/:id', isAuthenticated, async (req, res) => {
    try {
        await db.collection('vendors').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: 'Invalid ID' });
    }
});

app.get('/api/leads', isAuthenticated, async (req, res) => {
    const leads = await db.collection('leads').find().sort({ createdAt: -1 }).toArray();
    const result = await Promise.all(leads.map(async l => {
        let photos = l.photos || [];
        if (s3Client && photos.length && photos[0].startsWith('leads/')) {
            photos = await Promise.all(photos.map(k => getS3SignedUrl(k, 3600)));
        }
        return { ...l, id: l._id.toString(), photos };
    }));
    res.json(result);
});

app.patch('/api/leads/:id', isAuthenticated, async (req, res) => {
    const { status, note, touchPoints } = req.body;
    const update = { updatedAt: new Date() };
    if (status !== undefined) update.status = status;
    if (note !== undefined) update.note = note;
    if (touchPoints !== undefined) update.touchPoints = touchPoints;
    await db.collection('leads').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: update }
    );
    res.json({ success: true });
});

app.delete('/api/leads/:id', isAuthenticated, async (req, res) => {
    try {
        const lead = await db.collection('leads').findOne({ _id: new ObjectId(req.params.id) });
        if (!lead) return res.status(404).json({ error: 'Not found' });
        if (s3Client && lead.photos && lead.photos.length) {
            const s3Keys = lead.photos.filter(p => typeof p === 'string' && p.startsWith('leads/'));
            await Promise.all(s3Keys.map(key =>
                s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key })).catch(e => console.error('S3 delete error:', key, e))
            ));
        }
        await db.collection('leads').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete lead error:', error);
        res.status(500).json({ error: 'Server error' });
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

// Conditions page (public)
app.get('/conditions', async (req, res) => {
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
    <title>Conditions - ${companyName}</title>
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
        <h1>Conditions</h1>
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
    res.setHeader('Cache-Control', 'no-store');
    res.send(HTML_TEMPLATE);
});

// ── Phase 1 offline support: service worker (admin app only) ──────────────────
// Network-first with cache fallback. GET-only. Only intercepts the admin shell
// ('/') and admin read APIs; everything else (portal, invoices, auth, POSTs)
// passes straight through to the network untouched.
// KILL-SWITCH: any previously-installed worker updates to this, which clears all
// caches, unregisters itself, and reloads open tabs — restoring normal network.
const SERVICE_WORKER_JS = `
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){ return Promise.all(keys.map(function(k){ return caches.delete(k); })); })
      .then(function(){ return self.registration.unregister(); })
      .then(function(){ return self.clients.matchAll({ type: 'window' }); })
      .then(function(clients){ clients.forEach(function(c){ try { c.navigate(c.url); } catch(e){} }); })
  );
});
// No fetch handler — all requests go straight to the network.
`;
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.send(SERVICE_WORKER_JS);
});

// ============================================================
// GOOGLE ANALYTICS OAUTH + DATA ROUTES
// ============================================================

app.get('/analytics/auth', isAuthenticated, (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = 'https://app.gsdhandymanservice.com/analytics/callback';
    const scope = 'https://www.googleapis.com/auth/analytics.readonly';
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;
    res.redirect(url);
});

app.get('/analytics/callback', async (req, res) => {
    try {
        const { code } = req.query;
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const redirectUri = 'https://app.gsdhandymanservice.com/analytics/callback';

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })
        });
        const tokens = await tokenRes.json();

        const update = { gaAccessToken: tokens.access_token, gaTokenExpiry: Date.now() + (tokens.expires_in * 1000) };
        if (tokens.refresh_token) update.gaRefreshToken = tokens.refresh_token;
        await db.collection('settings').updateOne({}, { $set: update }, { upsert: true });

        res.redirect('/?analytics=connected');
    } catch (e) {
        res.redirect('/?analytics=error');
    }
});

async function getGAAccessToken() {
    const settings = await db.collection('settings').findOne() || {};
    if (!settings.gaRefreshToken && !settings.gaAccessToken) return null;
    if (settings.gaAccessToken && settings.gaTokenExpiry > Date.now() + 60000) return settings.gaAccessToken;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ refresh_token: settings.gaRefreshToken, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return null;
    await db.collection('settings').updateOne({}, { $set: { gaAccessToken: tokens.access_token, gaTokenExpiry: Date.now() + (tokens.expires_in * 1000) } });
    return tokens.access_token;
}

app.get('/api/analytics/properties', isAuthenticated, async (req, res) => {
    try {
        const accessToken = await getGAAccessToken();
        if (!accessToken) return res.json({ connected: false });
        const r = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', { headers: { Authorization: `Bearer ${accessToken}` } });
        const data = await r.json();
        res.json({ connected: true, accounts: data.accountSummaries || [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/analytics/property', isAuthenticated, async (req, res) => {
    const { propertyId } = req.body;
    await db.collection('settings').updateOne({}, { $set: { gaPropertyId: propertyId } }, { upsert: true });
    res.json({ success: true });
});

app.get('/api/analytics/summary', isAuthenticated, async (req, res) => {
    try {
        const settings = await db.collection('settings').findOne() || {};
        const accessToken = await getGAAccessToken();
        if (!accessToken) return res.json({ connected: false });
        const propertyId = settings.gaPropertyId;
        if (!propertyId) return res.json({ connected: true, needsProperty: true });

        const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
        const base = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}`;

        const [realtimeRes, reportRes, sourceRes, pagesRes] = await Promise.all([
            fetch(`${base}:runRealtimeReport`, { method: 'POST', headers, body: JSON.stringify({ metrics: [{ name: 'activeUsers' }] }) }),
            fetch(`${base}:runReport`, { method: 'POST', headers, body: JSON.stringify({ dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'averageSessionDuration' }], dimensions: [{ name: 'date' }], orderBys: [{ dimension: { dimensionName: 'date' } }] }) }),
            fetch(`${base}:runReport`, { method: 'POST', headers, body: JSON.stringify({ dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }], dimensions: [{ name: 'sessionDefaultChannelGroup' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 6 }) }),
            fetch(`${base}:runReport`, { method: 'POST', headers, body: JSON.stringify({ dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], metrics: [{ name: 'screenPageViews' }], dimensions: [{ name: 'pagePath' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 6 }) })
        ]);

        const [realtime, report, sources, pages] = await Promise.all([realtimeRes.json(), reportRes.json(), sourceRes.json(), pagesRes.json()]);

        res.json({
            connected: true,
            activeUsers: realtime.rows?.[0]?.metricValues?.[0]?.value || '0',
            report, sources, pages
        });
    } catch (e) {
        console.error('[analytics/summary]', e.message, e.stack);
        res.status(500).json({ error: e.message });
    }
});

// Protected API routes
app.get('/api/dashboard', isAuthenticated, async (req, res) => {
    const jobs = await db.collection('jobs').find().toArray();
    const clients = await db.collection('clients').find().toArray();
    const settings = await db.collection('settings').findOne() || {};
    const allExpenses = await db.collection('expenses').find().toArray();

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
        assignedTo: Array.isArray(j.assignedTo) ? j.assignedTo.map(id => id.toString()) : ((j.assignedTo && j.assignedTo !== 'undefined' && typeof j.assignedTo === 'object') ? [j.assignedTo.toString()] : [])
    }));

    const completedJobsThisMonth = jobsMapped
        .filter(j => (j.status === 'invoiced' || j.status === 'completed') && (j.scheduledDate || '').slice(0, 7) === thisMonth);

    const totalRevenue = completedJobsThisMonth.reduce((sum, j) => sum + (parseFloat(j.total) || 0), 0);

    // Material costs embedded on jobs
    const totalMaterialCosts = completedJobsThisMonth.reduce((sum, j) => {
        if (j.materialItems && Array.isArray(j.materialItems)) {
            return sum + j.materialItems.reduce((mSum, item) => mSum + ((item.quantity || 0) * (item.price || 0)), 0);
        }
        return sum;
    }, 0);

    // All expenses this month (labor payments, fuel, tools, etc.)
    const totalExpensesThisMonth = allExpenses
        .filter(e => {
            if (!e.date) return false;
            const d = typeof e.date === 'string' ? e.date : (e.date instanceof Date ? e.date.toISOString() : String(e.date));
            return d.startsWith(thisMonth);
        })
        .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);

    const totalProfit = totalRevenue - totalMaterialCosts - totalExpensesThisMonth;

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
        revenueThisMonthJobs: completedJobsThisMonth.map(j => ({
            id: j.id,
            name: j.title || 'Untitled job',
            clientName: j.clientName || '',
            total: parseFloat(j.total) || 0,
            status: j.status,
        })).sort((a, b) => b.total - a.total),
        profitThisMonth: totalProfit,
        totalAccountsReceivable: totalAccountsReceivable,
        accountsReceivableJobs: accountsReceivableJobs,
        lastMonthRevenue: (() => {
            const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
            const lm = d.toISOString().slice(0, 7);
            return jobsMapped.filter(j => (j.status === 'invoiced' || j.status === 'completed') && (j.scheduledDate || '').slice(0, 7) === lm)
                .reduce((sum, j) => sum + (parseFloat(j.total) || 0), 0);
        })(),
        lastMonthJobs: (() => {
            const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
            const lm = d.toISOString().slice(0, 7);
            return jobsMapped.filter(j => j.scheduledDate && j.scheduledDate.startsWith(lm)).length;
        })(),
        revenueByMonth: (() => {
            const months = [];
            for (let i = 5; i >= 0; i--) {
                const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
                const key = d.toISOString().slice(0, 7);
                const label = d.toLocaleString('default', { month: 'short' });
                const monthJobs = jobsMapped
                    .filter(j => (j.status === 'invoiced' || j.status === 'completed') && (j.scheduledDate || '').slice(0, 7) === key);
                const revenue = monthJobs.reduce((sum, j) => sum + (parseFloat(j.total) || 0), 0);
                const materialCosts = monthJobs.reduce((sum, j) => {
                    if (j.materialItems && Array.isArray(j.materialItems))
                        return sum + j.materialItems.reduce((s, item) => s + ((item.quantity || 0) * (item.price || 0)), 0);
                    return sum;
                }, 0);
                const monthExpenses = allExpenses
                    .filter(e => { const dt = typeof e.date === 'string' ? e.date : (e.date instanceof Date ? e.date.toISOString() : String(e.date || '')); return dt.startsWith(key); })
                    .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
                const profit = revenue - materialCosts - monthExpenses;
                months.push({ key, label, revenue, profit, materialCosts, monthExpenses });
            }
            return months;
        })(),
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
            .slice(0, 20),
        followUpsNeedAction: jobsMapped
            .filter(j => j.followUp && !j.followUpDone && j.followUpDate && j.followUpDate <= today)
            .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate)),
        followUpsUpcoming: jobsMapped
            .filter(j => j.followUp && !j.followUpDone && j.followUpDate && j.followUpDate > today)
            .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate))
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

    // Normalize email so login lookup always matches
    if (client.email) client.email = client.email.toLowerCase().trim();

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
        const { clientId, toEmail } = req.body;

        const client = await db.collection('clients').findOne({ _id: new ObjectId(clientId) });
        if (!client) {
            return res.status(404).json({ error: 'Client not found' });
        }

        const sendTo = toEmail || client.email;
        if (!sendTo) {
            return res.status(400).json({ error: 'No email address available' });
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

        const _portalLogId = new ObjectId();
        const _appUrl = process.env.APP_URL || 'https://app.gsdhandymanservice.com';
        await emailService.sendEmail({
            to: sendTo,
            subject: subject,
            html: html,
            text: `${companyName} Client Portal Access\n\nYour client portal is ready! Access it at: ${portalUrl}\n\nEmail: ${client.email}\nAccess Code: The last 4 digits of your phone number on file`,
            trackingPixelUrl: `${_appUrl}/api/email-track/${_portalLogId}`
        });

        await db.collection('email_logs').insertOne({
            _id: _portalLogId,
            type: 'portal_access',
            to: sendTo,
            toName: client.name,
            subject: subject,
            htmlBody: html,
            trigger: 'Portal access email sent manually',
            relatedId: client._id,
            relatedTitle: client.name,
            sentBy: req.session.userName || 'admin',
            sentAt: new Date(),
            status: 'sent',
            opened: false
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
            assignedTo: Array.isArray(j.assignedTo) ? j.assignedTo.map(id => id.toString()) : ((j.assignedTo && j.assignedTo !== 'undefined' && typeof j.assignedTo === 'object') ? [j.assignedTo.toString()] : []),
            totalWithTax: totalWithTax
        };
    });
    res.json(jobsWithId);
});

// ─── Portfolio routes ─────────────────────────────────────────────────────────
// Public — no auth required
// S3 key: portfolio/{entryId}/{type}-{timestamp}-{random}.{ext}
// Type is encoded in the filename prefix — no photo data stored in MongoDB.

async function _pfListS3(entryId) {
    const client = publicS3Client || s3Client;
    const bucket = publicS3Client ? PUBLIC_S3_BUCKET : S3_BUCKET_NAME;
    if (!client) return [];
    const prefix = entryId ? `portfolio/${entryId}/` : 'portfolio/';
    const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    return (result.Contents || []).filter(o => o.Key.split('/').length === 3);
}

app.get('/api/portfolio', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    try {
        const items = await db.collection('portfolio').find({}).sort({ createdAt: -1 }).toArray();

        // Join survey data for items with a linked survey
        const surveyIds = items.filter(i => i.surveyId).map(i => { try { return new ObjectId(i.surveyId); } catch(e) { return null; } }).filter(Boolean);
        const surveys = surveyIds.length ? await db.collection('surveys').find({ _id: { $in: surveyIds } }).toArray() : [];
        const surveyMap = Object.fromEntries(surveys.map(s => [s._id.toString(), s]));
        items.forEach(i => { if (i.surveyId) i._survey = surveyMap[i.surveyId] || null; });

        // One S3 list call for all new-style photos
        const client = publicS3Client || s3Client;
        const bucket = publicS3Client ? PUBLIC_S3_BUCKET : S3_BUCKET_NAME;
        let s3ByEntry = {};
        if (client) {
            try {
                const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'portfolio/', MaxKeys: 1000 }));
                (listed.Contents || []).forEach(obj => {
                    const parts = obj.Key.split('/');
                    if (parts.length !== 3) return; // skip root-level legacy keys
                    const entryId = parts[1];
                    if (!s3ByEntry[entryId]) s3ByEntry[entryId] = [];
                    s3ByEntry[entryId].push({ s3Key: obj.Key, url: portfolioPhotoUrl(obj.Key), type: _pfParseType(obj.Key) });
                });
            } catch (e) { console.warn('S3 list error:', e.message); }
        }

        res.json(items.map(item => {
            const id = item._id.toString();
            // New-style: photos from S3 key structure
            let photos = s3ByEntry[id] || [];
            // Legacy compat: MongoDB photos array (old entries before this fix)
            if (!photos.length && item.photos && item.photos.length) {
                photos = item.photos.map(p => ({ s3Key: p.s3Key, url: portfolioPhotoUrl(p.s3Key || p.url), type: p.type || 'other' }));
            }
            // Legacy compat: old single-photo entries
            if (!photos.length && item.s3Key) {
                photos = [{ s3Key: item.s3Key, url: portfolioPhotoUrl(item.s3Key), type: 'after' }];
            }
            const coverPhoto = photos.find(p => p.type === 'after') || photos[0];
            return { id, title: item.title || '', caption: item.caption || '', captionHtml: _pfFormatCaption(item.caption || ''), category: item.category || '', commercial: item.commercial || false, surveyId: item.surveyId || null, survey: item._survey || null, photos, photoUrl: coverPhoto?.url || portfolioPhotoUrl(item.s3Key) || '', createdAt: item.createdAt };
        }));
    } catch (err) {
        console.error('Portfolio GET error:', err);
        res.status(500).json({ error: 'Failed to load portfolio' });
    }
});

// Create entry — metadata only in MongoDB, no photo data
app.post('/api/portfolio/rebuild', isAdmin, async (req, res) => {
    try {
        // Other public pages (portfolio.html, PM, locations) rebuild via this call.
        rebuildPublicPortfolio().catch(e => console.error('Portfolio/PM/location rebuild failed:', e.message));
        // Await the homepage explicitly so we can surface its exact result.
        const home = await rebuildHomePage();
        res.json({ success: true, home });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/portfolio', isAuthenticated, async (req, res) => {
    try {
        const { title, caption, category, commercial, surveyId } = req.body;
        const doc = { title: title || '', caption: caption || '', category: category || '', commercial: commercial === true || commercial === 'true', surveyId: surveyId || null, createdAt: new Date() };
        const result = await db.collection('portfolio').insertOne(doc);
        res.json({ success: true, id: result.insertedId.toString() });
        rebuildPublicPortfolio().catch(() => {});
    } catch (err) {
        console.error('Portfolio POST error:', err);
        res.status(500).json({ error: 'Failed to create portfolio entry' });
    }
});

// Upload photo to S3 — key encodes type; nothing written to MongoDB
app.post('/api/portfolio/:id/photo', isAuthenticated, async (req, res) => {
    try {
        const { fileData, fileType, type } = req.body;
        if (!fileData || !fileType) return res.status(400).json({ error: 'Missing file data' });
        const client = publicS3Client || s3Client;
        const bucket = publicS3Client ? PUBLIC_S3_BUCKET : S3_BUCKET_NAME;
        if (!client) return res.status(500).json({ error: 'S3 not configured' });
        const photoType = ['before', 'after', 'other'].includes(type) ? type : 'other';
        const ext = fileType.split('/')[1] || 'jpg';
        const key = `portfolio/${req.params.id}/${photoType}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const buf = Buffer.from(fileData.replace(/^data:[^;]+;base64,/, ''), 'base64');
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: fileType }));
        const photo = { s3Key: key, url: portfolioPhotoUrl(key), type: photoType };
        res.json({ success: true, photo });
        rebuildPublicPortfolio().catch(() => {});
    } catch (err) {
        console.error('Portfolio add-photo error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete a specific photo — identified by s3Key in request body
app.delete('/api/portfolio/:id/photo', isAuthenticated, async (req, res) => {
    try {
        const { s3Key } = req.body;
        if (!s3Key) return res.status(400).json({ error: 'Missing s3Key' });
        const client = publicS3Client || s3Client;
        const bucket = publicS3Client ? PUBLIC_S3_BUCKET : S3_BUCKET_NAME;
        if (client) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key })).catch(() => {});
        // Also remove from legacy MongoDB photos array if present
        await db.collection('portfolio').updateOne({ _id: new ObjectId(req.params.id) }, { $pull: { photos: { s3Key } } }).catch(() => {});
        res.json({ success: true });
        rebuildPublicPortfolio().catch(() => {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update metadata only + handle type changes via S3 copy+delete
app.put('/api/portfolio/:id', isAuthenticated, async (req, res) => {
    try {
        const { title, caption, category, commercial, photos, surveyId } = req.body;
        const setFields = { title: title || '', caption: caption || '', category: category || '', commercial: commercial === true || commercial === 'true' };
        if (surveyId) setFields.surveyId = surveyId;
        else setFields.surveyId = null;
        // Metadata update only — leave photos array untouched (legacy compat)
        await db.collection('portfolio').updateOne({ _id: new ObjectId(req.params.id) },
            { $set: setFields });

        // Handle type changes: if photo's type doesn't match its key prefix, rename via copy+delete
        if (Array.isArray(photos)) {
            const client = publicS3Client || s3Client;
            const bucket = publicS3Client ? PUBLIC_S3_BUCKET : S3_BUCKET_NAME;
            if (client) {
                await Promise.all(photos.map(async p => {
                    if (!p.s3Key || !p.s3Key.startsWith(`portfolio/${req.params.id}/`)) return;
                    const currentType = _pfParseType(p.s3Key);
                    if (p.type === currentType) return;
                    const newKey = p.s3Key.replace(/\/(before|after|other)-/, `/${p.type}-`);
                    await client.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${p.s3Key}`, Key: newKey }));
                    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: p.s3Key })).catch(() => {});
                }));
            }
        }

        res.json({ success: true });
        rebuildPublicPortfolio().catch(() => {});
    } catch (err) {
        console.error('Portfolio PUT error:', err);
        res.status(500).json({ error: 'Failed to update portfolio item' });
    }
});

// Delete entry — list and delete all S3 photos, then remove MongoDB doc
app.delete('/api/portfolio/:id', isAuthenticated, async (req, res) => {
    try {
        const item = await db.collection('portfolio').findOne({ _id: new ObjectId(req.params.id) });
        const client = publicS3Client || s3Client;
        const bucket = publicS3Client ? PUBLIC_S3_BUCKET : S3_BUCKET_NAME;
        if (client) {
            const s3Photos = await _pfListS3(req.params.id);
            const legacyKeys = ((item && item.photos) || []).map(p => p.s3Key).filter(Boolean);
            if (item && item.s3Key) legacyKeys.push(item.s3Key);
            const allKeys = [...new Set([...s3Photos.map(p => p.Key), ...legacyKeys])];
            await Promise.all(allKeys.map(k => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: k })).catch(() => {})));
        }
        await db.collection('portfolio').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
        rebuildPublicPortfolio().catch(() => {});
    } catch (err) {
        console.error('Portfolio DELETE error:', err);
        res.status(500).json({ error: 'Failed to delete portfolio item' });
    }
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

    // Convert assignedTo array of ID strings to ObjectIds
    if (job.assignedTo) {
        const ids = Array.isArray(job.assignedTo) ? job.assignedTo : (typeof job.assignedTo === 'string' ? JSON.parse(job.assignedTo) : []);
        const validIds = ids.filter(id => id && id.length === 24);
        job.assignedTo = validIds.length > 0 ? validIds.map(id => new ObjectId(id)) : [];
    } else {
        job.assignedTo = [];
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

            // Stamp invoicedAt / completedAt the first time a job reaches those statuses
            if (job.status === 'invoiced' && oldJob.status !== 'invoiced') {
                updateData.invoicedAt = new Date();
            }
            if (job.status === 'completed' && oldJob.status !== 'completed') {
                updateData.completedAt = new Date();
            }
        }

        // Convert manually-sent completedAt string to Date
        if (updateData.completedAt && typeof updateData.completedAt === 'string') {
            updateData.completedAt = new Date(updateData.completedAt + 'T12:00:00');
        }

        // Auto-complete when paid in full
        const jobTotal = parseFloat(updateData.totalWithTax || updateData.total) || 0;
        const jobPaid = parseFloat(updateData.totalPaid) || 0;
        if (jobTotal > 0 && jobPaid >= jobTotal && updateData.status !== 'completed') {
            updateData.status = 'completed';
        }

        await db.collection('jobs').updateOne(
            { _id: new ObjectId(_id) },
            { $set: { ...updateData, updatedAt: new Date() } }
        );

        // Send cancellation confirmation email when status changes to cancelled
        if (job.status === 'cancelled' && oldJob?.status !== 'cancelled' && emailService.initialized) {
            try {
                const cancelClient = job.clientId ? await db.collection('clients').findOne({ _id: new ObjectId(job.clientId) }) : null;
                const cancelSettings = await db.collection('settings').findOne({});
                const businessName = cancelSettings?.companyName || 'GSD Property Services';
                const clientEmail = cancelClient?.email;
                const clientName = cancelClient?.name || 'Valued Client';
                if (clientEmail) {
                    const cancelDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
                    const _cancelLogId = new ObjectId();
                    await db.collection('email_logs').insertOne({
                        _id: _cancelLogId,
                        type: 'cancellation',
                        to: clientEmail,
                        toName: clientName,
                        subject: `Service Cancellation Confirmation — ${job.title}`,
                        trigger: `Job "${job.title}" cancelled`,
                        relatedId: new ObjectId(_id),
                        relatedTitle: job.title,
                        sentBy: req.session.userName || 'admin',
                        sentAt: new Date(),
                        status: 'sent',
                        opened: false
                    });
                    const _cancelHtml = `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:2rem;color:#1a202c;">
                            <h2 style="color:#667eea;margin-bottom:0.25rem;">${businessName}</h2>
                            <p style="color:#718096;font-size:0.85rem;margin-top:0;">Service Cancellation Confirmation</p>
                            <hr style="border:none;border-top:1px solid #e2e8f0;margin:1.25rem 0;">
                            <p>Dear ${clientName},</p>
                            <p>This letter confirms that, by mutual agreement between <strong>${businessName}</strong> and <strong>${clientName}</strong>, the service arrangement for the following has been cancelled effective <strong>${cancelDate}</strong>:</p>
                            <div style="background:#f8fafc;border-left:4px solid #667eea;padding:0.85rem 1.1rem;margin:1.25rem 0;border-radius:0 6px 6px 0;">
                                <strong style="font-size:1rem;">${job.title}</strong>
                            </div>
                            <p>Both parties acknowledge that this cancellation is final and agreed upon by mutual consent. Neither party shall pursue any claim, dispute, or legal action against the other arising from or related to this service arrangement or its cancellation.</p>
                            <p>We appreciate the opportunity and wish you well.</p>
                            <p style="margin-top:2rem;">Sincerely,<br><strong>${businessName}</strong></p>
                            <hr style="border:none;border-top:1px solid #e2e8f0;margin:1.5rem 0;">
                            <p style="color:#9ca3af;font-size:0.78rem;">This is an automated confirmation. Please retain this email for your records.</p>
                        </div>`;
                    await db.collection('email_logs').updateOne({ _id: _cancelLogId }, { $set: { htmlBody: _cancelHtml } });
                    await emailService.sendEmail({
                        to: clientEmail,
                        subject: `Service Cancellation Confirmation — ${job.title}`,
                        html: _cancelHtml,
                        text: `Service Cancellation Confirmation\n\nDear ${clientName},\n\nThis confirms that by mutual agreement, the service arrangement for "${job.title}" has been cancelled effective ${cancelDate}.\n\nBoth parties acknowledge this cancellation is final. Neither party shall pursue any claim or legal action related to this arrangement or its cancellation.\n\nSincerely,\n${businessName}`
                    });
                }
            } catch (e) { console.error('Cancellation email error:', e.message); }
        }

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

    // Send SMS + survey notifications
    try {
        const client = job.clientId ? await db.collection('clients').findOne({ _id: job.clientId }) : null;
        const settings = await db.collection('settings').findOne({});
        const companyName = settings?.companyName || 'Jobber Pro';

        if (client && client.phone) {
            const fmtDate = (d) => {
                if (!d) return 'TBD';
                const parsed = new Date(d);
                const s = parsed.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
                return s === 'Invalid Date' ? 'TBD' : s;
            };

            const statusBecameScheduled = isUpdate && oldJob && oldJob.status !== job.status && job.status === 'scheduled';
            const dateWasAdded = isUpdate && oldJob && job.status === 'scheduled' && job.scheduledDate && !oldJob.scheduledDate;
            const dateChanged = isUpdate && oldJob && job.status === 'scheduled' && job.scheduledDate && oldJob.scheduledDate && oldJob.scheduledDate !== job.scheduledDate;

            const smsMeta = { clientName: client.name };
            const smsT = settings?.smsTemplates || {};
            const smsVars = { companyName, jobTitle: job.title, title: job.title, total: (job.total || 0).toFixed(2) };

            const scheduledMsg = (date, time) => interpolate(
                smsT.scheduled || '{companyName}: Your job "{jobTitle}" is scheduled for {date} at {time}.',
                { ...smsVars, date, time }
            );

            // New job created already scheduled with a date
            if (!isUpdate && job.status === 'scheduled' && job.scheduledDate) {
                await sendSMS(client.phone, scheduledMsg(fmtDate(job.scheduledDate), job.scheduledTime || 'TBD'),
                    { ...smsMeta, type: 'job_scheduled', trigger: job.title });
            }

            // Status flipped to scheduled — only fire if date is already set
            if (statusBecameScheduled && job.scheduledDate) {
                await sendSMS(client.phone, scheduledMsg(fmtDate(job.scheduledDate), job.scheduledTime || 'TBD'),
                    { ...smsMeta, type: 'job_scheduled', trigger: job.title });
            }

            // Date added or changed on an already-scheduled job (catches "set status first, date second" flow)
            if ((dateWasAdded || dateChanged) && !statusBecameScheduled) {
                await sendSMS(client.phone, scheduledMsg(fmtDate(job.scheduledDate), job.scheduledTime || 'TBD'),
                    { ...smsMeta, type: 'job_scheduled', trigger: job.title });
            }

            // Status changed SMS (non-scheduled transitions)
            if (isUpdate && oldJob && oldJob.status !== job.status) {
                if (job.status === 'scheduled') {
                    // handled above
                } else if (job.status === 'in_progress') {
                    await sendSMS(client.phone,
                        interpolate(smsT.in_progress || '{companyName}: We\'re starting work on "{jobTitle}" now.', smsVars),
                        { ...smsMeta, type: 'job_update', trigger: job.title });
                } else if (job.status === 'completed') {
                    await sendSMS(client.phone,
                        interpolate(smsT.completed || '{companyName}: Job "{jobTitle}" is complete! Invoice will follow shortly.', smsVars),
                        { ...smsMeta, type: 'job_update', trigger: job.title });
                } else if (job.status === 'invoiced') {
                    await sendSMS(client.phone,
                        interpolate(smsT.invoiced || '{companyName}: Invoice ready for "{jobTitle}". Total: ${total}.', smsVars),
                        { ...smsMeta, type: 'invoice', trigger: job.title });
                }
            }
        }

        // Survey — auto-send on completion for residential clients only
        if (client && !client.isPropertyManagement && isUpdate && oldJob && oldJob.status !== job.status && job.status === 'completed') {
            sendJobSurvey(job._id || new ObjectId(_id), client, job.title, companyName, client.email).catch(e => console.error('Survey send error:', e));
        }
    } catch (smsError) {
        console.error('SMS notification error:', smsError);
        // Don't fail the job save if SMS fails
    }

    res.json({ success: true, id: job._id.toString(), _id: job._id.toString() });
});

app.get('/api/jobs/:id', isAuthenticated, async (req, res) => {
    try {
        const job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.id) });
        if (!job) return res.status(404).json({ error: 'Not found' });
        const settings = await db.collection('settings').findOne() || {};
        const taxRate = settings.taxRate || 0.06625;
        res.json({
            ...job,
            _id: job._id.toString(),
            id: job._id.toString(),
            clientId: (job.clientId && typeof job.clientId === 'object') ? job.clientId.toString() : job.clientId || null,
            assignedTo: Array.isArray(job.assignedTo) ? job.assignedTo.map(id => typeof id === 'object' ? id.toString() : id) : [],
            totalWithTax: parseFloat(job.total) || 0,
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/jobs/:id', isAuthenticated, async (req, res) => {
    await db.collection('jobs').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
});

// ── Survey system ─────────────────────────────────────────────────────────────

async function sendJobSurvey(jobId, client, jobTitle, companyName, toEmail = null) {
    const surveyEmail = toEmail || client?.email;
    if (!surveyEmail) throw new Error('Client has no email address on file — survey not sent.');
    const token = crypto.randomBytes(24).toString('hex');
    const appUrl = process.env.APP_URL || 'https://app.gsdhandymanservice.com';
    const surveyUrl = `${appUrl}/survey/${token}`;
    await db.collection('jobs').updateOne(
        { _id: new ObjectId(jobId.toString()) },
        { $set: { surveyToken: token, surveyTokenSentAt: new Date() } }
    );
    const clientName = client.contactName || client.name || 'there';
    const surveySettings = await db.collection('settings').findOne({}, { projection: { emailTemplates: 1 } });
    const surveyTpl = surveySettings?.emailTemplates || {};
    const subject = surveyTpl.surveySubject
        ? interpolate(surveyTpl.surveySubject, { companyName, jobTitle, clientName })
        : `How did we do? — ${companyName}`;
    const surveyBodyLine = surveyTpl.surveyBody
        ? `<p>${interpolate(surveyTpl.surveyBody, { companyName, jobTitle, clientName })}</p>`
        : `<p>We just wrapped up <strong>${jobTitle}</strong>. We'd love to know how we did — it takes 30 seconds.</p>`;
    const _surveyLogId = new ObjectId();
    const _surveyTrackUrl = `${appUrl}/api/email-track/${_surveyLogId}`;
    const _surveyHtml = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:2rem;color:#1a202c;">
            <div style="text-align:center;margin-bottom:1.5rem;">
                <div style="font-size:2.5rem;">🐾</div>
                <h2 style="color:#0f1c2e;margin:0.5rem 0;">How did we do?</h2>
                <p style="color:#718096;margin:0;">Your feedback helps us grow.</p>
            </div>
            <p>Hi ${clientName},</p>
            ${surveyBodyLine}
            <div style="text-align:center;margin:2rem 0;">
                <a href="${surveyUrl}" style="display:inline-block;background:#0f1c2e;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">Leave Feedback</a>
            </div>
            <p style="font-size:0.8rem;color:#a0aec0;text-align:center;">Or paste this link: <a href="${surveyUrl}" style="color:#667eea;">${surveyUrl}</a></p>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:1.5rem 0;">
            <div style="text-align:center;">
                <img src="https://gsdhandymanservice.com/images/hero-photo.png" alt="Cris and Maddox" style="width:120px;height:120px;object-fit:cover;border-radius:50%;margin:0 auto 0.75rem;display:block;box-shadow:0 3px 12px rgba(0,0,0,0.12);">
                <p style="font-size:0.9rem;color:#4a5568;margin:0 0 0.25rem;font-style:italic;">Thanks for trusting us with your home. It really does mean the world to us.</p>
                <p style="font-size:0.85rem;color:#718096;margin:0;">— Cris &amp; Maddox 🐕 · ${companyName}, South Jersey</p>
            </div>
        </div>`;
    await emailService.sendEmail({
        to: surveyEmail,
        subject,
        html: _surveyHtml,
        trackingPixelUrl: _surveyTrackUrl
    });
    await db.collection('email_logs').insertOne({
        _id: _surveyLogId,
        type: 'survey',
        to: surveyEmail,
        toName: client.name || clientName,
        subject,
        trigger: `Survey request for job "${jobTitle}"`,
        relatedId: new ObjectId(jobId.toString()),
        relatedTitle: jobTitle,
        htmlBody: _surveyHtml,
        sentBy: 'system',
        sentAt: new Date(),
        status: 'sent',
        opened: false
    });
}

// ── OOO Banner helper ──────────────────────────────────────────────────────
async function getOOOBanner() {
    try {
        const s = await db.collection('settings').findOne({}, { projection: { ooo: 1 } });
        const ooo = s?.ooo || {};
        if (!ooo.enabled) return '';
        const today = new Date(); today.setHours(0,0,0,0);
        const start = ooo.startDate ? new Date(ooo.startDate + 'T12:00:00') : null;
        const end   = ooo.endDate   ? new Date(ooo.endDate   + 'T12:00:00') : null;
        if (start) start.setHours(0,0,0,0);
        if (end)   end.setHours(23,59,59,999);
        if (start && today < start) return '';
        if (end   && new Date() > end) return '';
        const msg = ooo.message || 'We are currently out of the office.';
        const returnPart = ooo.endDate ? ` We return on <strong>${new Date(ooo.endDate + 'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</strong>.` : '';
        const phonePart = ooo.phone ? ` For emergencies call <a href="tel:${ooo.phone.replace(/\D/g,'')}" style="color:#92400e;font-weight:700;">${ooo.phone}</a>.` : '';
        return `<div id="ooo-banner" style="background:#fef3c7;border-bottom:2px solid #f59e0b;padding:0.65rem 1.25rem;text-align:center;font-family:Arial,sans-serif;font-size:0.92rem;color:#78350f;line-height:1.5;position:fixed;top:0;left:0;right:0;width:100%;box-sizing:border-box;z-index:1000;">
            ⚠️ ${msg}${returnPart}${phonePart}
        </div><script>document.addEventListener('DOMContentLoaded',function(){var b=document.getElementById('ooo-banner');if(b)document.body.style.paddingTop=b.offsetHeight+'px';});</script>`;
    } catch(e) { return ''; }
}

// Public survey page
app.get('/survey/:token', async (req, res) => {
    const job = await db.collection('jobs').findOne({ surveyToken: req.params.token });
    if (!job) return res.status(404).send('<h2>Survey not found or already submitted.</h2>');
    if (job.surveySubmittedAt) return res.status(410).send('<h2>This survey has already been submitted. Thank you!</h2>');
    const settings = await db.collection('settings').findOne({});
    const companyName = settings?.companyName || 'GSD Handyman Service';
    const oooBanner = await getOOOBanner();
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>How did we do? — ${companyName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f8fc;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;}
.card{background:#fff;border-radius:16px;padding:2rem 1.75rem;max-width:460px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,0.09);}
.logo{text-align:center;font-size:2.5rem;margin-bottom:0.5rem;}
h1{text-align:center;font-size:1.4rem;color:#0f1c2e;margin-bottom:0.25rem;}
.sub{text-align:center;color:#718096;font-size:0.9rem;margin-bottom:1.75rem;}
.job-name{text-align:center;font-weight:700;color:#553c9a;margin-bottom:1.5rem;font-size:0.95rem;}
.stars{display:flex;justify-content:center;gap:0.5rem;margin-bottom:1.5rem;}
.star{font-size:2.75rem;cursor:pointer;opacity:0.25;transition:opacity 0.15s,transform 0.1s;user-select:none;line-height:1;}
.star.on{opacity:1;}
.star:hover{transform:scale(1.15);}
label{display:block;font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#a0aec0;margin-bottom:0.4rem;}
textarea{width:100%;border:2px solid #e2e8f0;border-radius:8px;padding:0.75rem;font-size:0.95rem;font-family:inherit;resize:vertical;min-height:90px;outline:none;transition:border-color 0.15s;}
textarea:focus{border-color:#553c9a;}
.recommend{display:flex;gap:0.75rem;margin:1rem 0 1.5rem;}
.rec-btn{flex:1;padding:0.6rem;border:2px solid #e2e8f0;border-radius:8px;background:#fff;font-size:0.9rem;font-weight:600;cursor:pointer;transition:all 0.15s;color:#4a5568;}
.rec-btn.on{border-color:#48bb78;background:#f0fff4;color:#276749;}
.rec-btn.on-no{border-color:#fc8181;background:#fff5f5;color:#c53030;}
.submit{display:block;width:100%;background:#0f1c2e;color:#fff;border:none;padding:0.9rem;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;margin-top:0.5rem;transition:background 0.15s;}
.submit:hover{background:#1a2e4a;}
.submit:disabled{background:#a0aec0;cursor:not-allowed;}
.thanks{text-align:center;padding:2rem 0;}
.thanks .big{font-size:3rem;margin-bottom:0.75rem;}
.thanks h2{color:#0f1c2e;margin-bottom:0.5rem;}
.thanks p{color:#718096;}
.err{color:#e53e3e;font-size:0.85rem;margin-top:0.5rem;text-align:center;}
</style></head><body>${oooBanner}
<div class="card">
  <div id="surveyForm">
    <div class="logo">🐾</div>
    <h1>How did we do?</h1>
    <p class="sub">Your feedback means everything to us.</p>
    <p class="job-name">${job.title}</p>
    <div class="stars" id="stars">
      <span class="star" data-v="1">★</span>
      <span class="star" data-v="2">★</span>
      <span class="star" data-v="3">★</span>
      <span class="star" data-v="4">★</span>
      <span class="star" data-v="5">★</span>
    </div>
    <div style="margin-bottom:1rem;">
      <label>Comments (optional)</label>
      <textarea id="comment" placeholder="Tell us what went well or what we could improve..."></textarea>
    </div>
    <div style="margin-bottom:0.25rem;">
      <label>Would you recommend us?</label>
      <div class="recommend">
        <button class="rec-btn" id="recYes" onclick="setRec(true)">👍 Yes</button>
        <button class="rec-btn" id="recNo"  onclick="setRec(false)">👎 No</button>
      </div>
    </div>
    <button class="submit" id="submitBtn" onclick="submitSurvey()" disabled>Submit Feedback</button>
    <p class="err" id="errMsg"></p>
  </div>
  <div class="thanks" id="thanksMsg" style="display:none;">
    <div class="big">🙌</div>
    <h2>Thank you!</h2>
    <p>We really appreciate your feedback.<br>It helps us keep getting better.</p>
  </div>
  <div class="thanks" id="googleMsg" style="display:none;">
    <img src="https://gsdhandymanservice.com/images/hero-photo.png" alt="Cris and Maddox" style="width:150px;height:150px;object-fit:cover;border-radius:50%;margin:0 auto 1rem;display:block;box-shadow:0 4px 16px rgba(0,0,0,0.15);">
    <h2>You just made our day! 🐾</h2>
    <p style="margin-bottom:1rem;">Reviews like yours mean the world to me and Maddox — they're how a small local outfit like ours keeps the lights on and the treats coming. If you have 30 seconds, would you share it on Google too? It genuinely helps more than you know.</p>
    <a href="https://search.google.com/local/writereview?placeid=ChIJobmiZQyj9wcRdQPvKcZ1zQU" target="_blank" rel="noopener" style="display:inline-block;background:#0f1c2e;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">⭐ Leave a Google Review</a>
    <p style="margin-top:1rem;font-size:0.85rem;color:#718096;">Thank you — from Cris &amp; Maddox 🐕</p>
  </div>
</div>
<script>
let rating = 0, recommend = null;
const stars = document.querySelectorAll('.star');
stars.forEach(s => {
  s.addEventListener('click', () => {
    rating = +s.dataset.v;
    stars.forEach(x => x.classList.toggle('on', +x.dataset.v <= rating));
    checkReady();
  });
  s.addEventListener('mouseover', () => stars.forEach(x => x.classList.toggle('on', +x.dataset.v <= +s.dataset.v)));
  s.addEventListener('mouseout',  () => stars.forEach(x => x.classList.toggle('on', +x.dataset.v <= rating)));
});
function setRec(val) {
  recommend = val;
  document.getElementById('recYes').className = 'rec-btn' + (val === true  ? ' on' : '');
  document.getElementById('recNo').className  = 'rec-btn' + (val === false ? ' on-no' : '');
  checkReady();
}
function checkReady() {
  document.getElementById('submitBtn').disabled = !(rating > 0);
}
async function submitSurvey() {
  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const r = await fetch('/api/survey/${req.params.token}', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ rating, comment: document.getElementById('comment').value.trim(), recommend })
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('surveyForm').style.display = 'none';
      document.getElementById(d.promptGoogle ? 'googleMsg' : 'thanksMsg').style.display = 'block';
    } else {
      document.getElementById('errMsg').textContent = d.error || 'Something went wrong.';
      btn.disabled = false; btn.textContent = 'Submit Feedback';
    }
  } catch(e) {
    document.getElementById('errMsg').textContent = 'Network error — please try again.';
    btn.disabled = false; btn.textContent = 'Submit Feedback';
  }
}
</script></body></html>`);
});

// Survey submission
app.post('/api/survey/:token', async (req, res) => {
    try {
        const job = await db.collection('jobs').findOne({ surveyToken: req.params.token });
        if (!job) return res.status(404).json({ error: 'Survey not found.' });
        if (job.surveySubmittedAt) return res.status(410).json({ error: 'Already submitted.' });
        const { rating, comment, recommend } = req.body;
        if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating required.' });
        const now = new Date();
        const client = job.clientId ? await db.collection('clients').findOne({ _id: job.clientId }) : null;
        await db.collection('surveys').insertOne({
            jobId: job._id, clientId: job.clientId || null,
            jobTitle: job.title, clientName: client?.name || client?.contactName || '',
            rating: +rating, comment: comment || '', recommend: recommend ?? null,
            submittedAt: now, token: req.params.token
        });
        await db.collection('jobs').updateOne(
            { _id: job._id },
            { $set: { surveySubmittedAt: now, surveyRating: +rating } }
        );
        // Only nudge toward a public Google review on a genuinely great result
        res.json({ ok: true, promptGoogle: (+rating >= 4) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin: all surveys
app.get('/api/surveys', isAuthenticated, async (req, res) => {
    const surveys = await db.collection('surveys').find().sort({ submittedAt: -1 }).toArray();
    res.json(surveys.map(s => ({ ...s, id: s._id.toString() })));
});

// Admin: delete a survey (e.g. test entries)
app.delete('/api/surveys/:id', isAuthenticated, async (req, res) => {
    try {
        await db.collection('surveys').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: toggle whether a survey is shown on the public website
app.patch('/api/surveys/:id', isAuthenticated, async (req, res) => {
    try {
        const set = {};
        if (typeof req.body.hiddenFromSite === 'boolean') set.hiddenFromSite = req.body.hiddenFromSite;
        if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update' });
        await db.collection('surveys').updateOne({ _id: new ObjectId(req.params.id) }, { $set: set });
        res.json({ success: true, ...set });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public: 5-star survey testimonials for the website widget (sanitized, cached)
let _pubSurveyCache = null, _pubSurveyAt = 0;
app.get('/api/public/surveys', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'https://gsdhandymanservice.com');
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (_pubSurveyCache && Date.now() - _pubSurveyAt < 5 * 60 * 1000) return res.json(_pubSurveyCache);
        const surveys = await db.collection('surveys')
            .find({ rating: 5, hiddenFromSite: { $ne: true }, comment: { $exists: true, $ne: '' } })
            .sort({ submittedAt: -1 }).limit(30).toArray();
        const out = surveys.map(s => {
            const name = (s.clientName || '').trim();
            const parts = name.split(/\s+/).filter(Boolean);
            const display = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : (parts[0] || 'A GSD Customer');
            return { author: display, text: s.comment, service: s.jobTitle || '', rating: 5, submittedAt: s.submittedAt };
        }).filter(s => s.text && s.text.trim().length > 3);
        _pubSurveyCache = out; _pubSurveyAt = Date.now();
        res.json(out);
    } catch (e) { res.json([]); }
});

// Admin: resend survey for a job
app.post('/api/jobs/:id/dismiss-followup', isAuthenticated, async (req, res) => {
    try {
        const job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.id) });
        if (!job) return res.status(404).json({ error: 'Job not found' });
        const now = new Date();
        const comment = (req.body && req.body.comment) ? req.body.comment.trim() : '';
        const completedStr = now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        let noteText = `✅ Follow-up completed ${completedStr}`;
        if (job.followUpDate) noteText += ` (was due ${job.followUpDate})`;
        if (job.followUpNote) noteText += ` — ${job.followUpNote}`;
        if (comment) noteText += `\nOutcome: ${comment}`;
        const touchPoint = {
            id: now.getTime(),
            note: noteText,
            timestamp: now.toISOString(),
            user: req.session.userName || 'Admin',
            type: 'follow_up_done'
        };
        await db.collection('jobs').updateOne(
            { _id: new ObjectId(req.params.id) },
            {
                $set: { followUpDone: true, followUpCompletedAt: now, updatedAt: now },
                $push: { touchPoints: touchPoint }
            }
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/jobs/:id/resend-survey', isAuthenticated, async (req, res) => {
    try {
        const job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.id) });
        if (!job) return res.status(404).json({ error: 'Job not found' });
        const client = job.clientId ? await db.collection('clients').findOne({ _id: job.clientId }) : null;
        const settings = await db.collection('settings').findOne({});
        const companyName = settings?.companyName || 'GSD Handyman Service';
        // Resolve email — use location contactEmail if set (same logic as invoices)
        let toEmail = client?.email;
        if (job.serviceLocationId && client?.serviceLocations) {
            const loc = client.serviceLocations.find(l => String(l.id) === String(job.serviceLocationId));
            if (loc?.contactEmail) toEmail = loc.contactEmail;
        }
        // Reset token so it can be re-submitted
        await db.collection('jobs').updateOne({ _id: job._id }, { $unset: { surveyToken: '', surveyTokenSentAt: '', surveySubmittedAt: '', surveyRating: '' } });
        await sendJobSurvey(job._id, client, job.title, companyName, toEmail);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Email open tracking pixel
const TRACKING_PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
app.get('/api/email-track/:id', async (req, res) => {
    try {
        if (ObjectId.isValid(req.params.id)) {
            await db.collection('email_logs').updateOne(
                { _id: new ObjectId(req.params.id), opened: { $ne: true } },
                { $set: { opened: true, openedAt: new Date() } }
            );
        }
    } catch (_) {}
    res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': TRACKING_PIXEL.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
    });
    res.end(TRACKING_PIXEL);
});

// Atomic quote number generator — avoids duplicate numbers under concurrent saves
async function nextQuoteNumber() {
    const year = new Date().getFullYear();
    const counter = await db.collection('counters').findOneAndUpdate(
        { _id: `quoteNumber_${year}` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
    );
    return `Q-${year}-${String(counter.seq).padStart(3, '0')}`;
}

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

    // Generate quote number and token only when creating
    if (!isUpdate) {
        quote.quoteNumber = await nextQuoteNumber();
        const crypto = require('crypto');
        quote.secureToken = quote.secureToken || crypto.randomUUID();
        quote.createdByName = req.session.userName;
        quote.createdBy = new ObjectId(req.session.userId);
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

    if (quote._id) {
        // Write-once fields: never overwrite secureToken, quoteNumber, or original creator
        const { _id, secureToken: _t, quoteNumber: _qn, createdByName: _cn, createdBy: _cb, createdAt: _ca, ...updateData } = quote;

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

app.patch('/api/quotes/:id/archive', isAdmin, async (req, res) => {
    try {
        const { archived } = req.body;
        await db.collection('quotes').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { archived: !!archived } }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/jobs/:id/payment-attempts', isAdmin, async (req, res) => {
    try {
        const attempts = await db.collection('payment_attempts')
            .find({ jobId: new ObjectId(req.params.id) })
            .sort({ at: -1 })
            .toArray();
        res.json(attempts.map(a => ({ ...a, id: a._id.toString(), _id: undefined })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/jobs/:id/invoice-view-log', isAdmin, async (req, res) => {
    try {
        const job = await db.collection('jobs').findOne(
            { _id: new ObjectId(req.params.id) },
            { projection: { invoiceViewLog: 1, invoiceViewCount: 1 } }
        );
        if (!job) return res.status(404).json({ error: 'Not found' });
        res.json(job.invoiceViewLog || []);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/quotes/:id/photos', isAuthenticated, async (req, res) => {
    try {
        const quote = await db.collection('quotes').findOne(
            { _id: new ObjectId(req.params.id) },
            { projection: { photos: 1 } }
        );
        if (!quote) return res.status(404).json({ error: 'Not found' });
        const photos = Array.isArray(quote.photos) ? quote.photos : [];
        if (!photos.length || !s3Client) return res.json({ photos: [] });
        const urls = await Promise.all(photos.map(p =>
            typeof p === 'string' && !p.startsWith('data:') ? getS3SignedUrl(p, 3600) : Promise.resolve(p)
        ));
        res.json({ photos: urls.filter(Boolean) });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/jobs/:id/photos', isAuthenticated, async (req, res) => {
    try {
        const job = await db.collection('jobs').findOne(
            { _id: new ObjectId(req.params.id) },
            { projection: { photos: 1 } }
        );
        if (!job) return res.status(404).json({ error: 'Not found' });
        const photos = Array.isArray(job.photos) ? job.photos : [];
        if (!photos.length || !s3Client) return res.json({ photos: [] });
        const urls = await Promise.all(photos.map(p =>
            typeof p === 'string' && !p.startsWith('data:') ? getS3SignedUrl(p, 3600) : Promise.resolve(p)
        ));
        res.json({ photos: urls.filter(Boolean) });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Debug: inspect the raw shape of a job's stored photos (admin only)
app.get('/api/jobs/:id/photos-debug', isAuthenticated, async (req, res) => {
    try {
        const job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.id) }, { projection: { photos: 1 } });
        if (!job) return res.status(404).json({ error: 'Not found' });
        const photos = Array.isArray(job.photos) ? job.photos : [];
        const s3ok = !!s3Client;
        const items = await Promise.all(photos.map(async (p, i) => {
            const info = { i, type: typeof p, isString: typeof p === 'string' };
            if (typeof p === 'string') {
                info.isDataUrl = p.startsWith('data:');
                info.isHttp = p.startsWith('http');
                info.preview = p.slice(0, 60);
                info.length = p.length;
                if (!info.isDataUrl && !info.isHttp && s3ok) {
                    try { await getS3SignedUrl(p, 60); info.signs = true; }
                    catch (e) { info.signs = false; info.signError = e.message; }
                }
            } else {
                info.keys = p && typeof p === 'object' ? Object.keys(p) : null;
                info.preview = JSON.stringify(p).slice(0, 120);
            }
            return info;
        }));
        res.json({ count: photos.length, s3Configured: s3ok, items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Callbacks ────────────────────────────────────────────────────────────────
app.get('/api/jobs/:id/callbacks', isAuthenticated, async (req, res) => {
    try {
        const callbacks = await db.collection('callbacks')
            .find({ jobId: new ObjectId(req.params.id) })
            .sort({ date: -1 })
            .toArray();
        res.json(callbacks.map(c => ({ ...c, id: c._id.toString(), _id: c._id.toString() })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/jobs/:id/callbacks', isAuthenticated, async (req, res) => {
    try {
        const job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.id) });
        if (!job) return res.status(404).json({ error: 'Job not found' });
        const { date, hours, category, issue, charged, chargeAmount, resolved } = req.body;
        const doc = {
            jobId: new ObjectId(req.params.id),
            jobTitle: job.title || '',
            clientId: job.clientId,
            date: date || new Date().toISOString().slice(0, 10),
            hours: parseFloat(hours) || 0,
            category: category || 'workmanship',
            issue: issue || '',
            charged: !!charged,
            chargeAmount: charged ? (parseFloat(chargeAmount) || 0) : 0,
            resolved: !!resolved,
            createdAt: new Date()
        };
        const result = await db.collection('callbacks').insertOne(doc);
        res.json({ success: true, id: result.insertedId.toString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/callbacks/:id', isAuthenticated, async (req, res) => {
    try {
        const { resolved } = req.body;
        await db.collection('callbacks').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { resolved: !!resolved } }
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/callbacks/:id', isAdmin, async (req, res) => {
    try {
        await db.collection('callbacks').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clients/:id/callbacks', isAuthenticated, async (req, res) => {
    try {
        const callbacks = await db.collection('callbacks')
            .find({ clientId: new ObjectId(req.params.id) })
            .sort({ date: -1 })
            .toArray();
        res.json(callbacks.map(c => ({ ...c, id: c._id.toString(), _id: c._id.toString() })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clients/:id/quotes', isAuthenticated, async (req, res) => {
    try {
        const id = req.params.id;
        const or = [{ clientId: id }];
        try { or.push({ clientId: new ObjectId(id) }); } catch (e) {}
        const quotes = await db.collection('quotes')
            .find({ $or: or })
            .sort({ createdAt: -1 })
            .toArray();
        res.json(quotes.map(q => ({
            ...q,
            id: q._id.toString(),
            _id: q._id.toString(),
            convertedToJobId: q.convertedToJobId ? q.convertedToJobId.toString() : null
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/jobs/:id/signoff-attachment', isAuthenticated, async (req, res) => {
    try {
        const { imageDataUrl, signerName } = req.body;
        if (!imageDataUrl) return res.status(400).json({ error: 'No image data' });
        const match = imageDataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
        if (!match) return res.status(400).json({ error: 'Invalid image format' });
        if (!s3Client) return res.status(500).json({ error: 'S3 not configured' });
        const imgType = match[1]; // 'png' or 'jpeg'
        const contentType = `image/${imgType}`;
        const buffer = Buffer.from(match[2], 'base64');
        const ext = imgType === 'jpeg' ? 'jpg' : imgType;
        const key = `jobber-attachments/${req.params.id}-signoff-${Date.now()}.${ext}`;
        await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key, Body: buffer, ContentType: contentType }));
        const attachment = {
            id: new ObjectId().toString(),
            name: 'Business Sign-Off',
            type: contentType,
            size: buffer.length,
            s3Key: key,
            comment: signerName ? `Signed by ${signerName}` : '',
            uploadedAt: new Date(),
            uploadedBy: req.session.userName || 'Admin'
        };
        const signoff = { signedAt: new Date().toISOString(), signerName: signerName || '' };
        await db.collection('jobs').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $push: { attachments: attachment }, $set: { signoff, updatedAt: new Date() } }
        );
        res.json({ ok: true, attachment });
    } catch (e) {
        console.error('Signoff attachment error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/jobs/:id/signoff', isAuthenticated, async (req, res) => {
    try {
        await db.collection('jobs').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $unset: { signoff: '' }, $set: { updatedAt: new Date() } }
        );
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/quotes/:id/photos', isAuthenticated, async (req, res) => {
    try {
        const quote = await db.collection('quotes').findOne({ _id: new ObjectId(req.params.id) });
        if (!quote) return res.status(404).json({ error: 'Not found' });

        const { photos } = req.body;
        const valid = Array.isArray(photos) ? photos.filter(p => typeof p === 'string' && p.startsWith('data:image/')).slice(0, 10) : [];
        if (!valid.length) return res.status(400).json({ error: 'No valid photos' });

        let keys = [];
        if (s3Client) {
            const ts = Date.now();
            const uploads = await Promise.all(valid.map(async (dataUrl, i) => {
                const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/);
                if (!match) return null;
                const [, contentType, rawExt] = match;
                const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
                const key = `quotes/admin/${req.params.id}/${ts}-${i}.${ext}`;
                await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key, Body: Buffer.from(match[3], 'base64'), ContentType: contentType }));
                return key;
            }));
            keys = uploads.filter(Boolean);
        } else {
            keys = valid;
        }

        await db.collection('quotes').updateOne({ _id: new ObjectId(req.params.id) }, { $push: { photos: { $each: keys } } });
        res.json({ success: true, keys });
    } catch (err) {
        console.error('Add quote photos error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/quotes/:id/photos/:index', isAuthenticated, async (req, res) => {
    try {
        const quote = await db.collection('quotes').findOne({ _id: new ObjectId(req.params.id) });
        if (!quote) return res.status(404).json({ error: 'Not found' });

        const photos = Array.isArray(quote.photos) ? [...quote.photos] : [];
        const idx = parseInt(req.params.index);
        if (isNaN(idx) || idx < 0 || idx >= photos.length) return res.status(400).json({ error: 'Invalid index' });

        const removed = photos.splice(idx, 1)[0];
        if (s3Client && typeof removed === 'string' && !removed.startsWith('data:')) {
            await deleteFromS3(removed).catch(() => {});
        }
        await db.collection('quotes').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { photos } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/quotes/:id/import-lead-photos', isAuthenticated, async (req, res) => {
    try {
        const { leadId } = req.body;
        if (!leadId) return res.status(400).json({ error: 'leadId required' });

        const [quote, lead] = await Promise.all([
            db.collection('quotes').findOne({ _id: new ObjectId(req.params.id) }, { projection: { _id: 1 } }),
            db.collection('leads').findOne({ _id: new ObjectId(leadId) }, { projection: { photos: 1 } })
        ]);

        if (!quote) return res.status(404).json({ error: 'Quote not found' });
        if (!lead || !Array.isArray(lead.photos) || !lead.photos.length) return res.json({ success: true, copied: 0 });

        const s3Keys = lead.photos.filter(p => typeof p === 'string' && !p.startsWith('data:'));
        if (!s3Keys.length || !s3Client) return res.json({ success: true, copied: 0 });

        const ts = Date.now();
        const newKeys = await Promise.all(s3Keys.map(async (key, i) => {
            const ext = key.split('.').pop();
            const newKey = `quotes/admin/${req.params.id}/${ts}-${i}.${ext}`;
            await s3Client.send(new CopyObjectCommand({
                Bucket: S3_BUCKET_NAME,
                CopySource: `${S3_BUCKET_NAME}/${key}`,
                Key: newKey
            }));
            return newKey;
        }));

        await db.collection('quotes').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $push: { photos: { $each: newKeys } } }
        );
        res.json({ success: true, copied: newKeys.length });
    } catch (err) {
        console.error('Import lead photos error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/quotes/:id/view-log', isAdmin, async (req, res) => {
    try {
        const quote = await db.collection('quotes').findOne(
            { _id: new ObjectId(req.params.id) },
            { projection: { viewLog: 1, viewCount: 1 } }
        );
        if (!quote) return res.status(404).json({ error: 'Not found' });
        res.json(quote.viewLog || []);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/quotes/send-email', isAuthenticated, async (req, res) => {
    try {
        const { quoteId } = req.body;

        const quote = await db.collection('quotes').findOne({ _id: new ObjectId(quoteId) });
        if (!quote) {
            return res.status(404).json({ error: 'Quote not found' });
        }

        const client = await db.collection('clients').findOne({ _id: quote.clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // For portal quotes tied to a service location, email the location contact
        let toEmail = client.email;
        let toName  = client.name;
        if (quote.serviceLocationId) {
            const loc = (client.serviceLocations || []).find(l => String(l.id) === String(quote.serviceLocationId));
            if (loc?.contactEmail) { toEmail = loc.contactEmail; toName = loc.contact || loc.name || client.name; }
        }
        if (!toEmail) return res.status(400).json({ error: 'No email address found for this client' });

        const settings = await db.collection('settings').findOne({});
        const companyName = settings?.companyName || 'Your Company';

        // Get quote URL
        const quoteUrl = `${process.env.APP_URL}/quote-view/${quote.secureToken}`;

        const isPortalQuote = quote.source === 'portal';
        const quoteLabel = (isPortalQuote && client.isPropertyManagement) ? 'Work Order' : 'Quote';
        const subject = `${quoteLabel} #${quote.quoteNumber} from ${companyName}`;
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
            <h1>${quoteLabel} from ${companyName}</h1>
        </div>
        <div class="content">
            <p>Dear ${toName},</p>
            <p>${(() => {
                const raw = settings?.emailTemplates?.quoteBody;
                if (raw) return interpolate(raw, { clientName: toName, jobTitle: quote.title, total: fmt$(parseFloat(quote.total || 0)), validUntil: quote.validUntil, companyName });
                return (isPortalQuote ? 'Your submission has been reviewed and priced.' : 'Thank you for your interest!') + ' Here is your ' + quoteLabel.toLowerCase() + ' for: <strong>' + quote.title + '</strong>';
            })()}</p>
            <p><strong>${quoteLabel} Total:</strong> ${fmt$(parseFloat(quote.total || 0))}</p>
            <p><strong>Valid Until:</strong> ${quote.validUntil}</p>
            <a href="${quoteUrl}" class="button">View ${quoteLabel} & Approve</a>
            <p>Click the button above to view the full ${quoteLabel.toLowerCase()} and approve it online.</p>
        </div>
        <div class="footer">
            <p>${companyName}</p>
            <p>This is an automated quote notification</p>
        </div>
    </div>
</body>
</html>
        `;

        const _quoteLogId = new ObjectId();
        const _quoteAppUrl = process.env.APP_URL || 'https://app.gsdhandymanservice.com';
        await emailService.sendEmail({
            to: toEmail,
            subject: subject,
            html: html,
            text: `Quote #${quote.quoteNumber} from ${companyName}\n\nView quote: ${quoteUrl}\n\nTotal: ${fmt$(parseFloat(quote.total || 0))}\nValid until: ${quote.validUntil}`,
            trackingPixelUrl: `${_quoteAppUrl}/api/email-track/${_quoteLogId}`
        });

        await db.collection('email_logs').insertOne({
            _id: _quoteLogId,
            type: 'quote',
            to: toEmail,
            toName: toName,
            subject: subject,
            trigger: `Quote #${quote.quoteNumber} — ${quote.title}`,
            relatedId: quote._id,
            relatedTitle: quote.title,
            htmlBody: html,
            sentBy: req.session.userName || 'admin',
            sentAt: new Date(),
            opened: false,
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
            note: `Quote emailed to ${toEmail}`
        };

        const sentSnapshot = {
            sentAt: new Date(),
            sentTo: toEmail,
            sentBy: req.session.userName || 'admin',
            quoteNumber: quote.quoteNumber,
            title: quote.title,
            validUntil: quote.validUntil,
            notes: quote.notes || '',
            laborItems: quote.laborItems || [],
            materialItems: quote.materialItems || [],
            subtotal: quote.subtotal || 0,
            tax: quote.tax || 0,
            total: quote.total || 0,
            taxWaived: quote.taxWaived || false,
        };

        await db.collection('quotes').updateOne(
            { _id: new ObjectId(quoteId) },
            {
                $set: { status: 'sent', sentAt: new Date() },
                $push: { auditLog: auditEntry, sentVersions: sentSnapshot }
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

        const isReconvert = req.query.force === 'true' && !!quote.convertedToJobId;
        if (quote.convertedToJobId && !isReconvert) {
            return res.status(400).json({ error: 'Quote has already been converted to a job' });
        }

        // Build conversion entry first so it lands on both the job and the quote
        const conversionEntry = {
            timestamp: new Date(),
            userName: req.session.userName,
            userId: new ObjectId(req.session.userId),
            action: isReconvert ? 'reconverted_to_job' : 'converted_to_job',
            oldStatus: quote.status,
            newStatus: quote.status,
            note: isReconvert
                ? `Quote #${quote.quoteNumber} re-converted to a new job by ${req.session.userName}`
                : `Quote #${quote.quoteNumber} converted to job by ${req.session.userName}`
        };

        // Resolve photos: use quote's own photos; fall back to source lead's photos if none
        let jobPhotos = Array.isArray(quote.photos) && quote.photos.length ? quote.photos : [];
        if (!jobPhotos.length && quote.sourceLeadId) {
            try {
                const sourceLead = await db.collection('leads').findOne(
                    { _id: new ObjectId(quote.sourceLeadId) },
                    { projection: { photos: 1 } }
                );
                if (sourceLead && Array.isArray(sourceLead.photos)) {
                    jobPhotos = sourceLead.photos.filter(p => typeof p === 'string' && !p.startsWith('data:'));
                }
            } catch (e) { /* non-fatal */ }
        }

        // Create job from quote
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
            status: 'to_be_scheduled',
            scheduledDate: '',
            payments: [],
            touchPoints: (quote.touchPoints || []).map(tp => ({ ...tp, fromQuote: true })),
            photos: jobPhotos,
            attachments: [],
            createdAt: new Date(),
            notes: `Converted from Quote #${quote.quoteNumber}\n\nNeeds scheduling review.\n\n${quote.notes || ''}`,
            sourceQuoteId: quote._id,
            sourceQuoteNumber: quote.quoteNumber,
            sourceQuoteHistory: [...(quote.auditLog || []), conversionEntry],
            conversionLog: conversionEntry
        };

        if (quote.serviceLocationId) {
            job.serviceLocationId = quote.serviceLocationId;
        }

        const result = await db.collection('jobs').insertOne(job);

        // Update the conversion entry note with the real job ID, then push to quote
        conversionEntry.note = isReconvert
            ? `Quote #${quote.quoteNumber} re-converted to new Job #${result.insertedId.toString().slice(-6)} by ${req.session.userName}`
            : `Quote #${quote.quoteNumber} converted to Job #${result.insertedId.toString().slice(-6)} by ${req.session.userName}`;
        await db.collection('quotes').updateOne(
            { _id: new ObjectId(req.params.id) },
            {
                $set: { convertedToJobId: result.insertedId },
                $push: { auditLog: conversionEntry }
            }
        );

        res.json({ success: true, jobId: result.insertedId.toString() });
    } catch (error) {
        console.error('Convert quote error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Tax prep CSV export
app.get('/api/export/tax-prep', isAuthenticated, async (req, res) => {
    try {
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const start = new Date(`${year}-01-01T00:00:00Z`);
        const end   = new Date(`${year+1}-01-01T00:00:00Z`);
        const [jobs, expenses] = await Promise.all([
            db.collection('jobs').find({ status: { $in: ['completed','invoiced'] }, updatedAt: { $gte: start, $lt: end } }).toArray(),
            db.collection('expenses').find({ date: { $gte: start.toISOString().slice(0,10), $lt: end.toISOString().slice(0,10) } }).toArray()
        ]);
        const esc = v => `"${String(v||'').replace(/"/g,'""')}"`;
        const toDate = v => { if (!v) return ''; try { return new Date(v).toISOString().slice(0,10); } catch { return ''; } };
        const lines = ['Type,Date,Description,Client,Job,Category,Amount'];
        for (const j of jobs) {
            const ds = toDate(j.invoicedAt||j.completedDate||j.scheduledDate);
            const rev = parseFloat(j.totalWithTax||j.total)||0;
            lines.push([esc('Income'), esc(ds), esc(j.title), esc(j.clientName), esc(j.jobNumber||''), esc('Service Revenue'), esc(rev.toFixed(2))].join(','));
            for (const m of (j.materialItems||[])) {
                const cost = (parseFloat(m.quantity)||0) * (parseFloat(m.price)||0);
                if (cost > 0) lines.push([esc('COGS'), esc(ds), esc(m.description||m.name||'Material'), esc(j.clientName), esc(j.jobNumber||''), esc('Materials / COGS'), esc((-cost).toFixed(2))].join(','));
            }
        }
        for (const e of expenses) {
            const ed = typeof e.date === 'string' ? e.date.slice(0,10) : toDate(e.date);
            lines.push([esc('Expense'), esc(ed), esc(e.description||e.title), esc(''), esc(''), esc(e.category||'Business Expense'), esc((-Math.abs(parseFloat(e.amount)||0)).toFixed(2))].join(','));
        }
        res.setHeader('Content-Type','text/csv');
        res.setHeader('Content-Disposition',`attachment; filename="tax-prep-${year}.csv"`);
        res.send(lines.join('\n'));
    } catch(e) { res.status(500).json({ error: e.message }); }
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

// Send onboarding invite email with one-time token
app.post('/api/team/:id/send-onboarding', isAdmin, async (req, res) => {
    const member = await db.collection('team').findOne({ _id: new ObjectId(req.params.id) });
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    if (!member.email) return res.status(400).json({ error: 'Team member has no email address' });
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await db.collection('team').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { 'onboarding.inviteToken': token, 'onboarding.inviteTokenExpiry': expiry, 'onboarding.inviteSentAt': new Date() } }
    );
    const settings = await db.collection('settings').findOne({});
    const appName = settings?.companyName || settings?.appName || 'GSD Property Services';
    const url = `${process.env.APP_URL}/onboarding/${token}`;
    await emailService.sendEmail({
        to: member.email,
        subject: `${appName} — Complete Your Employee Onboarding`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:2rem;">
            <h2 style="color:#667eea;">Welcome to ${appName}, ${member.name.split(' ')[0]}!</h2>
            <p style="color:#4a5568;">Please complete your employment onboarding paperwork by clicking the button below. The link expires in 7 days.</p>
            <div style="text-align:center;margin:2rem 0;">
                <a href="${url}" style="display:inline-block;background:#667eea;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">Complete Onboarding →</a>
            </div>
            <p style="color:#718096;font-size:0.85rem;">Or copy this link: <a href="${url}" style="color:#667eea;">${url}</a></p>
            <p style="color:#718096;font-size:0.85rem;margin-top:1rem;">Questions? Reply to this email or contact your employer directly.</p>
        </div>`,
        text: `Complete your onboarding at: ${url}\n\nLink expires in 7 days.`
    });
    res.json({ success: true });
});

// Admin marks per-employee onboarding items (i9Section2, jobDescription)
app.post('/api/team/:id/onboarding', isAdmin, async (req, res) => {
    const { field, value, hireDate } = req.body;
    const allowed = ['i9Section2', 'jobDescription'];
    if (!allowed.includes(field)) return res.status(400).json({ error: 'Invalid field' });
    const now = new Date();
    const update = {};
    if (value) {
        const entry = { completedAt: now, completedBy: req.session.userName };
        if (field === 'i9Section2' && hireDate) {
            entry.hireDate = hireDate;
            // Retention deadline: 3 years from hire date
            const retain = new Date(hireDate);
            retain.setFullYear(retain.getFullYear() + 3);
            entry.retainUntil = retain;
            update['hireDate'] = hireDate; // top-level for easy access
        }
        update[`onboarding.${field}`] = entry;
    } else {
        update[`onboarding.${field}`] = null;
    }
    await db.collection('team').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
    res.json({ success: true });
});

// Google Ads conversion landing page
app.get('/thank-you', async (req, res) => {
    const settings = await db.collection('settings').findOne({}) || {};
    const phone = settings.companyPhone || '';
    const phoneHref = 'tel:+1' + phone.replace(/\D/g, '');
    const companyName = settings.companyName || 'GSD Handyman Service';
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Thank You — ${companyName}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #f0f4ff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem 1.25rem; }
  .card { background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 480px; width: 100%; padding: 2.5rem 2rem; text-align: center; }
  .icon { font-size: 3.5rem; margin-bottom: 1rem; }
  h1 { font-size: 1.6rem; font-weight: 700; color: #0f1c2e; margin-bottom: 0.6rem; }
  p { color: #4a5568; line-height: 1.7; font-size: 1rem; margin-bottom: 1rem; }
  .highlight { background: #f0f4ff; border-left: 4px solid #667eea; border-radius: 0 8px 8px 0; padding: 0.75rem 1rem; text-align: left; font-size: 0.95rem; color: #2d3748; margin: 1.25rem 0; }
  .phone { display: inline-block; margin-top: 0.5rem; font-size: 1.25rem; font-weight: 700; color: #667eea; text-decoration: none; }
  .brand { margin-top: 2rem; font-size: 0.8rem; color: #a0aec0; }
  .brand strong { color: #667eea; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h1>We got your request!</h1>
  <p>Thank you for reaching out to ${companyName}. We'll review your information and get back to you shortly.</p>
  <div class="highlight">
    <strong>What happens next:</strong><br>
    We typically respond within a few hours. For urgent jobs, give us a call:
  </div>
  ${phone ? `<a class="phone" href="${phoneHref}">${phone}</a>` : ''}
  <p style="margin-top:1.5rem;font-size:0.9rem;color:#718096;">South Jersey's trusted handyman — no job too small.</p>
  <a href="https://gsdhandymanservice.com" style="display:inline-block;margin-top:1.25rem;padding:0.65rem 1.75rem;background:#0f1c2e;color:#fff;border-radius:8px;font-weight:600;font-size:0.95rem;text-decoration:none;">← Back to Home</a>
  <div class="brand">Powered by <strong>${companyName}</strong></div>
</div>
</body>
</html>`);
});

// Public onboarding form (no auth — token-gated)
app.get('/onboarding/:token', async (req, res) => {
    const member = await db.collection('team').findOne({
        'onboarding.inviteToken': req.params.token,
        'onboarding.inviteTokenExpiry': { $gt: new Date() }
    });
    if (!member) return res.status(400).send('<div style="font-family:sans-serif;padding:3rem;text-align:center;"><h2>This onboarding link is invalid or has expired.</h2><p>Contact your employer for a new link.</p></div>');
    const settings = await db.collection('settings').findOne({});
    res.send(buildOnboardingHtml(member, req.params.token, settings));
});

// Employee submits onboarding form
app.post('/api/onboarding/:token', async (req, res) => {
    const member = await db.collection('team').findOne({
        'onboarding.inviteToken': req.params.token,
        'onboarding.inviteTokenExpiry': { $gt: new Date() }
    });
    if (!member) return res.status(400).json({ error: 'Invalid or expired token' });
    const { w4, i9, policies } = req.body;
    const now = new Date();
    await db.collection('team').updateOne({ _id: member._id }, {
        $set: {
            'onboarding.w4': { ...w4, completedAt: now },
            'onboarding.i9Section1': { ...i9, completedAt: now },
            'onboarding.policyAck': { acknowledged: true, completedAt: now },
            'onboarding.completedAt': now,
        }
    });
    res.json({ success: true });
});

// ── Quarterly Tax Estimates ──────────────────────────────────────────────────

function calcNJTax(annualIncome) {
    if (annualIncome <= 0) return 0;
    const brackets = [[20000,0.014],[15000,0.0175],[5000,0.035],[35000,0.05525],[425000,0.0637],[500000,0.0897],[Infinity,0.1075]];
    let tax = 0, rem = annualIncome;
    for (const [size, rate] of brackets) {
        if (rem <= 0) break;
        tax += Math.min(rem, size) * rate;
        rem -= size;
    }
    return tax;
}

function federalIncomeTax(annualIncome, filingStatus) {
    if (annualIncome <= 0) return 0;
    const single   = [[11925,0.10],[36550,0.12],[54875,0.22],[93900,0.24],[208900,0.32],[125300,0.35],[Infinity,0.37]];
    const married  = [[23850,0.10],[73100,0.12],[109750,0.22],[187800,0.24],[209350,0.32],[250500,0.35],[Infinity,0.37]];
    const brackets = filingStatus === 'married' ? married : single;
    let tax = 0, rem = annualIncome;
    for (const [size, rate] of brackets) {
        if (rem <= 0) break;
        tax += Math.min(rem, size) * rate;
        rem -= size;
    }
    return tax;
}

app.get('/api/taxes/summary', isAdmin, async (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const [jobs, expenses, payments, settings] = await Promise.all([
        db.collection('jobs').find({ status: { $in: ['invoiced', 'completed'] } }).toArray(),
        db.collection('expenses').find({}).toArray(),
        db.collection('taxpayments').find({ year }).toArray(),
        db.collection('settings').findOne({})
    ]);
    const ts = settings?.taxSettings || { filingStatus: 'single', otherIncome: 0, standardDeduction: true };

    const quarters = [
        { q: 1, label: 'Jan – Mar', months: [0,1,2], due: new Date(year, 3, 15) },
        { q: 2, label: 'Apr – May', months: [3,4],   due: new Date(year, 5, 15) },
        { q: 3, label: 'Jun – Aug', months: [5,6,7], due: new Date(year, 8, 15) },
        { q: 4, label: 'Sep – Dec', months: [8,9,10,11], due: new Date(year + 1, 0, 15) },
    ];

    const isCashOnly = j => Array.isArray(j.payments) && j.payments.length > 0 && j.payments.every(p => p.method === 'cash');
    const stdDed  = ts.filingStatus === 'married' ? 30000 : 15000;
    const useStd  = ts.standardDeduction !== false;
    const grossW2 = parseFloat(ts.otherIncome) || 0;

    // Apply W2 pre-tax deductions to get actual taxable W2 income
    const w2DedTotal = Array.isArray(ts.w2Deductions)
        ? ts.w2Deductions.reduce((sum, d) => {
            const amt = parseFloat(d.amount) || 0;
            return sum + (d.type === 'pct' ? grossW2 * (amt / 100) : amt * 26);
          }, 0)
        : 0;
    const annualOther = Math.max(0, grossW2 - w2DedTotal);
    const w2OnlyTaxable = Math.max(0, annualOther - (useStd ? stdDed : 0));

    let carryLoss = 0; // net loss carried forward from prior quarters
    let carryPaymentDelta = 0; // cumulative (paidAmount - calcDue) from paid quarters; positive = credit, negative = deficit
    let carryAssigned = false; // carry is applied to the first unpaid quarter only
    const result = [];

    for (const { q, label, months, due } of quarters) {
        const inQ = dateStr => {
            const d = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
            return d && !isNaN(d) && d.getFullYear() === year && months.includes(d.getMonth());
        };

        const qJobs = jobs.filter(j => {
            const d = j.scheduledDate;
            if (!inQ(d)) return false;
            if (ts.excludeCash && isCashOnly(j)) return false;
            return true;
        });
        const revenue = qJobs.reduce((s, j) => s + (parseFloat(j.totalWithTax || j.total) || 0), 0);
        const cogsMaterials = qJobs.reduce((s, j) => {
            if (!Array.isArray(j.materialItems)) return s;
            return s + j.materialItems.reduce((ms, m) => ms + ((m.quantity || 0) * (m.price || 0)), 0);
        }, 0);

        const qExp = expenses.filter(e => inQ(e.date));
        const expTotal = qExp.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

        const rawNet       = revenue - cogsMaterials - expTotal;
        const carryApplied = Math.min(carryLoss, Math.max(0, rawNet)); // how much carry offset this quarter
        const netAfterCarry= rawNet - carryLoss;
        const netIncome    = Math.max(0, netAfterCarry);
        const lossCarriedForward = netAfterCarry < 0 ? Math.abs(netAfterCarry) : 0;
        carryLoss = lossCarriedForward;

        const annualFactor = 12 / months.length;        // Q1=4, Q2=6, Q3=4, Q4=3
        const qOther       = annualOther * (months.length / 12);

        // SE tax — own base, completely separate from income tax base
        const seTax        = netIncome * 0.9235 * 0.153;
        const seTaxBase    = netIncome * 0.9235;

        // Annualize for bracket finding
        const annualBiz    = netIncome  * annualFactor;
        const annualSEDed  = seTax      * annualFactor / 2;   // projected annual ½ SE deduction
        const annualQOther = qOther     * annualFactor;        // = annualOther (re-annualized)

        // Income tax bases — SE deduction + standard deduction applied
        const w2QTaxable        = Math.max(0, annualQOther - (useStd ? stdDed : 0));
        const combinedBeforeQBI = Math.max(0, annualBiz + annualQOther - annualSEDed - (useStd ? stdDed : 0));

        // Section 199A QBI deduction: 20% of qualified biz income, capped at 20% of taxable income
        // Federal only — NJ does not recognize QBI deduction
        const annualQBI    = Math.max(0, annualBiz - annualSEDed);
        const annualQBIDed = Math.min(annualQBI * 0.20, combinedBeforeQBI * 0.20);
        const combinedTaxable = Math.max(0, combinedBeforeQBI - annualQBIDed);

        const fedAnnual = Math.max(0, federalIncomeTax(combinedTaxable, ts.filingStatus) - federalIncomeTax(w2QTaxable, ts.filingStatus));
        const njAnnual  = Math.max(0, calcNJTax(combinedBeforeQBI) - calcNJTax(w2QTaxable)); // NJ: no QBI
        const fedQ  = fedAnnual / annualFactor;
        const njQ   = njAnnual  / annualFactor;
        const totalDue = seTax + fedQ + njQ;

        const payment = payments.find(p => p.quarter === q);
        const paidAmount = payment?.amount || 0;

        // Accumulate payment delta for paid quarters
        if (payment) {
            carryPaymentDelta += paidAmount - totalDue;
            carryAssigned = false; // payment received — carry resets for next unpaid quarter
        }

        // Apply carry only to the first unpaid quarter after paid ones
        const carryAppliedHere = (!payment && !carryAssigned) ? carryPaymentDelta : 0;
        const adjustedDue = (!payment && !carryAssigned) ? Math.max(0, totalDue - carryPaymentDelta) : totalDue;
        if (!payment && !carryAssigned && Math.abs(carryPaymentDelta) > 0.01) carryAssigned = true;

        const jobItems = qJobs.map(j => {
            const matCost = Array.isArray(j.materialItems)
                ? j.materialItems.reduce((s, m) => s + ((m.quantity || 0) * (m.price || 0)), 0) : 0;
            return {
                date: j.scheduledDate || '',
                title: j.title || j.description || '(untitled)',
                client: j.clientName || j.client?.name || '',
                amount: parseFloat(j.totalWithTax || j.total) || 0,
                matCost,
                netAmount: (parseFloat(j.totalWithTax || j.total) || 0) - matCost,
                dateField: 'scheduledDate'
            };
        });
        const expItems = qExp.map(e => ({
            date: e.date || '',
            description: e.description || e.vendor || e.category || '(no description)',
            category: e.category || '',
            amount: parseFloat(e.amount) || 0
        }));
        result.push({
            q, label, due: due.toISOString(), months,
            revenue, cogsMaterials, expTotal, rawNet, netIncome,
            carryApplied, lossCarriedForward,
            seTax, fedQ, njQ, totalDue,
            calcDetail: {
                annualFactor, grossW2, w2DedTotal, effectiveW2: annualOther,
                seTaxBase, annualBiz, annualSEDed,
                annualQBI, annualQBIDed, combinedBeforeQBI,
                annualQOther, w2QTaxable, combinedTaxable,
                fedAnnual, njAnnual,
                stdDed: useStd ? stdDed : 0,
            },
            paidAmount, paidAt: payment?.paidAt || null,
            paidMethod: payment?.method || '', paidNotes: payment?.notes || '',
            irsConfirmKey: payment?.irsConfirmKey || null, irsConfirmName: payment?.irsConfirmName || null,
            njConfirmKey:  payment?.njConfirmKey  || null, njConfirmName:  payment?.njConfirmName  || null,
            adjustedDue, carryAppliedHere,
            remaining: Math.max(0, adjustedDue - paidAmount),
            cashExcluded: ts.excludeCash ? jobs.filter(j => {
                return inQ(j.scheduledDate) && isCashOnly(j);
            }).length : 0,
            items: { jobs: jobItems, expenses: expItems }
        });
    }

    res.json({ quarters: result, taxSettings: ts, year });
});

app.get('/api/settings/taxes', isAdmin, async (req, res) => {
    const s = await db.collection('settings').findOne({}, { projection: { taxSettings: 1 } });
    res.json(s?.taxSettings || {});
});
app.post('/api/settings/taxes', isAdmin, async (req, res) => {
    await db.collection('settings').updateOne({}, { $set: { taxSettings: req.body } }, { upsert: true });
    res.json({ success: true });
});

app.post('/api/taxes/payments', isAdmin, async (req, res) => {
    const { year, quarter, amount, method, notes } = req.body;
    await db.collection('taxpayments').updateOne(
        { year: parseInt(year), quarter: parseInt(quarter) },
        { $set: { year: parseInt(year), quarter: parseInt(quarter), amount: parseFloat(amount), method, notes, paidAt: new Date() } },
        { upsert: true }
    );
    res.json({ success: true });
});

app.delete('/api/taxes/payments/:year/:quarter', isAdmin, async (req, res) => {
    await db.collection('taxpayments').deleteOne({ year: parseInt(req.params.year), quarter: parseInt(req.params.quarter) });
    res.json({ success: true });
});

// Upload a tax confirmation (IRS or NJ) — base64 body, stored in S3
app.post('/api/taxes/confirmations/:year/:quarter', isAdmin, async (req, res) => {
    try {
        const year = parseInt(req.params.year), quarter = parseInt(req.params.quarter);
        const { type, fileName, fileType, fileData } = req.body;
        if (!['irs','nj'].includes(type)) return res.status(400).json({ error: 'type must be irs or nj' });
        if (!fileData) return res.status(400).json({ error: 'fileData required' });

        const ext = fileName?.split('.').pop()?.toLowerCase() || 'jpg';
        const s3Key = `tax-confirmations/${year}/Q${quarter}/${type}-${Date.now()}.${ext}`;
        const buf = Buffer.from(fileData.replace(/^data:[^;]+;base64,/, ''), 'base64');
        await s3Client.send(new PutObjectCommand({
            Bucket: S3_BUCKET_NAME, Key: s3Key, Body: buf,
            ContentType: fileType || 'application/octet-stream'
        }));

        // Delete old S3 object if one exists
        const existing = await db.collection('taxpayments').findOne({ year, quarter });
        const oldKey = type === 'irs' ? existing?.irsConfirmKey : existing?.njConfirmKey;
        if (oldKey && oldKey !== s3Key) await deleteFromS3(oldKey).catch(() => {});

        const setFields = type === 'irs'
            ? { irsConfirmKey: s3Key, irsConfirmName: fileName }
            : { njConfirmKey:  s3Key, njConfirmName:  fileName };
        await db.collection('taxpayments').updateOne(
            { year, quarter },
            { $set: setFields },
            { upsert: true }
        );
        res.json({ success: true, s3Key });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a tax confirmation
app.delete('/api/taxes/confirmations/:year/:quarter/:type', isAdmin, async (req, res) => {
    try {
        const year = parseInt(req.params.year), quarter = parseInt(req.params.quarter);
        const { type } = req.params;
        if (!['irs','nj'].includes(type)) return res.status(400).json({ error: 'invalid type' });
        const rec = await db.collection('taxpayments').findOne({ year, quarter });
        const key = type === 'irs' ? rec?.irsConfirmKey : rec?.njConfirmKey;
        if (key) await deleteFromS3(key).catch(() => {});
        const unset = type === 'irs' ? { irsConfirmKey: '', irsConfirmName: '' } : { njConfirmKey: '', njConfirmName: '' };
        await db.collection('taxpayments').updateOne({ year, quarter }, { $unset: unset });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// View a tax confirmation inline (browser renders PDF/image)
app.get('/api/taxes/confirmations/:year/:quarter/:type/view', isAdmin, async (req, res) => {
    try {
        const year = parseInt(req.params.year), quarter = parseInt(req.params.quarter);
        const rec = await db.collection('taxpayments').findOne({ year, quarter });
        const key = req.params.type === 'irs' ? rec?.irsConfirmKey : rec?.njConfirmKey;
        if (!key) return res.status(404).json({ error: 'No confirmation on file' });
        const url = await getS3SignedUrl(key, 300);
        res.redirect(url);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Download a tax confirmation
app.get('/api/taxes/confirmations/:year/:quarter/:type/file', isAdmin, async (req, res) => {
    try {
        const year = parseInt(req.params.year), quarter = parseInt(req.params.quarter);
        const rec = await db.collection('taxpayments').findOne({ year, quarter });
        const key  = req.params.type === 'irs' ? rec?.irsConfirmKey  : rec?.njConfirmKey;
        const name = req.params.type === 'irs' ? rec?.irsConfirmName : rec?.njConfirmName;
        if (!key) return res.status(404).json({ error: 'No confirmation on file' });
        const s3Res = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key }));
        res.setHeader('Content-Disposition', `attachment; filename="${(name||'confirmation').replace(/"/g,'')}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        s3Res.Body.pipe(res);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save job description text for a team member
app.post('/api/team/:id/job-description', isAdmin, async (req, res) => {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Job description text required' });
    const now = new Date();
    await db.collection('team').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { 'onboarding.jobDescription': { text: text.trim(), completedAt: now, completedBy: req.session.userName, updatedAt: now } } }
    );
    res.json({ success: true });
});

// Business-level compliance settings
app.get('/api/settings/compliance', isAdmin, async (req, res) => {
    const s = await db.collection('settings').findOne({}, { projection: { compliance: 1 } });
    res.json(s?.compliance || {});
});
app.post('/api/settings/compliance', isAdmin, async (req, res) => {
    await db.collection('settings').updateOne({}, { $set: { compliance: req.body, updatedAt: new Date() } }, { upsert: true });
    res.json({ success: true });
});

// Payroll summary — approved time entries for a date range with NJ tax estimates
app.get('/api/payroll/summary', isAdmin, async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });
    const startDate = new Date(start + 'T00:00:00');
    const endDate   = new Date(end   + 'T23:59:59');

    const [entries, teamDocs, settings] = await Promise.all([
        db.collection('timeentries').find({ status: 'approved', clockIn: { $gte: startDate, $lte: endDate } }).toArray(),
        db.collection('team').find({}).toArray(),
        db.collection('settings').findOne({})
    ]);

    const rates = settings?.payrollRates || { fica: 0.0765, sui: 0.028, wfd: 0.000425, empSDI: 0.0009, empFLI: 0.0009 };

    const rateMap = {};
    teamDocs.forEach(m => {
        if (m.userId) rateMap[String(m.userId)] = m.hourlyRate;
        if (m.name)   rateMap[m.name] = m.hourlyRate;
    });

    const byEmp = {};
    for (const e of entries) {
        const key = e.userId || e.userName;
        const rate = e.hourlyRate ?? rateMap[String(e.userId)] ?? rateMap[e.userName] ?? 0;
        const hrs = (e.duration || 0) / 3600;
        if (!byEmp[key]) byEmp[key] = { name: e.userName, hourlyRate: rate, hours: 0, gross: 0, paymentTotal: 0, entryCount: 0 };
        byEmp[key].hours += hrs;
        byEmp[key].gross += hrs * rate;
        byEmp[key].paymentTotal += parseFloat(e.paymentAmount) || 0;
        byEmp[key].entryCount++;
    }

    const employees = Object.values(byEmp).map(emp => {
        const g = emp.gross;
        const empFICA = g * rates.fica;
        const empSUI  = g * rates.sui;
        const empWFD  = g * rates.wfd;
        const totalCost = g + empFICA + empSUI + empWFD;
        const eeSSMed = g * 0.0765;
        const eeSDI   = Math.min(g * rates.empSDI, 150000 * rates.empSDI);
        const eeFLI   = Math.min(g * rates.empFLI, 150000 * rates.empFLI);
        return { ...emp, taxes: { empFICA, empSUI, empWFD, totalCost, eeSSMed, eeSDI, eeFLI, estNetPay: Math.max(0, g - eeSSMed - eeSDI - eeFLI) } };
    });

    res.json({ employees, rates, period: { start, end }, entryCount: entries.length });
});

// Public branding-only endpoint for client-facing pages (login, portal)
app.get('/api/public/branding', async (req, res) => {
    const s = await db.collection('settings').findOne({}, { projection: { appName: 1, companyName: 1, companyLogo: 1, favicon: 1 } });
    res.json(s || {});
});

// Public OOO status — no auth required (used by public pages)
app.get('/api/ooo-status', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
        const s = await db.collection('settings').findOne({}, { projection: { ooo: 1 } });
        const ooo = s?.ooo || {};
        if (!ooo.enabled) return res.json({ active: false });
        const today = new Date(); today.setHours(0,0,0,0);
        const start = ooo.startDate ? new Date(ooo.startDate + 'T12:00:00') : null;
        const end   = ooo.endDate   ? new Date(ooo.endDate   + 'T12:00:00') : null;
        if (start) start.setHours(0,0,0,0);
        if (end)   end.setHours(23,59,59,999);
        const active = (!start || today >= start) && (!end || new Date() <= end);
        res.json({ active, message: ooo.message || '', returnDate: ooo.endDate || '', phone: ooo.phone || '' });
    } catch (e) { res.json({ active: false }); }
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

// ── Backup / Restore API ───────────────────────────────────────────────────

async function runMongoBackup() {
    const bucket = process.env.S3_BUCKET_NAME;
    const s3b = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });
    const collectionNames = (await db.listCollections().toArray()).map(c => c.name);
    const dump = {};
    for (const name of collectionNames) {
        const docs = await db.collection(name).find({}).toArray();
        dump[name] = JSON.parse(JSON.stringify(docs));
    }
    const { promisify } = require('util');
    const gzip = promisify(require('zlib').gzip);
    const payload = await gzip(Buffer.from(JSON.stringify(dump), 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    const key = `backups/${today}.json.gz`;
    await s3b.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: payload, ContentType: 'application/gzip', ServerSideEncryption: 'AES256' }));
    const RETENTION_DAYS = 30;
    const listed = await s3b.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'backups/' }));
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000);
    const toDelete = (listed.Contents || []).filter(obj => {
        const d = obj.Key.replace('backups/', '').replace('.json.gz', '');
        return new Date(d) < cutoff;
    });
    for (const obj of toDelete) await s3b.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
    return { key, sizeKB: (payload.length / 1024).toFixed(1), collections: collectionNames.length, docs: Object.values(dump).reduce((s, d) => s + d.length, 0), pruned: toDelete.length };
}

app.post('/api/backup/run', isAdmin, async (req, res) => {
    try {
        const result = await runMongoBackup();
        res.json({ success: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup/list', isAdmin, async (req, res) => {
    try {
        const bucket = process.env.S3_BUCKET_NAME;
        const s3b = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });
        const listed = await s3b.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'backups/' }));
        const backups = (listed.Contents || [])
            .filter(o => o.Key.endsWith('.json.gz'))
            .sort((a, b) => b.LastModified - a.LastModified)
            .map(o => ({ key: o.Key, date: o.Key.replace('backups/', '').replace('.json.gz', ''), sizeKB: (o.Size / 1024).toFixed(1), lastModified: o.LastModified }));
        res.json(backups);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backup/restore', isAdmin, async (req, res) => {
    try {
        const { key } = req.body;
        if (!key || !key.startsWith('backups/') || !key.endsWith('.json.gz')) return res.status(400).json({ error: 'Invalid backup key' });
        const bucket = process.env.S3_BUCKET_NAME;
        const s3b = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });
        const getRes = await s3b.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const chunk of getRes.Body) chunks.push(chunk);
        const { promisify } = require('util');
        const gunzip = promisify(require('zlib').gunzip);
        const dump = JSON.parse((await gunzip(Buffer.concat(chunks))).toString('utf8'));
        const results = {};
        for (const [name, docs] of Object.entries(dump)) {
            await db.collection(name).deleteMany({});
            if (docs.length > 0) {
                const prepared = docs.map(doc => {
                    try { if (doc._id && typeof doc._id === 'string' && doc._id.length === 24) doc._id = new ObjectId(doc._id); } catch (e) {}
                    return doc;
                });
                await db.collection(name).insertMany(prepared, { ordered: false });
            }
            results[name] = docs.length;
        }
        res.json({ success: true, restored: results });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/ooo', isAuthenticated, async (req, res) => {
    try {
        const { enabled, startDate, endDate, message, phone } = req.body;
        await db.collection('settings').updateOne(
            {},
            { $set: { ooo: { enabled: !!enabled, startDate: startDate || null, endDate: endDate || null, message: message || '', phone: phone || '' }, updatedAt: new Date() } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Email Configuration API
app.get('/api/email/config', isAuthenticated, async (req, res) => {
    try {
        const settings = await db.collection('settings').findOne({});

        res.json({
            configured: !!(process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY && process.env.SES_FROM_EMAIL),
            fromEmail: process.env.SES_FROM_EMAIL || '',
            fromName: process.env.SES_FROM_NAME || 'GSD Property Services',
            provider: 'AWS SES',
            templates: settings?.emailTemplates || {},
            smsTemplates: settings?.smsTemplates || {},
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

app.post('/api/sms/templates', isAuthenticated, async (req, res) => {
    try {
        await db.collection('settings').updateOne(
            {},
            { $set: { smsTemplates: req.body } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) {
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
            subject: 'GSD Property Services — Email Test',
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

        // Generate a new random temp password, hash it, and save it so the email is always valid
        const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        const tempPassword = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const hashedTemp = await bcrypt.hash(tempPassword, 10);
        await db.collection('users').updateOne(
            { _id: user._id },
            { $set: { password: hashedTemp, tempPassword: tempPassword } }
        );

        // Get login URL
        const loginUrl = `${process.env.APP_URL}/`;

        // Get custom email templates if configured
        const customSubject = settings?.emailTemplates?.credentialsSubject;
        const customBody = settings?.emailTemplates?.credentialsBody;

        const _credLogId = new ObjectId();
        const _credAppUrl = process.env.APP_URL || 'https://app.gsdhandymanservice.com';
        await emailService.sendUserCredentials({
            to: user.email,
            name: user.name,
            email: user.email,
            tempPassword: tempPassword,
            companyName: companyName,
            loginUrl: loginUrl,
            customSubject: customSubject,
            customBody: customBody,
            trackingPixelUrl: `${_credAppUrl}/api/email-track/${_credLogId}`
        });

        await db.collection('email_logs').insertOne({
            _id: _credLogId,
            type: 'credentials',
            to: user.email,
            toName: user.name,
            subject: `Your ${companyName} Account Credentials`,
            trigger: `Login credentials sent to team member ${user.name}`,
            relatedId: user._id,
            relatedTitle: user.name,
            htmlBody: `<p style="font-family:Arial,sans-serif;padding:1rem;color:#4a5568;">Login credentials sent to <strong>${user.name}</strong> at <strong>${user.email}</strong>.<br><br>Email included their temporary password and a link to log in.</p>`,
            sentBy: req.session.userName || 'admin',
            sentAt: new Date(),
            status: 'sent',
            opened: false
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
        if (!client) {
            return res.status(400).json({ error: 'Client not found' });
        }

        // For PM clients, route invoice to the location's contact email if set
        let invoiceEmail = client.email;
        if (job.serviceLocationId && client.serviceLocations) {
            const location = client.serviceLocations.find(loc => String(loc.id) === String(job.serviceLocationId));
            if (location && location.contactEmail) {
                invoiceEmail = location.contactEmail;
            }
        }

        if (!invoiceEmail) {
            return res.status(400).json({ error: 'No email address found for this client or location' });
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

        const _invLogId = new ObjectId();
        const _invAppUrl = process.env.APP_URL || 'https://app.gsdhandymanservice.com';
        await emailService.sendInvoice({
            to: invoiceEmail,
            clientName: client.name,
            invoiceNumber: invoiceNumber,
            jobTitle: job.title,
            total: total,
            invoiceUrl: invoiceUrl,
            pdfBuffer: null,
            companyName: companyName,
            customSubject: customSubject,
            customBody: customBody,
            trackingPixelUrl: `${_invAppUrl}/api/email-track/${_invLogId}`
        });

        await db.collection('email_logs').insertOne({
            _id: _invLogId,
            type: 'invoice',
            to: invoiceEmail,
            toName: client.name,
            subject: `Your job summary from ${companyName} — ${job.title}`,
            trigger: `Invoice #${invoiceNumber} for job "${job.title}" — $${parseFloat(total).toFixed(2)}`,
            relatedId: job._id,
            relatedTitle: job.title,
            htmlBody: `<p style="font-family:Arial,sans-serif;padding:1rem;color:#4a5568;">Invoice email sent for <strong>${job.title}</strong> — Invoice #${invoiceNumber} — $${parseFloat(total).toFixed(2)}<br><br><a href="${invoiceUrl}" style="color:#667eea;">View full invoice →</a></p>`,
            sentBy: req.session.userName || 'admin',
            sentAt: new Date(),
            status: 'sent',
            opened: false
        });

        await db.collection('jobs').updateOne(
            { _id: new ObjectId(jobId) },
            { $set: { invoiceSentAt: new Date() } }
        );

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

app.get('/api/sms-logs', isAuthenticated, async (req, res) => {
    try {
        // Pull directly from Twilio if available — source of truth for everything sent
        if (twilioClient) {
            const messages = await twilioClient.messages.list({ limit: 200 });
            const outbound = messages
                .filter(m => m.direction === 'outbound-api' || m.direction === 'outbound-reply')
                .map(m => {
                    // Try to match against our DB log to get enriched metadata (clientName, type, trigger)
                    return {
                        id: m.sid,
                        sid: m.sid,
                        to: m.to,
                        message: m.body,
                        sentAt: m.dateCreated,
                        success: !['failed', 'undelivered'].includes(m.status),
                        twilioStatus: m.status,
                        type: 'system',
                        clientName: null,
                        trigger: null,
                        source: 'twilio'
                    };
                });

            // Overlay our DB log metadata (clientName, type, trigger) matched by sid
            const dbLogs = await db.collection('sms_log').find({ sid: { $in: outbound.map(m => m.sid) } }).toArray();
            const dbBySid = {};
            dbLogs.forEach(l => { dbBySid[l.sid] = l; });
            outbound.forEach(m => {
                const db = dbBySid[m.sid];
                if (db) { m.clientName = db.clientName; m.type = db.type || 'system'; m.trigger = db.trigger; }
            });

            return res.json(outbound);
        }

        // Fallback: our DB log only
        const logs = await db.collection('sms_log')
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
    const team = await db.collection('team').find({}, { projection: { userId: 1, name: 1, hourlyRate: 1 } }).toArray();
    const rateByUserId = {}, rateByName = {};
    team.forEach(m => {
        if (m.userId) rateByUserId[String(m.userId)] = m.hourlyRate;
        if (m.name) rateByName[m.name] = m.hourlyRate;
    });
    const entriesWithId = entries.map(e => ({
        ...e,
        id: e._id.toString(),
        hourlyRate: e.hourlyRate ?? rateByUserId[String(e.userId)] ?? rateByName[e.userName] ?? null
    }));
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
    const { entryId, survey } = req.body;
    const entry = await db.collection('timeentries').findOne({
        _id: new ObjectId(entryId),
        status: { $in: ['active', 'on_break'] }
    });

    if (entry) {
        const clockOut = new Date();
        const breaks = entry.breaks || [];
        let breakSeconds = 0;
        const finalBreaks = breaks.map(b => {
            if (b.start && b.end) {
                breakSeconds += Math.round((new Date(b.end) - new Date(b.start)) / 1000);
                return b;
            } else if (b.start && !b.end) {
                // Auto-close any open break at clock-out
                const end = clockOut;
                breakSeconds += Math.round((end - new Date(b.start)) / 1000);
                return { start: b.start, end };
            }
            return b;
        });
        const rawDuration = Math.round((clockOut - entry.clockIn) / 1000);
        const duration = Math.max(0, rawDuration - breakSeconds);

        const updates = {
            clockOut,
            status: 'pending',
            approvalStatus: 'pending',
            duration,
            breaks: finalBreaks,
            updatedAt: new Date()
        };
        if (survey?.rating) updates.survey = { rating: parseInt(survey.rating), comment: (survey.comment || '').trim(), submittedAt: new Date() };

        await db.collection('timeentries').updateOne(
            { _id: new ObjectId(entryId) },
            { $set: updates }
        );

        const updated = await db.collection('timeentries').findOne({ _id: new ObjectId(entryId) });
        res.json({ ...updated, id: updated._id.toString() });
    } else {
        res.status(404).json({ error: 'Active time entry not found' });
    }
});

app.post('/api/timeentries/breakstart', isAuthenticated, async (req, res) => {
    const { entryId } = req.body;
    const entry = await db.collection('timeentries').findOne({
        _id: new ObjectId(entryId),
        status: 'active'
    });
    if (!entry) return res.status(404).json({ error: 'Active time entry not found' });
    const now = new Date();
    await db.collection('timeentries').updateOne(
        { _id: new ObjectId(entryId) },
        { $set: { status: 'on_break', updatedAt: now }, $push: { breaks: { start: now, end: null } } }
    );
    const updated = await db.collection('timeentries').findOne({ _id: new ObjectId(entryId) });
    res.json({ ...updated, id: updated._id.toString() });
});

app.post('/api/timeentries/breakend', isAuthenticated, async (req, res) => {
    const { entryId } = req.body;
    const entry = await db.collection('timeentries').findOne({
        _id: new ObjectId(entryId),
        status: 'on_break'
    });
    if (!entry) return res.status(404).json({ error: 'On-break time entry not found' });
    const now = new Date();
    const updatedBreaks = (entry.breaks || []).map((b, i, arr) =>
        i === arr.length - 1 && !b.end ? { start: b.start, end: now } : b
    );
    await db.collection('timeentries').updateOne(
        { _id: new ObjectId(entryId) },
        { $set: { status: 'active', breaks: updatedBreaks, updatedAt: now } }
    );
    const updated = await db.collection('timeentries').findOne({ _id: new ObjectId(entryId) });
    res.json({ ...updated, id: updated._id.toString() });
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
            date: new Date(timeEntry.clockIn).toISOString().split('T')[0],
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
        date: new Date(timeEntry.clockIn).toISOString().split('T')[0],
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
        assignedTo: Array.isArray(j.assignedTo) ? j.assignedTo.map(id => id.toString()) : ((j.assignedTo && j.assignedTo !== 'undefined' && typeof j.assignedTo === 'object') ? [j.assignedTo.toString()] : [])
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
    // Delete S3 attachments first
    try {
        const expense = await db.collection('expenses').findOne({ _id: new ObjectId(req.params.id) });
        if (expense && expense.attachments && s3Client) {
            for (const att of expense.attachments) {
                if (att.s3Key) await deleteFromS3(att.s3Key).catch(() => {});
            }
        }
    } catch (_) {}
    await db.collection('expenses').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
});

// Expense attachments
app.post('/api/expenses/:id/attachments', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { fileName, fileType, fileData, comment } = req.body;
        if (!fileName || !fileType || !fileData) return res.status(400).json({ error: 'Missing fields' });

        const base64Data = fileData.replace(/^data:[^;]+;base64,/, '');
        const fileBuffer = Buffer.from(base64Data, 'base64');

        let s3Key = null;
        if (s3Client) {
            const key = `expense-receipts/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const cmd = new PutObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key, Body: fileBuffer, ContentType: fileType });
            await s3Client.send(cmd);
            s3Key = key;
        }

        const attachment = {
            id: new ObjectId().toString(),
            name: fileName,
            type: fileType,
            size: fileBuffer.length,
            s3Key,
            comment: (comment || '').trim(),
            uploadedAt: new Date(),
            uploadedBy: req.session.userName || 'Admin'
        };

        await db.collection('expenses').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $push: { attachments: attachment }, $set: { updatedAt: new Date() } }
        );
        res.json({ success: true, attachment });
    } catch (e) {
        console.error('Expense attachment upload error:', e);
        res.status(500).json({ error: 'Upload failed' });
    }
});

app.delete('/api/expenses/:id/attachments/:attachmentId', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const expense = await db.collection('expenses').findOne({ _id: new ObjectId(req.params.id) });
        const att = (expense?.attachments || []).find(a => a.id === req.params.attachmentId);
        if (att?.s3Key && s3Client) await deleteFromS3(att.s3Key).catch(() => {});
        await db.collection('expenses').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $pull: { attachments: { id: req.params.attachmentId } } }
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Expense comments
app.post('/api/expenses/:id/comments', isAuthenticated, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text?.trim()) return res.status(400).json({ error: 'Comment text required' });
        const comment = {
            id: new ObjectId().toString(),
            text: text.trim(),
            author: req.session.userName || 'Admin',
            at: new Date()
        };
        await db.collection('expenses').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $push: { comments: comment }, $set: { updatedAt: new Date() } }
        );
        res.json({ success: true, comment });
    } catch (e) {
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

app.delete('/api/expenses/:id/comments/:commentId', isAuthenticated, isAdmin, async (req, res) => {
    await db.collection('expenses').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $pull: { comments: { id: req.params.commentId } } }
    );
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
                    const smsT2 = settings?.smsTemplates || {};
                    const message = interpolate(
                        smsT2.reminder || '{companyName} Reminder: Your appointment "{jobTitle}" is tomorrow at {time}. Reply CONFIRM or call us if you need to reschedule.',
                        { companyName, jobTitle: job.title, time }
                    );

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

    // Resolve service location for PM clients
    let serviceLocation = null;
    if (job.serviceLocationId && client && client.serviceLocations) {
        serviceLocation = client.serviceLocations.find(loc => String(loc.id) === String(job.serviceLocationId)) || null;
    }

    // Calculate subtotal from line items
    const laborSubtotal = (job.laborItems || []).reduce((sum, item) => sum + (item.hours * item.rate), 0);
    const materialSubtotal = (job.materialItems || []).reduce((sum, item) => sum + (item.quantity * item.price), 0);
    const subtotal = laborSubtotal + materialSubtotal;

    // Track invoice view — skip if admin is viewing, but count client portal views
    if (!req.session.userId || req.session.isClientPortal) {
        const now = new Date();
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
        await db.collection('jobs').updateOne(
            { _id: job._id },
            {
                $inc: { invoiceViewCount: 1 },
                $set: { invoiceLastViewedAt: now, ...(!job.invoiceFirstViewedAt ? { invoiceFirstViewedAt: now } : {}) },
                $push: { invoiceViewLog: { at: now, ip } }
            }
        );
    }

    // Generate signed URLs for job photos — from BOTH job.photos (quote/lead-carried)
    // and image attachments added on the job (Before/After), which live in job.attachments.
    let photoData = []; // [{ url, label }]
    if (s3Client) {
        const signKey = async (key) => { try { return await getS3SignedUrl(key, 3600); } catch (e) { return null; } };
        // 1) quote/lead-carried photos (no labels)
        for (const p of (Array.isArray(job.photos) ? job.photos : [])) {
            if (typeof p === 'string' && p.startsWith('data:')) { photoData.push({ url: p, label: '' }); }
            else if (typeof p === 'string' && p) { const u = await signKey(p); if (u) photoData.push({ url: u, label: '' }); }
        }
        // 2) image attachments (Before/After etc.), excluding the sign-off signature
        for (const a of (Array.isArray(job.attachments) ? job.attachments : [])) {
            if (!a || !a.s3Key || !String(a.type || '').startsWith('image/')) continue;
            if (a.name === 'Business Sign-Off' || String(a.comment || '').startsWith('Signed by')) continue;
            const u = await signKey(a.s3Key);
            if (u) photoData.push({ url: u, label: a.comment || '' });
        }
    }

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
        ${serviceLocation ? `
        <p style="margin-top:4px; color:#667eea; font-weight:600;">${serviceLocation.name || ''}</p>
        ${serviceLocation.address ? `<p style="white-space:pre-line;">${serviceLocation.address.trim()}</p>` : ''}
        ` : (client && client.address ? `<p>${client.address.replace(/\n/g, '<br>')}</p>` : '')}
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
                <td>${payment.method ? payment.method.charAt(0).toUpperCase() + payment.method.slice(1) : 'N/A'}${payment.last4 ? ` ••••${payment.last4}` : ''}</td>
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

    ${!isPaidInFull ? `
    <style>
        .pay-btn { display:inline-flex;align-items:center;gap:0.5rem;background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;padding:0.875rem 2.5rem;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;box-shadow:0 4px 15px rgba(102,126,234,0.45);transition:opacity 0.15s,transform 0.1s;letter-spacing:0.01em; }
        .pay-btn:hover { opacity:0.92;transform:translateY(-1px); }
        #payOverlay { display:none;position:fixed;inset:0;background:rgba(15,23,42,0.6);z-index:2000;align-items:center;justify-content:center;padding:1rem;backdrop-filter:blur(3px); }
        #payCard { background:#fff;border-radius:16px;width:100%;max-width:420px;box-shadow:0 25px 60px rgba(0,0,0,0.25);overflow:hidden; }
        .pay-header { background:linear-gradient(135deg,#667eea,#764ba2);padding:1.5rem 1.75rem;color:white; }
        .pay-header h2 { font-size:1.25rem;font-weight:700;margin:0 0 0.2rem; }
        .pay-header p { font-size:0.9rem;opacity:0.85;margin:0; }
        .pay-body { padding:1.5rem 1.75rem; }
        .pay-field { margin-bottom:1.1rem; }
        .pay-field label { display:block;font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:0.35rem; }
        .pay-input { width:100%;height:44px;padding:0 0.875rem;border:1.5px solid #e2e8f0;border-radius:8px;font-size:0.95rem;color:#1e293b;background:#f8fafc;transition:border-color 0.15s;box-sizing:border-box; }
        .pay-input:focus { outline:none;border-color:#667eea;background:#fff; }
        .clover-field { height:46px;border:1.5px solid #e2e8f0;border-radius:8px;background:#f8fafc;overflow:hidden;transition:border-color 0.15s;display:flex;align-items:center; }
        .clover-field iframe { width:100% !important;height:46px !important;border:none !important;display:block; }
        .pay-row { display:grid;grid-template-columns:1fr 1fr;gap:0.875rem; }
        .pay-divider { height:1px;background:#f1f5f9;margin:0.25rem 0 1.1rem; }
        #payError { display:none;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:0.65rem 0.875rem;border-radius:8px;font-size:0.85rem;margin-bottom:1rem; }
        .pay-actions { display:flex;gap:0.75rem;margin-top:0.25rem; }
        .pay-submit { flex:1;height:46px;background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;border-radius:8px;font-weight:700;font-size:0.95rem;cursor:pointer;transition:opacity 0.15s; }
        .pay-submit:disabled { opacity:0.6;cursor:not-allowed; }
        .pay-cancel { height:46px;padding:0 1.25rem;background:#f1f5f9;color:#64748b;border:none;border-radius:8px;font-weight:600;font-size:0.95rem;cursor:pointer;transition:background 0.15s; }
        .pay-cancel:hover { background:#e2e8f0; }
        .pay-secure { text-align:center;font-size:0.75rem;color:#94a3b8;margin-top:1rem; }
    </style>

    <div class="no-print" style="margin-top:2.5rem;text-align:center;">
        <button class="pay-btn" onclick="openPayModal()">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
            Pay Online
        </button>
        <p style="color:#94a3b8;font-size:0.8rem;margin-top:0.6rem;">Secure payment via Clover</p>
    </div>

    <div id="payOverlay" onclick="if(event.target===this)closePayModal()">
        <div id="payCard">
            <div class="pay-header">
                <h2>Pay Invoice #${job._id.toString().slice(-6)}</h2>
                <p>Balance due: $${formatMoney(balance)}</p>
            </div>
            <div class="pay-body">
                <div class="pay-field">
                    <label>Amount to Pay</label>
                    <div style="position:relative;">
                        <span style="position:absolute;left:0.875rem;top:50%;transform:translateY(-50%);color:#94a3b8;font-weight:600;">$</span>
                        <input type="number" id="payAmount" class="pay-input" value="${balance.toFixed(2)}" min="0.50" step="0.01" style="padding-left:1.75rem;" oninput="updateInvFee()">
                    </div>
                    <p style="font-size:0.75rem;color:#94a3b8;margin-top:0.3rem;">Enter less than the balance to make a partial payment.</p>
                </div>

                ${(parseFloat(settings.cloverFeePercent) || 0) > 0 ? `
                <div id="invFeeBox" style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:8px;padding:0.75rem 1rem;margin-bottom:0.85rem;font-size:0.85rem;">
                    <div style="display:flex;justify-content:space-between;color:#4a5568;margin-bottom:0.3rem;">
                        <span>Processing fee (${parseFloat(settings.cloverFeePercent)}%)</span>
                        <span id="invFeeAmt">$${(balance * parseFloat(settings.cloverFeePercent) / 100).toFixed(2)}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;font-weight:700;color:#1a202c;padding-top:0.3rem;border-top:1px solid #e2e8f0;">
                        <span>Total charged</span>
                        <span id="invFeeTotal">$${(balance * (1 + parseFloat(settings.cloverFeePercent) / 100)).toFixed(2)}</span>
                    </div>
                    <p style="font-size:0.72rem;color:#94a3b8;margin-top:0.4rem;">Credit card processing fees are collected by Clover and are non-refundable.</p>
                </div>` : ''}

                <div class="pay-divider"></div>

                <div class="pay-field">
                    <label>Card Number</label>
                    <div id="card-number" class="clover-field"></div>
                </div>
                <div class="pay-row">
                    <div class="pay-field">
                        <label>Expiry</label>
                        <div id="card-date" class="clover-field"></div>
                    </div>
                    <div class="pay-field">
                        <label>CVV</label>
                        <div id="card-cvv" class="clover-field"></div>
                    </div>
                </div>
                <div class="pay-field">
                    <label>Postal Code</label>
                    <div id="card-postal-code" class="clover-field"></div>
                </div>

                <div id="payError"></div>

                <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-size:0.85rem;color:#4a5568;margin-bottom:1rem;">
                    <input type="checkbox" id="saveCardCheckbox" checked style="width:15px;height:15px;accent-color:#667eea;cursor:pointer;flex-shrink:0;">
                    Save card for future payments
                </label>

                <div class="pay-actions">
                    <button class="pay-submit" id="payBtn" onclick="submitPayment()">Pay Now</button>
                    <button class="pay-cancel" onclick="closePayModal()">Cancel</button>
                </div>
                <p class="pay-secure">🔒 256-bit encrypted · PCI compliant</p>
            </div>
        </div>
    </div>

    <script src="https://checkout.clover.com/sdk.js"></script>
    <script>
        var cloverInst = null;
        var cloverCardEl = null;
        var cloverMounted = false;

        function openPayModal() {
            var overlay = document.getElementById('payOverlay');
            overlay.style.display = 'flex';
            if (!cloverMounted) {
                cloverInst = new Clover('${process.env.CLOVER_PUBLIC_KEY}', { merchantId: '${process.env.CLOVER_MERCHANT_ID}' });
                var elems = cloverInst.elements();
                cloverCardEl = elems.create('CARD_NUMBER');
                cloverCardEl.mount('#card-number');
                elems.create('CARD_DATE').mount('#card-date');
                elems.create('CARD_CVV').mount('#card-cvv');
                elems.create('CARD_POSTAL_CODE').mount('#card-postal-code');
                cloverMounted = true;
            }
        }

        function updateInvFee() {
            var feeBox = document.getElementById('invFeeBox');
            if (!feeBox) return;
            var amt = parseFloat(document.getElementById('payAmount').value) || 0;
            var feeRate = ${parseFloat(settings.cloverFeePercent) || 0} / 100;
            var fee = amt * feeRate;
            var total = amt + fee;
            document.getElementById('invFeeAmt').textContent = '$' + fee.toFixed(2);
            document.getElementById('invFeeTotal').textContent = '$' + total.toFixed(2);
        }

        function closePayModal() {
            document.getElementById('payOverlay').style.display = 'none';
        }

        async function submitPayment() {
            var btn = document.getElementById('payBtn');
            var errDiv = document.getElementById('payError');
            var amount = document.getElementById('payAmount').value;
            errDiv.style.display = 'none';
            btn.disabled = true;
            btn.textContent = 'Processing...';
            try {
                var result = await cloverInst.createToken(cloverCardEl);
                console.log('Clover createToken result:', JSON.stringify(result));
                if (!result || (!result.token && !result.errors)) {
                    var raw = result ? JSON.stringify(result) : 'null';
                    errDiv.innerHTML = 'Card tokenization failed. Clover response: <code style="font-size:0.8rem;word-break:break-all;">' + raw + '</code>';
                    errDiv.style.display = 'block';
                    btn.disabled = false;
                    btn.textContent = 'Pay Now';
                    return;
                }
                if (result.errors && Object.keys(result.errors).length) {
                    errDiv.textContent = Object.values(result.errors).join(' ');
                    errDiv.style.display = 'block';
                    btn.disabled = false;
                    btn.textContent = 'Pay Now';
                    return;
                }
                var saveCard = document.getElementById('saveCardCheckbox')?.checked !== false;
                var resp = await fetch('/api/client-portal/pay', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId: '${job._id.toString()}', amount: amount, token: result.token, saveCard: saveCard })
                });
                var data = await resp.json();
                if (data.success) {
                    document.getElementById('payCard').innerHTML = '<div style="padding:2.5rem 2rem;text-align:center;"><svg width="56" height="56" viewBox="0 0 56 56" style="margin-bottom:1rem;"><circle cx="28" cy="28" r="28" fill="#dcfce7"/><path d="M18 28l7 7 13-13" stroke="#16a34a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg><h2 style="color:#15803d;font-size:1.3rem;margin-bottom:0.5rem;">Payment Successful</h2><p style="color:#64748b;font-size:0.9rem;">Thank you — your payment has been received.</p><button onclick="location.reload()" style="margin-top:1.5rem;background:#667eea;color:white;border:none;padding:0.75rem 2rem;border-radius:8px;font-weight:700;cursor:pointer;font-size:0.9rem;">View Updated Invoice</button></div>';
                } else {
                    errDiv.textContent = data.error || 'Payment failed.';
                    errDiv.style.display = 'block';
                    btn.disabled = false;
                    btn.textContent = 'Pay Now';
                }
            } catch (e) {
                errDiv.textContent = 'Connection error. Please try again.';
                errDiv.style.display = 'block';
                btn.disabled = false;
                btn.textContent = 'Pay Now';
            }
        }
    </script>
    ` : ''}

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

    ${photoData.length ? `
    <div style="margin-top:40px;">
        <h3 style="color:#667eea;margin-bottom:16px;font-size:1.1em;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">Job Photos</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;">
            ${photoData.map((ph, i) => `
            <div style="cursor:pointer;" onclick="openLightbox(${i})">
                <div style="aspect-ratio:1;overflow:hidden;border-radius:8px;border:1px solid #e2e8f0;">
                    <img src="${ph.url}" alt="Job photo ${i+1}${ph.label ? ' — ' + ph.label : ''}"
                         style="width:100%;height:100%;object-fit:cover;transition:transform 0.2s;"
                         onmouseover="this.style.transform='scale(1.05)'"
                         onmouseout="this.style.transform='scale(1)'" />
                </div>
                ${ph.label ? `<div style="text-align:center;font-size:0.78em;color:#718096;margin-top:4px;font-weight:600;">${ph.label}</div>` : ''}
            </div>`).join('')}
        </div>
    </div>

    <div id="lb-overlay" onclick="closeLightbox()"
         style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:9999;cursor:pointer;align-items:center;justify-content:center;">
        <span style="position:absolute;top:18px;right:24px;color:#fff;font-size:2rem;line-height:1;user-select:none;">&times;</span>
        <img id="lb-img" src="" style="max-width:92vw;max-height:88vh;border-radius:6px;box-shadow:0 4px 32px rgba(0,0,0,0.5);" />
        <button onclick="event.stopPropagation();lbPrev()" style="position:absolute;left:16px;background:rgba(255,255,255,0.15);border:none;color:#fff;font-size:2rem;padding:8px 14px;border-radius:6px;cursor:pointer;">&#8249;</button>
        <button onclick="event.stopPropagation();lbNext()" style="position:absolute;right:16px;background:rgba(255,255,255,0.15);border:none;color:#fff;font-size:2rem;padding:8px 14px;border-radius:6px;cursor:pointer;">&#8250;</button>
    </div>
    <script>
        var lbUrls = ${JSON.stringify(photoData.map(p => p.url))};
        var lbIdx = 0;
        function openLightbox(i) {
            lbIdx = i;
            document.getElementById('lb-img').src = lbUrls[i];
            var ov = document.getElementById('lb-overlay');
            ov.style.display = 'flex';
        }
        function closeLightbox() { document.getElementById('lb-overlay').style.display = 'none'; }
        function lbPrev() { lbIdx = (lbIdx - 1 + lbUrls.length) % lbUrls.length; document.getElementById('lb-img').src = lbUrls[lbIdx]; }
        function lbNext() { lbIdx = (lbIdx + 1) % lbUrls.length; document.getElementById('lb-img').src = lbUrls[lbIdx]; }
        document.addEventListener('keydown', function(e) {
            if (document.getElementById('lb-overlay').style.display === 'flex') {
                if (e.key === 'Escape') closeLightbox();
                if (e.key === 'ArrowLeft') lbPrev();
                if (e.key === 'ArrowRight') lbNext();
            }
        });
    </script>
    ` : ''}

    <div class="footer" style="margin-top: 40px;">
        <p>Thank you for your business!</p>
        <p>Please remit payment within 3 days.</p>
        <p style="margin-top:8px;font-size:0.85em;color:#aaa;">Licensed &amp; Insured · LIC# 13VH13491700</p>
    </div>
</body>
</html>`;

    const oooBanner = await getOOOBanner();
    res.send(invoiceHTML.replace('<body>', '<body>' + oooBanner));
});

// Public Quote Viewing (no authentication required)
app.get('/quote-view/:token', async (req, res) => {
    try {
        const quote = await db.collection('quotes').findOne({ secureToken: req.params.token });

        if (!quote) {
            return res.status(404).send('<h1>Quote not found</h1><p>This quote may have been deleted or the link is invalid.</p>');
        }

        // Track view — skip if admin is viewing, but count client portal views
        if (!req.session.userId || req.session.isClientPortal) {
            const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
            const ua = req.headers['user-agent'] || '';
            const now = new Date();

            // If another view was logged within 90 seconds, this is an email security
            // scanner hitting the link from multiple nodes simultaneously (Safe Links etc.).
            // Still log it for diagnostics but don't count it as a real human view.
            const recentViews = (quote.viewLog || []).filter(v => now - new Date(v.at) < 90000);
            const isLikelyScan = recentViews.length > 0;

            const update = {
                $set: { lastViewedAt: now, ...(!quote.firstViewedAt && !isLikelyScan ? { firstViewedAt: now } : {}) },
                $push: { viewLog: { at: now, ip, ua, ...(isLikelyScan ? { scan: true } : {}) } }
            };
            if (!isLikelyScan) update.$inc = { viewCount: 1 };
            await db.collection('quotes').updateOne({ _id: quote._id }, update);
        }

        const client = await db.collection('clients').findOne({ _id: quote.clientId });
        const settings = await db.collection('settings').findOne({});

        const companyName    = settings?.companyName    || 'Your Company';
        const companyLogo    = settings?.companyLogo    || '';
        const companyAddress = settings?.companyAddress || '';
        const companyPhone   = settings?.companyPhone   || '';
        const companyEmail   = settings?.companyEmail   || '';
        const companyLicense = settings?.companyLicense || '';

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
        const viewLabel = (quote.source === 'portal' && client?.isPropertyManagement) ? 'Work Order' : 'Quote';

        const quoteHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${viewLabel} #${quote.quoteNumber} - ${companyName}</title>
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
            ${companyLogo ? `<img src="${companyLogo}" alt="${companyName}" class="logo">` : ''}
            <h1>${companyName}</h1>
            <div style="color:#718096;font-size:0.9rem;margin-top:0.4rem;line-height:1.7;">
                ${companyAddress ? `<span>${companyAddress.replace(/\n/g, ', ')}</span><br>` : ''}
                ${companyPhone ? `<span>${companyPhone}</span>` : ''}${companyPhone && companyEmail ? ' &nbsp;·&nbsp; ' : ''}${companyEmail ? `<span>${companyEmail}</span>` : ''}
                ${companyLicense ? `<br><span style="font-size:0.82rem;">License #${companyLicense}</span>` : ''}
            </div>
            <h2 style="margin-top:1rem;">${viewLabel} #${quote.quoteNumber}</h2>
        </div>

        <div class="status">
            ${statusBadge}
        </div>

        <div class="info-grid">
            <div class="info-section">
                <h3>${viewLabel} For:</h3>
                <p><strong>${client ? client.name : 'Client'}</strong></p>
                ${client?.email ? `<p>${client.email}</p>` : ''}
                ${client?.phone ? `<p>${client.phone}</p>` : ''}
                ${client?.address ? `<p>${client.address}</p>` : ''}
            </div>
            <div class="info-section">
                <h3>${viewLabel} Details:</h3>
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
                    <th style="text-align: right;">Amount</th>
                </tr>
            </thead>
            <tbody>
                ${quote.laborItems.map(item => `
                <tr>
                    <td>${item.description}</td>
                    <td style="text-align: right;">$${(item.hours * item.rate).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
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
                    <td style="text-align: right;">$${parseFloat(item.price).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                    <td style="text-align: right;">$${(item.quantity * item.price).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                </tr>
                `).join('')}
            </tbody>
        </table>
        ` : ''}

        <div class="totals">
            <div class="totals-row">
                <span>Subtotal:</span>
                <span>$${subtotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
            </div>
            <div class="totals-row">
                <span>Tax ${quote.taxWaived ? '(EXEMPT)' : `(${((settings?.taxRate || 0.06625) * 100).toFixed(3)}%)`}:</span>
                <span>$${taxAmount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
            </div>
            <div class="totals-row total">
                <span>Total:</span>
                <span>$${total.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
            </div>
        </div>

        ${quote.clientNotes ? `
        <div class="notes">
            <h4 style="margin-bottom: 0.5rem;">Notes:</h4>
            <p style="white-space: pre-wrap;">${quote.clientNotes}</p>
        </div>
        ` : ''}

        ${showButtons ? `
        <!-- ── Agreement block ─────────────────────────────────────────── -->
        <div style="margin:2.5rem 0 1rem;">
            <h3 style="color:#2d3748;font-size:1.05rem;margin:0 0 0.5rem;display:flex;align-items:center;gap:0.5rem;">📋 Review &amp; Agree to Project Terms</h3>
            <p style="color:#718096;font-size:0.87rem;margin-bottom:0.85rem;">Scroll through the project scope and terms below. The checkbox unlocks when you reach the bottom.</p>

            <div id="agreementScroll" onscroll="checkScrolled()" style="border:2px solid #e2e8f0;border-radius:10px;max-height:280px;overflow-y:scroll;padding:1.25rem 1.5rem;background:#fafafa;font-size:0.88rem;line-height:1.75;color:#2d3748;">
                <p style="font-weight:700;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.07em;color:#667eea;margin:0 0 0.35rem;">Project Scope</p>
                <p style="font-weight:600;font-size:1rem;margin:0 0 0.5rem;">${quote.title}</p>
                ${quote.description ? `<p style="white-space:pre-wrap;margin-bottom:0.75rem;">${quote.description}</p>` : ''}
                ${quote.laborItems && quote.laborItems.length > 0 ? `
                <p style="font-weight:700;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.07em;color:#718096;margin:0.75rem 0 0.3rem;">Labor</p>
                ${quote.laborItems.map(item => `<p style="margin:0.2rem 0;">• ${item.description} — $${parseFloat(item.rate * item.hours).toFixed(2)}</p>`).join('')}` : ''}
                ${quote.materialItems && quote.materialItems.length > 0 ? `
                <p style="font-weight:700;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.07em;color:#718096;margin:0.75rem 0 0.3rem;">Materials</p>
                ${quote.materialItems.map(item => `<p style="margin:0.2rem 0;">• ${item.description} — qty ${item.quantity} @ $${parseFloat(item.price).toFixed(2)}</p>`).join('')}` : ''}
                <div style="border-top:1.5px solid #e2e8f0;margin:1.25rem 0;"></div>
                <p style="font-weight:700;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.07em;color:#667eea;margin:0 0 0.5rem;">Terms &amp; Conditions</p>
                ${settings.contractTerms
                    ? `<p style="white-space:pre-wrap;">${settings.contractTerms}</p>`
                    : `<p>By approving this ${viewLabel.toLowerCase()}, you agree that ${companyName} will perform the work described above at the quoted price. Payment is due upon completion unless otherwise agreed in writing. All work is performed professionally and consistent with industry standards. Either party may cancel prior to commencement of work with written notice.</p>`}
                <div style="height:4px;"></div>
            </div>

            <p id="scrollHint" style="font-size:0.8rem;color:#d97706;margin:0.4rem 0 0;display:flex;align-items:center;gap:0.3rem;">↕ Scroll to the bottom to continue</p>

            <label id="agreeLabel" style="display:flex;align-items:flex-start;gap:0.75rem;margin-top:0.85rem;padding:0.9rem 1rem;border:2px solid #e2e8f0;border-radius:8px;background:#f7fafc;opacity:0.45;cursor:not-allowed;transition:opacity 0.3s,border-color 0.3s,background 0.3s;user-select:none;">
                <input type="checkbox" id="agreeCheck" disabled onchange="checkAgreed()" style="width:18px;height:18px;margin-top:2px;flex-shrink:0;accent-color:#48bb78;cursor:inherit;">
                <span style="font-size:0.9rem;color:#2d3748;line-height:1.5;">I have read and agree to the project scope and terms &amp; conditions above. I am authorized to approve this ${viewLabel.toLowerCase()} on behalf of the client.</span>
            </label>
        </div>

        <div class="actions">
            <button id="approveBtn" class="btn btn-approve" onclick="document.getElementById('approveModal').style.display='flex'" disabled style="opacity:0.45;cursor:not-allowed;transition:opacity 0.3s;">✓ Approve ${viewLabel}</button>
            <button class="btn btn-reject" onclick="document.getElementById('rejectModal').style.display='flex'">✗ Decline</button>
        </div>
        ` : ''}

        ${quote.status === 'in_review' ? `
        <div style="background:#f0fff4;border:1.5px solid #68d391;border-radius:10px;padding:1.25rem 1.5rem;margin:2rem 0;text-align:center;">
            <p style="font-size:1.1rem;font-weight:700;color:#276749;margin-bottom:0.4rem;">✓ ${viewLabel} Approved</p>
            <p style="color:#2f855a;margin:0;">We've received your approval and will be in touch shortly to confirm scheduling. Thank you!</p>
        </div>
        ` : ''}

        ${quote.status === 'rejected' ? `
        <div style="background:#fff5f5;border:1.5px solid #fc8181;border-radius:10px;padding:1.25rem 1.5rem;margin:2rem 0;text-align:center;">
            <p style="font-size:1.1rem;font-weight:700;color:#742a2a;margin-bottom:0.4rem;">✗ ${viewLabel} Declined</p>
            <p style="color:#9b2c2c;margin:0;">If you have questions or would like to revisit this, please don't hesitate to reach out to us directly.</p>
        </div>
        ` : ''}

        <div class="footer">
            <p>Thank you for choosing ${companyName}</p>
            <p>${viewLabel} generated on ${new Date(quote.createdAt).toLocaleDateString()}</p>
        </div>
    </div>

    <!-- Approve Modal -->
    <div id="approveModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:100;align-items:center;justify-content:center;padding:1rem;">
        <div style="background:white;border-radius:12px;padding:1.5rem;max-width:460px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,0.2);">
            <h3 style="margin:0 0 0.25rem;color:#2d3748;">✓ Approve ${quote.source === 'portal' ? 'Work Order' : 'Quote'}</h3>
            <p style="color:#718096;font-size:0.85rem;margin-bottom:1.25rem;">Please confirm who is authorizing this approval.</p>
            <label style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#718096;display:block;margin-bottom:0.25rem;">Full Name <span style="color:#e53e3e;">*</span></label>
            <input id="approveName" type="text" placeholder="Your full name" style="width:100%;padding:0.6rem 0.75rem;border:1.5px solid #e2e8f0;border-radius:8px;font-size:0.95rem;font-family:inherit;box-sizing:border-box;margin-bottom:0.85rem;">
            <label style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#718096;display:block;margin-bottom:0.25rem;">Title / Role</label>
            <input id="approveTitle" type="text" placeholder="e.g. Property Manager, Owner" style="width:100%;padding:0.6rem 0.75rem;border:1.5px solid #e2e8f0;border-radius:8px;font-size:0.95rem;font-family:inherit;box-sizing:border-box;margin-bottom:0.85rem;">
            <label style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#718096;display:block;margin-bottom:0.25rem;">Comments</label>
            <textarea id="approveNote" rows="3" placeholder="e.g. Please schedule for mornings, gate code is 1234..." style="width:100%;padding:0.65rem;border:1.5px solid #e2e8f0;border-radius:8px;font-family:inherit;font-size:0.9rem;box-sizing:border-box;resize:vertical;"></textarea>
            <div style="display:flex;gap:0.5rem;margin-top:1rem;">
                <button onclick="submitApprove()" style="flex:1;padding:0.75rem;background:#48bb78;color:white;border:none;border-radius:8px;font-size:0.95rem;font-weight:600;cursor:pointer;">Confirm Approval</button>
                <button onclick="document.getElementById('approveModal').style.display='none'" style="padding:0.75rem 1rem;background:#e2e8f0;border:none;border-radius:8px;cursor:pointer;">Cancel</button>
            </div>
        </div>
    </div>

    <!-- Reject Modal -->
    <div id="rejectModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:100;align-items:center;justify-content:center;padding:1rem;">
        <div style="background:white;border-radius:12px;padding:1.5rem;max-width:420px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,0.2);">
            <h3 style="margin:0 0 0.75rem;color:#2d3748;">✗ Decline ${quote.source === 'portal' ? 'Work Order' : 'Quote'}</h3>
            <p style="color:#718096;font-size:0.9rem;margin-bottom:1rem;">Let us know why (optional — helps us improve):</p>
            <textarea id="rejectNote" rows="3" placeholder="e.g. Price is too high, need to get other bids first..." style="width:100%;padding:0.65rem;border:1.5px solid #e2e8f0;border-radius:8px;font-family:inherit;font-size:0.9rem;box-sizing:border-box;resize:vertical;"></textarea>
            <div style="display:flex;gap:0.5rem;margin-top:1rem;">
                <button onclick="submitReject()" style="flex:1;padding:0.75rem;background:#e53e3e;color:white;border:none;border-radius:8px;font-size:0.95rem;font-weight:600;cursor:pointer;">Confirm Decline</button>
                <button onclick="document.getElementById('rejectModal').style.display='none'" style="padding:0.75rem 1rem;background:#e2e8f0;border:none;border-radius:8px;cursor:pointer;">Cancel</button>
            </div>
        </div>
    </div>

    <script>
        // ── Scroll-to-agree logic ────────────────────────────────────────────
        var _scrolledThrough = false;
        function checkScrolled() {
            if (_scrolledThrough) return;
            var el = document.getElementById('agreementScroll');
            if (!el) return;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 30) {
                _unlockCheckbox();
            }
        }
        function _unlockCheckbox() {
            if (_scrolledThrough) return;
            _scrolledThrough = true;
            var cb  = document.getElementById('agreeCheck');
            var lbl = document.getElementById('agreeLabel');
            var hint = document.getElementById('scrollHint');
            if (!cb) return;
            cb.disabled = false;
            lbl.style.opacity = '1';
            lbl.style.cursor = 'pointer';
            lbl.style.borderColor = '#9ae6b4';
            lbl.style.background = '#f0fff4';
            if (hint) hint.style.display = 'none';
        }
        function checkAgreed() {
            var btn = document.getElementById('approveBtn');
            var cb  = document.getElementById('agreeCheck');
            if (!btn || !cb) return;
            if (cb.checked) {
                btn.disabled = false;
                btn.style.opacity = '1';
                btn.style.cursor = 'pointer';
            } else {
                btn.disabled = true;
                btn.style.opacity = '0.45';
                btn.style.cursor = 'not-allowed';
            }
        }
        // Auto-unlock if content is too short to scroll
        window.addEventListener('load', function() {
            var el = document.getElementById('agreementScroll');
            if (el && el.scrollHeight <= el.clientHeight + 10) _unlockCheckbox();
        });

        // ── Submit handlers ──────────────────────────────────────────────────
        async function submitApprove() {
            var agreeCheck = document.getElementById('agreeCheck');
            if (agreeCheck && !agreeCheck.checked) {
                alert('Please read and check the agreement box before approving.');
                document.getElementById('approveModal').style.display = 'none';
                return;
            }
            const approverName  = document.getElementById('approveName').value.trim();
            const approverTitle = document.getElementById('approveTitle').value.trim();
            const note = document.getElementById('approveNote').value.trim();
            if (!approverName) {
                document.getElementById('approveName').style.borderColor = '#e53e3e';
                document.getElementById('approveName').focus();
                return;
            }
            try {
                const res = await fetch('/quote-action/${quote.secureToken}/approve', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ note, approverName, approverTitle, agreedToTerms: true, agreedAt: new Date().toISOString() })
                });
                if (res.ok) { document.getElementById('approveModal').style.display='none'; location.reload(); }
                else alert('Failed to approve. Please try again or contact us directly.');
            } catch (e) { alert('Error: ' + e.message); }
        }

        async function submitReject() {
            const reason = document.getElementById('rejectNote').value.trim();
            try {
                const res = await fetch('/quote-action/${quote.secureToken}/reject', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason })
                });
                if (res.ok) { document.getElementById('rejectModal').style.display='none'; location.reload(); }
                else alert('Failed to decline. Please try again or contact us directly.');
            } catch (e) { alert('Error: ' + e.message); }
        }
    </script>
</body>
</html>`;

        const oooBanner = await getOOOBanner();
        res.send(quoteHTML.replace('<body>', '<body>' + oooBanner));
    } catch (error) {
        console.error('Quote view error:', error);
        res.status(500).send('<h1>Error loading quote</h1>');
    }
});

// Quote approval/rejection actions (public)
app.post('/quote-action/:token/approve', async (req, res) => {
    try {
        const quote = await db.collection('quotes').findOne({ secureToken: req.params.token });
        if (!quote) return res.status(404).json({ error: 'Quote not found' });

        const { note, approverName, approverTitle, agreedToTerms, agreedAt } = req.body || {};
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
        const client = await db.collection('clients').findOne({ _id: new ObjectId(quote.clientId) });
        const signerLabel = [approverName, approverTitle].filter(Boolean).join(' — ');
        const auditEntry = {
            timestamp: new Date(),
            userName: approverName || client?.name || 'Client',
            approverTitle: approverTitle || '',
            action: 'approved',
            oldStatus: quote.status,
            newStatus: 'in_review',
            agreedToTerms: !!agreedToTerms,
            agreedAt: agreedAt ? new Date(agreedAt) : new Date(),
            ipAddress: ip,
            note: [signerLabel ? `Authorized by: ${signerLabel}` : '', agreedToTerms ? 'Agreed to project scope & T&C ✓' : '', note ? `Comments: ${note}` : ''].filter(Boolean).join('\n') || 'Approved by client'
        };

        await db.collection('quotes').updateOne(
            { _id: quote._id },
            { $set: { status: 'in_review', approvedAt: new Date(), clientNote: note || '', approverName: approverName || '', approverTitle: approverTitle || '', agreedToTerms: !!agreedToTerms, agreedAt: agreedAt ? new Date(agreedAt) : new Date(), approverIp: ip }, $push: { auditLog: auditEntry } }
        );

        const approvalLabel = quote.source === 'portal' ? 'work order' : 'quote';
        await db.collection('client_messages').insertOne({
            clientId: new ObjectId(quote.clientId),
            clientName: client?.name || 'Unknown Client',
            clientEmail: client?.email || '',
            message: `Client approved ${approvalLabel} ${quote.quoteNumber} — "${quote.title}"\n\nTotal: ${fmt$(parseFloat(quote.total || 0))}${note ? '\n\nClient note: ' + note : ''}\n\nNow in review — please schedule the work.`,
            subject: 'quote',
            reference: quote.quoteNumber,
            createdAt: new Date(),
            read: false
        });

        if (emailService.initialized) {
            const settings = await db.collection('settings').findOne({});
            const companyName = settings?.companyName || 'GSD Property Services';
            await emailService.sendEmail({
                to: 'info@gsdhandymanservice.com',
                subject: `✅ ${approvalLabel.charAt(0).toUpperCase() + approvalLabel.slice(1)} Approved — ${quote.quoteNumber} — ${client?.name || 'Client'}`,
                html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                    <h2 style="color:#48bb78;">✅ ${approvalLabel.charAt(0).toUpperCase() + approvalLabel.slice(1)} Approved</h2>
                    <p style="background:#f0fff4;padding:10px 14px;border-radius:6px;font-weight:700;color:#276749;">${quote.quoteNumber} — ${quote.title}</p>
                    <table style="width:100%;border-collapse:collapse;">
                        <tr><td style="padding:8px 0;font-weight:600;color:#374151;width:140px;">Client</td><td>${client?.name || 'Unknown'}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:600;color:#374151;">Total</td><td><strong>${fmt$(parseFloat(quote.total || 0))}</strong></td></tr>
                        ${approverName ? `<tr><td style="padding:8px 0;font-weight:600;color:#374151;">Authorized By</td><td>${approverName}${approverTitle ? ' — ' + approverTitle : ''}</td></tr>` : ''}
                        ${note ? `<tr><td style="padding:8px 0;font-weight:600;color:#374151;vertical-align:top;">Comments</td><td>${note}</td></tr>` : ''}
                    </table>
                    <p style="margin-top:16px;color:#4a5568;">Ready to schedule — log in to convert this to a job.</p>
                </div>`,
                text: `${approvalLabel.charAt(0).toUpperCase() + approvalLabel.slice(1)} Approved\n\n${quote.quoteNumber} — ${quote.title}\nClient: ${client?.name || 'Unknown'}\nTotal: ${fmt$(parseFloat(quote.total || 0))}${note ? '\nClient Note: ' + note : ''}\n\nLog in to schedule the work.`
            });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/quote-action/:token/reject', async (req, res) => {
    try {
        const quote = await db.collection('quotes').findOne({ secureToken: req.params.token });
        if (!quote) return res.status(404).json({ error: 'Quote not found' });

        const { reason } = req.body || {};
        const client = await db.collection('clients').findOne({ _id: new ObjectId(quote.clientId) });
        const auditEntry = {
            timestamp: new Date(),
            userName: client?.name || 'Client',
            action: 'rejected',
            oldStatus: quote.status,
            newStatus: 'rejected',
            note: reason ? `Declined with reason: ${reason}` : 'Declined by client'
        };

        await db.collection('quotes').updateOne(
            { _id: quote._id },
            { $set: { status: 'rejected', rejectedAt: new Date(), rejectionReason: reason || '' }, $push: { auditLog: auditEntry } }
        );

        await db.collection('client_messages').insertOne({
            clientId: new ObjectId(quote.clientId),
            clientName: client?.name || 'Unknown Client',
            clientEmail: client?.email || '',
            message: `Client declined ${quote.source === 'portal' ? 'work order' : 'quote'} ${quote.quoteNumber} — "${quote.title}"${reason ? '\n\nReason: ' + reason : ''}`,
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

// Client Portal Routes
app.get('/client-login', async (req, res) => {
    const fs = require('fs');
    const html = fs.readFileSync('./client-login.html', 'utf8');
    const oooBanner = await getOOOBanner();
    res.send(html.replace('<body>', '<body>' + oooBanner));
});

app.get('/client-portal', async (req, res) => {
    if (!req.session.clientId) {
        return res.redirect('/client-login');
    }
    const fs = require('fs');
    const html = fs.readFileSync('./client-portal.html', 'utf8');
    const oooBanner = await getOOOBanner();
    res.send(html.replace('<body>', '<body>' + oooBanner));
});

// Client Portal API - Login
app.post('/api/client-portal/login', loginLimiter, async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
    try {
        const { email, password } = req.body;
        const emailNorm = email.trim().toLowerCase();

        // First try primary email match
        let client = await db.collection('clients').findOne({
            email: { $regex: new RegExp(`^${emailNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        });
        let matchedLocationId = null;

        // If not found by primary email, check service location contact emails
        if (!client) {
            client = await db.collection('clients').findOne({
                'serviceLocations.contactEmail': { $regex: new RegExp(`^${emailNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
            });
            if (client) {
                const loc = client.serviceLocations.find(l => l.contactEmail?.toLowerCase() === emailNorm);
                if (loc) matchedLocationId = String(loc.id);
            }
        }

        if (!client) {
            await db.collection('login_logs').insertOne({ type: 'client', email: emailNorm, at: new Date(), ip, success: false, reason: 'Email not found' });
            return res.status(401).json({ error: 'Invalid email or access code' });
        }

        if (!client.portalPassword) {
            await db.collection('login_logs').insertOne({ type: 'client', targetId: client._id, email: emailNorm, at: new Date(), ip, success: false, reason: 'Portal access not set up' });
            return res.status(401).json({ error: 'Portal access not set up. Contact us to enable portal access.' });
        }

        const passwordMatch = await bcrypt.compare(password, client.portalPassword);
        if (!passwordMatch) {
            await db.collection('login_logs').insertOne({ type: 'client', targetId: client._id, email: emailNorm, at: new Date(), ip, success: false, reason: 'Wrong access code' });
            return res.status(401).json({ error: 'Invalid email or access code' });
        }

        await db.collection('login_logs').insertOne({ type: 'client', targetId: client._id, email: emailNorm, at: new Date(), ip, success: true, reason: null });

        req.session.clientId = client._id.toString();
        req.session.clientName = client.name;
        req.session.isClientPortal = true;
        req.session.portalLocationId = matchedLocationId; // null = full access, string = location-scoped

        await db.collection('clients').updateOne({ _id: client._id }, { $set: { lastPortalLogin: new Date() } });

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
        const locationId = req.session.portalLocationId || null; // null = full access

        // Get client
        const client = await db.collection('clients').findOne({ _id: clientId });
        if (!client) {
            return res.status(404).json({ error: 'Client not found' });
        }

        // Build location-scoped filters if logged in as a property contact
        const jobFilter = locationId
            ? { clientId, serviceLocationId: { $in: [locationId, parseInt(locationId)] } }
            : { clientId };
        const quoteFilter = locationId
            ? { clientId, serviceLocationId: { $in: [locationId, parseInt(locationId)] } }
            : { clientId };

        // Resolve the matched location for display name
        const matchedLocation = locationId
            ? (client.serviceLocations || []).find(l => String(l.id) === locationId)
            : null;

        // Get client's quotes (scoped or full)
        const quotes = await db.collection('quotes')
            .find(quoteFilter)
            .sort({ createdAt: -1 })
            .toArray();

        // Get client's jobs (scoped or full)
        const jobs = await db.collection('jobs')
            .find(jobFilter)
            .sort({ scheduledDate: -1 })
            .toArray();

        // Get settings for branding
        const settings = await db.collection('settings').findOne({}) || {};

        // Add id field for frontend
        const quotesWithId = quotes.map(q => ({ ...q, id: q._id.toString(), convertedToJobId: q.convertedToJobId ? q.convertedToJobId.toString() : null }));
        const jobsWithId = jobs.map(j => ({ ...j, id: j._id.toString() }));

        // Build address list for the portal address picker
        const primaryAddress = [client.addressLine1, client.addressLine2, client.city, client.state, client.zipCode].filter(Boolean).join(', ') || client.address || '';
        const addresses = [];
        if (primaryAddress) addresses.push({ id: 'primary', label: 'Primary Address', address: primaryAddress });
        (client.serviceLocations || []).forEach(loc => {
            if (loc.address) addresses.push({ id: String(loc.id), label: loc.name || loc.address, address: loc.address });
        });

        // Invoices = jobs that have been invoiced or completed WITH a real total or payment
        // (zero-total completed jobs fall back to a job card with no amount row)
        const invoices = jobs
            .filter(j => (j.invoiceSentAt || j.status === 'invoiced' || j.status === 'completed')
                      && (parseFloat(j.totalWithTax || j.total) > 0 || parseFloat(j.totalPaid) > 0))
            .map(j => {
                const total = parseFloat(j.totalWithTax || j.total) || 0;
                const paid = parseFloat(j.totalPaid) || 0;
                const due = Math.round(Math.max(0, total - paid) * 100) / 100;
                // If admin marked job completed, treat as paid — admin is source of truth
                const status = (j.status === 'completed' || due < 0.01) ? 'paid' : paid > 0 ? 'partial' : 'outstanding';
                const invoiceNumber = j.invoiceNumber || `INV-${j._id.toString().slice(-8).toUpperCase()}`;
                return {
                    id: j._id.toString(),
                    invoiceNumber,
                    jobTitle: j.title,
                    total,
                    paid,
                    due,
                    status,
                    date: j.invoiceSentAt || j.updatedAt || j.createdAt
                };
            })
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json({
            client: {
                name: matchedLocation ? `${matchedLocation.name || matchedLocation.address}` : client.name,
                displayName: client.name,
                email: client.email,
                phone: client.phone,
                isLocationScoped: !!locationId,
                locationAddress: matchedLocation?.address || '',
                isPropertyManagement: !!client.isPropertyManagement
            },
            quotes: quotesWithId,
            jobs: jobsWithId,
            invoices,
            addresses: locationId && matchedLocation
                ? [{ id: String(matchedLocation.id), label: matchedLocation.name || matchedLocation.address, address: matchedLocation.address }]
                : addresses,
            settings: {
                appName: settings.appName || 'Jobber Pro',
                favicon: settings.favicon || '',
                companyName: settings.companyName || 'Your Company',
                companyPhone: settings.companyPhone || ''
            }
        });
    } catch (error) {
        console.error('Get client data error:', error);
        res.status(500).json({ error: 'Failed to load data' });
    }
});

// Client Portal API - Get single quote detail (with signed photo URLs)
app.get('/api/client-portal/job/:id/photos', async (req, res) => {
    try {
        if (!req.session.clientId || !req.session.isClientPortal) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        const clientId = new ObjectId(req.session.clientId);
        const job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.id), clientId });
        if (!job) return res.status(404).json({ error: 'Not found' });
        const photos = Array.isArray(job.photos) ? job.photos : [];
        const urls = await Promise.all(photos.map(p =>
            typeof p === 'string' && !p.startsWith('data:') && s3Client
                ? getS3SignedUrl(p, 3600)
                : Promise.resolve(p)
        ));
        res.json({ photos: urls.filter(Boolean) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/client-portal/quote/:id', async (req, res) => {
    try {
        if (!req.session.clientId || !req.session.isClientPortal) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        const clientId = new ObjectId(req.session.clientId);
        const quote = await db.collection('quotes').findOne({ _id: new ObjectId(req.params.id), clientId });
        if (!quote) return res.status(404).json({ error: 'Not found' });

        const priorityLabels = { urgent: '🔴 Urgent', '1_day': '🟠 Within 1 Day', '3_days': '🟡 Within 3 Days', '1_week': '🟢 Within 1 Week', '2_weeks': '🔵 Within 2 Weeks', flexible: '⚪ Flexible / No Rush' };

        let photoUrls = [];
        if (Array.isArray(quote.photos) && quote.photos.length > 0 && s3Client) {
            photoUrls = await Promise.all(quote.photos.map(p =>
                typeof p === 'string' && !p.startsWith('data:') ? getS3SignedUrl(p, 3600) : Promise.resolve(p)
            ));
        }

        res.json({
            id: quote._id.toString(),
            quoteNumber: quote.quoteNumber,
            title: quote.title,
            description: quote.description || '',
            serviceAddress: quote.serviceAddress || '',
            priority: quote.priority || 'flexible',
            priorityLabel: priorityLabels[quote.priority] || '⚪ Flexible / No Rush',
            status: quote.status,
            source: quote.source,
            createdAt: quote.createdAt,
            photos: photoUrls
        });
    } catch (error) {
        console.error('Get portal quote error:', error);
        res.status(500).json({ error: 'Failed to load' });
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

// Client Portal — Submit quote request (creates a quote directly)
app.post('/api/client-portal/quote-request', async (req, res) => {
    try {
        if (!req.session.clientId || !req.session.isClientPortal) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const client = await db.collection('clients').findOne({ _id: new ObjectId(req.session.clientId) });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const { service, description, addressId, priority, photos } = req.body;
        if (!service) return res.status(400).json({ error: 'Service is required' });

        // Resolve the chosen address — if session is location-scoped, force that location
        const sessionLocationId = req.session.portalLocationId || null;
        let serviceAddress = '';
        let serviceLocationId = null;
        const resolvedAddressId = sessionLocationId || addressId;

        if (!resolvedAddressId || resolvedAddressId === 'primary') {
            serviceAddress = [client.addressLine1, client.addressLine2, client.city, client.state, client.zipCode].filter(Boolean).join(', ') || client.address || '';
        } else {
            const loc = (client.serviceLocations || []).find(l => String(l.id) === String(resolvedAddressId));
            if (loc) { serviceAddress = loc.address; serviceLocationId = loc.id; }
        }

        // Upload photos to S3
        const validPhotos = Array.isArray(photos) ? photos.filter(p => typeof p === 'string' && p.startsWith('data:image/')).slice(0, 5) : [];
        let photoKeys = [];
        if (validPhotos.length > 0 && s3Client) {
            const ts = Date.now();
            const uploads = await Promise.all(validPhotos.map(async (dataUrl, i) => {
                const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/);
                if (!match) return null;
                const [, contentType, rawExt] = match;
                const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
                const key = `quotes/portal/${ts}-${i}.${ext}`;
                const buffer = Buffer.from(match[3], 'base64');
                await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key, Body: buffer, ContentType: contentType }));
                return key;
            }));
            photoKeys = uploads.filter(Boolean);
        }

        // Generate quote number and secure token
        const crypto = require('crypto');
        const quoteNumber = await nextQuoteNumber();
        const secureToken = crypto.randomUUID();

        const validUntilDate = new Date();
        validUntilDate.setDate(validUntilDate.getDate() + 30);
        const validUntil = validUntilDate.toISOString().split('T')[0];

        const quote = {
            clientId: new ObjectId(req.session.clientId),
            clientName: client.name,
            title: service,
            description: description || '',
            serviceAddress,
            serviceLocationId,
            photos: photoKeys.length ? photoKeys : validPhotos,
            quoteNumber,
            secureToken,
            priority: priority || 'flexible',
            status: 'draft',
            source: 'portal',
            total: 0,
            lineItems: [],
            validUntil,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const insertResult = await db.collection('quotes').insertOne(quote);
        const newQuoteId = insertResult.insertedId.toString();

        const settings = await db.collection('settings').findOne({});
        const businessName = settings?.companyName || settings?.appName || 'GSD Property Services';

        const priorityLabels = { urgent: '🔴 Urgent', '1_day': '🟠 Within 1 Day', '3_days': '🟡 Within 3 Days', '1_week': '🟢 Within 1 Week', '2_weeks': '🔵 Within 2 Weeks', flexible: '⚪ Flexible / No Rush' };
        const priorityLabel = priorityLabels[priority] || priority || 'Flexible';

        if (emailService.initialized) {
            const emailPhotoUrls = photoKeys.length
                ? await Promise.all(photoKeys.map(k => getS3SignedUrl(k, 86400)))
                : validPhotos;
            const photoHtml = emailPhotoUrls.length
                ? `<tr><td style="padding:8px 0;font-weight:600;color:#374151;vertical-align:top;">Photos</td><td><div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px;">${emailPhotoUrls.map(p => `<img src="${p}" style="width:120px;height:90px;object-fit:cover;border-radius:4px;border:1px solid #e5e7eb;">`).join('')}</div></td></tr>` : '';
            await emailService.sendEmail({
                to: 'info@gsdhandymanservice.com',
                subject: `Portal Quote Request — ${service} — ${client.name} [${quoteNumber}]`,
                html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                    <h2 style="color:#667eea;">Client Portal Quote Request</h2>
                    <p style="background:#f0f4ff;padding:10px 14px;border-radius:6px;font-weight:700;color:#667eea;">Quote #: ${quoteNumber}</p>
                    <table style="width:100%;border-collapse:collapse;">
                        <tr><td style="padding:8px 0;font-weight:600;color:#374151;width:140px;">Client</td><td>${client.name}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:600;color:#374151;">Phone</td><td><a href="tel:${client.phone}">${client.phone}</a></td></tr>
                        ${client.email ? `<tr><td style="padding:8px 0;font-weight:600;color:#374151;">Email</td><td>${client.email}</td></tr>` : ''}
                        <tr><td style="padding:8px 0;font-weight:600;color:#374151;">Service</td><td>${service}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:600;color:#374151;">Priority</td><td>${priorityLabel}</td></tr>
                        ${serviceAddress ? `<tr><td style="padding:8px 0;font-weight:600;color:#374151;">Address</td><td>${serviceAddress}</td></tr>` : ''}
                        ${description ? `<tr><td style="padding:8px 0;font-weight:600;color:#374151;vertical-align:top;">Details</td><td>${description}</td></tr>` : ''}
                        ${photoHtml}
                    </table>
                </div>`,
                text: `Portal Quote Request [${quoteNumber}]\n\nClient: ${client.name}\nPhone: ${client.phone}\nService: ${service}\nPriority: ${priorityLabel}\n${serviceAddress ? 'Address: ' + serviceAddress + '\n' : ''}${description ? '\n' + description : ''}`
            });

            // Confirm receipt to the submitter (PM location contact or client email)
            const loc = serviceLocationId ? (client.serviceLocations || []).find(l => String(l.id) === String(serviceLocationId)) : null;
            const confirmEmail = loc?.contactEmail || client.email;
            const confirmName  = loc?.contact || client.name;
            if (confirmEmail) {
                await emailService.sendEmail({
                    to: confirmEmail,
                    subject: `Work Order Received — ${quoteNumber} — ${businessName}`,
                    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                        <div style="background:#667eea;color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
                            <h1 style="margin:0;font-size:1.4rem;">${businessName}</h1>
                        </div>
                        <div style="background:#f9f9f9;padding:30px;border:1px solid #ddd;border-radius:0 0 8px 8px;">
                            <p>Hi ${confirmName},</p>
                            <p>We've received your work order request and will review it shortly. Once we've priced it out, you'll get an email with the details and a link to approve.</p>
                            <p style="background:#f0f4ff;padding:10px 14px;border-radius:6px;"><strong>Reference #:</strong> ${quoteNumber}<br><strong>Service:</strong> ${service}<br><strong>Priority:</strong> ${priorityLabel}${serviceAddress ? `<br><strong>Address:</strong> ${serviceAddress}` : ''}</p>
                            <p>Questions? Reply to this email or call us directly.</p>
                        </div>
                        <div style="text-align:center;color:#888;font-size:12px;margin-top:20px;"><p>${businessName}</p></div>
                    </div>`,
                    text: `Hi ${confirmName},\n\nWe've received your work order request (${quoteNumber}) for: ${service}.\n\nOnce we price it out, you'll get an email to review and approve.\n\n— ${businessName}`
                });
            }
        }

        res.json({ success: true, quoteNumber, id: newQuoteId });
    } catch (e) {
        console.error('Portal quote request error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── Compliance / License & Insurance ─────────────────────────────────────────

// List all compliance docs (metadata only — no file data)
app.get('/api/compliance-docs', isAuthenticated, async (req, res) => {
    try {
        const docs = await db.collection('compliance_docs')
            .find({}, { projection: { data: 0 } })
            .sort({ uploadedAt: -1 })
            .toArray();
        res.json(docs.map(d => ({ ...d, _id: d._id.toString() })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Upload a compliance doc — store file in S3, metadata in MongoDB
app.post('/api/compliance-docs', isAuthenticated, async (req, res) => {
    try {
        const { type, expiresAt, notes, filename, mimeType, data } = req.body;
        if (!type || !filename || !data) return res.status(400).json({ error: 'type, filename, and data are required' });
        if (!s3Client) return res.status(503).json({ error: 'S3 not configured' });

        const fileBuffer = Buffer.from(data, 'base64');
        const s3Key = await uploadToS3(fileBuffer, filename, mimeType || 'application/octet-stream');

        const doc = {
            type,
            filename,
            mimeType: mimeType || 'application/octet-stream',
            s3Key,
            expiresAt: expiresAt ? new Date(expiresAt) : null,
            notes: notes || '',
            uploadedAt: new Date()
        };
        const result = await db.collection('compliance_docs').insertOne(doc);
        res.json({ id: result.insertedId.toString() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Download — redirect to a short-lived S3 signed URL
// Download — streams from S3 with Content-Disposition: attachment
app.get('/api/compliance-docs/:id/file', isAuthenticated, async (req, res) => {
    try {
        const doc = await db.collection('compliance_docs').findOne({ _id: new ObjectId(req.params.id) });
        if (!doc) return res.status(404).json({ error: 'Not found' });
        const s3Res = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: doc.s3Key }));
        res.setHeader('Content-Disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`);
        res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
        s3Res.Body.pipe(res);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Inline — streams from S3 with Content-Disposition: inline (same-origin, safe for iframe printing)
app.get('/api/compliance-docs/:id/inline', isAuthenticated, async (req, res) => {
    try {
        const doc = await db.collection('compliance_docs').findOne({ _id: new ObjectId(req.params.id) });
        if (!doc) return res.status(404).json({ error: 'Not found' });
        const s3Res = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: doc.s3Key }));
        res.setHeader('Content-Disposition', `inline; filename="${doc.filename.replace(/"/g, '')}"`);
        res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
        s3Res.Body.pipe(res);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// View — redirects to a short-lived signed URL so browser renders inline
app.get('/api/compliance-docs/:id/view', isAuthenticated, async (req, res) => {
    try {
        const doc = await db.collection('compliance_docs').findOne({ _id: new ObjectId(req.params.id) });
        if (!doc) return res.status(404).json({ error: 'Not found' });
        const url = await getS3SignedUrl(doc.s3Key, 300);
        res.redirect(url);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update metadata (type, expiry, notes) — file stays in S3 unchanged
app.patch('/api/compliance-docs/:id', isAuthenticated, async (req, res) => {
    try {
        const { type, expiresAt, notes } = req.body;
        const update = {};
        if (type !== undefined) update.type = type;
        if (expiresAt !== undefined) update.expiresAt = expiresAt ? new Date(expiresAt) : null;
        if (notes !== undefined) update.notes = notes;
        await db.collection('compliance_docs').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: update }
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete from S3 and MongoDB
app.delete('/api/compliance-docs/:id', isAuthenticated, async (req, res) => {
    try {
        const doc = await db.collection('compliance_docs').findOne({ _id: new ObjectId(req.params.id) });
        if (doc?.s3Key) await deleteFromS3(doc.s3Key).catch(() => {});
        await db.collection('compliance_docs').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Quote Templates ─────────────────────────────────────────────────────────
app.get('/api/quote-templates', isAuthenticated, async (req, res) => {
    try {
        const templates = await db.collection('quote_templates').find({}).sort({ createdAt: -1 }).toArray();
        res.json(templates.map(t => ({ ...t, id: t._id.toString() })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/quote-templates', isAuthenticated, async (req, res) => {
    try {
        const { name, laborItems, materialItems, description } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
        const result = await db.collection('quote_templates').insertOne({
            name: name.trim(), laborItems: laborItems || [], materialItems: materialItems || [],
            description: description || '', createdAt: new Date()
        });
        res.json({ id: result.insertedId.toString(), success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/quote-templates/:id', isAuthenticated, async (req, res) => {
    try {
        const { name, laborItems, materialItems, description } = req.body;
        await db.collection('quote_templates').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { name, laborItems, materialItems, description, updatedAt: new Date() } }
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/quote-templates/:id', isAuthenticated, async (req, res) => {
    try {
        await db.collection('quote_templates').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send compliance docs to a client — stream from S3 and attach to email
app.post('/api/compliance-docs/send-email', isAuthenticated, async (req, res) => {
    try {
        const { clientId, docIds, message, toEmail } = req.body;
        if (!clientId || !docIds || docIds.length === 0) return res.status(400).json({ error: 'clientId and docIds required' });

        const client = await db.collection('clients').findOne({ _id: new ObjectId(clientId) });
        if (!client) return res.status(404).json({ error: 'Client not found' });
        const sendTo = toEmail || client.email;
        if (!sendTo) return res.status(400).json({ error: 'Client has no email address on file' });
        if (!emailService.transporter) return res.status(503).json({ error: 'Email service not configured' });
        if (!s3Client) return res.status(503).json({ error: 'S3 not configured' });

        const oids = docIds.map(id => new ObjectId(id));
        const docs = await db.collection('compliance_docs').find({ _id: { $in: oids } }).toArray();

        // Stream each file from S3 into a buffer for the email attachment
        const attachments = await Promise.all(docs.map(async doc => {
            const cmd = new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: doc.s3Key });
            const s3Res = await s3Client.send(cmd);
            const chunks = [];
            for await (const chunk of s3Res.Body) chunks.push(chunk);
            return {
                filename: doc.filename,
                content: Buffer.concat(chunks),
                contentType: doc.mimeType || 'application/octet-stream'
            };
        }));

        const settings = await db.collection('settings').findOne({});
        const businessName = settings?.companyName || settings?.appName || 'GSD Property Services';

        const typeLabels = {
            license: 'License', gl_insurance: 'Insurance — General Liability',
            umbrella_insurance: 'Insurance — Umbrella', workers_comp: 'Workers Compensation',
            surety_bond: 'Surety Bond', other: 'Other'
        };
        const docList = docs.map(d => `<li>${typeLabels[d.type] || d.type}: ${d.filename}</li>`).join('');
        const customMsg = message ? `<p style="color:#4a5568;">${message}</p>` : '';

        await emailService.transporter.sendMail({
            from: `"${businessName}" <${emailService.fromEmail}>`,
            to: sendTo,
            subject: `${businessName} — License & Insurance Documents`,
            html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:2rem;">
                <h2 style="color:#667eea;">License & Insurance Documents</h2>
                <p>Hi ${client.name},</p>
                ${customMsg}
                <p>Please find the following documents attached:</p>
                <ul style="color:#4a5568;line-height:1.8;">${docList}</ul>
                <p style="color:#718096;font-size:0.85rem;margin-top:2rem;">— ${businessName}</p>
            </div>`,
            text: `License & Insurance Documents\n\nHi ${client.name},\n\n${message || ''}${message ? '\n\n' : ''}Documents attached:\n${docs.map(d => `- ${typeLabels[d.type] || d.type}: ${d.filename}`).join('\n')}\n\n— ${businessName}`,
            attachments
        });

        res.json({ success: true });
    } catch (e) {
        console.error('Compliance send-email error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── End Compliance ────────────────────────────────────────────────────────────

const fmt$ = n => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function getMaddoxContext() {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const weekEnd = new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0];
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [jobs, quotes, msgs, leads] = await Promise.all([
        db.collection('jobs').find({}).sort({ scheduledDate: -1 }).limit(100).toArray(),
        db.collection('quotes').find({}).sort({ createdAt: -1 }).limit(50).toArray(),
        db.collection('client_messages').find({ read: false }).toArray(),
        db.collection('leads').find({ status: 'new' }).toArray(),
    ]);

    const todayJobs = jobs.filter(j => j.scheduledDate === today);
    const weekJobs  = jobs.filter(j => j.scheduledDate >= today && j.scheduledDate <= weekEnd);
    const inProgress = jobs.filter(j => j.status === 'in_progress');
    const toSchedule = jobs.filter(j => j.status === 'to_be_scheduled' || j.status === 'prospecting');

    const outstanding = jobs.filter(j => {
        if (j.status !== 'invoiced' && j.status !== 'completed') return false;
        return (parseFloat(j.totalWithTax || j.total) || 0) - (parseFloat(j.totalPaid) || 0) > 0.01;
    });
    const outstandingTotal = outstanding.reduce((s, j) =>
        s + (parseFloat(j.totalWithTax || j.total) || 0) - (parseFloat(j.totalPaid) || 0), 0);

    const monthRevenue = jobs
        .filter(j => {
            if (j.status !== 'completed' && j.status !== 'invoiced') return false;
            return j.scheduledDate && new Date(j.scheduledDate) >= monthStart;
        })
        .reduce((s, j) => s + (parseFloat(j.totalWithTax || j.total) || 0), 0);

    const pendingQuotes  = quotes.filter(q => q.status === 'draft' || q.status === 'in_review');
    const approvedQuotes = quotes.filter(q => q.status === 'approved' && !q.convertedToJobId);

    const topOutstanding = [...outstanding]
        .sort((a, b) => ((parseFloat(b.totalWithTax||b.total)||0)-(parseFloat(b.totalPaid)||0)) - ((parseFloat(a.totalWithTax||a.total)||0)-(parseFloat(a.totalPaid)||0)))
        .slice(0, 3)
        .map(j => `${j.clientName||'?'} $${((parseFloat(j.totalWithTax||j.total)||0)-(parseFloat(j.totalPaid)||0)).toFixed(2)}`)
        .join(', ');

    return [
        `Date: ${today}`,
        `Jobs today: ${todayJobs.length} — ${todayJobs.map(j => `${j.title} (${j.clientName||'client'}, ${j.status})`).join('; ') || 'none'}`,
        `Jobs this week: ${weekJobs.length}`,
        `In progress: ${inProgress.length} — ${inProgress.map(j => j.title).join(', ') || 'none'}`,
        `Awaiting scheduling: ${toSchedule.length}`,
        `Outstanding invoices: ${outstanding.length} totalling $${outstandingTotal.toFixed(2)}`,
        `Top outstanding: ${topOutstanding || 'none'}`,
        `Revenue this month: $${monthRevenue.toFixed(2)}`,
        `Unread messages: ${msgs.length}`,
        `New leads: ${leads.length}`,
        `Pending quotes (draft/review): ${pendingQuotes.length}`,
        `Approved quotes awaiting conversion: ${approvedQuotes.length}`,
        '',
        'Recent jobs (last 15):',
        ...jobs.slice(0, 15).map(j => `  ${j.scheduledDate||'no date'} | ${j.title} | ${j.clientName||'?'} | ${j.status} | $${parseFloat(j.totalWithTax||j.total||0).toFixed(2)}`),
        '',
        'Recent quotes (last 8):',
        ...quotes.slice(0, 8).map(q => `  ${q.quoteNumber} | ${q.title} | ${q.clientName||'?'} | ${q.status} | $${parseFloat(q.total||0).toFixed(2)}`),
    ].join('\n');
}

app.get('/api/activity-log', isAuthenticated, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const events = [];

        // Flatten quote auditLog entries
        const quotes = await db.collection('quotes').find(
            { auditLog: { $exists: true, $ne: [] } },
            { projection: { quoteNumber: 1, title: 1, clientName: 1, clientId: 1, source: 1, total: 1, auditLog: 1 } }
        ).toArray();
        for (const q of quotes) {
            for (const e of (q.auditLog || [])) {
                events.push({
                    ts: new Date(e.timestamp),
                    type: 'quote',
                    action: e.action,
                    icon: e.action === 'approved' ? '✅' : e.action === 'rejected' ? '❌' : e.action === 'sent_email' ? '📧' : e.action === 'status_change' ? '🔄' : '📋',
                    title: `${q.source === 'portal' ? 'Work Order' : 'Quote'} #${q.quoteNumber} — ${q.title}`,
                    detail: e.note || e.action.replace(/_/g, ' '),
                    by: e.userName || '',
                    clientName: q.clientName || '',
                    clientId: q.clientId
                });
            }
        }

        // Portal quote submissions (source:portal, no auditLog entry for creation)
        const portalQuotes = await db.collection('quotes').find(
            { source: 'portal' },
            { projection: { quoteNumber: 1, title: 1, clientName: 1, clientId: 1, priority: 1, createdAt: 1 } }
        ).toArray();
        for (const q of portalQuotes) {
            events.push({
                ts: new Date(q.createdAt),
                type: 'portal_submission',
                action: 'submitted',
                icon: '📥',
                title: `Work Order #${q.quoteNumber} submitted — ${q.title}`,
                detail: q.priority ? `Priority: ${({urgent:'🔴 Urgent','1_day':'🟠 1 Day','3_days':'🟡 3 Days','1_week':'🟢 1 Week','2_weeks':'🔵 2 Weeks',flexible:'⚪ Flexible'}[q.priority] || q.priority)}` : 'Via client portal',
                by: q.clientName || '',
                clientName: q.clientName || '',
                clientId: q.clientId
            });
        }

        // Flatten job auditLog entries
        const jobs = await db.collection('jobs').find(
            { auditLog: { $exists: true, $ne: [] } },
            { projection: { title: 1, clientId: 1, totalWithTax: 1, total: 1, auditLog: 1 } }
        ).toArray();
        const clientCache = {};
        const getClientName = async (clientId) => {
            if (!clientId) return '';
            const key = clientId.toString();
            if (clientCache[key]) return clientCache[key];
            try {
                const c = await db.collection('clients').findOne({ _id: typeof clientId === 'string' ? new ObjectId(clientId) : clientId }, { projection: { name: 1 } });
                clientCache[key] = c?.name || '';
            } catch { clientCache[key] = ''; }
            return clientCache[key];
        };
        for (const j of jobs) {
            const cName = await getClientName(j.clientId);
            for (const e of (j.auditLog || [])) {
                events.push({
                    ts: new Date(e.timestamp),
                    type: 'job',
                    action: e.action,
                    icon: e.action === 'completed' ? '✅' : e.action === 'payment_recorded' ? '💰' : e.action === 'invoice_sent' ? '🧾' : '🔨',
                    title: `Job — ${j.title}`,
                    detail: e.note || e.action.replace(/_/g, ' '),
                    by: e.userName || '',
                    clientName: cName,
                    clientId: j.clientId
                });
            }
        }

        // Email logs
        const emails = await db.collection('email_logs').find({}).sort({ sentAt: -1 }).limit(50).toArray();
        for (const e of emails) {
            events.push({
                ts: new Date(e.sentAt),
                type: 'email',
                action: 'email_sent',
                icon: '📧',
                title: e.subject || 'Email sent',
                detail: `To: ${e.toName || e.to}`,
                by: e.sentBy || '',
                clientName: e.toName || '',
                clientId: null
            });
        }

        // Payments recorded (jobs with payments array)
        const paidJobs = await db.collection('jobs').find({ payments: { $exists: true, $ne: [] } }, { projection: { title: 1, clientId: 1, payments: 1 } }).toArray();
        for (const j of paidJobs) {
            const cName = await getClientName(j.clientId);
            for (const p of (j.payments || [])) {
                if (!p.date) continue;
                events.push({
                    ts: new Date(p.date),
                    type: 'payment',
                    action: 'payment_recorded',
                    icon: '💵',
                    title: `Payment — ${j.title}`,
                    detail: `${fmt$(p.amount)} via ${p.method || 'unknown'}${p.notes ? ' · ' + p.notes : ''}`,
                    by: '',
                    clientName: cName,
                    clientId: j.clientId
                });
            }
        }

        events.sort((a, b) => b.ts - a.ts);
        res.json(events.slice(0, limit).map(e => ({ ...e, ts: e.ts.toISOString(), clientId: e.clientId?.toString() || null })));
    } catch (err) {
        console.error('Activity log error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Activity Briefing ────────────────────────────────────────────────────────
app.get('/api/activity-brief', isAuthenticated, async (req, res) => {
    try {
        const since = req.session.briefingSince ? new Date(req.session.briefingSince) : null;
        const sinceFilter = since ? { $gt: since } : { $gt: new Date(Date.now() - 7 * 86400000) };

        const now = new Date();
        const weekFromNow = new Date(now.getTime() + 7 * 86400000);
        const todayStr = now.toISOString().split('T')[0];
        const weekStr  = weekFromNow.toISOString().split('T')[0];

        const [
            newPortalQuotes,
            quoteStatusChanges,
            newJobs,
            completedJobs,
            newMessages,
            newLeads,
            upcomingJobs,
            allJobs
        ] = await Promise.all([
            db.collection('quotes').find({ source: 'portal', status: 'draft', createdAt: sinceFilter }).toArray(),
            db.collection('quotes').find({ source: 'portal', status: { $ne: 'draft' }, updatedAt: sinceFilter }).toArray(),
            db.collection('jobs').find({ createdAt: sinceFilter }).toArray(),
            db.collection('jobs').find({ status: 'completed', updatedAt: sinceFilter }).toArray(),
            db.collection('client_messages').find({ createdAt: sinceFilter, read: false }).toArray(),
            db.collection('leads').find({ createdAt: sinceFilter }).toArray(),
            db.collection('jobs').find({ scheduledDate: { $gte: todayStr, $lte: weekStr }, status: { $in: ['scheduled', 'in_progress'] } }).sort({ scheduledDate: 1 }).limit(5).toArray(),
            db.collection('jobs').find({ status: { $in: ['invoiced', 'completed'] } }).toArray()
        ]);

        // Outstanding invoice total
        const outstanding = allJobs.reduce((sum, j) => {
            const total = parseFloat(j.totalWithTax || j.total) || 0;
            const paid  = parseFloat(j.totalPaid) || 0;
            return sum + Math.max(0, total - paid);
        }, 0);

        const sinceLabel = since
            ? (() => {
                const diff = Math.round((now - since) / 60000);
                if (diff < 60) return `${diff} minute${diff !== 1 ? 's' : ''} ago`;
                const hrs = Math.round(diff / 60);
                if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
                const days = Math.round(hrs / 24);
                return `${days} day${days !== 1 ? 's' : ''} ago`;
            })()
            : 'the last 7 days';

        // Resolve client names for jobs (jobs use clientId ref, not embedded clientName)
        const resolveJobName = async (job) => {
            if (job.clientName) return job.clientName;
            if (!job.clientId) return 'Unknown';
            try {
                const id = typeof job.clientId === 'string' ? new ObjectId(job.clientId) : job.clientId;
                const c = await db.collection('clients').findOne({ _id: id }, { projection: { name: 1 } });
                return c?.name || 'Unknown';
            } catch { return 'Unknown'; }
        };

        const [newJobsMapped, completedMapped, upcomingMapped] = await Promise.all([
            Promise.all(newJobs.map(async j => ({ id: j._id, title: j.title, clientName: await resolveJobName(j), scheduledDate: j.scheduledDate }))),
            Promise.all(completedJobs.map(async j => ({ id: j._id, title: j.title, clientName: await resolveJobName(j) }))),
            Promise.all(upcomingJobs.map(async j => ({ id: j._id, title: j.title, clientName: await resolveJobName(j), scheduledDate: j.scheduledDate })))
        ]);

        res.json({
            since: sinceLabel,
            newPortalQuotes:    newPortalQuotes.map(q => ({ id: q._id, quoteNumber: q.quoteNumber, title: q.title, clientName: q.clientName, priority: q.priority })),
            quoteStatusChanges: quoteStatusChanges.map(q => ({ id: q._id, quoteNumber: q.quoteNumber, title: q.title, clientName: q.clientName, status: q.status })),
            newJobs:            newJobsMapped,
            completedJobs:      completedMapped,
            newMessages:        newMessages.length,
            newLeads:           newLeads.length,
            upcomingJobs:       upcomingMapped,
            outstandingTotal:   outstanding
        });
    } catch (e) {
        console.error('Activity brief error:', e);
        res.status(500).json({ error: e.message });
    }
});

const MADDOX_TOOLS = [
    {
        name: 'search_jobs',
        description: 'Search jobs by client name or job title to identify the right job before making any changes.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Client name, job title, or keyword' }
            },
            required: ['query']
        }
    },
    {
        name: 'update_job_status',
        description: 'Queue a job status update for user confirmation. Always call search_jobs first to confirm the correct job.',
        input_schema: {
            type: 'object',
            properties: {
                job_id:     { type: 'string', description: 'MongoDB _id of the job' },
                new_status: { type: 'string', enum: ['prospecting','to_be_scheduled','scheduled','in_progress','completed','invoiced','bid_lost'] },
                job_title:  { type: 'string', description: 'Job title for the confirmation message' },
                client_name:{ type: 'string', description: 'Client name for the confirmation message' }
            },
            required: ['job_id', 'new_status', 'job_title']
        }
    },
    {
        name: 'add_job_note',
        description: 'Queue adding a touch point note to a job for user confirmation.',
        input_schema: {
            type: 'object',
            properties: {
                job_id:     { type: 'string', description: 'MongoDB _id of the job' },
                note:       { type: 'string', description: 'Note text to add' },
                job_title:  { type: 'string', description: 'Job title for the confirmation message' },
                client_name:{ type: 'string', description: 'Client name for the confirmation message' }
            },
            required: ['job_id', 'note', 'job_title']
        }
    }
];

app.post('/api/activity-query', isAuthenticated, async (req, res) => {
    try {
        if (!anthropic) return res.status(503).json({ answer: 'AI not configured.', items: [] });

        const { query } = req.body;
        if (!query || !query.trim()) return res.json({ answer: 'What can I help you with?', items: [] });

        if (!req.session.maddoxHistory) req.session.maddoxHistory = [];
        const history = req.session.maddoxHistory;
        const pending = req.session.maddoxPendingAction;

        // --- Confirmation / denial of a pending action ---
        const isYes = pending && /^\s*(yes|yep|yeah|yup|do it|confirm|go ahead|correct|sure|ok|okay|sounds good)\s*$/i.test(query.trim());
        const isNo  = pending && /^\s*(no|nope|cancel|stop|never mind|don't|dont|skip)\s*$/i.test(query.trim());

        if (isYes && pending) {
            let reply;
            try {
                const now = new Date();
                if (pending.type === 'update_job_status') {
                    const label = pending.new_status.replace(/_/g, ' ');
                    await db.collection('jobs').updateOne(
                        { _id: new ObjectId(pending.job_id) },
                        {
                            $set: { status: pending.new_status, updatedAt: now },
                            $push: { auditLog: { action: 'status_change', note: `Status set to "${label}" via Maddox`, timestamp: now.toISOString(), userName: 'Maddox (AI)' } }
                        }
                    );
                    reply = `✅ Done — **${pending.job_title}** is now **${label}**.`;
                } else if (pending.type === 'add_job_note') {
                    await db.collection('jobs').updateOne(
                        { _id: new ObjectId(pending.job_id) },
                        {
                            $push: { touchPoints: { id: now.getTime().toString(), text: pending.note, timestamp: now.toISOString(), author: 'Maddox (AI)' } },
                            $set: { updatedAt: now }
                        }
                    );
                    reply = `✅ Note added to **${pending.job_title}**.`;
                }
            } catch (e) {
                reply = `❌ Update failed: ${e.message}`;
            }
            req.session.maddoxPendingAction = null;
            history.push({ role: 'user', content: query });
            history.push({ role: 'assistant', content: reply });
            if (history.length > 20) req.session.maddoxHistory = history.slice(-20);
            return res.json({ answer: reply, items: [] });
        }

        if (isNo && pending) {
            req.session.maddoxPendingAction = null;
            const reply = 'Got it, cancelled. Anything else?';
            history.push({ role: 'user', content: query });
            history.push({ role: 'assistant', content: reply });
            if (history.length > 20) req.session.maddoxHistory = history.slice(-20);
            return res.json({ answer: reply, items: [] });
        }

        // Clear stale pending if user moved on
        if (pending) req.session.maddoxPendingAction = null;

        // --- Normal agentic Claude call ---
        const context = await getMaddoxContext();
        const systemPrompt = `You are Maddox, a loyal German Shepherd and business assistant for GSD Handyman Service in South Jersey. You help Cris run his business.

You can read live data AND update records. When updating:
1. Use search_jobs to find the right job first.
2. Call the update tool — it queues the action for confirmation.
3. Tell the user exactly what's pending and ask them to say "yes" or "cancel".

Rules:
- Be concise. **Bold** key names and statuses.
- A little dog personality is fine but keep it brief.
- Never invent data — only use what's in the context.
- Valid statuses: prospecting, to_be_scheduled, scheduled, in_progress, completed, invoiced, bid_lost

LIVE BUSINESS DATA:
${context}`;

        history.push({ role: 'user', content: query });
        let messages = history.map(h => ({ role: h.role, content: h.content }));
        let finalReply = '';

        // Agentic loop — up to 5 rounds of tool use
        for (let round = 0; round < 5; round++) {
            const response = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 600,
                system: systemPrompt,
                messages,
                tools: MADDOX_TOOLS
            });

            if (response.stop_reason === 'end_turn') {
                finalReply = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
                break;
            }

            if (response.stop_reason === 'tool_use') {
                const toolBlocks = response.content.filter(b => b.type === 'tool_use');
                const toolResults = [];

                for (const tb of toolBlocks) {
                    let result;
                    if (tb.name === 'search_jobs') {
                        const q = (tb.input.query || '').toLowerCase();
                        const [allJobs, allClients] = await Promise.all([
                            db.collection('jobs').find({}).project({ _id:1, title:1, status:1, clientId:1, scheduledDate:1 }).toArray(),
                            db.collection('clients').find({}).project({ _id:1, name:1, contactName:1 }).toArray()
                        ]);
                        const clientMap = {};
                        allClients.forEach(c => clientMap[c._id.toString()] = c.name || c.contactName || '');
                        const matched = allJobs.filter(j =>
                            (j.title||'').toLowerCase().includes(q) ||
                            (clientMap[j.clientId?.toString()]||'').toLowerCase().includes(q)
                        ).slice(0, 6).map(j => ({
                            id: j._id.toString(), title: j.title,
                            client: clientMap[j.clientId?.toString()] || 'Unknown',
                            status: j.status, scheduledDate: j.scheduledDate
                        }));
                        result = matched.length ? { found: true, jobs: matched } : { found: false, message: `No jobs found matching "${tb.input.query}"` };

                    } else if (tb.name === 'update_job_status') {
                        req.session.maddoxPendingAction = {
                            type: 'update_job_status',
                            job_id: tb.input.job_id,
                            new_status: tb.input.new_status,
                            job_title: tb.input.job_title,
                            client_name: tb.input.client_name || ''
                        };
                        result = { status: 'pending_confirmation', message: `Queued: set "${tb.input.job_title}" → ${tb.input.new_status}. Awaiting user confirmation.` };

                    } else if (tb.name === 'add_job_note') {
                        req.session.maddoxPendingAction = {
                            type: 'add_job_note',
                            job_id: tb.input.job_id,
                            note: tb.input.note,
                            job_title: tb.input.job_title,
                            client_name: tb.input.client_name || ''
                        };
                        result = { status: 'pending_confirmation', message: `Queued: add note to "${tb.input.job_title}". Awaiting user confirmation.` };
                    }

                    toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) });
                }

                messages.push({ role: 'assistant', content: response.content });
                messages.push({ role: 'user', content: toolResults });
            }
        }

        if (!finalReply) finalReply = 'Woof — I had trouble with that one. Try again?';

        history.push({ role: 'assistant', content: finalReply });
        if (history.length > 20) req.session.maddoxHistory = history.slice(-20);
        else req.session.maddoxHistory = history;

        return res.json({ answer: finalReply, items: [] });

    } catch (e) {
        console.error('Maddox AI error:', e.message);
        res.status(500).json({ answer: 'Woof — something went wrong. Try again!', items: [] });
    }
});

// Lightweight notification counts (messages + leads + expiring compliance docs)
app.get('/api/notifications/counts', isAuthenticated, async (req, res) => {
    try {
        const now = new Date();
        const warn30 = new Date(); warn30.setDate(warn30.getDate() + 30);
        const [messages, leads, expiringDocs, portalQuotes] = await Promise.all([
            db.collection('client_messages').countDocuments({ read: false }),
            db.collection('leads').countDocuments({ status: 'new' }),
            db.collection('compliance_docs').countDocuments({ expiresAt: { $ne: null, $lte: warn30 } }),
            db.collection('quotes').countDocuments({ status: 'draft', source: 'portal' })
        ]);
        res.json({ messages, leads, expiringDocs, portalQuotes });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Upsell suggestions — common labor items paired with similar jobs
app.get('/api/quotes/upsell-suggestions', isAuthenticated, async (req, res) => {
    try {
        const title = (req.query.title || '').toLowerCase().trim();
        if (title.length < 4) return res.json({ suggestions: [] });
        const keywords = title.split(' ').filter(w => w.length > 3).slice(0, 2);
        if (keywords.length === 0) return res.json({ suggestions: [] });
        const regex = new RegExp(keywords.join('|'), 'i');
        const jobs = await db.collection('jobs').find({ status: { $in: ['completed','invoiced'] }, title: { $regex: regex } }).toArray();
        if (jobs.length < 2) return res.json({ suggestions: [] });
        const itemCounts = {};
        for (const job of jobs) {
            const seen = new Set();
            for (const item of (job.laborItems || [])) {
                const desc = (item.description || '').trim();
                if (desc && !seen.has(desc)) { seen.add(desc); itemCounts[desc] = (itemCounts[desc]||0)+1; }
            }
        }
        const threshold = Math.max(2, Math.floor(jobs.length * 0.3));
        const suggestions = Object.entries(itemCounts)
            .filter(([,count]) => count >= threshold)
            .sort((a,b) => b[1]-a[1]).slice(0, 4)
            .map(([desc, count]) => ({ desc, pct: Math.round(count/jobs.length*100) }));
        res.json({ suggestions, jobCount: jobs.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Maddox nudges — proactive business health checks
app.get('/api/maddox/nudges', isAuthenticated, async (req, res) => {
    try {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const nudges = [];

        const [jobs, quotes, leads, clientsList] = await Promise.all([
            db.collection('jobs').find({}).toArray(),
            db.collection('quotes').find({ status: { $in: ['approved', 'draft', 'in_review'] }, convertedToJobId: { $exists: false } }).toArray(),
            db.collection('leads').find({ status: 'new' }).toArray(),
            db.collection('clients').find({}).toArray()
        ]);
        const clientMap = Object.fromEntries(clientsList.map(c => [c._id.toString(), c]));
        const TERMS_DAYS = { due_receipt: 0, net_15: 15, net_30: 30, net_45: 45, net_60: 60, net_90: 90 };

        // 1. Approved quotes sitting unconverted for 3+ days
        const staleApproved = quotes.filter(q => {
            if (q.status !== 'approved') return false;
            const converted = (q.auditLog || []).find(e => e.action === 'status_change' && e.newStatus === 'approved');
            const approvedAt = converted ? new Date(converted.timestamp) : new Date(q.createdAt);
            return (now - approvedAt) > 3 * 24 * 60 * 60 * 1000;
        });
        if (staleApproved.length === 1) {
            const q = staleApproved[0];
            const days = Math.floor((now - new Date(q.createdAt)) / (24 * 60 * 60 * 1000));
            nudges.push({ key: `stale_quote_${q._id}`, type: 'stale_quote', severity: 'warning',
                message: `${q.quoteNumber} has been approved for ${days} days — ready to convert to a job?` });
        } else if (staleApproved.length > 1) {
            nudges.push({ key: `stale_quotes_${staleApproved.length}`, type: 'stale_quote', severity: 'warning',
                message: `${staleApproved.length} approved quotes haven't been converted yet. Don't let them go cold.` });
        }

        // 2. Scheduled jobs this week with no crew assigned
        const weekOut = new Date(); weekOut.setDate(weekOut.getDate() + 7);
        const weekStr = weekOut.toISOString().split('T')[0];
        const unassigned = jobs.filter(j =>
            j.status === 'scheduled' && j.scheduledDate >= today && j.scheduledDate <= weekStr &&
            (!j.assignedTo || (Array.isArray(j.assignedTo) && j.assignedTo.length === 0))
        );
        if (unassigned.length > 0) {
            nudges.push({ key: `unassigned_${unassigned.length}_${today}`, type: 'unassigned_jobs', severity: 'warning',
                message: `${unassigned.length} job${unassigned.length > 1 ? 's' : ''} scheduled this week ${unassigned.length > 1 ? 'have' : 'has'} no crew assigned.` });
        }

        // 3. Jobs stuck in-progress for 3+ days
        const staleInProgress = jobs.filter(j => {
            if (j.status !== 'in_progress') return false;
            const since = j.statusChangedAt || j.scheduledDate || j.createdAt;
            return since && (now - new Date(since)) > 3 * 24 * 60 * 60 * 1000;
        });
        if (staleInProgress.length > 0) {
            nudges.push({ key: `stale_inprogress_${staleInProgress.length}_${today}`, type: 'stale_inprogress', severity: 'info',
                message: `${staleInProgress.length} job${staleInProgress.length > 1 ? 's have' : ' has'} been "In Progress" for 3+ days. Need a status update?` });
        }

        // 4. Overdue balances — respects client payment terms
        const bigOverdue = jobs.filter(j => {
            if (j.status !== 'invoiced' && j.status !== 'completed') return false;
            const balance = (j.totalWithTax || parseFloat(j.total) || 0) - (parseFloat(j.totalPaid) || 0);
            if (balance < 200) return false;
            const client = clientMap[j.clientId?.toString()];
            const terms = client?.paymentTerms;
            const td = TERMS_DAYS[terms];
            if (td !== undefined && j.invoicedAt) {
                // Has payment terms + invoice date — check if past due
                const dueDate = new Date(new Date(j.invoicedAt).getTime() + td * 86400000);
                return now > dueDate;
            }
            // Fallback: no terms set — flag after 30 days from invoicedAt or scheduledDate
            const since = j.invoicedAt || j.completedDate || j.scheduledDate;
            const fallbackThreshold = new Date(); fallbackThreshold.setDate(fallbackThreshold.getDate() - 30);
            return since && new Date(since) < fallbackThreshold;
        }).sort((a, b) => {
            const balA = (a.totalWithTax || parseFloat(a.total) || 0) - (parseFloat(a.totalPaid) || 0);
            const balB = (b.totalWithTax || parseFloat(b.total) || 0) - (parseFloat(b.totalPaid) || 0);
            return balB - balA;
        });
        if (bigOverdue.length > 0) {
            const top = bigOverdue[0];
            const topClient = clientMap[top.clientId?.toString()];
            const bal = ((top.totalWithTax || parseFloat(top.total) || 0) - (parseFloat(top.totalPaid) || 0)).toFixed(2);
            const terms = topClient?.paymentTerms ? ` (${topClient.paymentTerms.replace('_',' ')})` : ' (30+ days)';
            nudges.push({ key: `overdue_${top._id}`, type: 'overdue_invoice', severity: 'urgent',
                message: `$${bal} overdue for "${top.title}"${terms} — time to follow up?` });
        }

        // 5. Cold leads — no touchpoint in 7+ days
        const coldLeads = leads.filter(l => {
            const tps = l.touchPoints || [];
            if (tps.length === 0) {
                return (now - new Date(l.createdAt)) > 7 * 24 * 60 * 60 * 1000;
            }
            const lastTp = Math.max(...tps.map(tp => new Date(tp.timestamp)));
            return (now - lastTp) > 7 * 24 * 60 * 60 * 1000;
        });
        if (coldLeads.length > 0) {
            nudges.push({ key: `cold_leads_${coldLeads.length}_${today}`, type: 'cold_leads', severity: 'info',
                message: `${coldLeads.length} lead${coldLeads.length > 1 ? 's haven\'t' : ' hasn\'t'} been touched in 7+ days. Don't let them go cold.` });
        }

        // 5b. Sent quotes with no response in 3+ days
        const staleSent = quotes.filter(q => {
            if (q.status === 'approved' || q.status === 'rejected') return false;
            const sentEntry = (q.auditLog || [])
                .filter(e => e.action === 'sent_email')
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
            if (!sentEntry) return false;
            return (now - new Date(sentEntry.timestamp)) > 3 * 24 * 60 * 60 * 1000;
        });
        if (staleSent.length === 1) {
            nudges.push({ key: `stale_sent_${staleSent[0]._id}`, type: 'stale_sent', severity: 'info',
                message: `${staleSent[0].quoteNumber} was sent ${Math.floor((now - new Date((staleSent[0].auditLog||[]).filter(e=>e.action==='sent_email').slice(-1)[0]?.timestamp)) / 86400000)}d ago with no response — time to follow up?` });
        } else if (staleSent.length > 1) {
            nudges.push({ key: `stale_sent_${staleSent.length}_${today}`, type: 'stale_sent', severity: 'info',
                message: `${staleSent.length} sent quotes haven't gotten a response in 3+ days.` });
        }

        // 6. Today's scheduled jobs still showing 'scheduled' after 10am
        if (now.getHours() >= 10) {
            const todayUnstarted = jobs.filter(j => j.status === 'scheduled' && j.scheduledDate === today);
            if (todayUnstarted.length > 0) {
                nudges.push({ key: `today_unstarted_${today}`, type: 'today_unstarted', severity: 'info',
                    message: `${todayUnstarted.length} job${todayUnstarted.length > 1 ? 's' : ''} scheduled for today ${todayUnstarted.length > 1 ? 'are' : 'is'} still showing "Scheduled" — are they underway?` });
            }
        }

        // 7. Seasonal outreach — same month last year had a job cluster
        const lyDate = new Date(); lyDate.setFullYear(lyDate.getFullYear()-1); lyDate.setDate(1);
        const lyKey = lyDate.toISOString().slice(0,7);
        const lyJobs = jobs.filter(j => j.scheduledDate && j.scheduledDate.startsWith(lyKey) && (j.status==='completed'||j.status==='invoiced'));
        if (lyJobs.length >= 2) {
            const lyGroups = {};
            for (const j of lyJobs) { const k=(j.title||'').toLowerCase().trim(); lyGroups[k]=(lyGroups[k]||0)+1; }
            const topLy = Object.entries(lyGroups).sort((a,b)=>b[1]-a[1])[0];
            if (topLy && topLy[1] >= 2) {
                const monthName = lyDate.toLocaleString('default',{month:'long'});
                nudges.push({ key:`seasonal_${lyKey}_${topLy[0].slice(0,15).replace(/\s+/g,'_')}`, type:'seasonal_outreach', severity:'info',
                    message:`Last ${monthName} you did ${topLy[1]} "${topLy[0]}" jobs — time to reach out to those clients for this year?` });
            }
        }

        // 8. Quote comparison — client re-quoted for similar service within 12 months
        const recentDrafts = await db.collection('quotes').find({ status: { $in: ['draft','in_review'] }, createdAt: { $gte: new Date(Date.now() - 7*86400000) } }).limit(10).toArray();
        for (const draft of recentDrafts) {
            if (!draft.clientId || !draft.title) continue;
            const keyword = (draft.title.split(' ')[0]||'').trim();
            if (keyword.length < 4) continue;
            const prior = await db.collection('quotes').findOne({
                clientId: draft.clientId,
                _id: { $ne: draft._id },
                status: { $in: ['approved','rejected'] },
                title: { $regex: new RegExp(keyword,'i') },
                createdAt: { $gte: new Date(Date.now() - 365*86400000) }
            });
            if (prior) {
                const daysAgo = Math.floor((now-new Date(prior.createdAt))/86400000);
                nudges.push({ key:`requote_${draft._id}`, type:'quote_comparison', severity:'info',
                    message:`${draft.clientName||'A client'} was quoted "${prior.title}" ${daysAgo}d ago (${prior.quoteNumber} · ${fmt$(parseFloat(prior.total||0))}) — check if pricing still applies.` });
                break;
            }
        }

        res.json({ nudges });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/maddox/clear-history', isAuthenticated, (req, res) => {
    req.session.maddoxHistory = [];
    res.json({ ok: true });
});

// Maddox AI nudges — Claude analyzes live data and surfaces proactive insights
app.get('/api/maddox/ai-nudges', isAuthenticated, async (req, res) => {
    try {
        if (!anthropic) return res.json({ nudges: [] });

        const now = Date.now();
        if (req.session.aiNudgeCache && (now - req.session.aiNudgeCache.at) < 60 * 60 * 1000) {
            return res.json({ nudges: req.session.aiNudgeCache.nudges });
        }

        const context = await getMaddoxContext();
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            system: `You are Maddox, a business assistant for a handyman/property services company in South Jersey. Analyze the business snapshot and identify 2-3 of the most important things the owner should act on TODAY. Each nudge must be a single actionable sentence under 120 characters. Reply ONLY with a valid JSON array: [{"message":"...","severity":"urgent|warning|info"}]`,
            messages: [{ role: 'user', content: `Business snapshot:\n\n${context}\n\nWhat should I focus on today?` }],
        });

        let nudges = [];
        try {
            const text = response.content[0]?.text || '[]';
            const match = text.match(/\[[\s\S]*\]/);
            nudges = match ? JSON.parse(match[0]) : [];
        } catch { nudges = []; }

        const today = new Date().toISOString().split('T')[0];
        nudges = nudges.slice(0, 3).map((n, i) => ({ ...n, key: `ai_nudge_${today}_${i}`, type: 'ai' }));

        req.session.aiNudgeCache = { at: now, nudges };
        res.json({ nudges });
    } catch (e) {
        console.error('AI nudge error:', e.message);
        res.json({ nudges: [] });
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
            read: msg.read || false,
            archived: msg.archived || false
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

// Admin Messages API - Archive message
app.post('/api/client-messages/:id/archive', isAuthenticated, async (req, res) => {
    try {
        const messageId = new ObjectId(req.params.id);
        const { archived } = req.body;
        await db.collection('client_messages').updateOne(
            { _id: messageId },
            { $set: { archived: archived !== false, read: true } }
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Archive message error:', error);
        res.status(500).json({ error: 'Failed to archive message' });
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

// Pay invoice via Clover — no auth required, anyone with the invoice link can pay
app.post('/api/client-portal/pay', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
    const logFail = async (jobObjId, errCode, errMsg) => {
        try {
            await db.collection('payment_attempts').insertOne({
                jobId: jobObjId || null,
                at: new Date(), ip,
                amount: parseFloat(req.body.amount) || 0,
                success: false,
                errorCode: errCode,
                error: errMsg
            });
        } catch (_) {}
    };

    try {
        const { jobId, amount, token, saveCard } = req.body;
        const amountCents = Math.round(parseFloat(amount) * 100);

        if (!token) {
            await logFail(null, 'no_token', 'Clover did not return a card token — API key may be invalid');
            return res.status(400).json({ error: 'Card tokenization failed. Please check card details and try again.' });
        }
        if (!jobId || isNaN(amountCents) || amountCents < 50) {
            return res.status(400).json({ error: 'Invalid payment details.' });
        }

        let job;
        try { job = await db.collection('jobs').findOne({ _id: new ObjectId(jobId) }); }
        catch (e) { return res.status(400).json({ error: 'Invalid job ID.' }); }
        if (!job) return res.status(404).json({ error: 'Invoice not found.' });

        const attemptBase = { jobId: job._id, at: new Date(), amount: parseFloat(amount), ip };

        // If saveCard: create Clover customer first (consumes token), then charge by customer ID
        let cloverCustomerId = null;
        let savedClientId = null;
        if (saveCard && job.clientId) {
            try {
                const client = await db.collection('clients').findOne({ _id: job.clientId });
                const custRes = await fetch('https://scl.clover.com/v1/customers', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.CLOVER_API_KEY}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-Clover-Merchant-Id': process.env.CLOVER_MERCHANT_ID
                    },
                    body: JSON.stringify({ source: token, name: client?.name || 'Customer', email: client?.email || '' })
                });
                const custData = await custRes.json();
                if (custData.id) {
                    cloverCustomerId = custData.id;
                    savedClientId = job.clientId;
                } else {
                    console.error('Clover customer creation failed:', JSON.stringify(custData));
                }
            } catch (e) {
                console.error('Clover customer creation error:', e);
                // Fall through — charge with token below
            }
        }

        const chargeSource = cloverCustomerId
            ? { source: cloverCustomerId }
            : { source: token };

        const chargeRes = await fetch(`https://scl.clover.com/v1/charges`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.CLOVER_API_KEY}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Clover-Merchant-Id': process.env.CLOVER_MERCHANT_ID
            },
            body: JSON.stringify({ amount: amountCents, currency: 'USD', ...chargeSource })
        });

        const rawText = await chargeRes.text();
        console.error('Clover HTTP', chargeRes.status, rawText);
        let charge = {};
        try { charge = JSON.parse(rawText); } catch (_) {}
        if (!chargeRes.ok) {
            const errDetail = rawText || String(chargeRes.status);
            await db.collection('payment_attempts').insertOne({
                ...attemptBase,
                success: false,
                errorCode: charge.error?.code || charge.code || String(chargeRes.status),
                error: errDetail
            });
            return res.status(400).json({ error: errDetail });
        }

        const last4 = charge.source?.last4 || charge.paymentToken?.last4 || null;
        const cardBrand = charge.source?.brand || charge.paymentToken?.brand || null;

        await db.collection('payment_attempts').insertOne({
            ...attemptBase,
            success: true,
            chargeId: charge.id,
            last4,
            cardBrand
        });

        const newPayment = {
            id: Date.now(),
            date: new Date().toISOString().split('T')[0],
            amount: parseFloat(amount),
            method: 'credit_card',
            last4,
            cardBrand,
            notes: `Online payment — Clover ${charge.id}${last4 ? ` ••••${last4}` : ''}`
        };

        // Recalculate denormalized totals so dashboard/reports/AR stay current
        const existingPaid = (job.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
        const newTotalPaid = existingPaid + parseFloat(amount);
        const jobTotal = job.totalWithTax || parseFloat(job.total) || 0;
        const newBalanceOwed = Math.max(0, jobTotal - newTotalPaid);

        const invoiceSetFields = {
            totalPaid: newTotalPaid,
            balanceOwed: newBalanceOwed,
            updatedAt: new Date()
        };
        if (newBalanceOwed <= 0 && job.status !== 'completed') {
            invoiceSetFields.status = 'completed';
        }

        await db.collection('jobs').updateOne(
            { _id: job._id },
            { $push: { payments: newPayment }, $set: invoiceSetFields }
        );

        // Persist saved card info to client record
        if (cloverCustomerId && savedClientId) {
            try {
                await db.collection('clients').updateOne(
                    { _id: savedClientId },
                    { $set: { cloverCustomerId, cloverCardLast4: last4, cloverCardBrand: cardBrand, cloverCardSavedAt: new Date() } }
                );
            } catch (e) { console.error('Failed to save cloverCustomerId to client:', e); }
        }

        // Inbox notification
        try {
            const client = job.clientId ? await db.collection('clients').findOne({ _id: job.clientId }) : null;
            const cardDesc = last4 ? ` (${cardBrand || 'card'} ••••${last4})` : '';
            await db.collection('client_messages').insertOne({
                clientId: job.clientId || null,
                clientName: client?.name || 'Client',
                clientEmail: client?.email || '',
                message: `💳 Client paid $${parseFloat(amount).toFixed(2)} online for "${job.title}"${cardDesc}.`,
                subject: 'payment',
                reference: job.title,
                createdAt: new Date(),
                read: false
            });
        } catch (e) { console.error('Invoice payment inbox message error:', e.message); }

        res.json({ success: true, chargeId: charge.id, cardSaved: !!cloverCustomerId });
    } catch (e) {
        console.error('Clover payment error:', e);
        try {
            const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
            await db.collection('payment_attempts').insertOne({
                jobId: req.body.jobId || null,
                at: new Date(), ip,
                amount: parseFloat(req.body.amount) || 0,
                success: false,
                errorCode: 'server_error',
                error: e.message
            });
        } catch (_) {}
        res.status(500).json({ error: 'Payment processing failed.' });
    }
});

// ── Deposit Requests ────────────────────────────────────────────────────────

app.post('/api/jobs/:id/send-deposit', isAuthenticated, async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid deposit amount' });

        let job;
        try { job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.id) }); }
        catch (e) { return res.status(400).json({ error: 'Invalid job ID' }); }
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const client = job.clientId ? await db.collection('clients').findOne({ _id: new ObjectId(job.clientId) }) : null;
        const settings = await db.collection('settings').findOne() || {};
        const companyName = settings.appName || 'GSD Property Services';

        // Resolve email same way as invoice
        let toEmail = client?.email;
        if (job.serviceLocationId && client?.serviceLocations) {
            const loc = client.serviceLocations.find(l => String(l.id) === String(job.serviceLocationId));
            if (loc?.contactEmail) toEmail = loc.contactEmail;
        }
        if (!toEmail) return res.status(400).json({ error: 'No email address for this client' });

        const depositToken = crypto.randomUUID();
        const depositAmount = parseFloat(amount);
        const depositUrl = `${process.env.APP_URL}/deposit/${depositToken}`;

        await db.collection('jobs').updateOne(
            { _id: job._id },
            { $set: { deposit: { token: depositToken, amount: depositAmount, status: 'pending', sentAt: new Date() }, updatedAt: new Date() } }
        );

        const _depLogId = new ObjectId();
        const _depTrackUrl = `${process.env.APP_URL}/api/email-track/${_depLogId}`;

        const _depHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;">
                <h2 style="color:#667eea;">${companyName}</h2>
                <p>Hi ${client?.name || 'there'},</p>
                <p>To secure your upcoming job, a deposit is required:</p>
                <table style="border-collapse:collapse;margin:1rem 0;width:100%;">
                    <tr><td style="padding:0.5rem;font-weight:600;">Job:</td><td style="padding:0.5rem;">${job.title}</td></tr>
                    <tr><td style="padding:0.5rem;font-weight:600;">Deposit Amount:</td><td style="padding:0.5rem;font-size:1.2rem;font-weight:700;color:#667eea;">$${depositAmount.toFixed(2)}</td></tr>
                </table>
                <div style="text-align:center;margin:2rem 0;">
                    <a href="${depositUrl}" style="display:inline-block;background:#667eea;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">Pay Deposit Now</a>
                </div>
                <p style="color:#718096;font-size:0.85rem;">This secures your spot on our schedule. Thank you!</p>
                <p style="color:#718096;font-size:0.85rem;">${companyName}</p>
                <img src="${_depTrackUrl}" width="1" height="1" style="display:none" alt="">
            </div>`;
        await emailService.sendEmail({
            to: toEmail,
            subject: `Deposit Request — ${job.title} — ${companyName}`,
            html: _depHtml,
            text: `Deposit request for "${job.title}"\nAmount: $${depositAmount.toFixed(2)}\nPay here: ${depositUrl}`
        });

        await db.collection('email_logs').insertOne({
            _id: _depLogId,
            type: 'deposit',
            to: toEmail,
            toName: client?.name || '',
            subject: `Deposit Request — ${job.title} — ${companyName}`,
            trigger: `Deposit of $${depositAmount.toFixed(2)} requested for "${job.title}"`,
            relatedId: job._id,
            relatedTitle: job.title,
            htmlBody: _depHtml,
            sentBy: req.session.userName || 'admin',
            sentAt: new Date(),
            status: 'sent',
            opened: false
        });

        res.json({ success: true, depositUrl });
    } catch (e) {
        console.error('Send deposit error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/deposit/:token', async (req, res) => {
    const job = await db.collection('jobs').findOne({ 'deposit.token': req.params.token });
    if (!job) return res.status(404).send('<h2>Deposit link not found or expired.</h2>');

    const settings = await db.collection('settings').findOne() || {};
    const companyName = settings.appName || 'GSD Property Services';
    const deposit = job.deposit;
    const isPaid = deposit.status === 'paid';
    const oooBanner = await getOOOBanner();
    const feePercent = parseFloat(settings.cloverFeePercent) || 0;
    const feeAmount = feePercent > 0 ? deposit.amount * (feePercent / 100) : 0;
    const depositTotal = deposit.amount + feeAmount;

    res.send(`<!DOCTYPE html><html lang="en"><head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Deposit — ${companyName}</title>
        <style>
            *{margin:0;padding:0;box-sizing:border-box;}
            body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;}
            .card{background:white;border-radius:16px;max-width:460px;width:100%;box-shadow:0 20px 50px rgba(0,0,0,0.2);overflow:hidden;}
            .header{background:linear-gradient(135deg,#667eea,#764ba2);padding:1.5rem 2rem;color:white;}
            .header h1{font-size:1.3rem;margin-bottom:0.25rem;}
            .header p{opacity:0.85;font-size:0.9rem;}
            .body{padding:1.75rem 2rem;}
            .amount{font-size:2.5rem;font-weight:700;color:#667eea;margin:1rem 0;}
            .job-name{color:#4a5568;margin-bottom:1.5rem;}
            .paid-box{background:#c6f6d5;border:2px solid #48bb78;border-radius:12px;padding:1.5rem;text-align:center;}
            .paid-box h2{color:#22543d;font-size:1.4rem;}
            .clover-field{height:46px;border:1.5px solid #e2e8f0;border-radius:8px;background:#f8fafc;overflow:hidden;display:flex;align-items:center;margin-bottom:1rem;}
            .clover-field iframe{width:100%!important;height:46px!important;border:none!important;display:block;}
            .pay-row{display:grid;grid-template-columns:1fr 1fr;gap:0.875rem;}
            #payError{display:none;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:0.65rem 0.875rem;border-radius:8px;font-size:0.85rem;margin-bottom:1rem;}
            .btn{width:100%;height:48px;background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;border-radius:8px;font-weight:700;font-size:1rem;cursor:pointer;margin-top:0.5rem;}
            .btn:disabled{opacity:0.6;cursor:not-allowed;}
            .secure{text-align:center;font-size:0.75rem;color:#94a3b8;margin-top:1rem;}
        </style>
    </head><body>${oooBanner}
    <div class="card">
        <div class="header">
            <h1>${companyName}</h1>
            <p>Deposit Payment</p>
        </div>
        <div class="body">
            <div class="job-name"><strong>${job.title}</strong></div>
            ${isPaid ? `
            <div class="amount">$${deposit.amount.toFixed(2)}</div>
            <div class="paid-box">
                <div style="font-size:2rem;margin-bottom:0.5rem;">✅</div>
                <h2>Deposit Paid!</h2>
                <p style="color:#276749;margin-top:0.5rem;">Thank you — you're all set.</p>
            </div>` : `
            ${feePercent > 0 ? `
            <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.25rem;">
                <div style="display:flex;justify-content:space-between;font-size:0.9rem;color:#4a5568;margin-bottom:0.4rem;">
                    <span>Deposit amount</span><span>$${deposit.amount.toFixed(2)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:0.9rem;color:#4a5568;margin-bottom:0.6rem;padding-bottom:0.6rem;border-bottom:1px solid #e2e8f0;">
                    <span>Processing fee (${feePercent}%)</span><span>$${feeAmount.toFixed(2)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;font-weight:700;color:#1a202c;font-size:1rem;">
                    <span>Total charged</span><span>$${depositTotal.toFixed(2)}</span>
                </div>
                <p style="font-size:0.75rem;color:#94a3b8;margin-top:0.6rem;line-height:1.4;">Credit card processing fees are collected by Clover and are non-refundable.</p>
            </div>` : `<div class="amount">$${deposit.amount.toFixed(2)}</div>`}
            <div id="payError"></div>
            <label style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;display:block;margin-bottom:0.35rem;">Card Number</label>
            <div id="card-number" class="clover-field"></div>
            <div class="pay-row">
                <div>
                    <label style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;display:block;margin-bottom:0.35rem;">Expiry</label>
                    <div id="card-date" class="clover-field"></div>
                </div>
                <div>
                    <label style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;display:block;margin-bottom:0.35rem;">CVV</label>
                    <div id="card-cvv" class="clover-field"></div>
                </div>
            </div>
            <label style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;display:block;margin-bottom:0.35rem;">ZIP Code</label>
            <div id="card-postal-code" class="clover-field"></div>
            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-size:0.85rem;color:#4a5568;margin:0.75rem 0;">
                <input type="checkbox" id="saveCardCheckbox" checked style="width:15px;height:15px;accent-color:#667eea;cursor:pointer;flex-shrink:0;">
                Save card for future payments
            </label>
            <button class="btn" id="payBtn" onclick="submitDeposit()">Pay $${depositTotal.toFixed(2)} Deposit</button>
            <div class="secure">🔒 Secure payment via Clover</div>
            <script src="https://checkout.clover.com/sdk.js"></script>
            <script>
                var clover = new Clover('${process.env.CLOVER_PUBLIC_KEY}', { merchantId: '${process.env.CLOVER_MERCHANT_ID}' });
                var elems = clover.elements();
                elems.create('CARD_NUMBER').mount('#card-number');
                elems.create('CARD_DATE').mount('#card-date');
                elems.create('CARD_CVV').mount('#card-cvv');
                elems.create('CARD_POSTAL_CODE').mount('#card-postal-code');

                async function submitDeposit() {
                    var btn = document.getElementById('payBtn');
                    var errDiv = document.getElementById('payError');
                    errDiv.style.display = 'none';
                    btn.disabled = true;
                    btn.textContent = 'Processing...';
                    try {
                        var result = await clover.createToken();
                        if (!result.token) { errDiv.textContent = 'Card error: ' + (result.errors ? Object.values(result.errors).join(', ') : 'Please check your card details'); errDiv.style.display='block'; btn.disabled=false; btn.textContent='Pay $${deposit.amount.toFixed(2)} Deposit'; return; }
                        var saveCard = document.getElementById('saveCardCheckbox')?.checked !== false;
                        var resp = await fetch('/api/deposit/pay', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token: result.token, depositToken: '${deposit.token}', saveCard: saveCard }) });
                        var data = await resp.json();
                        if (!resp.ok) { errDiv.textContent = data.error || 'Payment failed'; errDiv.style.display='block'; btn.disabled=false; btn.textContent='Pay $${deposit.amount.toFixed(2)} Deposit'; return; }
                        document.querySelector('.body').innerHTML = '<div class="paid-box"><div style="font-size:2.5rem;margin-bottom:0.5rem;">✅</div><h2>Deposit Paid!</h2><p style="color:#276749;margin-top:0.5rem;">Thank you — you\\'re all set.</p></div>';
                    } catch(e) { errDiv.textContent = 'An error occurred. Please try again.'; errDiv.style.display='block'; btn.disabled=false; btn.textContent='Pay $${deposit.amount.toFixed(2)} Deposit'; }
                }
            </script>`}
        </div>
    </div>
    </body></html>`);
});

app.post('/api/deposit/pay', async (req, res) => {
    try {
        const { token, depositToken, saveCard } = req.body;
        if (!token || !depositToken) return res.status(400).json({ error: 'Missing payment details' });

        const job = await db.collection('jobs').findOne({ 'deposit.token': depositToken });
        if (!job) return res.status(404).json({ error: 'Deposit request not found' });
        if (job.deposit.status === 'paid') return res.status(400).json({ error: 'Deposit already paid' });

        const amount = job.deposit.amount;
        const amountCents = Math.round(amount * 100);

        // If saveCard: create Clover customer first (consumes token), then charge by customer ID
        let cloverCustomerId = null;
        let savedClientId = null;
        if (saveCard && job.clientId) {
            try {
                const client = await db.collection('clients').findOne({ _id: job.clientId });
                const custRes = await fetch('https://scl.clover.com/v1/customers', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.CLOVER_API_KEY}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-Clover-Merchant-Id': process.env.CLOVER_MERCHANT_ID
                    },
                    body: JSON.stringify({ source: token, name: client?.name || 'Customer', email: client?.email || '' })
                });
                const custData = await custRes.json();
                if (custData.id) {
                    cloverCustomerId = custData.id;
                    savedClientId = job.clientId;
                } else {
                    console.error('Clover customer creation (deposit) failed:', JSON.stringify(custData));
                }
            } catch (e) {
                console.error('Clover customer creation (deposit) error:', e);
            }
        }

        const chargeSource = cloverCustomerId
            ? { source: cloverCustomerId }
            : { source: token };

        const chargeRes = await fetch('https://scl.clover.com/v1/charges', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.CLOVER_API_KEY}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Clover-Merchant-Id': process.env.CLOVER_MERCHANT_ID
            },
            body: JSON.stringify({ amount: amountCents, currency: 'USD', ...chargeSource })
        });

        const rawText = await chargeRes.text();
        let charge = {};
        try { charge = JSON.parse(rawText); } catch (_) {}
        if (!chargeRes.ok) return res.status(400).json({ error: charge.error?.message || rawText });

        const last4 = charge.source?.last4 || charge.paymentToken?.last4 || null;
        const cardBrand = charge.source?.brand || charge.paymentToken?.brand || null;

        const newPayment = {
            id: Date.now(),
            date: new Date().toISOString().split('T')[0],
            amount,
            method: 'credit_card',
            last4,
            cardBrand,
            notes: `Deposit payment — Clover ${charge.id}${last4 ? ` ••••${last4}` : ''}`
        };

        const existingPaid = (job.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
        const newTotalPaid = existingPaid + amount;
        const jobTotal = parseFloat(job.totalWithTax || job.total) || 0;
        const newBalanceOwed = Math.max(0, jobTotal - newTotalPaid);

        const depositSetFields = {
            'deposit.status': 'paid',
            'deposit.paidAt': new Date(),
            'deposit.chargeId': charge.id,
            totalPaid: newTotalPaid,
            balanceOwed: newBalanceOwed,
            updatedAt: new Date()
        };
        if (newBalanceOwed <= 0 && job.status !== 'completed') {
            depositSetFields.status = 'completed';
        }

        await db.collection('jobs').updateOne(
            { _id: job._id },
            { $push: { payments: newPayment }, $set: depositSetFields }
        );

        // Drop a message in the inbox
        try {
            const depositClient = job.clientId ? await db.collection('clients').findOne({ _id: job.clientId }) : null;
            const cardDesc = last4 ? ` (${cardBrand || 'card'} ••••${last4})` : '';
            await db.collection('client_messages').insertOne({
                clientId: job.clientId || null,
                clientName: depositClient?.name || 'Client',
                clientEmail: depositClient?.email || '',
                message: `Deposit of $${amount.toFixed(2)} received for "${job.title}"${cardDesc}.`,
                subject: 'deposit',
                reference: job.title,
                createdAt: new Date(),
                read: false
            });
        } catch (e) { console.error('Deposit inbox message error:', e.message); }

        // Persist saved card info to client record
        if (cloverCustomerId && savedClientId) {
            try {
                await db.collection('clients').updateOne(
                    { _id: savedClientId },
                    { $set: { cloverCustomerId, cloverCardLast4: last4, cloverCardBrand: cardBrand, cloverCardSavedAt: new Date() } }
                );
            } catch (e) { console.error('Failed to save cloverCustomerId to client (deposit):', e); }
        }

        // Notify owner that deposit was received
        try {
            const settings = await db.collection('settings').findOne({});
            const companyName = settings?.companyName || 'GSD Handyman Service';
            const notifyEmail = settings?.companyEmail || process.env.SES_FROM_EMAIL;
            const notifyPhone = settings?.companyPhone;
            const client = job.clientId ? await db.collection('clients').findOne({ _id: job.clientId }) : null;
            const clientName = client?.name || 'Client';
            const appUrl = process.env.APP_URL || 'https://app.gsdhandymanservice.com';
            const cardDesc = last4 ? ` (${cardBrand || 'card'} ••••${last4})` : '';
            const paidAt = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

            if (notifyEmail && emailService.initialized) {
                await emailService.sendEmail({
                    to: notifyEmail,
                    subject: `💳 Deposit received — ${job.title} — $${amount.toFixed(2)}`,
                    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#222;max-width:520px;margin:0 auto;padding:20px;">
                        <h2 style="color:#667eea;margin-bottom:0.25rem;">💳 Deposit Received</h2>
                        <p style="color:#718096;margin-top:0.25rem;">${paidAt}</p>
                        <table style="width:100%;border-collapse:collapse;margin:1rem 0;">
                            <tr><td style="padding:0.4rem 0;color:#718096;">Client</td><td style="padding:0.4rem 0;font-weight:600;">${clientName}</td></tr>
                            <tr><td style="padding:0.4rem 0;color:#718096;">Job</td><td style="padding:0.4rem 0;font-weight:600;">${job.title}</td></tr>
                            <tr><td style="padding:0.4rem 0;color:#718096;">Amount</td><td style="padding:0.4rem 0;font-weight:700;font-size:1.1rem;color:#276749;">$${amount.toFixed(2)}${cardDesc}</td></tr>
                        </table>
                        <p><a href="${appUrl}" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">View in ${companyName}</a></p>
                    </body></html>`,
                    text: `Deposit received\nClient: ${clientName}\nJob: ${job.title}\nAmount: $${amount.toFixed(2)}${cardDesc}\n${paidAt}`
                });
            }

            if (notifyPhone) {
                await sendSMS(notifyPhone, `${companyName}: Deposit of $${amount.toFixed(2)} received from ${clientName} for "${job.title}"${cardDesc}.`).catch(() => {});
            }
        } catch (notifyErr) {
            console.error('Deposit notify error:', notifyErr.message);
        }

        res.json({ success: true, cardSaved: !!cloverCustomerId });
    } catch (e) {
        console.error('Deposit pay error:', e);
        res.status(500).json({ error: 'Payment processing failed' });
    }
});

// Admin manually enters a card for a client (keys it in on their behalf)
app.post('/api/jobs/:id/manual-charge', isAdmin, async (req, res) => {
    try {
        const { token, amount, saveCard } = req.body;
        const amountCents = Math.round(parseFloat(amount) * 100);
        if (!token) return res.status(400).json({ error: 'Missing card token' });
        if (!amount || isNaN(amountCents) || amountCents < 50) return res.status(400).json({ error: 'Invalid amount' });

        let job;
        try { job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.id) }); }
        catch (e) { return res.status(400).json({ error: 'Invalid job ID' }); }
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const jobTotal = parseFloat(job.totalWithTax || job.total) || 0;
        const alreadyPaid = parseFloat(job.totalPaid) || 0;
        const balanceOwed = Math.max(0, jobTotal - alreadyPaid);
        if (jobTotal > 0 && balanceOwed < 0.01) {
            return res.status(400).json({ error: 'This job is already paid in full' });
        }

        const client = job.clientId ? await db.collection('clients').findOne({ _id: job.clientId }) : null;

        // If saveCard: create Clover customer first (consumes the token), then charge by customer ID
        let cloverCustomerId = null;
        if (saveCard && client) {
            try {
                const custRes = await fetch('https://scl.clover.com/v1/customers', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.CLOVER_API_KEY}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-Clover-Merchant-Id': process.env.CLOVER_MERCHANT_ID
                    },
                    body: JSON.stringify({ source: token, name: client.name || 'Customer', email: client.email || '' })
                });
                const custData = await custRes.json();
                if (custData.id) cloverCustomerId = custData.id;
                else console.error('Clover customer creation (manual) failed:', JSON.stringify(custData));
            } catch (e) {
                console.error('Clover customer creation (manual) error:', e);
            }
        }

        const chargeSource = cloverCustomerId ? { source: cloverCustomerId } : { source: token };

        const chargeRes = await fetch('https://scl.clover.com/v1/charges', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.CLOVER_API_KEY}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Clover-Merchant-Id': process.env.CLOVER_MERCHANT_ID
            },
            body: JSON.stringify({ amount: amountCents, currency: 'USD', ...chargeSource })
        });

        const rawText = await chargeRes.text();
        let charge = {};
        try { charge = JSON.parse(rawText); } catch (_) {}

        const attemptBase = { jobId: job._id, at: new Date(), ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip, amount: parseFloat(amount), source: 'admin_manual' };
        if (!chargeRes.ok) {
            console.error('Manual charge failed:', chargeRes.status, rawText);
            await db.collection('payment_attempts').insertOne({ ...attemptBase, success: false, errorCode: charge.error?.code || String(chargeRes.status), error: charge.error?.message || rawText }).catch(() => {});
            return res.status(400).json({ error: charge.error?.message || rawText });
        }

        const last4 = charge.source?.last4 || null;
        const cardBrand = charge.source?.brand || null;

        await db.collection('payment_attempts').insertOne({ ...attemptBase, success: true, chargeId: charge.id, last4, cardBrand }).catch(() => {});

        const newPayment = {
            id: Date.now(),
            date: new Date().toISOString().split('T')[0],
            amount: parseFloat(amount),
            method: 'credit_card',
            last4,
            cardBrand,
            notes: `Manual card entry — Clover ${charge.id}${last4 ? ` ••••${last4}` : ''}`
        };

        const existingPaid = (job.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
        const newTotalPaid = existingPaid + parseFloat(amount);
        const newBalanceOwed = Math.max(0, jobTotal - newTotalPaid);

        const setFields = { totalPaid: newTotalPaid, balanceOwed: newBalanceOwed, updatedAt: new Date() };
        if (newBalanceOwed <= 0 && job.status !== 'completed') setFields.status = 'completed';

        await db.collection('jobs').updateOne(
            { _id: job._id },
            { $push: { payments: newPayment }, $set: setFields }
        );

        if (cloverCustomerId && client) {
            try {
                await db.collection('clients').updateOne(
                    { _id: client._id },
                    { $set: { cloverCustomerId, cloverCardLast4: last4, cloverCardBrand: cardBrand, cloverCardSavedAt: new Date() } }
                );
            } catch (e) { console.error('Failed to save card to client (manual):', e); }
        }

        res.json({ success: true, chargeId: charge.id, last4, cardBrand, cardSaved: !!cloverCustomerId });
    } catch (e) {
        console.error('Manual charge error:', e);
        res.status(500).json({ error: 'Payment processing failed' });
    }
});

// Charge a client's saved Clover card on file (admin only)
app.post('/api/jobs/:id/charge-saved-card', isAdmin, async (req, res) => {
    try {
        const { amount } = req.body;
        const amountCents = Math.round(parseFloat(amount) * 100);
        if (!amount || isNaN(amountCents) || amountCents < 50) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        let job;
        try { job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.id) }); }
        catch (e) { return res.status(400).json({ error: 'Invalid job ID' }); }
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const jobTotal = parseFloat(job.totalWithTax || job.total) || 0;
        const alreadyPaid = parseFloat(job.totalPaid) || 0;
        const balanceOwed = Math.max(0, jobTotal - alreadyPaid);
        if (balanceOwed < 0.01) {
            return res.status(400).json({ error: 'This job is already paid in full' });
        }
        if (parseFloat(amount) > balanceOwed + 0.01) {
            return res.status(400).json({ error: `Amount exceeds balance owed ($${balanceOwed.toFixed(2)})` });
        }

        const client = job.clientId ? await db.collection('clients').findOne({ _id: job.clientId }) : null;
        if (!client?.cloverCustomerId) {
            return res.status(400).json({ error: 'No saved card on file for this client' });
        }

        const chargeRes = await fetch('https://scl.clover.com/v1/charges', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.CLOVER_API_KEY}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Clover-Merchant-Id': process.env.CLOVER_MERCHANT_ID
            },
            body: JSON.stringify({ amount: amountCents, currency: 'USD', source: client.cloverCustomerId })
        });

        const rawText = await chargeRes.text();
        let charge = {};
        try { charge = JSON.parse(rawText); } catch (_) {}

        const attemptBase = { jobId: job._id, at: new Date(), ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip, amount: parseFloat(amount), source: 'admin_saved_card' };
        if (!chargeRes.ok) {
            const errMsg = charge.error?.message || rawText;
            console.error('Charge saved card failed:', chargeRes.status, rawText);
            await db.collection('payment_attempts').insertOne({ ...attemptBase, success: false, errorCode: charge.error?.code || String(chargeRes.status), error: errMsg }).catch(() => {});
            return res.status(400).json({ error: errMsg });
        }

        const last4 = charge.source?.last4 || client.cloverCardLast4 || null;
        const cardBrand = charge.source?.brand || client.cloverCardBrand || null;

        await db.collection('payment_attempts').insertOne({ ...attemptBase, success: true, chargeId: charge.id, last4, cardBrand }).catch(() => {});

        const newPayment = {
            id: Date.now(),
            date: new Date().toISOString().split('T')[0],
            amount: parseFloat(amount),
            method: 'credit_card',
            last4,
            cardBrand,
            notes: `Charged saved card — Clover ${charge.id}${last4 ? ` ••••${last4}` : ''}`
        };

        const existingPaid = (job.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
        const newTotalPaid = existingPaid + parseFloat(amount);
        const newBalanceOwed = Math.max(0, jobTotal - newTotalPaid);

        const setFields = { totalPaid: newTotalPaid, balanceOwed: newBalanceOwed, updatedAt: new Date() };
        if (newBalanceOwed <= 0 && job.status !== 'completed') setFields.status = 'completed';

        await db.collection('jobs').updateOne(
            { _id: job._id },
            { $push: { payments: newPayment }, $set: setFields }
        );

        res.json({ success: true, chargeId: charge.id, last4, cardBrand });
    } catch (e) {
        console.error('Charge saved card error:', e);
        res.status(500).json({ error: 'Payment processing failed' });
    }
});

} // End setupRoutes

// ─── Static portfolio page generator ────────────────────────────────────────

const CAT_LABEL = { bathroom:'Bathroom', kitchen:'Kitchen', deck:'Deck / Patio', flooring:'Flooring',
    painting:'Painting', carpentry:'Carpentry', electrical:'Electrical', plumbing:'Plumbing',
    exterior:'Exterior', general:'General' };

function _pfUrl(raw) {
    if (!raw) return '';
    if (raw.startsWith('http')) return raw;
    return `${CLOUDFRONT_URL}/${raw}`;
}

function _pfEsc(s) { return String(s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }
function _pfHe(s)  { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _pfFormatCaption(text) {
    if (!text) return '';
    const esc = s => _pfHe(s);
    const lines = text.split('\n');
    let html = '', inList = false;
    for (const line of lines) {
        const fc = line.trimStart().charAt(0);
        const isBullet = (fc === '-' || fc === '*' || fc === '•') && line.trim().length > 1;
        if (isBullet) {
            if (!inList) { html += '<ul style="margin:.2rem 0 .2rem 0;padding-left:1.2rem;">'; inList = true; }
            html += `<li>${esc(line.trim().slice(1).trim())}</li>`;
        } else {
            if (inList) { html += '</ul>'; inList = false; }
            if (line.trim()) html += esc(line) + '<br>';
            else if (html.length) html += '<br>';
        }
    }
    if (inList) html += '</ul>';
    return html.replace(/(<br>)+$/, '');
}

function _pfInitialLastName(name) {
    if (!name) return name;
    const parts = name.trim().split(/\s+/);
    return parts.length > 1 ? parts[0] + ' ' + parts[parts.length - 1][0] + '.' : name;
}

function generatePortfolioHtml(rawItems) {
    const CAT_ORDER = ['bathroom','kitchen','deck','flooring','painting','carpentry','electrical','plumbing','exterior','general'];

    const items = rawItems.map(item => {
        const photos = (item.photos || []).map(p => ({ url: _pfUrl(p.s3Key || p.url), type: p.type || 'other' }));
        if (!photos.length && item.s3Key) photos.push({ url: _pfUrl(item.s3Key), type: 'after' });
        const cover = photos.find(p => p.type === 'after') || photos[0];
        const bCt = photos.filter(p => p.type === 'before').length;
        const aCt = photos.filter(p => p.type === 'after').length;
        const oCt = photos.filter(p => p.type === 'other').length;
        const badge = [bCt && bCt+'B', aCt && aCt+'A', oCt && oCt+'O'].filter(Boolean).join(' · ');
        const catName = CAT_LABEL[item.category] || item.category || '';
        return { id: item._id.toString(), title: item.title || '', caption: item.caption || '',
            category: item.category || '', commercial: !!item.commercial, catName, cover, photos, badge, survey: item.survey || null };
    });

    // Filter buttons — only categories that have items
    const usedCats = new Set(items.map(i => i.category).filter(Boolean));
    const hasCommercial = items.some(i => i.commercial);
    let filterBtns = '';
    if (hasCommercial) filterBtns += `<button class="filter-btn" data-filter="commercial" onclick="setFilter('commercial')">🏢 Commercial</button>`;
    CAT_ORDER.filter(c => usedCats.has(c)).forEach(c => {
        filterBtns += `<button class="filter-btn" data-filter="${c}" onclick="setFilter('${c}')">${CAT_LABEL[c]}</button>`;
    });

    // Cards — show photo grid (up to 4 photos), Before first then After then Other
    const cardsHtml = items.map(item => {
        const baseAlt = _pfHe([item.catName, item.title, 'GSD Home Improvement South Jersey'].filter(Boolean).join(' — '));
        const catBadge = item.commercial
            ? `<span class="card-cat" style="background:#dbeafe;color:#1d4ed8;">🏢 Commercial</span>`
            : (item.catName ? `<span class="card-cat">${_pfHe(item.catName)}</span>` : '');
        const TRUNC = 150;
        const capFull = item.caption;
        const capTrunc = capFull.length > TRUNC ? capFull.slice(0, TRUNC).replace(/\s+\S*$/, '') + '…' : capFull;
        const capHtml = capFull
            ? `<div class="card-caption">${_pfFormatCaption(capTrunc)}${capFull.length > TRUNC ? ` <button class="cap-more" onclick="event.stopPropagation();openProject('${_pfEsc(item.id)}')">View more</button>` : ''}</div>`
            : '';
        const reviewStrip = item.survey?.rating ? (() => {
            const stars = '★'.repeat(item.survey.rating) + '☆'.repeat(5 - item.survey.rating);
            const comment = item.survey.comment || '';
            const CTRUNC = 90;
            const commentSnip = comment.length > CTRUNC ? comment.slice(0, CTRUNC).replace(/\s+\S*$/, '') + '…' : comment;
            return `<div style="margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid #e5e7eb;font-size:0.8rem;">
                <div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.2rem;">
                  <span style="color:#f59e0b;letter-spacing:0.05em;">${_pfHe(stars)}</span>
                  <span style="color:#374151;font-weight:600;">${_pfHe(_pfInitialLastName(item.survey.clientName))}</span>
                </div>
                ${commentSnip ? `<div style="color:#6b7280;font-style:italic;line-height:1.4;">"${_pfHe(commentSnip)}"</div>` : ''}
              </div>`;
        })() : '';
        const body = (catBadge || item.title || item.caption || reviewStrip) ? `<div class="card-body">${catBadge}${item.title ? `<div class="card-title">${_pfHe(item.title)}</div>` : ''}${capHtml}${reviewStrip}</div>` : '';

        const sorted = [...item.photos.filter(p => p.type === 'before'), ...item.photos.filter(p => p.type === 'after'), ...item.photos.filter(p => p.type === 'other')];
        const show = sorted.slice(0, 4);
        const _pfBadge = (type) => {
            const t = type === 'before' ? 'Before' : type === 'after' ? 'After' : type === 'other' ? 'Other' : '';
            return t ? `<span class="photo-badge">${t}</span>` : '';
        };
        let gridHtml;
        if (!show.length) {
            gridHtml = '';
        } else if (show.length === 1) {
            const typeLabel = show[0].type === 'before' ? 'Before — ' : show[0].type === 'after' ? 'After — ' : '';
            gridHtml = `<img src="${_pfHe(show[0].url)}" alt="${_pfHe(typeLabel)}${baseAlt}" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;">${_pfBadge(show[0].type)}`;
        } else {
            const wrapStyle = show.length === 2
                ? 'position:absolute;inset:0;display:flex;gap:2px;'
                : 'position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px;';
            const cellStyle = show.length === 2 ? 'flex:1;min-width:0;position:relative;overflow:hidden;' : 'position:relative;overflow:hidden;';
            const imgStyle = show.length === 2
                ? 'width:100%;height:100%;object-fit:cover;display:block;'
                : 'width:100%;height:100%;object-fit:cover;display:block;';
            const cells = show.map((p) => {
                const typeLabel = p.type === 'before' ? 'Before — ' : p.type === 'after' ? 'After — ' : '';
                return `<div style="${cellStyle}"><img src="${_pfHe(p.url)}" alt="${_pfHe(typeLabel)}${baseAlt}" loading="lazy" style="${imgStyle}">${_pfBadge(p.type)}</div>`;
            }).join('');
            gridHtml = `<div style="${wrapStyle}">${cells}</div>`;
        }

        return `<article class="card" data-cat="${_pfHe(item.category)}" data-commercial="${item.commercial}" onclick="openProject('${_pfEsc(item.id)}')">\n  <div class="card-img">${gridHtml}</div>${body}\n</article>`;
    }).join('\n');

    // JSON payload for lightbox (UX only — SEO comes from the <img> tags above)
    const projectJson = JSON.stringify(items.map(i => ({
        id: i.id, title: i.title, captionHtml: _pfFormatCaption(i.caption), catName: i.catName,
        survey: i.survey ? { rating: i.survey.rating, comment: i.survey.comment || '', clientName: _pfInitialLastName(i.survey.clientName || '') } : null,
        photos: i.photos.map(p => ({ url: p.url, type: p.type }))
    }))).replace(/<\/script>/gi, '<\\/script>');

    // schema.org ItemList
    const schemaItems = items.map((item, idx) => ({
        '@type': 'ListItem', position: idx + 1,
        item: { '@type': 'CreativeWork',
            name: item.title || 'GSD Home Improvement Project',
            description: item.caption,
            image: item.cover?.url || '' }
    }));
    const schema = JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList',
        name: 'GSD Home Improvement Portfolio', itemListElement: schemaItems });

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Our Work | GSD Home Improvement &amp; Property Services — Mount Laurel NJ</title>
<meta name="description" content="Browse completed projects by GSD Home Improvement &amp; Property Services. Bathrooms, kitchens, decks, flooring, painting, carpentry and more in Mount Laurel, NJ.">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://gsdhandymanservice.com/portfolio.html">
<meta property="og:type" content="website">
<meta property="og:url" content="https://gsdhandymanservice.com/portfolio.html">
<meta property="og:title" content="Our Work | GSD Home Improvement">
<meta property="og:description" content="Real jobs, real results. Browse completed projects by GSD Home Improvement in South Jersey.">
<meta property="og:image" content="https://gsdhandymanservice.com/images/logo.png">
<script type="application/ld+json">${schema}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#0f1c2e;--navy-mid:#1a2f4a;--blue:#1d6fa4}
body{font-family:'Inter',sans-serif;background:#f8fafc;color:#1f2937}
nav{position:sticky;top:0;z-index:100;background:var(--navy);padding:0 2rem;display:flex;align-items:center;justify-content:space-between;height:60px}
.nav-logo{display:flex;align-items:center;gap:.6rem;text-decoration:none;color:white;font-weight:800;font-size:1.05rem}
.nav-logo img{height:32px;filter:brightness(0) invert(1)}
.nav-links{display:flex;align-items:center;gap:1.5rem}
.nav-links a{color:rgba(255,255,255,.8);text-decoration:none;font-size:.9rem;font-weight:500;transition:color .2s}
.nav-links a:hover,.nav-links a.active{color:white}
.nav-phone{color:white;text-decoration:none;font-weight:700;font-size:.95rem;display:flex;align-items:center;gap:.4rem}
@media(max-width:640px){.nav-links{display:none}}
.hero{background:linear-gradient(135deg,var(--navy) 0%,var(--navy-mid) 60%,#1a3a5c 100%);color:white;text-align:center;padding:4rem 1.5rem 3.5rem}
.hero h1{font-size:clamp(1.8rem,4vw,2.8rem);font-weight:800;margin-bottom:.75rem}
.hero p{font-size:1.1rem;opacity:.85;max-width:520px;margin:0 auto}
.filters{background:white;border-bottom:1px solid #e5e7eb;padding:1rem 1.5rem;display:flex;gap:.6rem;flex-wrap:wrap;justify-content:center}
.filter-btn{padding:.45rem 1.1rem;border-radius:999px;border:2px solid #e5e7eb;background:white;color:#4b5563;font-size:.85rem;font-weight:600;cursor:pointer;transition:all .15s}
.filter-btn:hover{border-color:var(--navy);color:var(--navy)}
.filter-btn.active{background:var(--navy);color:white;border-color:var(--navy)}
.gallery-wrap{max-width:1280px;margin:0 auto;padding:2.5rem 1.5rem 4rem}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1.25rem}
.card{background:white;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.07);overflow:hidden;transition:transform .2s,box-shadow .2s;cursor:pointer}
.card:hover{transform:translateY(-3px);box-shadow:0 6px 20px rgba(0,0,0,.12)}
.card.hidden{display:none}
.card-img{position:relative;padding-top:66.6%;overflow:hidden;background:#e5e7eb}
.card-img > img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:transform .3s}
.card:hover .card-img img{transform:scale(1.03)}
.photo-badge{position:absolute;bottom:5px;left:5px;background:rgba(0,0,0,.55);color:#fff;font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;pointer-events:none}
.card-body{padding:.9rem 1.1rem 1.1rem}
.card-cat{display:inline-block;margin-bottom:.4rem;background:#ede9fe;color:#6d28d9;border-radius:999px;padding:2px 10px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.card-title{font-size:1rem;font-weight:700;color:#1f2937}
.card-caption{margin-top:.3rem;font-size:.875rem;color:#6b7280;line-height:1.5}
.cap-more{background:none;border:none;padding:0;color:#1d6fa4;font-size:.875rem;font-weight:600;cursor:pointer;text-decoration:underline;line-height:inherit}
#proj-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:2rem 1rem}
#proj-modal.open{display:block}
#proj-panel{background:white;border-radius:16px;max-width:720px;margin:0 auto;overflow:hidden}
#proj-head{padding:1.25rem 1.5rem;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e5e7eb}
#proj-head h2{font-size:1.15rem;font-weight:700}
#proj-close{background:none;border:none;font-size:1.8rem;cursor:pointer;color:#6b7280;line-height:1}
#proj-body{padding:1.5rem}
.proj-cap{color:#6b7280;font-size:.9rem;margin-bottom:1.25rem}
.sec-label{font-weight:700;font-size:.85rem;margin-bottom:.5rem}
.photo-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.5rem;margin-bottom:1.25rem}
.photo-row img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;cursor:zoom-in}
#lightbox{display:none;position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:99999;align-items:center;justify-content:center}
#lightbox.open{display:flex}
#lightbox img{max-width:92vw;max-height:88vh;object-fit:contain;border-radius:8px}
#lb-close{position:absolute;top:1rem;right:1.25rem;color:white;font-size:2.2rem;cursor:pointer}
footer{background:var(--navy);color:rgba(255,255,255,.7);text-align:center;padding:2rem 1rem;font-size:.9rem}
footer a{color:rgba(255,255,255,.85);text-decoration:none}
footer a:hover{color:white}
</style>
</head>
<body>
<nav>
  <a class="nav-logo" href="/"><img src="/images/logo.png" alt="GSD logo" onerror="this.style.display='none'">GSD Home Improvement</a>
  <div class="nav-links">
    <a href="/">Home</a><a href="/#services">Services</a>
    <a href="/portfolio.html" class="active">Our Work</a>
    <a href="/#quote">Get a Quote</a><a href="/property-management">Property Managers</a><a href="/#portal">Client Portal</a>
  </div>
  <a class="nav-phone" href="tel:+18568724636">
    <svg width="15" height="15" fill="currentColor" viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
    856-872-4636
  </a>
</nav>
<div class="hero">
  <h1>Our Work</h1>
  <p>Real jobs completed for homeowners, landlords, and commercial properties across South Jersey.</p>
</div>
<div class="filters">
  <button class="filter-btn active" data-filter="" onclick="setFilter('')">All</button>
  ${filterBtns}
</div>
<div class="gallery-wrap">
  <div class="gallery" id="gallery">
    ${cardsHtml || '<div style="text-align:center;padding:5rem 1rem;color:#9ca3af;grid-column:1/-1"><h3>No portfolio items yet.</h3></div>'}
  </div>
</div>
<div id="proj-modal" onclick="if(event.target===this)closeProject()">
  <div id="proj-panel">
    <div id="proj-head"><h2 id="proj-title"></h2><button id="proj-close" onclick="closeProject()">×</button></div>
    <div id="proj-body"><p class="proj-cap" id="proj-cap"></p><div id="proj-review" style="display:none;background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:0.65rem 1rem;margin-bottom:1.1rem;font-size:0.88rem;"></div><div id="proj-photos"></div></div>
  </div>
</div>
<div id="lightbox" onclick="closeLb()"><span id="lb-close" onclick="closeLb()">×</span><img id="lb-img" src="" alt=""></div>
<footer>
  <p style="margin-bottom:.5rem;"><strong style="color:white;">GSD Home Improvement &amp; Property Services</strong><br>Mount Laurel, NJ · Serving South Jersey</p>
  <p><a href="tel:+18568724636">856-872-4636</a> &nbsp;·&nbsp; <a href="mailto:info@gsdhandymanservice.com">info@gsdhandymanservice.com</a></p>
  <p style="margin-top:.35rem;"><a href="/">Home</a> &nbsp;·&nbsp; <a href="/#quote">Get a Quote</a></p>
  <p style="margin-top:.75rem;font-size:.8rem;opacity:.6;">© 2025 GSD Home Improvement &amp; Property Services. All rights reserved.</p>
</footer>
<script>
const PF=${projectJson};
function setFilter(cat){
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.toggle('active',b.dataset.filter===cat));
  document.querySelectorAll('.card').forEach(c=>{
    if(!cat){c.classList.remove('hidden');return;}
    if(cat==='commercial'){c.classList.toggle('hidden',c.dataset.commercial!=='true');return;}
    c.classList.toggle('hidden',c.dataset.cat!==cat);
  });
}
function openProject(id){
  const p=PF.find(x=>x.id===id); if(!p) return;
  document.getElementById('proj-title').textContent=p.title||'Project Details';
  const cap=document.getElementById('proj-cap');
  cap.style.display=p.captionHtml?'':'none';
  cap.innerHTML=p.captionHtml||'';
  const secs=[{k:'before',l:'📷 Before',c:'#b45309',bg:'#fffbeb',br:'#fcd34d'},{k:'after',l:'✅ After',c:'#166534',bg:'#f0fdf4',br:'#86efac'},{k:'other',l:'📌 Other',c:'#1e40af',bg:'#eff6ff',br:'#93c5fd'}];
  let h='';
  secs.forEach(s=>{
    const ph=p.photos.filter(x=>x.type===s.k); if(!ph.length) return;
    h+='<div class="sec-label" style="color:'+s.c+'"><span style="background:'+s.bg+';border:1.5px solid '+s.br+';border-radius:6px;padding:2px 12px;">'+s.l+'</span></div>';
    h+='<div class="photo-row">';
    ph.forEach(x=>{const alt=(s.k==='before'?'Before':s.k==='after'?'After':'')+(p.catName?' — '+p.catName:'')+(p.title?' — '+p.title:'');h+='<img src="'+x.url+'" alt="'+alt+'" loading="lazy" style="cursor:pointer" onclick="openLb(this.src)">';});
    h+='</div>';
  });
  document.getElementById('proj-photos').innerHTML=h||'<p style="color:#9ca3af">No photos.</p>';
  const revEl=document.getElementById('proj-review');
  if(p.survey&&p.survey.rating){
    const stars='★'.repeat(p.survey.rating)+'☆'.repeat(5-p.survey.rating);
    revEl.style.display='';
    revEl.innerHTML='<div style="color:#f59e0b;font-size:1rem;margin-bottom:0.2rem;">'+stars+'</div>'+(p.survey.comment?'<div style="color:#1a202c;font-style:italic;margin-bottom:0.25rem;">"'+p.survey.comment+'"</div>':'')+'<div style="color:#92400e;font-weight:600;font-size:0.8rem;">— '+p.survey.clientName+'</div>';
  } else { revEl.style.display='none'; }
  document.getElementById('proj-modal').classList.add('open');
  document.body.style.overflow='hidden';
}
function closeProject(){document.getElementById('proj-modal').classList.remove('open');document.body.style.overflow='';}
function openLb(src){document.getElementById('lb-img').src=src;document.getElementById('lightbox').classList.add('open');}
function closeLb(){document.getElementById('lightbox').classList.remove('open');}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeLb();closeProject();}});
</script>
</body>
</html>`;
}

const PM_PORTAL_SECTION = `
<section id="pm-portal" style="padding:5rem 1.5rem;background:#f8fafc;">
<div style="max-width:1000px;margin:0 auto;">
<div style="text-align:center;color:#059669;font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5rem;">Included With Every Account</div>
<h2 style="text-align:center;font-size:clamp(1.5rem,3vw,2.1rem);font-weight:800;margin-bottom:0.75rem;color:#0f1c2e;">Your Own Client Portal</h2>
<p style="text-align:center;color:#6b7280;max-width:560px;margin:0 auto 3rem;font-size:1.05rem;line-height:1.6;">Submit work orders, track every job, and message us directly — all in one place. No email chains, no phone tag.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1.25rem;">
<div style="background:white;border-radius:12px;padding:1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<div style="font-size:1.5rem;margin-bottom:0.75rem;">📋</div>
<div style="font-weight:700;color:#0f1c2e;margin-bottom:0.4rem;">Submit Work Orders</div>
<div style="font-size:0.88rem;color:#6b7280;line-height:1.6;">Pick the service type, priority level, and property address. Attach photos. A ticket number is generated instantly.</div>
</div>
<div style="background:white;border-radius:12px;padding:1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<div style="font-size:1.5rem;margin-bottom:0.75rem;">📍</div>
<div style="font-weight:700;color:#0f1c2e;margin-bottom:0.4rem;">Track Job Status</div>
<div style="font-size:0.88rem;color:#6b7280;line-height:1.6;">Real-time visibility from Scheduled → In Progress → Completed → Invoiced. No need to call and ask.</div>
</div>
<div style="background:white;border-radius:12px;padding:1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<div style="font-size:1.5rem;margin-bottom:0.75rem;">🧾</div>
<div style="font-weight:700;color:#0f1c2e;margin-bottom:0.4rem;">View &amp; Pay Invoices</div>
<div style="font-size:0.88rem;color:#6b7280;line-height:1.6;">Itemized invoices, easy to code and forward to accounting. View and pay directly from the portal.</div>
</div>
<div style="background:white;border-radius:12px;padding:1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<div style="font-size:1.5rem;margin-bottom:0.75rem;">🏘️</div>
<div style="font-weight:700;color:#0f1c2e;margin-bottom:0.4rem;">Multi-Property Support</div>
<div style="font-size:0.88rem;color:#6b7280;line-height:1.6;">Manage all your locations under one account. Submit and track work orders per property.</div>
</div>
<div style="background:white;border-radius:12px;padding:1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<div style="font-size:1.5rem;margin-bottom:0.75rem;">🔴</div>
<div style="font-weight:700;color:#0f1c2e;margin-bottom:0.4rem;">Priority Flags</div>
<div style="font-size:0.88rem;color:#6b7280;line-height:1.6;">Mark requests Urgent, Within 1 Day, 1 Week, or Flexible. We respond and schedule accordingly.</div>
</div>
<div style="background:white;border-radius:12px;padding:1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<div style="font-size:1.5rem;margin-bottom:0.75rem;">📸</div>
<div style="font-weight:700;color:#0f1c2e;margin-bottom:0.4rem;">Photo Documentation</div>
<div style="font-size:0.88rem;color:#6b7280;line-height:1.6;">Attach photos to every work order. We document before &amp; after on every job for your records.</div>
</div>
<div style="background:white;border-radius:12px;padding:1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<div style="font-size:1.5rem;margin-bottom:0.75rem;">💬</div>
<div style="font-weight:700;color:#0f1c2e;margin-bottom:0.4rem;">Direct Messaging</div>
<div style="font-size:0.88rem;color:#6b7280;line-height:1.6;">Message us directly about any quote or job from the portal. No third-party app, no lost threads.</div>
</div>
<div style="background:white;border-radius:12px;padding:1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<div style="font-size:1.5rem;margin-bottom:0.75rem;">🚨</div>
<div style="font-weight:700;color:#0f1c2e;margin-bottom:0.4rem;">Urgent Access</div>
<div style="font-size:0.88rem;color:#6b7280;line-height:1.6;">One-tap emergency contact when a repair can't wait. We pick up fast for established accounts.</div>
</div>
</div>
<div style="text-align:center;margin-top:2.5rem;">
<a href="https://app.gsdhandymanservice.com/client-login" style="display:inline-block;padding:0.85rem 2.25rem;background:#0f1c2e;color:white;border-radius:8px;font-weight:700;font-size:1rem;text-decoration:none;">Access Your Portal →</a>
</div>
</div>
</section>
`;

const PM_VENDOR_READY_SECTION = `
<section id="vendor-ready" style="padding:5rem 1.5rem;background:#eff6ff;">
<div style="max-width:1000px;margin:0 auto;">
<div style="text-align:center;color:#1d4ed8;font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5rem;">Vendor Onboarding</div>
<h2 style="text-align:center;font-size:clamp(1.5rem,3vw,2.1rem);font-weight:800;margin-bottom:0.75rem;color:#0f1c2e;">Vendor Ready</h2>
<p style="text-align:center;color:#6b7280;max-width:560px;margin:0 auto 2.5rem;font-size:1.05rem;line-height:1.6;">Everything your office needs to add us to your approved vendor list. Available same day — no runaround.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:1rem;">
<div style="background:white;border-radius:12px;padding:1.25rem 1.5rem;display:flex;gap:0.75rem;align-items:flex-start;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<span style="color:#16a34a;font-size:1.1rem;font-weight:700;flex-shrink:0;margin-top:0.05rem;">✓</span>
<div><div style="font-weight:700;color:#0f1c2e;margin-bottom:0.2rem;">Certificate of Insurance</div><div style="font-size:0.85rem;color:#6b7280;">Emailed same day on request</div></div>
</div>
<div style="background:white;border-radius:12px;padding:1.25rem 1.5rem;display:flex;gap:0.75rem;align-items:flex-start;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<span style="color:#16a34a;font-size:1.1rem;font-weight:700;flex-shrink:0;margin-top:0.05rem;">✓</span>
<div><div style="font-weight:700;color:#0f1c2e;margin-bottom:0.2rem;">W9 Available</div><div style="font-size:0.85rem;color:#6b7280;">Ready for your accounting department</div></div>
</div>
<div style="background:white;border-radius:12px;padding:1.25rem 1.5rem;display:flex;gap:0.75rem;align-items:flex-start;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<span style="color:#16a34a;font-size:1.1rem;font-weight:700;flex-shrink:0;margin-top:0.05rem;">✓</span>
<div><div style="font-weight:700;color:#0f1c2e;margin-bottom:0.2rem;">Net-30 Accepted</div><div style="font-size:0.85rem;color:#6b7280;">Flexible billing on recurring accounts</div></div>
</div>
<div style="background:white;border-radius:12px;padding:1.25rem 1.5rem;display:flex;gap:0.75rem;align-items:flex-start;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<span style="color:#16a34a;font-size:1.1rem;font-weight:700;flex-shrink:0;margin-top:0.05rem;">✓</span>
<div><div style="font-weight:700;color:#0f1c2e;margin-bottom:0.2rem;">Itemized Invoicing</div><div style="font-size:0.85rem;color:#6b7280;">Easy to code, forward, and justify</div></div>
</div>
<div style="background:white;border-radius:12px;padding:1.25rem 1.5rem;display:flex;gap:0.75rem;align-items:flex-start;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<span style="color:#16a34a;font-size:1.1rem;font-weight:700;flex-shrink:0;margin-top:0.05rem;">✓</span>
<div><div style="font-weight:700;color:#0f1c2e;margin-bottom:0.2rem;">Multi-Property Billing</div><div style="font-size:0.85rem;color:#6b7280;">One vendor for all your locations</div></div>
</div>
<div style="background:white;border-radius:12px;padding:1.25rem 1.5rem;display:flex;gap:0.75rem;align-items:flex-start;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<span style="color:#16a34a;font-size:1.1rem;font-weight:700;flex-shrink:0;margin-top:0.05rem;">✓</span>
<div><div style="font-weight:700;color:#0f1c2e;margin-bottom:0.2rem;">Work Order Compatible</div><div style="font-size:0.85rem;color:#6b7280;">We work with your existing ticketing systems</div></div>
</div>
<div style="background:white;border-radius:12px;padding:1.25rem 1.5rem;display:flex;gap:0.75rem;align-items:flex-start;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<span style="color:#16a34a;font-size:1.1rem;font-weight:700;flex-shrink:0;margin-top:0.05rem;">✓</span>
<div><div style="font-weight:700;color:#0f1c2e;margin-bottom:0.2rem;">Tenant Coordination</div><div style="font-size:0.85rem;color:#6b7280;">We schedule directly with tenants — hands off for you</div></div>
</div>
<div style="background:white;border-radius:12px;padding:1.25rem 1.5rem;display:flex;gap:0.75rem;align-items:flex-start;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<span style="color:#16a34a;font-size:1.1rem;font-weight:700;flex-shrink:0;margin-top:0.05rem;">✓</span>
<div><div style="font-weight:700;color:#0f1c2e;margin-bottom:0.2rem;">Background Checks</div><div style="font-size:0.85rem;color:#6b7280;">Available upon request for your compliance requirements</div></div>
</div>
</div>
<p style="text-align:center;margin-top:2rem;font-size:0.95rem;color:#4b5563;">Need a document? Call or text and we'll have it to you same day. <a href="tel:+18568724636" style="color:#1d4ed8;font-weight:600;">856-872-4636</a></p>
</div>
</section>
`;

const PM_SCREENSHOTS_SECTION = `
<section id="pm-screenshots" style="padding:4rem 1.5rem;background:#0f1c2e;">
<div style="max-width:1000px;margin:0 auto;">
<div style="text-align:center;color:#90cdf4;font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5rem;">See It In Action</div>
<h2 style="text-align:center;font-size:clamp(1.4rem,3vw,2rem);font-weight:800;margin-bottom:0.6rem;color:#fff;">Your Portal, Live</h2>
<p style="text-align:center;color:rgba(255,255,255,0.6);max-width:480px;margin:0 auto 2.5rem;font-size:1rem;line-height:1.6;">Screenshots updated daily — no mockups.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:1.25rem;">
<div class="pm-ss-card" style="border-radius:12px;overflow:hidden;background:#1a2f4a;box-shadow:0 4px 20px rgba(0,0,0,0.35);">
<img src="https://gsdhandymanservice.com/portal-screenshots/01-dashboard.jpg" alt="Client portal dashboard — My Quotes and My Jobs" loading="lazy" style="width:100%;display:block;" onerror="this.closest('.pm-ss-card').style.display='none'">
<div style="padding:1rem 1.1rem 1.1rem;">
<div style="color:#fff;font-size:0.92rem;font-weight:700;margin-bottom:0.3rem;">Centralized Maintenance Requests</div>
<div style="color:rgba(255,255,255,0.58);font-size:0.82rem;line-height:1.55;">Track open quotes and active jobs across all properties from one dashboard. No phone tags, no spreadsheets.</div>
</div>
</div>
<div class="pm-ss-card" style="border-radius:12px;overflow:hidden;background:#1a2f4a;box-shadow:0 4px 20px rgba(0,0,0,0.35);">
<img src="https://gsdhandymanservice.com/portal-screenshots/02-work-order.jpg" alt="Submit a maintenance work order" loading="lazy" style="width:100%;display:block;" onerror="this.closest('.pm-ss-card').style.display='none'">
<div style="padding:1rem 1.1rem 1.1rem;">
<div style="color:#fff;font-size:0.92rem;font-weight:700;margin-bottom:0.3rem;">Submit Work Orders Online</div>
<div style="color:rgba(255,255,255,0.58);font-size:0.82rem;line-height:1.55;">Select service type, set priority, attach photos, and submit from any device — in under a minute. No calls required.</div>
</div>
</div>
<div class="pm-ss-card" style="border-radius:12px;overflow:hidden;background:#1a2f4a;box-shadow:0 4px 20px rgba(0,0,0,0.35);">
<img src="https://gsdhandymanservice.com/portal-screenshots/03-ticket-confirmed.jpg" alt="Work order ticket confirmed" loading="lazy" style="width:100%;display:block;" onerror="this.closest('.pm-ss-card').style.display='none'">
<div style="padding:1rem 1.1rem 1.1rem;">
<div style="color:#fff;font-size:0.92rem;font-weight:700;margin-bottom:0.3rem;">Instant Confirmation, Every Time</div>
<div style="color:rgba(255,255,255,0.58);font-size:0.82rem;line-height:1.55;">Every request generates a ticket number on the spot. Your team always has a paper trail — no follow-up email needed.</div>
</div>
</div>
<div class="pm-ss-card" style="border-radius:12px;overflow:hidden;background:#1a2f4a;box-shadow:0 4px 20px rgba(0,0,0,0.35);">
<img src="https://gsdhandymanservice.com/portal-screenshots/04-invoices.jpg" alt="Invoice history view" loading="lazy" style="width:100%;display:block;" onerror="this.closest('.pm-ss-card').style.display='none'">
<div style="padding:1rem 1.1rem 1.1rem;">
<div style="color:#fff;font-size:0.92rem;font-weight:700;margin-bottom:0.3rem;">Property-Level Invoice History</div>
<div style="color:rgba(255,255,255,0.58);font-size:0.82rem;line-height:1.55;">Access itemized invoices, payment status, and service records by property — ready to forward to ownership anytime.</div>
</div>
</div>
</div>
<div style="text-align:center;margin-top:2.25rem;">
<a href="https://app.gsdhandymanservice.com/client-login" style="display:inline-block;padding:0.85rem 2.25rem;background:#3182ce;color:white;border-radius:8px;font-weight:700;font-size:1rem;text-decoration:none;">Access Your Portal →</a>
</div>
</div>
</section>
`;

const PM_COMMON_REQUESTS_SECTION = `
<section id="pm-common-requests" style="padding:5rem 1.5rem;background:#fff;">
<div style="max-width:1000px;margin:0 auto;">
<div style="text-align:center;color:#7c3aed;font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5rem;">What We Handle</div>
<h2 style="text-align:center;font-size:clamp(1.5rem,3vw,2.1rem);font-weight:800;margin-bottom:0.75rem;color:#0f1c2e;">Common Requests We Handle</h2>
<p style="text-align:center;color:#6b7280;max-width:560px;margin:0 auto 2.5rem;font-size:1.05rem;line-height:1.6;">Property managers and landlords use us for jobs that need to get done fast, documented, and out of your inbox.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:0.75rem;margin-bottom:2.5rem;">
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>🏠</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Tenant Repair Requests</span></div>
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>🔄</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Apartment Turnovers</span></div>
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>📋</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Punch-List Work</span></div>
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>🚪</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Door &amp; Hardware Repairs</span></div>
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>🎨</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Drywall &amp; Paint Repair</span></div>
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>💡</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Fixture Replacement</span></div>
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>🏢</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Common-Area Maintenance</span></div>
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>🌿</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Exterior Touch-Ups</span></div>
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>🏪</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Retail Maintenance</span></div>
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>📦</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Move-In / Move-Out Repairs</span></div>
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>🚿</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Pressure Washing</span></div>
<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.6rem;"><span>🔒</span><span style="font-weight:600;color:#374151;font-size:0.9rem;">Lock &amp; Hardware Replacement</span></div>
</div>
<div style="background:#f0fdf4;border-left:4px solid #16a34a;border-radius:0 8px 8px 0;padding:1.1rem 1.4rem;max-width:660px;margin:0 auto;">
<strong style="color:#15803d;">📸 Every job is photo-documented.</strong> Before &amp; after photos are stored in your client portal — ready to pull for ownership reports, insurance claims, or tenant disputes. No chasing us for records.
</div>
</div>
</section>
`;

const PM_GALLERY_OLD = `(async function loadCommercialPortfolio()`;
const PM_GALLERY_NEW = `(async function loadCommercialPortfolio() {
    try {
        const res = await fetch('https://app.gsdhandymanservice.com/api/portfolio');
        const items = await res.json();
        const commercial = items.filter(function(i){return i.commercial;});
        if (!commercial.length) return;
        document.getElementById('commercial-portfolio').style.display = '';

        // Inject modal + lightbox HTML once
        if (!document.getElementById('pm-proj-modal')) {
            var modalHtml = '<div id="pm-proj-modal" onclick="if(event.target===this)pmCloseProject()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:2rem 1rem;">'
                +'<div style="background:white;border-radius:16px;max-width:720px;margin:0 auto;overflow:hidden;">'
                +'<div style="padding:1.25rem 1.5rem;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e5e7eb;">'
                +'<h2 id="pm-proj-title" style="font-size:1.15rem;font-weight:700;font-family:inherit;"></h2>'
                +'<button onclick="pmCloseProject()" style="background:none;border:none;font-size:1.8rem;cursor:pointer;color:#6b7280;line-height:1;">&times;</button></div>'
                +'<div style="padding:1.5rem;"><div id="pm-proj-cap" style="color:#4b5563;font-size:.93rem;line-height:1.65;margin-bottom:1.25rem;"></div><div id="pm-proj-photos"></div></div>'
                +'</div></div>'
                +'<div id="pm-lightbox" onclick="pmCloseLb()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:99999;align-items:center;justify-content:center;">'
                +'<span onclick="pmCloseLb()" style="position:absolute;top:1rem;right:1.25rem;color:white;font-size:2.2rem;cursor:pointer;">&times;</span>'
                +'<img id="pm-lb-img" src="" alt="" style="max-width:92vw;max-height:88vh;object-fit:contain;border-radius:8px;">'
                +'</div>';
            var tmp = document.createElement('div');
            tmp.innerHTML = modalHtml;
            while (tmp.firstChild) document.body.appendChild(tmp.firstChild);
            document.getElementById('pm-lightbox').style.display = 'none';
            document.addEventListener('keydown', function(e){ if(e.key==='Escape'){pmCloseLb();pmCloseProject();} });
            var st = document.createElement('style');
            st.textContent = '.pm-card:hover{transform:translateY(-3px);box-shadow:0 6px 20px rgba(0,0,0,.12)!important;} #pm-proj-cap ul,#hp-proj-cap ul{margin:.3rem 0 .5rem 1.1rem;padding-left:.8rem;} #pm-proj-cap li,#hp-proj-cap li{margin-bottom:.2rem;}';
            document.head.appendChild(st);
        }

        window._pmData = commercial;

        window.pmOpenProject = function(idx) {
            var item = window._pmData[idx]; if (!item) return;
            document.getElementById('pm-proj-title').textContent = item.title || 'Project Details';
            var cap = document.getElementById('pm-proj-cap');
            cap.innerHTML = item.captionHtml || ''; cap.style.display = item.captionHtml ? '' : 'none';
            var photos = (item.photos && item.photos.length) ? item.photos : (item.photoUrl ? [{url:item.photoUrl,type:'after'}] : []);
            var secs = [{k:'before',l:'📷 Before',c:'#b45309',bg:'#fffbeb',br:'#fcd34d'},{k:'after',l:'✅ After',c:'#166534',bg:'#f0fdf4',br:'#86efac'},{k:'other',l:'📌 Other',c:'#1e40af',bg:'#eff6ff',br:'#93c5fd'}];
            var h = '';
            secs.forEach(function(s){
                var ph = photos.filter(function(x){return x.type===s.k;}); if (!ph.length) return;
                h += '<div style="font-weight:700;font-size:.85rem;margin-bottom:.5rem;color:'+s.c+'"><span style="background:'+s.bg+';border:1.5px solid '+s.br+';border-radius:6px;padding:2px 12px;">'+s.l+'</span></div>';
                h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.5rem;margin-bottom:1.25rem;">';
                ph.forEach(function(x){
                    var alt=(s.k==='before'?'Before':s.k==='after'?'After':'')+(item.title?' — '+item.title:'');
                    h+='<img src="'+x.url+'" alt="'+alt+'" loading="lazy" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;cursor:zoom-in;" onclick="pmOpenLb(this.src)">';
                });
                h += '</div>';
            });
            document.getElementById('pm-proj-photos').innerHTML = h || '<p style="color:#9ca3af">No photos.</p>';
            document.getElementById('pm-proj-modal').style.display = 'block';
            document.body.style.overflow = 'hidden';
        };
        window.pmCloseProject = function(){ document.getElementById('pm-proj-modal').style.display='none'; document.body.style.overflow=''; };
        window.pmOpenLb = function(src){ var lb=document.getElementById('pm-lightbox'); document.getElementById('pm-lb-img').src=src; lb.style.display='flex'; };
        window.pmCloseLb = function(){ document.getElementById('pm-lightbox').style.display='none'; };

        function badge(type){var t=type==='before'?'Before':type==='after'?'After':type==='other'?'Other':'';return t?'<span style="position:absolute;bottom:5px;left:5px;background:rgba(0,0,0,.55);color:#fff;font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;pointer-events:none;">'+t+'</span>':'';}

        document.getElementById('commercial-gallery').innerHTML = commercial.map(function(item, idx) {
            var photos = (item.photos && item.photos.length) ? item.photos : (item.photoUrl ? [{url:item.photoUrl,type:'after'}] : []);
            var sorted = [].concat(photos.filter(function(p){return p.type==='before';}),photos.filter(function(p){return p.type==='after';}),photos.filter(function(p){return p.type==='other';}));
            var show = sorted.slice(0,4);
            var containerStyle, inner;
            if (!show.length) {
                containerStyle = 'height:200px;background:#e5e7eb;';
                inner = '';
            } else if (show.length === 1) {
                containerStyle = 'height:200px;overflow:hidden;background:#e5e7eb;position:relative;';
                inner = '<img src="'+show[0].url+'" alt="'+(item.title||'Commercial job')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(show[0].type);
            } else if (show.length === 2) {
                containerStyle = 'height:200px;overflow:hidden;background:#e5e7eb;display:flex;gap:2px;';
                inner = show.map(function(p){return '<div style="flex:1;min-width:0;position:relative;overflow:hidden;"><img src="'+p.url+'" alt="'+(item.title||'Commercial job')+'" loading="lazy" style="width:100%;height:200px;object-fit:cover;display:block;">'+badge(p.type)+'</div>';}).join('');
            } else if (show.length === 3) {
                containerStyle = 'height:200px;overflow:hidden;background:#e5e7eb;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px;';
                inner = '<div style="grid-row:1/3;position:relative;overflow:hidden;"><img src="'+show[0].url+'" alt="'+(item.title||'Commercial job')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(show[0].type)+'</div>'
                      + '<div style="position:relative;overflow:hidden;"><img src="'+show[1].url+'" alt="'+(item.title||'Commercial job')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(show[1].type)+'</div>'
                      + '<div style="position:relative;overflow:hidden;"><img src="'+show[2].url+'" alt="'+(item.title||'Commercial job')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(show[2].type)+'</div>';
            } else {
                containerStyle = 'height:200px;overflow:hidden;background:#e5e7eb;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px;';
                inner = show.map(function(p){return '<div style="position:relative;overflow:hidden;"><img src="'+p.url+'" alt="'+(item.title||'Commercial job')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(p.type)+'</div>';}).join('');
            }
            var title = item.title ? '<div style="font-weight:700;color:#1f2937;margin-top:0.5rem;">'+item.title+'</div>' : '';
            var rawCap = item.caption || '';
            var isTrunc = rawCap.length > 110;
            var truncCap = isTrunc ? rawCap.slice(0, 110).replace(/\s+\S*$/, '') + '… ' : rawCap;
            var viewMore = isTrunc ? '<button onclick="event.stopPropagation();pmOpenProject('+idx+')" style="background:none;border:none;padding:0;color:#1d4ed8;font-size:0.82rem;font-weight:600;cursor:pointer;text-decoration:underline;">View more</button>' : '';
            var caption = truncCap ? '<div style="color:#6b7280;font-size:0.82rem;margin-top:0.25rem;line-height:1.5;">'+truncCap+viewMore+'</div>' : '';
            return '<div onclick="pmOpenProject('+idx+')" class="pm-card" style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.07);cursor:pointer;transition:transform .2s,box-shadow .2s;">'
                +'<div style="'+containerStyle+'">'+inner+'</div>'
                +'<div style="padding:0.9rem 1.1rem 1.1rem;"><span style="background:#dbeafe;color:#1d4ed8;border-radius:999px;padding:2px 10px;font-size:0.72rem;font-weight:700;text-transform:uppercase;">🏢 Commercial</span>'
                +title+caption+'</div></div>';
        }).join('');
    } catch(e) {}
})();`;

async function _patchAndUploadPmPage(s3Key, fetchUrl) {
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${fetchUrl}`);
    let html = await res.text();
    const idx = html.indexOf(PM_GALLERY_OLD);
    if (idx === -1) { console.warn(`⚠️  ${s3Key}: commercial gallery marker not found, skipping`); return false; }
    const end = html.indexOf('})();', idx);
    if (end === -1) { console.warn(`⚠️  ${s3Key}: IIFE closing not found, skipping`); return false; }
    html = html.slice(0, idx) + PM_GALLERY_NEW + html.slice(end + 5);
    // Inject portal showcase + vendor ready sections before CTA (idempotent)
    if (!html.includes('id="pm-portal"')) {
        const ctaIdx = html.indexOf('<section class="cta-section">');
        if (ctaIdx !== -1) {
            html = html.slice(0, ctaIdx) + PM_PORTAL_SECTION + PM_VENDOR_READY_SECTION + html.slice(ctaIdx);
        }
    }
    // Inject common requests before portal section (idempotent)
    if (!html.includes('id="pm-common-requests"')) {
        const insertBefore = html.indexOf('<section id="pm-portal"') !== -1
            ? html.indexOf('<section id="pm-portal"')
            : html.indexOf('<section class="cta-section">');
        if (insertBefore !== -1) {
            html = html.slice(0, insertBefore) + PM_COMMON_REQUESTS_SECTION + html.slice(insertBefore);
        }
    }
    // Fix nav logo name
    html = html.replace(/GSD Home Improvement/g, 'GSD Property Services');
    // Inject or replace screenshots section (always overwrite so content stays current)
    if (html.includes('id="pm-screenshots"')) {
        const start = html.indexOf('<section id="pm-screenshots"');
        const end = html.indexOf('</section>', start) + '</section>'.length;
        if (start !== -1 && end > start) {
            html = html.slice(0, start) + PM_SCREENSHOTS_SECTION.trim() + html.slice(end);
        }
    } else {
        const insertBefore = html.indexOf('<section id="vendor-ready"') !== -1
            ? html.indexOf('<section id="vendor-ready"')
            : html.indexOf('<section class="cta-section">');
        if (insertBefore !== -1) {
            html = html.slice(0, insertBefore) + PM_SCREENSHOTS_SECTION + html.slice(insertBefore);
        }
    }
    // Add Client Portal link to PM page nav (idempotent)
    if (!html.includes('app.gsdhandymanservice.com/client-login')) {
        html = html.replace(
            '<a href="/#quote">Get a Quote</a>',
            '<a href="/#quote">Get a Quote</a>\n        <a href="https://app.gsdhandymanservice.com/client-login">Client Portal</a>'
        );
    }
    // Add "Capabilities Sheet" button to the hero CTAs (idempotent)
    if (!html.includes('/capabilities.html')) {
        html = html.replace(
            '<a class="btn-outline" href="sms:+18568724636">📱 Text Your Property List</a>',
            '<a class="btn-outline" href="sms:+18568724636">📱 Text Your Property List</a>\n            <a class="btn-outline" href="/capabilities.html" target="_blank">📄 Capabilities Sheet</a>'
        );
    }
    html = _withOOOSnippet(html);
    await publicS3Client.send(new PutObjectCommand({ Bucket: PUBLIC_S3_BUCKET, Key: s3Key, Body: html, ContentType: 'text/html; charset=utf-8', CacheControl: 'no-cache, must-revalidate' }));
    console.log(`✅ ${s3Key} commercial gallery updated`);
    return true;
}

// One-page, print-ready capabilities sheet for PMs to file/forward/print.
function generateCapabilitiesSheet() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GSD Property Services — Capabilities Sheet</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Segoe UI',Arial,sans-serif;color:#1a202c;background:#e9edf2;padding:1.5rem;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  header,.lic-bar,.trust,footer{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .toolbar{max-width:8.5in;margin:0 auto .9rem;display:flex;justify-content:flex-end;}
  .print-btn{background:#0f1c2e;color:#fff;border:none;border-radius:8px;padding:.6rem 1.2rem;font-size:.9rem;font-weight:700;cursor:pointer;}
  .sheet{max-width:8.5in;margin:0 auto;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.12);}
  header{background:#0f1c2e;color:#fff;padding:1.4rem 2rem;display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;}
  header .brand h1{font-size:1.5rem;letter-spacing:.02em;}
  header .brand p{color:#9fb3c8;font-size:.78rem;margin-top:.2rem;text-transform:uppercase;letter-spacing:.08em;}
  header .contact{text-align:right;font-size:.85rem;line-height:1.55;}
  header .contact a{color:#fff;text-decoration:none;}
  .lic-bar{background:#22543d;color:#fff;text-align:center;padding:.4rem;font-size:.8rem;font-weight:700;letter-spacing:.03em;}
  .body{padding:1.4rem 2rem;}
  .intro{font-size:.95rem;line-height:1.55;color:#2d3748;margin-bottom:1rem;}
  h2.sec{font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;color:#0f1c2e;border-bottom:2px solid #e2e8f0;padding-bottom:.3rem;margin:1.1rem 0 .7rem;}
  .services{display:grid;grid-template-columns:1fr 1fr;gap:.45rem 1.5rem;}
  .service strong{display:block;color:#0f1c2e;font-size:.9rem;}
  .service span{color:#718096;font-size:.8rem;}
  .how{list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:.4rem 1.5rem;}
  .how li{font-size:.86rem;padding-left:1.3rem;position:relative;color:#2d3748;}
  .how li::before{content:'✓';position:absolute;left:0;color:#22543d;font-weight:800;}
  .trust{display:flex;gap:1.25rem;flex-wrap:wrap;justify-content:space-between;background:#f8fafc;border-radius:10px;padding:.9rem 1.25rem;}
  .trust div{text-align:center;flex:1;}
  .trust .n{font-size:1.25rem;font-weight:800;color:#0f1c2e;}
  .trust .l{font-size:.68rem;color:#718096;text-transform:uppercase;letter-spacing:.05em;}
  .area{font-size:.83rem;color:#4a5568;margin-top:.7rem;}
  footer{background:#0f1c2e;color:#fff;padding:1rem 2rem;text-align:center;}
  footer .big{font-size:1.02rem;font-weight:700;}
  footer a{color:#fff;text-decoration:none;}
  @media print{body{background:#fff;padding:0;}.toolbar{display:none;}.sheet{box-shadow:none;max-width:100%;border:1px solid #cbd5e0;}@page{margin:.4in;}}
</style>
</head>
<body>
  <div class="toolbar"><button class="print-btn" onclick="window.print()">🖨 Print / Save as PDF</button></div>
  <div class="sheet">
    <header>
      <div class="brand"><h1>GSD Property Services</h1><p>Commercial &amp; Property Management Services</p></div>
      <div class="contact"><a href="tel:+18568724636">856-872-4636</a><br><a href="mailto:info@gsdhandymanservice.com">info@gsdhandymanservice.com</a><br>gsdhandymanservice.com</div>
    </header>
    <div class="lic-bar">NJ LICENSED &amp; INSURED · HIC LIC# 13VH13491700</div>
    <div class="body">
      <p class="intro">One reliable contractor for all your properties across South Jersey. GSD works with property managers, landlords, HOAs, and facility operators — from residential rentals to commercial buildings. We coordinate access directly with tenants, show up when we say we will, and send a clean, itemized invoice when the work is done.</p>
      <h2 class="sec">Services</h2>
      <div class="services">
        <div class="service"><strong>General Handyman &amp; Repairs</strong><span>Drywall, doors, fixtures, mounting, punch lists</span></div>
        <div class="service"><strong>Carpentry &amp; Wood Rot</strong><span>Trim, framing, fences, decks, repairs</span></div>
        <div class="service"><strong>Electrical</strong><span>Fixtures, outlets, switches, detectors</span></div>
        <div class="service"><strong>Plumbing</strong><span>Faucets, toilets, leaks, fixture swaps</span></div>
        <div class="service"><strong>Pressure Washing</strong><span>Building exteriors, walkways, lots</span></div>
        <div class="service"><strong>Turnovers &amp; Make-Readies</strong><span>Unit prep between tenants</span></div>
      </div>
      <h2 class="sec">How We Work With Property Managers</h2>
      <ul class="how">
        <li>Online work-order portal — submit &amp; track jobs</li>
        <li>Direct tenant access coordination</li>
        <li>Clear, itemized invoicing per property</li>
        <li>Fast response on urgent repairs</li>
        <li>One point of contact across your portfolio</li>
        <li>Photo documentation on completed work</li>
      </ul>
      <h2 class="sec">Why GSD</h2>
      <div class="trust">
        <div><div class="n">5.0&#9733;</div><div class="l">27 Google Reviews</div></div>
        <div><div class="n">10+ yrs</div><div class="l">Experience</div></div>
        <div><div class="n">500+</div><div class="l">Jobs Completed</div></div>
        <div><div class="n">Licensed</div><div class="l">&amp; Insured</div></div>
      </div>
      <p class="area"><strong>Service area:</strong> Mount Laurel, Moorestown, Marlton, Cherry Hill, Cinnaminson, Delran, Maple Shade, Medford, Voorhees &amp; surrounding South Jersey communities.</p>
    </div>
    <footer>
      <div class="big">Ready to add a reliable contractor to your vendor list?</div>
      <div style="margin-top:.35rem;font-size:.9rem;">📞 <a href="tel:+18568724636">856-872-4636</a> &nbsp;·&nbsp; ✉️ <a href="mailto:info@gsdhandymanservice.com">info@gsdhandymanservice.com</a> &nbsp;·&nbsp; gsdhandymanservice.com</div>
    </footer>
  </div>
</body>
</html>`;
}

async function rebuildCapabilitiesSheet() {
    if (!publicS3Client || !PUBLIC_S3_BUCKET) return { page: 'capabilities.html', ok: false, error: 'public S3 not configured' };
    try {
        const html = generateCapabilitiesSheet();
        await publicS3Client.send(new PutObjectCommand({ Bucket: PUBLIC_S3_BUCKET, Key: 'capabilities.html', Body: html, ContentType: 'text/html; charset=utf-8', CacheControl: 'public, max-age=3600' }));
        const distId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
        if (distId) {
            const cfClient = new CloudFrontClient({ region: 'us-east-1', credentials: { accessKeyId: process.env.PUBLIC_S3_KEY, secretAccessKey: process.env.PUBLIC_S3_SECRET } });
            await cfClient.send(new CreateInvalidationCommand({ DistributionId: distId, InvalidationBatch: { CallerReference: Date.now().toString(), Paths: { Quantity: 1, Items: ['/capabilities.html'] } } }));
        }
        console.log('✅ capabilities.html rebuilt');
        return { page: 'capabilities.html', ok: true, bytes: html.length };
    } catch (err) {
        console.error('❌ capabilities.html rebuild failed:', err.message);
        return { page: 'capabilities.html', ok: false, error: err.message };
    }
}

async function uploadThankYouPage() {
    if (!publicS3Client || !PUBLIC_S3_BUCKET) return;
    try {
        const settings = await db.collection('settings').findOne({}) || {};
        const phone = settings.companyPhone || '';
        const phoneHref = 'tel:+1' + phone.replace(/\D/g, '');
        const companyName = settings.companyName || 'GSD Handyman Service';
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Thank You — ${companyName}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #f0f4ff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem 1.25rem; }
  .card { background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 480px; width: 100%; padding: 2.5rem 2rem; text-align: center; }
  .icon { font-size: 3.5rem; margin-bottom: 1rem; }
  h1 { font-size: 1.6rem; font-weight: 700; color: #0f1c2e; margin-bottom: 0.6rem; }
  p { color: #4a5568; line-height: 1.7; font-size: 1rem; margin-bottom: 1rem; }
  .highlight { background: #f0f4ff; border-left: 4px solid #667eea; border-radius: 0 8px 8px 0; padding: 0.75rem 1rem; text-align: left; font-size: 0.95rem; color: #2d3748; margin: 1.25rem 0; }
  .phone { display: inline-block; margin-top: 0.5rem; font-size: 1.25rem; font-weight: 700; color: #667eea; text-decoration: none; }
  .brand { margin-top: 2rem; font-size: 0.8rem; color: #a0aec0; }
  .brand strong { color: #667eea; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h1>We got your request!</h1>
  <p>Thank you for reaching out to ${companyName}. We'll review your information and get back to you shortly.</p>
  <div class="highlight">
    <strong>What happens next:</strong><br>
    We typically respond within a few hours. For urgent jobs, give us a call:
  </div>
  ${phone ? `<a class="phone" href="${phoneHref}">${phone}</a>` : ''}
  <p style="margin-top:1.5rem;font-size:0.9rem;color:#718096;">South Jersey's trusted handyman — no job too small.</p>
  <a href="https://gsdhandymanservice.com" style="display:inline-block;margin-top:1.25rem;padding:0.65rem 1.75rem;background:#0f1c2e;color:#fff;border-radius:8px;font-weight:600;font-size:0.95rem;text-decoration:none;">← Back to Home</a>
  <div class="brand">Powered by <strong>${companyName}</strong></div>
</div>
</body>
</html>`;
        const opts = { ContentType: 'text/html; charset=utf-8', CacheControl: 'no-cache, must-revalidate' };
        await Promise.all([
            publicS3Client.send(new PutObjectCommand({ Bucket: PUBLIC_S3_BUCKET, Key: 'thank-you',      Body: html, ...opts })),
            publicS3Client.send(new PutObjectCommand({ Bucket: PUBLIC_S3_BUCKET, Key: 'thank-you.html', Body: html, ...opts })),
        ]);
        const distId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
        if (distId) {
            const cfClient = new CloudFrontClient({ region: 'us-east-1', credentials: { accessKeyId: process.env.PUBLIC_S3_KEY, secretAccessKey: process.env.PUBLIC_S3_SECRET } });
            await cfClient.send(new CreateInvalidationCommand({ DistributionId: distId, InvalidationBatch: { CallerReference: Date.now().toString(), Paths: { Quantity: 2, Items: ['/thank-you', '/thank-you.html'] } } }));
        }
        console.log('✅ thank-you page uploaded to S3');
    } catch (err) {
        console.error('❌ thank-you upload failed:', err.message);
    }
}

async function rebuildPropertyManagementPage() {
    if (!publicS3Client || !PUBLIC_S3_BUCKET) return;
    try {
        await Promise.all([
            _patchAndUploadPmPage('property-management.html', 'https://gsdhandymanservice.com/property-management.html'),
            _patchAndUploadPmPage('property-management',      'https://gsdhandymanservice.com/property-management'),
        ]);
        const distId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
        if (distId) {
            const cfClient = new CloudFrontClient({ region: 'us-east-1', credentials: { accessKeyId: process.env.PUBLIC_S3_KEY, secretAccessKey: process.env.PUBLIC_S3_SECRET } });
            await cfClient.send(new CreateInvalidationCommand({ DistributionId: distId, InvalidationBatch: { CallerReference: Date.now().toString(), Paths: { Quantity: 2, Items: ['/property-management.html', '/property-management'] } } }));
            console.log('✅ CloudFront cache invalidated for /property-management.*');
        }
    } catch (err) {
        console.error('❌ property-management rebuild failed:', err.message);
    }
}

const LOC_PORTFOLIO_MARKER = '<section id="loc-portfolio"';
const LOC_PORTFOLIO_INJECT_BEFORE = '<section class="cta-section">';
function makeLocPortfolioBlock() {
    return `<section id="loc-portfolio" style="padding:4rem 1.5rem;background:#f8fafc;">
  <div style="max-width:1200px;margin:0 auto;">
    <div style="text-align:center;color:#6d28d9;font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5rem;">Recent Work</div>
    <h2 style="text-align:center;font-size:clamp(1.5rem,3vw,2rem);font-weight:800;margin-bottom:0.75rem;color:#0f1c2e;">See What We've Done</h2>
    <p style="text-align:center;color:#6b7280;max-width:520px;margin:0 auto 2rem;font-size:1rem;">Real jobs, real results — for homeowners just like you.</p>
    <div id="loc-portfolio-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem;"></div>
    <div style="text-align:center;margin-top:2rem;">
      <a href="/portfolio.html" style="display:inline-block;padding:0.75rem 2rem;background:#0f1c2e;color:white;border-radius:8px;font-weight:700;font-size:0.95rem;text-decoration:none;">View All Our Work &rarr;</a>
    </div>
  </div>
</section>
<script>
(function(){
    fetch('https://app.gsdhandymanservice.com/api/portfolio')
        .then(function(r){return r.json();})
        .then(function(items){
            var grid = document.getElementById('loc-portfolio-grid');
            if (!items || !items.length) { grid.closest('section').style.display='none'; return; }
            var isMobile = window.innerWidth < 768;
            var show = items.slice(0, isMobile ? 6 : 8);
            if (!document.getElementById('hp-proj-modal')) {
                var el = document.createElement('div');
                el.innerHTML = '<div id="hp-proj-modal" onclick="if(event.target===this)hpCloseProject()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:2rem 1rem;">'
                    +'<div style="background:white;border-radius:16px;max-width:720px;margin:0 auto;overflow:hidden;">'
                    +'<div style="padding:1.25rem 1.5rem;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e5e7eb;">'
                    +'<h2 id="hp-proj-title" style="font-size:1.15rem;font-weight:700;font-family:inherit;"></h2>'
                    +'<button onclick="hpCloseProject()" style="background:none;border:none;font-size:1.8rem;cursor:pointer;color:#6b7280;line-height:1;">&times;</button></div>'
                    +'<div style="padding:1.5rem;"><div id="hp-proj-cap" style="color:#4b5563;font-size:.93rem;line-height:1.65;margin-bottom:1.25rem;"></div><div id="hp-proj-photos"></div>'
                    +'<div style="text-align:center;margin-top:1.5rem;"><a href="/portfolio.html" style="display:inline-block;padding:0.65rem 1.75rem;background:#0f1c2e;color:white;border-radius:8px;font-weight:700;font-size:0.9rem;text-decoration:none;">View All Work &rarr;</a></div>'
                    +'</div></div></div>'
                    +'<div id="hp-lightbox" onclick="hpCloseLb()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:99999;align-items:center;justify-content:center;">'
                    +'<span onclick="hpCloseLb()" style="position:absolute;top:1rem;right:1.25rem;color:white;font-size:2.2rem;cursor:pointer;">&times;</span>'
                    +'<img id="hp-lb-img" src="" alt="" style="max-width:92vw;max-height:88vh;object-fit:contain;border-radius:8px;"></div>';
                while (el.firstChild) document.body.appendChild(el.firstChild);
                document.addEventListener('keydown', function(e){ if(e.key==='Escape'){hpCloseLb();hpCloseProject();} });
                var st = document.createElement('style');
                st.textContent = '.hp-card:hover{transform:translateY(-3px);box-shadow:0 6px 20px rgba(0,0,0,.12)!important;} #hp-proj-cap ul{margin:.3rem 0 .5rem 1.1rem;padding-left:.8rem;} #hp-proj-cap li{margin-bottom:.2rem;}';
                document.head.appendChild(st);
            }
            window._hpData = show;
            window.hpOpenProject = function(idx){
                var item = window._hpData[idx]; if (!item) return;
                document.getElementById('hp-proj-title').textContent = item.title || 'Project Details';
                var cap = document.getElementById('hp-proj-cap');
                cap.innerHTML = item.captionHtml || ''; cap.style.display = item.captionHtml ? '' : 'none';
                var photos = (item.photos && item.photos.length) ? item.photos : (item.photoUrl ? [{url:item.photoUrl,type:'after'}] : []);
                var secs = [{k:'before',l:'\\uD83D\\uDCF7 Before',c:'#b45309',bg:'#fffbeb',br:'#fcd34d'},{k:'after',l:'\\u2705 After',c:'#166534',bg:'#f0fdf4',br:'#86efac'},{k:'other',l:'\\uD83D\\uDCCC Other',c:'#1e40af',bg:'#eff6ff',br:'#93c5fd'}];
                var h = '';
                secs.forEach(function(s){
                    var ph = photos.filter(function(x){return x.type===s.k;}); if (!ph.length) return;
                    h += '<div style="font-weight:700;font-size:.85rem;margin-bottom:.5rem;color:'+s.c+'"><span style="background:'+s.bg+';border:1.5px solid '+s.br+';border-radius:6px;padding:2px 12px;">'+s.l+'</span></div>';
                    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.5rem;margin-bottom:1.25rem;">';
                    ph.forEach(function(x){
                        h += '<img src="'+x.url+'" alt="'+(s.k==='before'?'Before':s.k==='after'?'After':'')+(item.title?' - '+item.title:'')+'" loading="lazy" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;cursor:zoom-in;" onclick="hpOpenLb(this.src)">';
                    });
                    h += '</div>';
                });
                document.getElementById('hp-proj-photos').innerHTML = h || '<p style="color:#9ca3af">No photos.</p>';
                document.getElementById('hp-proj-modal').style.display = 'block';
                document.body.style.overflow = 'hidden';
            };
            window.hpCloseProject = function(){ document.getElementById('hp-proj-modal').style.display='none'; document.body.style.overflow=''; };
            window.hpOpenLb = function(src){ document.getElementById('hp-lb-img').src=src; document.getElementById('hp-lightbox').style.display='flex'; };
            window.hpCloseLb = function(){ document.getElementById('hp-lightbox').style.display='none'; };
            function badge(type){var t=type==='before'?'Before':type==='after'?'After':type==='other'?'Other':'';return t?'<span style="position:absolute;bottom:5px;left:5px;background:rgba(0,0,0,.55);color:#fff;font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;pointer-events:none;">'+t+'</span>':'';}
            grid.innerHTML = show.map(function(item,idx){
                var photos=(item.photos&&item.photos.length)?item.photos:(item.photoUrl?[{url:item.photoUrl,type:'after'}]:[]);
                var sorted=[].concat(photos.filter(function(p){return p.type==='before';}),photos.filter(function(p){return p.type==='after';}),photos.filter(function(p){return p.type==='other';}));
                var sp=sorted.slice(0,4);
                var inner;
                if(!sp.length){inner='<div style="aspect-ratio:4/3;background:#e5e7eb;"></div>';}
                else if(sp.length===1){inner='<div style="aspect-ratio:4/3;overflow:hidden;background:#e5e7eb;position:relative;"><img src="'+sp[0].url+'" alt="'+(item.title||'GSD work')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(sp[0].type)+'</div>';}
                else if(sp.length===2){inner='<div style="aspect-ratio:4/3;overflow:hidden;background:#e5e7eb;display:flex;gap:2px;">'+sp.map(function(p){return'<div style="flex:1;min-width:0;position:relative;overflow:hidden;"><img src="'+p.url+'" alt="'+(item.title||'GSD work')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(p.type)+'</div>';}).join('')+'</div>';}
                else{inner='<div style="aspect-ratio:4/3;overflow:hidden;background:#e5e7eb;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px;">'+sp.map(function(p){return'<div style="position:relative;overflow:hidden;"><img src="'+p.url+'" alt="'+(item.title||'GSD work')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(p.type)+'</div>';}).join('')+'</div>';}
                return '<div onclick="hpOpenProject('+idx+')" class="hp-card" style="border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);background:white;cursor:pointer;transition:transform .2s,box-shadow .2s;">'+inner+(item.title||item.category?'<div style="padding:0.65rem 0.85rem;font-weight:600;color:#1f2937;font-size:0.9rem;">'+(item.title||item.category)+'</div>':'')+'</div>';
            }).join('');
        })
        .catch(function(){var s=document.getElementById('loc-portfolio-grid');if(s)s.closest('section').style.display='none';});
})();
</script>
`;
}

const LOCATION_PAGES = [
    'cherry-hill-handyman',
    'indian-mills-handyman',
    'marlton-handyman',
    'medford-handyman',
    'moorestown-handyman',
    'mount-laurel-handyman',
    'shamong-handyman',
    'voorhees-handyman',
];

async function rebuildLocationPages() {
    if (!publicS3Client || !PUBLIC_S3_BUCKET) return;
    const block = makeLocPortfolioBlock();
    const cfKeys = [];
    await Promise.all(LOCATION_PAGES.map(async (slug) => {
        try {
            const res = await fetch(`https://gsdhandymanservice.com/${slug}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            let html = await res.text();
            if (html.includes(LOC_PORTFOLIO_MARKER)) {
                // Already injected — re-patch by replacing the old block
                const start = html.indexOf(LOC_PORTFOLIO_MARKER);
                const end = html.indexOf(LOC_PORTFOLIO_INJECT_BEFORE, start);
                if (end !== -1) html = html.slice(0, start) + block + html.slice(end);
            } else {
                const injectAt = html.indexOf(LOC_PORTFOLIO_INJECT_BEFORE);
                if (injectAt === -1) { console.warn(`⚠️  ${slug}: cta-section marker not found`); return; }
                html = html.slice(0, injectAt) + block + html.slice(injectAt);
            }
            // Add Property Managers nav link (idempotent)
            if (!html.includes('>Property Managers</a>')) {
                html = html.replace(
                    '<a href="/#quote">Get a Quote</a>',
                    '<a href="/#quote">Get a Quote</a>\n        <a href="/property-management">Property Managers</a>'
                );
            }
            // Add Decks nav link (idempotent)
            if (!html.includes('>Decks</a>')) {
                html = html.replace(
                    '<a href="/portfolio.html">Our Work</a>',
                    '<a href="/portfolio.html">Our Work</a>\n        <a href="/decks">Decks</a>'
                );
            }
            html = _withOOOSnippet(html);
            await publicS3Client.send(new PutObjectCommand({ Bucket: PUBLIC_S3_BUCKET, Key: slug, Body: html, ContentType: 'text/html; charset=utf-8', CacheControl: 'no-cache, must-revalidate' }));
            console.log(`✅ ${slug} portfolio section updated`);
            cfKeys.push(`/${slug}`);
        } catch (err) {
            console.error(`❌ ${slug} rebuild failed:`, err.message);
        }
    }));
    if (cfKeys.length) {
        try {
            const distId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
            if (distId) {
                const cfClient = new CloudFrontClient({ region: 'us-east-1', credentials: { accessKeyId: process.env.PUBLIC_S3_KEY, secretAccessKey: process.env.PUBLIC_S3_SECRET } });
                await cfClient.send(new CreateInvalidationCommand({ DistributionId: distId, InvalidationBatch: { CallerReference: Date.now().toString(), Paths: { Quantity: cfKeys.length, Items: cfKeys } } }));
                console.log('✅ CloudFront invalidated for location pages:', cfKeys.join(', '));
            }
        } catch (e) { console.warn('CloudFront invalidation for location pages failed:', e.message); }
    }
}


const DECK_BODY = `
<div class="hero">
    <div class="hero-photo">
        <img src="/images/hero-photo.png" alt="GSD Property Services — deck resurfacing & composite re-decking, South Jersey" loading="lazy">
    </div>
    <div class="hero-content">
        <div class="breadcrumb"><a href="/">GSD Property Services</a> › Decks</div>
        <div class="hero-badge">Deck Resurfacing &amp; Composite (Trex) Re-Decking · South Jersey</div>
        <h1>Bring Your Deck<br><span>Back to Life</span></h1>
        <p>Two honest ways to renew a tired deck — a budget-friendly resurfacing, or a low-maintenance composite (Trex) rebuild that lets us inspect and fix the structure underneath. We'll tell you straight which one your deck actually needs.</p>
        <div class="hero-ctas">
            <a class="btn-primary" href="sms:+18568724636">📱 Text Us Deck Photos for a Quote</a>
            <a class="btn-outline" href="tel:+18568724636">📞 856-872-4636</a>
        </div>
    </div>
</div>

<section class="services">
    <div class="inner">
        <div class="section-tag" style="text-align:center;">Two Ways to Renew Your Deck</div>
        <h2 class="section-title" style="text-align:center;">Pick the Right Fit — We'll Help You Decide</h2>
        <p style="text-align:center;color:#6b7280;max-width:640px;margin:0 auto 2.5rem;line-height:1.6;">We don't build brand-new decks from the ground up — but if your deck's bones are still there, we've got two great ways to make it look and feel new again.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1.5rem;">
            <div style="background:#fff;border:1px solid #eef2f7;border-radius:14px;padding:1.75rem;box-shadow:0 2px 12px rgba(0,0,0,0.05);">
                <div style="font-size:0.76rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#2b6cb0;">Option 1 · Budget-Friendly</div>
                <h3 style="font-size:1.35rem;color:#0f1c2e;margin:0.4rem 0 0.6rem;">Deck Resurfacing</h3>
                <p style="color:#4a5568;font-size:0.95rem;line-height:1.55;margin-bottom:1.1rem;">A thick, textured resurfacing coating goes over your existing boards — filling small cracks, hiding splinters and gray, and leaving a clean, slip-resistant finish. The fastest, most affordable way to freshen up a deck that's still solid.</p>
                <div style="font-weight:700;color:#166534;font-size:0.85rem;margin-bottom:0.4rem;">✓ The Upside</div>
                <ul style="margin:0 0 1.1rem 1.1rem;color:#4a5568;font-size:0.9rem;line-height:1.65;padding:0;">
                    <li>Lowest price point by far</li>
                    <li>Quick turnaround</li>
                    <li>Fills small cracks, hides splinters &amp; weathering</li>
                    <li>Slip-resistant, uniform finish</li>
                </ul>
                <div style="font-weight:700;color:#c53030;font-size:0.85rem;margin-bottom:0.4rem;">△ The Honest Catch</div>
                <ul style="margin:0;color:#4a5568;font-size:0.9rem;line-height:1.65;padding:0 0 0 1.1rem;">
                    <li>It coats <strong>over</strong> the existing boards — hidden rot or soft spots underneath aren't fixed, and can telegraph through later</li>
                    <li>Only right for a structurally sound deck. If yours isn't a good candidate, we'll tell you.</li>
                </ul>
            </div>
            <div style="background:#0f1c2e;color:#fff;border-radius:14px;padding:1.75rem;box-shadow:0 8px 24px rgba(15,28,46,0.25);">
                <div style="font-size:0.76rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#7fd1a3;">Option 2 · Do It Right</div>
                <h3 style="font-size:1.35rem;color:#fff;margin:0.4rem 0 0.6rem;">Composite Re-Decking <span style="font-weight:400;font-size:0.9rem;color:#9fb3c8;">(Trex)</span></h3>
                <p style="color:#cbd9e8;font-size:0.95rem;line-height:1.55;margin-bottom:1.1rem;">We pull up the old deck boards and replace them with low-maintenance Trex composite on your existing frame. Because the boards come off, <strong style="color:#fff;">we get to see and fix the structure underneath</strong> — not hide it.</p>
                <div style="font-weight:700;color:#7fd1a3;font-size:0.85rem;margin-bottom:0.4rem;">✓ Why It's Worth It</div>
                <ul style="margin:0 0 1.1rem 1.1rem;color:#e6edf5;font-size:0.9rem;line-height:1.65;padding:0;">
                    <li><strong>We inspect &amp; repair the substructure</strong> — joists, ledger, fasteners</li>
                    <li>Virtually no upkeep — never sand, stain, or seal again</li>
                    <li>25-year fade &amp; stain warranty; outlasts wood 2–3×</li>
                    <li>Won't rot, warp, splinter, or attract bugs</li>
                    <li>Splinter-free &amp; barefoot-friendly (paw-approved 🐾)</li>
                    <li>Great looks &amp; added resale value</li>
                </ul>
                <div style="font-weight:700;color:#fbd38d;font-size:0.85rem;margin-bottom:0.4rem;">△ The Trade-off</div>
                <ul style="margin:0;color:#e6edf5;font-size:0.9rem;line-height:1.65;padding:0 0 0 1.1rem;">
                    <li>Higher cost than resurfacing — still far less than a full tear-down rebuild</li>
                </ul>
            </div>
        </div>
    </div>
</section>

<section style="padding:4rem 1.5rem;background:#f8fafc;">
    <div class="inner" style="max-width:820px;margin:0 auto;">
        <div class="section-tag" style="text-align:center;">Side by Side</div>
        <h2 class="section-title" style="text-align:center;">Which One's Right for You?</h2>
        <div style="overflow-x:auto;margin-top:1.5rem;">
            <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.05);min-width:460px;">
                <thead>
                    <tr style="background:#0f1c2e;color:#fff;">
                        <th style="text-align:left;padding:0.9rem 1rem;font-size:0.85rem;"></th>
                        <th style="padding:0.9rem 1rem;font-size:0.9rem;">Resurfacing</th>
                        <th style="padding:0.9rem 1rem;font-size:0.9rem;">Composite Re-Deck</th>
                    </tr>
                </thead>
                <tbody style="font-size:0.9rem;color:#2d3748;">
                    <tr style="border-bottom:1px solid #eef2f7;"><td style="padding:0.8rem 1rem;font-weight:600;">Price</td><td style="text-align:center;">$</td><td style="text-align:center;">$$$</td></tr>
                    <tr style="border-bottom:1px solid #eef2f7;background:#f8fafc;"><td style="padding:0.8rem 1rem;font-weight:600;">Lifespan</td><td style="text-align:center;">A few years</td><td style="text-align:center;">25+ years</td></tr>
                    <tr style="border-bottom:1px solid #eef2f7;"><td style="padding:0.8rem 1rem;font-weight:600;">Upkeep</td><td style="text-align:center;">Recoat periodically</td><td style="text-align:center;">Virtually none</td></tr>
                    <tr style="border-bottom:1px solid #eef2f7;background:#f8fafc;"><td style="padding:0.8rem 1rem;font-weight:600;">Fixes hidden damage</td><td style="text-align:center;color:#c53030;font-weight:700;">✗ No</td><td style="text-align:center;color:#166534;font-weight:700;">✓ Yes</td></tr>
                    <tr><td style="padding:0.8rem 1rem;font-weight:600;">Look &amp; feel</td><td style="text-align:center;">Fresh coating</td><td style="text-align:center;">Like-new composite</td></tr>
                </tbody>
            </table>
        </div>
        <p style="text-align:center;color:#6b7280;font-size:0.9rem;margin-top:1.25rem;">Not sure which your deck needs? Text us a few photos — we'll take a look and give it to you straight.</p>
    </div>
</section>

<section class="services">
    <div class="inner">
        <div class="section-tag" style="text-align:center;">Real Decks, Real Results</div>
        <h2 class="section-title" style="text-align:center;">Recent Deck Work</h2>
        <div id="deck-portfolio" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem;margin-top:1.5rem;"></div>
        <div style="text-align:center;margin-top:2rem;"><a class="btn-primary" href="/portfolio.html">See All Our Work →</a></div>
    </div>
</section>
<script>
(function(){
  fetch('https://app.gsdhandymanservice.com/api/portfolio').then(function(r){return r.json();}).then(function(items){
    var decks = (items||[]).filter(function(i){return i.category==='deck';});
    var grid = document.getElementById('deck-portfolio');
    if(!grid) return;
    if(!decks.length){ var s=grid.closest('section'); if(s)s.style.display='none'; return; }
    grid.innerHTML = decks.slice(0,6).map(function(item){
      var photos = (item.photos&&item.photos.length)?item.photos:(item.photoUrl?[{url:item.photoUrl}]:[]);
      var cover = photos.filter(function(p){return p.type==='after';})[0] || photos[0];
      if(!cover||!cover.url) return '';
      return '<div style="border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);background:#fff;"><div style="aspect-ratio:4/3;overflow:hidden;background:#e5e7eb;"><img src="'+cover.url+'" alt="'+((item.title||'Deck project').replace(/"/g,''))+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;"></div>'+(item.title?'<div style="padding:0.6rem 0.85rem;font-weight:600;color:#1f2937;font-size:0.9rem;">'+item.title+'</div>':'')+'</div>';
    }).join('');
  }).catch(function(){ var g=document.getElementById('deck-portfolio'); if(g){var s=g.closest('section'); if(s)s.style.display='none';} });
})();
</script>

<section class="services" id="quote">
    <div class="inner" style="max-width:720px;margin:0 auto;">
        <div class="section-tag" style="text-align:center;">Free Estimates</div>
        <h2 class="section-title" style="text-align:center;">Request a Deck Quote</h2>
        <p style="text-align:center;color:#6b7280;max-width:560px;margin:0 auto 2rem;line-height:1.6;">Tell us about your deck — snap a few photos if you can. We'll get back to you fast with honest options. No obligation.</p>
        <div style="border-radius:12px;overflow:hidden;border:2px solid #e5e7eb;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <iframe id="quoteIframe" src="https://app.gsdhandymanservice.com/request-quote" title="Request a Quote" loading="lazy" scrolling="no" style="width:100%;height:520px;border:none;display:block;transition:height 0.2s;"></iframe>
        </div>
    </div>
</section>
<script>
window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'quoteFormHeight') {
        var iframe = document.getElementById('quoteIframe');
        if (iframe) iframe.style.height = (e.data.height + 16) + 'px';
    }
});
(function() {
    var iframe = document.getElementById('quoteIframe');
    if (!iframe) return;
    var src = new URL(iframe.src);
    var p = new URLSearchParams(window.location.search);
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(function(k){ if (p.has(k)) src.searchParams.set(k, p.get(k)); });
    if (document.referrer) src.searchParams.set('ref', document.referrer);
    src.searchParams.set('entry', window.location.pathname + window.location.search);
    iframe.src = src.toString();
})();
</script>

<section class="cta-section">
    <div class="inner">
        <div class="cta-box">
            <h2>Let's Bring Your Deck Back</h2>
            <p>Text us a few photos of your deck and we'll tell you honestly which option makes sense — and what it'll cost. No pressure, no obligation.</p>
            <div class="cta-buttons">
                <a class="btn-primary" href="sms:+18568724636">📱 Text Deck Photos for a Quote</a>
                <a href="tel:+18568724636" style="display:inline-flex;align-items:center;gap:0.5rem;padding:0.875rem 2rem;border-radius:8px;border:2px solid #e5e7eb;color:var(--navy);font-weight:600;font-size:1rem;text-decoration:none;">📞 856-872-4636</a>
            </div>
        </div>
    </div>
</section>
`;

async function rebuildDeckingPage() {
    if (!publicS3Client || !PUBLIC_S3_BUCKET) return { page: 'decks', ok: false, error: 'public S3 not configured' };
    try {
        // Reuse a location page as the shell (current CSS, nav, footer)
        const res = await fetch('https://gsdhandymanservice.com/mount-laurel-handyman');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        let html = await res.text();
        const navEnd = html.indexOf('</nav>');
        const footerStart = html.indexOf('<footer');
        if (navEnd === -1 || footerStart === -1) return { page: 'decks', ok: false, skipped: 'nav/footer markers not found' };
        html = html.slice(0, navEnd + '</nav>'.length) + '\n' + DECK_BODY + '\n' + html.slice(footerStart);
        // SEO title + description + canonical + OG (shell was cloned from a location page)
        html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>Deck Resurfacing &amp; Composite (Trex) Re-Decking | GSD Property Services — South Jersey</title>');
        html = html.replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="Deck resurfacing and low-maintenance composite (Trex) re-decking across South Jersey. We renew tired decks and inspect the structure underneath. Licensed &amp; insured. Call 856-872-4636.">');
        html = html.replace(/<link rel="canonical"[^>]*>/, '<link rel="canonical" href="https://gsdhandymanservice.com/decks">');
        html = html.replace(/<meta property="og:url"[^>]*>/, '<meta property="og:url" content="https://gsdhandymanservice.com/decks">');
        html = html.replace(/<meta property="og:title"[^>]*>/, '<meta property="og:title" content="Deck Resurfacing &amp; Composite (Trex) Re-Decking | GSD Property Services">');
        html = html.replace(/<meta property="og:description"[^>]*>/, '<meta property="og:description" content="Two honest ways to renew a tired deck in South Jersey — budget resurfacing, or composite (Trex) re-decking that lets us inspect the structure underneath.">');
        // Add "Decks" to the nav (idempotent)
        if (!html.includes('>Decks</a>')) {
            html = html.replace('<a href="/portfolio.html">Our Work</a>', '<a href="/portfolio.html">Our Work</a>\n        <a href="/decks">Decks</a>');
        }
        // Point the nav "Get a Quote" at this page's own embedded form
        html = html.replace('<a href="/#quote">Get a Quote</a>', '<a href="#quote">Get a Quote</a>');
        html = _withOOOSnippet(html);
        for (const key of ['decks', 'decks.html']) {
            await publicS3Client.send(new PutObjectCommand({ Bucket: PUBLIC_S3_BUCKET, Key: key, Body: html, ContentType: 'text/html; charset=utf-8', CacheControl: 'no-cache, must-revalidate' }));
        }
        const distId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
        if (distId) {
            const cfClient = new CloudFrontClient({ region: 'us-east-1', credentials: { accessKeyId: process.env.PUBLIC_S3_KEY, secretAccessKey: process.env.PUBLIC_S3_SECRET } });
            await cfClient.send(new CreateInvalidationCommand({ DistributionId: distId, InvalidationBatch: { CallerReference: Date.now().toString(), Paths: { Quantity: 2, Items: ['/decks', '/decks.html'] } } }));
        }
        console.log('✅ decks page rebuilt');
        return { page: 'decks', ok: true, bytes: html.length };
    } catch (err) {
        console.error('❌ decks rebuild failed:', err.message);
        return { page: 'decks', ok: false, error: err.message };
    }
}

const REVIEWS_WIDGET_2X2 = `<script>
(function(){
  function card(item){
    var meta = item.time || item.service || '';
    var n = item.rating || 5;
    var stars = '<div style="color:#F59E0B;font-size:1rem;letter-spacing:3px;margin-bottom:0.6rem;">' + '★★★★★'.slice(0, n) + '</div>';
    return '<div style="background:#fff;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,0.07);padding:1.5rem;box-sizing:border-box;height:230px;display:flex;flex-direction:column;opacity:0;transition:opacity .6s;">'
      + stars
      + '<div style="font-style:italic;font-size:0.95rem;line-height:1.55;color:#2d3748;flex:1;overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;">' + (item.text||'') + '</div>'
      + '<div style="margin-top:0.75rem;font-weight:700;color:#1a202c;">' + (item.author||'') + '</div>'
      + (meta ? '<div style="font-size:0.78rem;color:#a0aec0;margin-top:0.15rem;">'+meta+'</div>' : '')
      + '</div>';
  }
  function mount(id, item){ var el=document.getElementById(id); if(!el) return; if(!item){ el.style.display='none'; return; } el.innerHTML=card(item); var c=el.firstChild; requestAnimationFrame(function(){ if(c) c.style.opacity=1; }); }
  function rotate(list, s0, s1){
    if(!list || !list.length){ mount(s0,null); mount(s1,null); return; }
    var idx=0;
    function show(){ mount(s0, list[idx%list.length]); mount(s1, list.length>1 ? list[(idx+1)%list.length] : null); }
    show();
    if(list.length>2) setInterval(function(){
      [s0,s1].forEach(function(id){ var e=document.getElementById(id); if(e&&e.firstChild) e.firstChild.style.opacity=0; });
      setTimeout(function(){ idx=(idx+2)%list.length; show(); }, 400);
    }, 11000);
  }
  Promise.all([
    fetch('https://app.gsdhandymanservice.com/api/public/reviews').then(function(r){return r.json();}).catch(function(){return {};}),
    fetch('https://app.gsdhandymanservice.com/api/public/surveys').then(function(r){return r.json();}).catch(function(){return [];})
  ]).then(function(res){
    var g=res[0]||{}, s=res[1]||[];
    var sum=document.getElementById('reviewsSummary');
    if(sum && g.rating){
      sum.innerHTML='<span style="font-size:2rem;font-weight:800;color:#1a202c;vertical-align:middle;">'+Number(g.rating).toFixed(1)+'</span>'
        +'<span style="color:#F59E0B;font-size:1.3rem;letter-spacing:2px;margin:0 0.5rem;vertical-align:middle;">★★★★★</span>'
        +'<span style="color:#718096;vertical-align:middle;">'+(g.total||'')+' Google reviews</span>';
    }
    var greviews=(g.reviews||[]).filter(function(r){return r.text;});
    rotate(greviews, 'rev-google-0', 'rev-google-1');
    rotate(s, 'rev-survey-0', 'rev-survey-1');
  }).catch(function(){});
})();
</script>`;

const OOO_SNIPPET = '<script>\n(function(){fetch(\'https://app.gsdhandymanservice.com/api/ooo-status\').then(function(r){return r.json();}).then(function(d){if(!d.active)return;var msg=d.message||\'We are currently out of the office.\';var ret=d.returnDate?(\' We return on <strong>\'+new Date(d.returnDate+\'T12:00:00\').toLocaleDateString(\'en-US\',{month:\'long\',day:\'numeric\',year:\'numeric\'})+\'</strong>.\'):\'\';var ph=d.phone?(\' For emergencies call <a href="tel:\'+d.phone.replace(/\\D/g,\'\')+\'" style="color:#92400e;font-weight:700;">\'+d.phone+\'</a>.\'):\'\';var el=document.createElement(\'div\');el.style.cssText=\'background:#fef3c7;border-bottom:2px solid #f59e0b;padding:0.65rem 1.25rem;text-align:center;font-family:Arial,sans-serif;font-size:0.92rem;color:#78350f;line-height:1.5;position:fixed;top:0;left:0;right:0;width:100%;box-sizing:border-box;z-index:1000;\';el.innerHTML=\'⚠️ \'+msg+ret+ph;document.body.prepend(el);var h=el.offsetHeight+\'px\';document.body.style.paddingTop=h;var nav=document.querySelector(\'nav\');if(nav)nav.style.top=h;}).catch(function(){});})();\n</script>';
function _withOOOSnippet(html) {
    if (html.includes("d.returnDate+'T12:00:00'") && html.includes('nav.style.top')) return html; // already up to date
    // Strip any old version of the snippet before injecting the fixed one
    html = html.replace(/<script>\s*\(function\(\)\{fetch\('https:\/\/app\.gsdhandymanservice\.com\/api\/ooo-status'\)[\s\S]*?\}\)\(\);[\s\S]*?<\/script>/g, '');
    return html.replace('</body>', OOO_SNIPPET + '\n</body>');
}

async function rebuildSitemap() {
    if (!publicS3Client || !PUBLIC_S3_BUCKET) return;
    try {
        const base = 'https://gsdhandymanservice.com';
        const paths = ['/', '/property-management', '/decks', '/portfolio.html'].concat(LOCATION_PAGES.map(s => '/' + s));
        const now = new Date().toISOString().slice(0, 10);
        const urls = paths.map(p => `  <url><loc>${base}${p}</loc><lastmod>${now}</lastmod></url>`).join('\n');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
        await publicS3Client.send(new PutObjectCommand({ Bucket: PUBLIC_S3_BUCKET, Key: 'sitemap.xml', Body: xml, ContentType: 'application/xml', CacheControl: 'public, max-age=3600' }));
        const distId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
        if (distId) {
            const cfClient = new CloudFrontClient({ region: 'us-east-1', credentials: { accessKeyId: process.env.PUBLIC_S3_KEY, secretAccessKey: process.env.PUBLIC_S3_SECRET } });
            await cfClient.send(new CreateInvalidationCommand({ DistributionId: distId, InvalidationBatch: { CallerReference: Date.now().toString(), Paths: { Quantity: 1, Items: ['/sitemap.xml'] } } }));
        }
        console.log('✅ sitemap.xml rebuilt (' + paths.length + ' urls)');
    } catch (err) { console.error('❌ sitemap rebuild failed:', err.message); }
}

async function rebuildPublicPortfolio() {
    if (!publicS3Client || !PUBLIC_S3_BUCKET) {
        console.warn('⚠️  Public S3 not configured — skipping portfolio.html rebuild');
        return;
    }
    try {
        const rawItems = await db.collection('portfolio').find({}).sort({ createdAt: -1 }).toArray();

        // Populate photos from S3 listing (same as GET /api/portfolio)
        let s3ByEntry = {};
        try {
            const listed = await publicS3Client.send(new ListObjectsV2Command({ Bucket: PUBLIC_S3_BUCKET, Prefix: 'portfolio/', MaxKeys: 1000 }));
            (listed.Contents || []).forEach(obj => {
                const parts = obj.Key.split('/');
                if (parts.length !== 3) return;
                const entryId = parts[1];
                if (!s3ByEntry[entryId]) s3ByEntry[entryId] = [];
                s3ByEntry[entryId].push({ s3Key: obj.Key, url: portfolioPhotoUrl(obj.Key), type: _pfParseType(obj.Key) });
            });
        } catch (e) { console.warn('S3 listing for portfolio.html failed:', e.message); }

        // Join survey data
        const surveyIds = rawItems.filter(i => i.surveyId).map(i => { try { return new ObjectId(i.surveyId); } catch(e) { return null; } }).filter(Boolean);
        const linkedSurveys = surveyIds.length ? await db.collection('surveys').find({ _id: { $in: surveyIds } }).toArray() : [];
        const surveyMap = Object.fromEntries(linkedSurveys.map(s => [s._id.toString(), s]));

        // Merge S3 photos into each item (same fallback chain as API)
        const items = rawItems.map(item => {
            const id = item._id.toString();
            let photos = s3ByEntry[id] || [];
            if (!photos.length && item.photos && item.photos.length)
                photos = item.photos.map(p => ({ s3Key: p.s3Key, url: portfolioPhotoUrl(p.s3Key || p.url), type: p.type || 'other' }));
            if (!photos.length && item.s3Key)
                photos = [{ s3Key: item.s3Key, url: portfolioPhotoUrl(item.s3Key), type: 'after' }];
            return { ...item, photos, survey: surveyMap[item.surveyId] || null };
        });

        const html = _withOOOSnippet(generatePortfolioHtml(items));
        await publicS3Client.send(new PutObjectCommand({
            Bucket: PUBLIC_S3_BUCKET,
            Key: 'portfolio.html',
            Body: html,
            ContentType: 'text/html; charset=utf-8',
            CacheControl: 'public, max-age=60'
        }));
        console.log(`✅ portfolio.html rebuilt (${items.length} items, ${html.length} bytes)`);
        const distId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
        if (distId) {
            try {
                const cfClient = new CloudFrontClient({ region: 'us-east-1', credentials: { accessKeyId: process.env.PUBLIC_S3_KEY, secretAccessKey: process.env.PUBLIC_S3_SECRET } });
                await cfClient.send(new CreateInvalidationCommand({ DistributionId: distId, InvalidationBatch: { CallerReference: Date.now().toString(), Paths: { Quantity: 1, Items: ['/portfolio.html'] } } }));
                console.log('✅ CloudFront cache invalidated for /portfolio.html');
            } catch (e) { console.warn('CloudFront invalidation for portfolio.html failed:', e.message); }
        }
        rebuildPropertyManagementPage().catch(() => {});
        rebuildHomePage().catch(() => {});
        rebuildLocationPages().catch(() => {});
        rebuildCapabilitiesSheet().catch(() => {});
        rebuildDeckingPage().catch(() => {});
        rebuildSitemap().catch(() => {});
        uploadThankYouPage().catch(() => {});
    } catch (err) {
        console.error('❌ portfolio.html rebuild failed:', err.message);
    }
}

const HOME_PORTFOLIO_OLD = `(function(){\n    fetch('https://app.gsdhandymanservice.com/api/portfolio')`;
const HOME_PORTFOLIO_NEW = `(function(){
    fetch('https://app.gsdhandymanservice.com/api/portfolio')
        .then(function(r){return r.json();})
        .then(function(items){
            var grid = document.getElementById('homepage-portfolio');
            if (!items || !items.length) { grid.closest('section').style.display='none'; return; }
            var isMobile = window.innerWidth < 768;
            var show = items.slice(0, isMobile ? 6 : 8);

            // Inject modal + lightbox once
            if (!document.getElementById('hp-proj-modal')) {
                var el = document.createElement('div');
                el.innerHTML = '<div id="hp-proj-modal" onclick="if(event.target===this)hpCloseProject()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:2rem 1rem;">'
                    +'<div style="background:white;border-radius:16px;max-width:720px;margin:0 auto;overflow:hidden;">'
                    +'<div style="padding:1.25rem 1.5rem;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e5e7eb;">'
                    +'<h2 id="hp-proj-title" style="font-size:1.15rem;font-weight:700;font-family:inherit;"></h2>'
                    +'<button onclick="hpCloseProject()" style="background:none;border:none;font-size:1.8rem;cursor:pointer;color:#6b7280;line-height:1;">&times;</button></div>'
                    +'<div style="padding:1.5rem;"><div id="hp-proj-cap" style="color:#4b5563;font-size:.93rem;line-height:1.65;margin-bottom:1.25rem;"></div><div id="hp-proj-photos"></div>'
                    +'<div style="text-align:center;margin-top:1.5rem;"><a href="/portfolio.html" style="display:inline-block;padding:0.65rem 1.75rem;background:#0f1c2e;color:white;border-radius:8px;font-weight:700;font-size:0.9rem;text-decoration:none;">View All Work &rarr;</a></div>'
                    +'</div></div></div>'
                    +'<div id="hp-lightbox" onclick="hpCloseLb()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:99999;align-items:center;justify-content:center;">'
                    +'<span onclick="hpCloseLb()" style="position:absolute;top:1rem;right:1.25rem;color:white;font-size:2.2rem;cursor:pointer;">&times;</span>'
                    +'<img id="hp-lb-img" src="" alt="" style="max-width:92vw;max-height:88vh;object-fit:contain;border-radius:8px;"></div>';
                while (el.firstChild) document.body.appendChild(el.firstChild);
                document.addEventListener('keydown', function(e){ if(e.key==='Escape'){hpCloseLb();hpCloseProject();} });
                var st = document.createElement('style');
                st.textContent = '.hp-card:hover{transform:translateY(-3px);box-shadow:0 6px 20px rgba(0,0,0,.12)!important;} #hp-proj-cap ul{margin:.3rem 0 .5rem 1.1rem;padding-left:.8rem;} #hp-proj-cap li{margin-bottom:.2rem;}';
                document.head.appendChild(st);
            }

            window._hpData = show;
            window.hpOpenProject = function(idx){
                var item = window._hpData[idx]; if (!item) return;
                document.getElementById('hp-proj-title').textContent = item.title || 'Project Details';
                var cap = document.getElementById('hp-proj-cap');
                cap.innerHTML = item.captionHtml || ''; cap.style.display = item.captionHtml ? '' : 'none';
                var photos = (item.photos && item.photos.length) ? item.photos : (item.photoUrl ? [{url:item.photoUrl,type:'after'}] : []);
                var secs = [{k:'before',l:'📷 Before',c:'#b45309',bg:'#fffbeb',br:'#fcd34d'},{k:'after',l:'✅ After',c:'#166534',bg:'#f0fdf4',br:'#86efac'},{k:'other',l:'📌 Other',c:'#1e40af',bg:'#eff6ff',br:'#93c5fd'}];
                var h = '';
                secs.forEach(function(s){
                    var ph = photos.filter(function(x){return x.type===s.k;}); if (!ph.length) return;
                    h += '<div style="font-weight:700;font-size:.85rem;margin-bottom:.5rem;color:'+s.c+'"><span style="background:'+s.bg+';border:1.5px solid '+s.br+';border-radius:6px;padding:2px 12px;">'+s.l+'</span></div>';
                    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.5rem;margin-bottom:1.25rem;">';
                    ph.forEach(function(x){
                        h += '<img src="'+x.url+'" alt="'+(s.k==='before'?'Before':s.k==='after'?'After':'')+(item.title?' — '+item.title:'')+'" loading="lazy" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;cursor:zoom-in;" onclick="hpOpenLb(this.src)">';
                    });
                    h += '</div>';
                });
                document.getElementById('hp-proj-photos').innerHTML = h || '<p style="color:#9ca3af">No photos.</p>';
                document.getElementById('hp-proj-modal').style.display = 'block';
                document.body.style.overflow = 'hidden';
            };
            window.hpCloseProject = function(){ document.getElementById('hp-proj-modal').style.display='none'; document.body.style.overflow=''; };
            window.hpOpenLb = function(src){ document.getElementById('hp-lb-img').src=src; document.getElementById('hp-lightbox').style.display='flex'; };
            window.hpCloseLb = function(){ document.getElementById('hp-lightbox').style.display='none'; };

            function badge(type){var t=type==='before'?'Before':type==='after'?'After':type==='other'?'Other':'';return t?'<span style="position:absolute;bottom:5px;left:5px;background:rgba(0,0,0,.55);color:#fff;font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;pointer-events:none;">'+t+'</span>':'';}

            grid.innerHTML = show.map(function(item, idx){
                var photos = (item.photos && item.photos.length) ? item.photos : (item.photoUrl ? [{url:item.photoUrl,type:'after'}] : []);
                var sorted = [].concat(photos.filter(function(p){return p.type==='before';}),photos.filter(function(p){return p.type==='after';}),photos.filter(function(p){return p.type==='other';}));
                var sp = sorted.slice(0,4);
                var inner;
                if (!sp.length) {
                    inner = '<div style="aspect-ratio:4/3;background:#e5e7eb;"></div>';
                } else if (sp.length === 1) {
                    inner = '<div style="aspect-ratio:4/3;overflow:hidden;background:#e5e7eb;position:relative;">'
                        +'<img src="'+sp[0].url+'" alt="'+(item.title||'GSD work')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'
                        +badge(sp[0].type)+'</div>';
                } else if (sp.length === 2) {
                    inner = '<div style="aspect-ratio:4/3;overflow:hidden;background:#e5e7eb;display:flex;gap:2px;">'
                        +sp.map(function(p){return '<div style="flex:1;min-width:0;position:relative;overflow:hidden;"><img src="'+p.url+'" alt="'+(item.title||'GSD work')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(p.type)+'</div>';}).join('')
                        +'</div>';
                } else if (sp.length === 3) {
                    inner = '<div style="aspect-ratio:4/3;overflow:hidden;background:#e5e7eb;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px;">'
                        +'<div style="grid-row:1/3;position:relative;overflow:hidden;"><img src="'+sp[0].url+'" alt="'+(item.title||'GSD work')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(sp[0].type)+'</div>'
                        +'<div style="position:relative;overflow:hidden;"><img src="'+sp[1].url+'" alt="'+(item.title||'GSD work')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(sp[1].type)+'</div>'
                        +'<div style="position:relative;overflow:hidden;"><img src="'+sp[2].url+'" alt="'+(item.title||'GSD work')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(sp[2].type)+'</div>'
                        +'</div>';
                } else {
                    inner = '<div style="aspect-ratio:4/3;overflow:hidden;background:#e5e7eb;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px;">'
                        +sp.map(function(p){return '<div style="position:relative;overflow:hidden;"><img src="'+p.url+'" alt="'+(item.title||'GSD work')+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">'+badge(p.type)+'</div>';}).join('')
                        +'</div>';
                }
                return '<div onclick="hpOpenProject('+idx+')" class="hp-card" style="border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);background:white;cursor:pointer;transition:transform .2s,box-shadow .2s;">'+inner
                    +(item.title||item.category ? '<div style="padding:0.65rem 0.85rem;font-weight:600;color:#1f2937;font-size:0.9rem;">'+(item.title||item.category)+'</div>' : '')
                    +'</div>';
            }).join('');
        })
        .catch(function(){ var s=document.getElementById('homepage-portfolio'); if(s)s.closest('section').style.display='none'; })`;

async function rebuildHomePage() {
    if (!publicS3Client || !PUBLIC_S3_BUCKET) return { page:'index.html', ok:false, error:'public S3 not configured' };
    try {
        const res = await fetch('https://gsdhandymanservice.com/');
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching index.html`);
        let html = await res.text();
        const idx = html.indexOf(HOME_PORTFOLIO_OLD);
        if (idx === -1) { console.warn('⚠️  index.html: homepage portfolio marker not found, skipping'); return { page:'index.html', ok:false, skipped:'portfolio marker not found' }; }
        const end = html.indexOf('})();', idx);
        if (end === -1) { console.warn('⚠️  index.html: portfolio IIFE closing not found, skipping'); return { page:'index.html', ok:false, skipped:'IIFE close not found' }; }
        html = html.slice(0, idx) + HOME_PORTFOLIO_NEW + html.slice(end);
        // Add Property Managers nav link (idempotent — check for the specific nav text, not just the href)
        if (!html.includes('>Property Managers</a>')) {
            html = html.replace(
                '<a href="#portal">Client Portal</a>',
                '<a href="/property-management">Property Managers</a>\n        <a href="#portal">Client Portal</a>'
            );
        }
        // Add Decks nav link (idempotent)
        if (!html.includes('>Decks</a>')) {
            html = html.replace(
                '<a href="/portfolio.html">Our Work</a>',
                '<a href="/portfolio.html">Our Work</a>\n        <a href="/decks">Decks</a>'
            );
        }
        // Update hero paragraph to include commercial context (idempotent)
        if (html.includes("homeowners deserve a contractor who communicates")) {
            html = html.replace(
                "I'm Cris. I started GSD because homeowners deserve a contractor who communicates clearly, arrives when they say they will, and does the work right. Based in Mount Laurel — serving Moorestown, Marlton, Cherry Hill, Cinnaminson, and surrounding communities.",
                "I'm Cris. GSD serves homeowners, property managers, landlords, and commercial facilities across South Jersey — reliable repairs, clear communication, and no chasing required. Based in Mount Laurel, serving Cherry Hill, Moorestown, Marlton, Medford, and surrounding towns."
            );
        }
        // ── Trust / SEO enhancements (idempotent) ──────────────────────────
        // Ensure the 1200x630 social-share cover (shipped as a repo asset) is on S3.
        try {
            const ogBuf = fs.readFileSync(path.join(__dirname, 'og-cover.jpg'));
            await publicS3Client.send(new PutObjectCommand({ Bucket: PUBLIC_S3_BUCKET, Key: 'images/og-cover.jpg', Body: ogBuf, ContentType: 'image/jpeg', CacheControl: 'public, max-age=86400' }));
        } catch (e) { console.warn('og-cover upload skipped:', e.message); }

        // Pull live review figures from our own public endpoint (reviewsCache is
        // scoped to the route registration block and not visible here).
        let rvRating = '5.0', rvCount = 27;
        try {
            const rvRes = await fetch('https://app.gsdhandymanservice.com/api/public/reviews');
            if (rvRes.ok) {
                const rv = await rvRes.json();
                if (rv && rv.rating) rvRating = Number(rv.rating).toFixed(1);
                if (rv && rv.total)  rvCount  = rv.total;
            }
        } catch (e) { /* keep sensible defaults */ }

        // 1) aggregateRating in JSON-LD — surfaces ⭐ star rating in Google results
        if (!html.includes('"aggregateRating"')) {
            html = html.replace('"priceRange": "$$",',
                `"priceRange": "$$",\n      "aggregateRating": {\n        "@type": "AggregateRating",\n        "ratingValue": "${rvRating}",\n        "reviewCount": "${rvCount}"\n      },`);
        }

        // 2) NJ Home Improvement Contractor license in footer
        if (!html.includes('13VH13491700')) {
            html = html.replace('<p class="footer-copy">',
                `<p class="footer-copy" style="margin-bottom:0.5rem;">NJ Licensed &amp; Insured &nbsp;·&nbsp; HIC Lic# 13VH13491700</p>\n    <p class="footer-copy">`);
        }

        // 3) Surface actual review count in hero stat (guard on the old label so an
        //    unrelated "Google Reviews" elsewhere on the page doesn't skip this)
        if (html.includes('<div class="label">Google Rating</div>')) {
            html = html.replace('<div class="num">5★</div>', `<div class="num">${rvRating}★</div>`)
                       .replace('<div class="label">Google Rating</div>', `<div class="label">${rvCount} Google Reviews</div>`);
        }

        // 4) Favicon (was missing — blank tab icon)
        if (!html.includes('rel="icon"')) {
            html = html.replace('<meta charset="UTF-8">',
                '<meta charset="UTF-8">\n    <link rel="icon" type="image/png" href="/images/logo.png">\n    <link rel="apple-touch-icon" href="/images/logo.png">');
        }

        // 5) og:image / twitter:image → purpose-built 1200x630 cover (crop-safe on all platforms)
        html = html
            .replace(/<meta property="og:image" content="[^"]*">/, '<meta property="og:image" content="https://gsdhandymanservice.com/images/og-cover.jpg">')
            .replace(/<meta name="twitter:image" content="[^"]*">/, '<meta name="twitter:image" content="https://gsdhandymanservice.com/images/og-cover.jpg">');
        if (!html.includes('og:image:width')) {
            html = html.replace(
                '<meta property="og:image" content="https://gsdhandymanservice.com/images/og-cover.jpg">',
                '<meta property="og:image" content="https://gsdhandymanservice.com/images/og-cover.jpg">\n    <meta property="og:image:width" content="1200">\n    <meta property="og:image:height" content="630">');
        }

        // 6) "How It Works" section — sets expectations + pricing transparency before the quote form
        if (!html.includes('id="how-it-works"')) {
            const steps = [
                ['1', 'Reach Out', 'Call, text, or request a free estimate online. Tell us what you need done — no job too small.'],
                ['2', 'Free Estimate', 'We review the work and give you a clear, upfront price. No obligation, no pressure.'],
                ['3', 'We Get It Done', 'Scheduled work, on time, done right the first time — and we clean up when we\'re finished.'],
                ['4', "Pay When It's Right", 'Simple invoice, easy payment, and backed by our "done right or we fix it" promise.']
            ];
            const stepCards = steps.map(function(s){
                return '<div style="background:#f8fafc;border:1px solid #eef2f7;border-radius:12px;padding:2rem 1.5rem 1.5rem;text-align:center;">'
                    + '<div style="width:46px;height:46px;line-height:46px;margin:0 auto 1.1rem;background:#0f1c2e;color:#fff;border-radius:50%;font-weight:800;font-size:1.15rem;">'+s[0]+'</div>'
                    + '<h4 style="margin:0 0 0.55rem;font-size:1.08rem;color:#0f1c2e;">'+s[1]+'</h4>'
                    + '<p style="margin:0;color:#6b7280;font-size:0.93rem;line-height:1.55;">'+s[2]+'</p>'
                    + '</div>';
            }).join('');
            const pricingItems = ['Free, no-pressure estimates', 'Upfront pricing — approved before we start', 'No hidden fees or surprise charges']
                .map(function(t){ return '<div style="display:flex;align-items:center;gap:0.6rem;color:#e6edf5;font-size:0.98rem;font-weight:600;"><span style="color:#4ade80;font-size:1.2rem;">✓</span>'+t+'</div>'; }).join('');
            const howItWorks = '\n<!-- HOW IT WORKS -->\n'
                + '<section id="how-it-works" style="padding:5rem 1.5rem;background:#ffffff;">\n'
                + '  <div class="section-inner" style="max-width:1100px;margin:0 auto;">\n'
                + '    <div class="section-tag" style="text-align:center;">Simple &amp; Straightforward</div>\n'
                + '    <h2 class="section-title" style="text-align:center;">How It Works</h2>\n'
                + '    <p class="section-sub" style="text-align:center;margin:0 auto 3rem;">From first call to finished job — no runaround, no surprises. Here\'s exactly what to expect.</p>\n'
                + '    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1.5rem;">'+stepCards+'</div>\n'
                + '    <div style="margin-top:2.5rem;background:#0f1c2e;border-radius:14px;padding:1.9rem 2rem;display:flex;flex-wrap:wrap;gap:1.1rem 3rem;align-items:center;justify-content:center;">'+pricingItems+'</div>\n'
                + '  </div>\n'
                + '</section>\n';
            html = html.replace('<!-- QUOTE -->', howItWorks + '\n<!-- QUOTE -->');
        }

        // 7) Two-column reviews (re-derivable): Google left, rotating 5-star surveys right.
        // Always rewrite everything between the section title and the CTA, so styling tweaks re-apply.
        {
            const revTitle = '<h2 class="section-title">Real Reviews From Real Neighbors</h2>';
            const revCta = '<div class="reviews-cta">';
            const ti = html.indexOf(revTitle);
            const ci = ti !== -1 ? html.indexOf(revCta, ti) : -1;
            if (ti !== -1 && ci !== -1) {
                const body = '\n        <div id="reviewsSummary" style="text-align:center;margin:1.25rem 0 2rem;"></div>'
                    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1.75rem;align-items:start;">'
                    + '<div><div style="font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#4285F4;margin-bottom:1rem;text-align:center;">From Google</div>'
                    + '<div id="rev-google-0" style="margin-bottom:1.25rem;"></div><div id="rev-google-1"></div></div>'
                    + '<div><div style="font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#667eea;margin-bottom:1rem;text-align:center;">Straight From Our Customers</div>'
                    + '<div id="rev-survey-0" style="margin-bottom:1.25rem;"></div><div id="rev-survey-1"></div></div>'
                    + '</div>\n        ' + REVIEWS_WIDGET_2X2 + '\n        ';
                html = html.slice(0, ti + revTitle.length) + body + html.slice(ci);
            }
        }

        html = _withOOOSnippet(html);
        await publicS3Client.send(new PutObjectCommand({ Bucket: PUBLIC_S3_BUCKET, Key: 'index.html', Body: html, ContentType: 'text/html; charset=utf-8', CacheControl: 'no-cache, must-revalidate' }));
        console.log('✅ index.html homepage portfolio updated');
        const distId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
        if (distId) {
            const cfClient = new CloudFrontClient({ region: 'us-east-1', credentials: { accessKeyId: process.env.PUBLIC_S3_KEY, secretAccessKey: process.env.PUBLIC_S3_SECRET } });
            await cfClient.send(new CreateInvalidationCommand({ DistributionId: distId, InvalidationBatch: { CallerReference: Date.now().toString(), Paths: { Quantity: 2, Items: ['/index.html', '/'] } } }));
            console.log('✅ CloudFront cache invalidated for /index.html');
        }
        return { page:'index.html', ok:true, wrote:true, bytes: html.length };
    } catch (err) {
        console.error('❌ index.html rebuild failed:', err.message);
        return { page:'index.html', ok:false, error: err.message, stack: (err.stack||'').split('\n').slice(0,3).join(' | ') };
    }
}

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

    // Initialize non-critical services — a failure here must NOT stop the app from serving
    try { await emailService.initialize(); } catch (e) { console.error('⚠️  emailService init failed (continuing):', e.message); }
    try { await calendarService.initialize(); } catch (e) { console.error('⚠️  calendarService init failed (continuing):', e.message); }

    // Setup session middleware after DB connection
    app.use(session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        store: MongoStore.create({
            client: client,
            dbName: DB_NAME,
            touchAfter: 0
        }),
        cookie: {
            maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production'
        },
        rolling: true
    }));

    // Setup routes after session middleware
    setupRoutes();

    // Express error handler (registered last) — catches synchronous throws / next(err)
    app.use((err, req, res, next) => {
        console.error('❌ Route error on', req.method, req.originalUrl, '—', err && err.stack ? err.stack : err);
        if (res.headersSent) return next(err);
        res.status(500).json({ error: 'Server error' });
    });

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
        // Rebuild public pages on startup to pick up any pending changes
        setTimeout(() => {
            rebuildPublicPortfolio().catch(() => {});
        }, 3000);
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
