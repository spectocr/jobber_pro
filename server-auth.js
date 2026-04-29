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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

    const stats = {
        totalClients: clientsWithId.length,
        totalJobs: jobsMapped.length,
        jobsToday: jobsMapped.filter(j => j.scheduledDate === today).length,
        jobsThisMonth: jobsMapped.filter(j => j.scheduledDate && j.scheduledDate.startsWith(thisMonth)).length,
        prospecting: jobsMapped.filter(j => j.status === 'prospecting').length,
        scheduled: jobsMapped.filter(j => j.status === 'scheduled').length,
        inProgress: jobsMapped.filter(j => j.status === 'in_progress').length,
        completed: jobsMapped.filter(j => j.status === 'completed').length,
        invoiced: jobsMapped.filter(j => j.status === 'invoiced').length,
        bidLost: jobsMapped.filter(j => j.status === 'bid_lost').length,
        revenueThisMonth: totalRevenue,
        profitThisMonth: totalProfit,
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
    if (client._id) {
        const { _id, ...updateData } = client;
        await db.collection('clients').updateOne(
            { _id: new ObjectId(_id) },
            { $set: { ...updateData, updatedAt: new Date() } }
        );
    } else {
        client.createdAt = new Date();
        await db.collection('clients').insertOne(client);
    }
    res.json({ success: true });
});

app.delete('/api/clients/:id', isAuthenticated, async (req, res) => {
    await db.collection('clients').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
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
            id: j._id.toString(),
            clientId: (j.clientId && j.clientId !== 'undefined' && typeof j.clientId === 'object') ? j.clientId.toString() : null,
            assignedTo: (j.assignedTo && j.assignedTo !== 'undefined' && typeof j.assignedTo === 'object') ? j.assignedTo.toString() : null,
            totalWithTax: totalWithTax
        };
    });
    res.json(jobsWithId);
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
        await db.collection('jobs').updateOne(
            { _id: new ObjectId(_id) },
            { $set: { ...updateData, updatedAt: new Date() } }
        );
    } else {
        job.createdAt = new Date();
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

app.get('/api/team', isAuthenticated, async (req, res) => {
    const team = await db.collection('team').find().toArray();
    // Map _id to id for frontend compatibility
    const teamWithId = team.map(t => ({ ...t, id: t._id.toString() }));
    res.json(teamWithId);
});

app.post('/api/team', isAuthenticated, async (req, res) => {
    const member = req.body;
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
    res.json({ success: true });
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
app.get('/invoice/:jobId', isAuthenticated, async (req, res) => {
    const job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.jobId) });
    if (!job) {
        return res.status(404).send('<h1>Invoice not found</h1>');
    }

    const client = await db.collection('clients').findOne({ _id: job.clientId });
    const assigned = await db.collection('team').findOne({ _id: job.assignedTo });
    const settings = await db.collection('settings').findOne() || {};

    // Calculate subtotal from line items
    const laborSubtotal = (job.laborItems || []).reduce((sum, item) => sum + (item.hours * item.rate), 0);
    const materialSubtotal = (job.materialItems || []).reduce((sum, item) => sum + (item.quantity * item.price), 0);
    const subtotal = laborSubtotal + materialSubtotal;

    // Calculate tax (0 if waived)
    const taxWaived = job.taxWaived || false;
    const tax = taxWaived ? 0 : subtotal * (settings.taxRate || 0.06625);
    const total = subtotal + tax;

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
        body { font-family: 'Segoe UI', Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; background: white; }
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
    </style>
</head>
<body>
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
        <p><strong>Technician:</strong> ${assigned ? assigned.name : 'Unassigned'}</p>
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
                <td style="text-align: right;">$${(item.hours * item.rate).toFixed(2)}</td>
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
            <span>Tax ${taxWaived ? '(EXEMPT)' : `(${((settings.taxRate || 0.06625) * 100).toFixed(3)}%)`}:</span>
            <span>$${tax.toFixed(2)}</span>
        </div>
        <div class="totals-row total">
            <span>Total:</span>
            <span>$${total.toFixed(2)}</span>
        </div>
    </div>

    <div class="footer">
        <p>Thank you for your business!</p>
        <p>Please remit payment within 30 days.</p>
    </div>

    ${settings.contractTerms ? `
    <div style="margin-top: 40px; padding: 20px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #667eea;">
        <h3 style="color: #667eea; margin-bottom: 15px;">Terms & Conditions</h3>
        <p style="white-space: pre-wrap; line-height: 1.6; color: #333; font-size: 0.9em;">${settings.contractTerms}</p>
    </div>
    ` : ''}
</body>
</html>`;

    res.send(invoiceHTML);
});
} // End setupRoutes

// Start server
connectDB().then(() => {
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
