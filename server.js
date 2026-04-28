#!/usr/bin/env node
/**
 * Jobber Pro - Cloud Version with MongoDB
 * Field Service Management System
 */

require('dotenv').config();
const http = require('http');
const { MongoClient, ObjectId } = require('mongodb');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'jobber_pro';

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
        await db.collection('clients').createIndex({ name: 1 });
        await db.collection('jobs').createIndex({ scheduledDate: 1 });
        await db.collection('jobs').createIndex({ clientId: 1 });
        await db.collection('team').createIndex({ name: 1 });

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

// Data Manager for MongoDB
class DataManager {
    async getClients() {
        return await db.collection('clients').find().toArray();
    }

    async saveClient(client) {
        if (client._id) {
            const { _id, ...updateData } = client;
            await db.collection('clients').updateOne(
                { _id: new ObjectId(_id) },
                { $set: { ...updateData, updatedAt: new Date() } }
            );
            return _id;
        } else {
            client.createdAt = new Date();
            const result = await db.collection('clients').insertOne(client);
            return result.insertedId;
        }
    }

    async deleteClient(id) {
        await db.collection('clients').deleteOne({ _id: new ObjectId(id) });
    }

    async getJobs() {
        return await db.collection('jobs').find().toArray();
    }

    async saveJob(job) {
        // Convert string IDs to ObjectId if needed
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
            return _id;
        } else {
            job.createdAt = new Date();
            const result = await db.collection('jobs').insertOne(job);
            return result.insertedId;
        }
    }

    async deleteJob(id) {
        await db.collection('jobs').deleteOne({ _id: new ObjectId(id) });
    }

    async getTeam() {
        return await db.collection('team').find().toArray();
    }

    async saveTeamMember(member) {
        if (member._id) {
            const { _id, ...updateData } = member;
            await db.collection('team').updateOne(
                { _id: new ObjectId(_id) },
                { $set: { ...updateData, updatedAt: new Date() } }
            );
            return _id;
        } else {
            member.createdAt = new Date();
            member.active = true;
            const result = await db.collection('team').insertOne(member);
            return result.insertedId;
        }
    }

    async deleteTeamMember(id) {
        await db.collection('team').deleteOne({ _id: new ObjectId(id) });
    }

    async getSettings() {
        const settings = await db.collection('settings').findOne();
        return settings || {};
    }

    async saveSettings(settings) {
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
    }

    async getDashboardStats() {
        const jobs = await this.getJobs();
        const clients = await this.getClients();

        const today = new Date().toISOString().split('T')[0];
        const thisMonth = new Date().toISOString().slice(0, 7);

        const stats = {
            totalClients: clients.length,
            totalJobs: jobs.length,
            jobsToday: jobs.filter(j => j.scheduledDate === today).length,
            jobsThisMonth: jobs.filter(j => j.scheduledDate && j.scheduledDate.startsWith(thisMonth)).length,

            scheduled: jobs.filter(j => j.status === 'scheduled').length,
            inProgress: jobs.filter(j => j.status === 'in_progress').length,
            completed: jobs.filter(j => j.status === 'completed').length,
            invoiced: jobs.filter(j => j.status === 'invoiced').length,

            revenueThisMonth: jobs
                .filter(j => (j.status === 'invoiced' || j.status === 'completed') && j.scheduledDate && j.scheduledDate.startsWith(thisMonth))
                .reduce((sum, j) => sum + (parseFloat(j.total) || 0), 0),

            upcomingJobs: jobs
                .filter(j => j.status === 'scheduled' && j.scheduledDate >= today)
                .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))
                .slice(0, 5)
        };

        return stats;
    }

    async getCalendarData(year, month) {
        const monthStr = `${year}-${String(month).padStart(2, '0')}`;
        return await db.collection('jobs').find({
            scheduledDate: { $regex: `^${monthStr}` }
        }).toArray();
    }

    async generateInvoice(jobId) {
        const job = await db.collection('jobs').findOne({ _id: new ObjectId(jobId) });
        if (!job) return null;

        const client = await db.collection('clients').findOne({ _id: job.clientId });
        const assigned = await db.collection('team').findOne({ _id: job.assignedTo });
        const settings = await this.getSettings();

        const subtotal = parseFloat(job.total) || 0;
        const tax = subtotal * (settings.taxRate || 0.06625);
        const total = subtotal + tax;

        return {
            job: { ...job, id: job._id },
            client,
            assigned,
            settings,
            subtotal,
            tax,
            total
        };
    }
}

const dataManager = new DataManager();

console.log('Starting Jobber Pro server...');
console.log('Reading HTML template...');

// Read the HTML template from the original file
const fs = require('fs');
const path = require('path');

let HTML_TEMPLATE = '';
try {
    const originalFile = fs.readFileSync(path.join(__dirname, 'jobber-pro-server.js'), 'utf8');
    const templateStart = 'const HTML_TEMPLATE = `';
    const templateEnd = '</html>`;\n\n// API Routes';

    const htmlStart = originalFile.indexOf(templateStart);
    const htmlEnd = originalFile.indexOf(templateEnd);

    if (htmlStart !== -1 && htmlEnd !== -1) {
        // Extract from after the backtick to before </html>`;
        HTML_TEMPLATE = originalFile.substring(htmlStart + templateStart.length, htmlEnd + 7); // +7 for </html>
        console.log('HTML template loaded from jobber-pro-server.js (' + HTML_TEMPLATE.length + ' chars)');
    } else {
        throw new Error('Template markers not found');
    }
} catch (error) {
    console.error('Error reading template file:', error.message);
    console.log('Template file path:', path.join(__dirname, 'jobber-pro-server.js'));
    process.exit(1);
}

