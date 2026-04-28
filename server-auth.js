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

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'jobber_pro';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';

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

    // Map _id to id for frontend compatibility
    const jobsWithId = jobs.map(j => ({ ...j, id: j._id.toString() }));
    const clientsWithId = clients.map(c => ({ ...c, id: c._id.toString() }));

    const today = new Date().toISOString().split('T')[0];
    const thisMonth = new Date().toISOString().slice(0, 7);

    const stats = {
        totalClients: clientsWithId.length,
        totalJobs: jobsWithId.length,
        jobsToday: jobsWithId.filter(j => j.scheduledDate === today).length,
        jobsThisMonth: jobsWithId.filter(j => j.scheduledDate && j.scheduledDate.startsWith(thisMonth)).length,
        scheduled: jobsWithId.filter(j => j.status === 'scheduled').length,
        inProgress: jobsWithId.filter(j => j.status === 'in_progress').length,
        completed: jobsWithId.filter(j => j.status === 'completed').length,
        invoiced: jobsWithId.filter(j => j.status === 'invoiced').length,
        revenueThisMonth: jobsWithId
            .filter(j => (j.status === 'invoiced' || j.status === 'completed') && j.scheduledDate && j.scheduledDate.startsWith(thisMonth))
            .reduce((sum, j) => sum + (parseFloat(j.total) || 0), 0),
        upcomingJobs: jobsWithId
            .filter(j => j.status === 'scheduled' && j.scheduledDate >= today)
            .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))
            .slice(0, 5)
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
    // Map _id to id and ObjectId references to strings for frontend compatibility
    const jobsWithId = jobs.map(j => ({
        ...j,
        id: j._id.toString(),
        clientId: j.clientId ? j.clientId.toString() : j.clientId,
        assignedTo: j.assignedTo ? j.assignedTo.toString() : j.assignedTo
    }));
    res.json(jobsWithId);
});

app.post('/api/jobs', isAuthenticated, async (req, res) => {
    const job = req.body;
    if (job.clientId && typeof job.clientId === 'string' && job.clientId.length === 24) {
        job.clientId = new ObjectId(job.clientId);
    }
    if (job.assignedTo && typeof job.assignedTo === 'string' && job.assignedTo.length === 24) {
        job.assignedTo = new ObjectId(job.assignedTo);
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
        clientId: j.clientId ? j.clientId.toString() : j.clientId,
        assignedTo: j.assignedTo ? j.assignedTo.toString() : j.assignedTo
    }));
    res.json(dataWithId);
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

    const subtotal = parseFloat(job.total) || 0;
    const tax = subtotal * (settings.taxRate || 0.06625);
    const total = subtotal + tax;

    // (Invoice HTML would be here - same as before, just with protected route)
    res.send('<h1>Invoice</h1><p>Invoice generation - add full HTML here</p>');
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