// Request Handler
const handleRequest = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    // Serve main HTML
    if (path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(HTML_TEMPLATE);
        return;
    }

    // API Routes
    if (path === '/api/dashboard' && req.method === 'GET') {
        const stats = await dataManager.getDashboardStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        return;
    }

    if (path === '/api/clients' && req.method === 'GET') {
        const clients = await dataManager.getClients();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clients));
        return;
    }

    if (path === '/api/clients' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            const client = JSON.parse(body);
            await dataManager.saveClient(client);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    if (path.startsWith('/api/clients/') && req.method === 'DELETE') {
        const id = path.split('/')[3];
        await dataManager.deleteClient(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    if (path === '/api/jobs' && req.method === 'GET') {
        const jobs = await dataManager.getJobs();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jobs));
        return;
    }

    if (path === '/api/jobs' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            const job = JSON.parse(body);
            await dataManager.saveJob(job);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    if (path.startsWith('/api/jobs/') && req.method === 'DELETE') {
        const id = path.split('/')[3];
        await dataManager.deleteJob(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    if (path === '/api/team' && req.method === 'GET') {
        const team = await dataManager.getTeam();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(team));
        return;
    }

    if (path === '/api/team' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            const member = JSON.parse(body);
            await dataManager.saveTeamMember(member);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    if (path.startsWith('/api/team/') && req.method === 'DELETE') {
        const id = path.split('/')[3];
        await dataManager.deleteTeamMember(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    if (path === '/api/settings' && req.method === 'GET') {
        const settings = await dataManager.getSettings();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(settings));
        return;
    }

    if (path === '/api/settings' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            const settings = JSON.parse(body);
            await dataManager.saveSettings(settings);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    if (path === '/api/calendar' && req.method === 'GET') {
        const year = url.searchParams.get('year');
        const month = url.searchParams.get('month');
        const data = await dataManager.getCalendarData(year, month);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
    }

    // Invoice generation (keeping the HTML generation from original)
    if (path.startsWith('/invoice/')) {
        const jobId = path.split('/')[2];
        const invoiceData = await dataManager.generateInvoice(jobId);

        if (!invoiceData) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<h1>Invoice not found</h1>');
            return;
        }

        const { job, client, assigned, settings, subtotal, tax, total } = invoiceData;

        const invoiceHTML = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Invoice #${job._id}</title>
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
            <p>Phone: ${settings.companyPhone || 'Add phone'}</p>
            <p>Email: ${settings.companyEmail || 'Add email'}</p>
        </div>
        <div class="invoice-meta">
            <h2>INVOICE</h2>
            <p><strong>Invoice #:</strong> ${job._id}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>Status:</strong> <span class="status-badge status-${job.status}">${job.status.replace('_', ' ')}</span></p>
        </div>
    </div>

    <div class="bill-to">
        <h3>Bill To:</h3>
        <p><strong>${client ? client.name : 'Unknown Client'}</strong></p>
        ${client ? `<p>${(client.address || '').replace(/\n/g, '<br>')}</p>
        <p>Phone: ${client.phone || 'N/A'}</p>
        <p>Email: ${client.email || 'N/A'}</p>` : ''}
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
                <th style="text-align: center;">Hours</th>
                <th style="text-align: right;">Rate</th>
                <th style="text-align: right;">Amount</th>
            </tr>
        </thead>
        <tbody>
            ${job.laborItems.map(item => `
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
            <span>Tax (${((settings.taxRate || 0.06625) * 100).toFixed(3)}%):</span>
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
</body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(invoiceHTML);
        return;
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
};

// Start server after DB connection
connectDB().then(() => {
    const server = http.createServer(handleRequest);

    server.listen(PORT, () => {
        console.log('='.repeat(60));
        console.log('🚀 Jobber Pro - Cloud Version with MongoDB');
        console.log('='.repeat(60));
        console.log(`📡 Server: http://localhost:${PORT}`);
        console.log(`🗄️  Database: ${MONGODB_URI.includes('mongodb+srv') ? 'MongoDB Atlas' : 'Local MongoDB'}`);
        console.log('');
        console.log('💡 Press Ctrl+C to stop');
        console.log('='.repeat(60));
        console.log('');

        // Auto-open browser only in development
        if (process.env.NODE_ENV !== 'production') {
            const cmd = process.platform === 'win32' ? 'start' :
                        process.platform === 'darwin' ? 'open' : 'xdg-open';
            exec(`${cmd} http://localhost:${PORT}`);
        }
    });

    process.on('SIGINT', async () => {
        console.log('\n\n👋 Shutting down...');
        await client.close();
        console.log('✅ MongoDB connection closed');
        server.close(() => {
            console.log('✅ Server stopped');
            process.exit(0);
        });
    });
}).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
