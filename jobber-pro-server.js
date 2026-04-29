#!/usr/bin/env node
/**
 * Jobber Pro - Field Service Management System
 * Complete with clients, jobs, scheduling, invoicing, and dashboards
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(os.homedir(), '.jobber-pro');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const TEAM_FILE = path.join(DATA_DIR, 'team.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Initialize data directory
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Initialize data files
const initFile = (file, defaultData) => {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(defaultData, null, 2));
    }
};

initFile(CLIENTS_FILE, []);
initFile(JOBS_FILE, []);
initFile(TEAM_FILE, [
    { id: 1, name: 'John Smith', role: 'Technician', phone: '555-0101', email: 'john@example.com', active: true },
    { id: 2, name: 'Sarah Johnson', role: 'Technician', phone: '555-0102', email: 'sarah@example.com', active: true }
]);
initFile(SETTINGS_FILE, { companyName: 'Your Company', hourlyRate: 75, taxRate: 0.10 });

// Data Manager
class DataManager {
    readJSON(file) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            return [];
        }
    }

    writeJSON(file, data) {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    }

    getClients() {
        return this.readJSON(CLIENTS_FILE);
    }

    saveClients(clients) {
        this.writeJSON(CLIENTS_FILE, clients);
    }

    getJobs() {
        return this.readJSON(JOBS_FILE);
    }

    saveJobs(jobs) {
        this.writeJSON(JOBS_FILE, jobs);
    }

    getTeam() {
        return this.readJSON(TEAM_FILE);
    }

    saveTeam(team) {
        this.writeJSON(TEAM_FILE, team);
    }

    getSettings() {
        return this.readJSON(SETTINGS_FILE);
    }

    saveSettings(settings) {
        this.writeJSON(SETTINGS_FILE, settings);
    }

    getDashboardStats() {
        const jobs = this.getJobs();
        const clients = this.getClients();

        const today = new Date().toISOString().split('T')[0];
        const thisMonth = new Date().toISOString().slice(0, 7);

        // Calculate 30 days ago
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

        const stats = {
            totalClients: clients.length,
            totalJobs: jobs.length,
            jobsToday: jobs.filter(j => j.scheduledDate === today).length,
            jobsThisMonth: jobs.filter(j => j.scheduledDate && j.scheduledDate.startsWith(thisMonth)).length,

            prospecting: jobs.filter(j => j.status === 'prospecting').length,
            scheduled: jobs.filter(j => j.status === 'scheduled').length,
            inProgress: jobs.filter(j => j.status === 'in_progress').length,
            completed: jobs.filter(j => j.status === 'completed').length,
            invoiced: jobs.filter(j => j.status === 'invoiced').length,
            bidLost: jobs.filter(j => j.status === 'bid_lost').length,

            revenueThisMonth: jobs
                .filter(j => (j.status === 'invoiced' || j.status === 'completed') && j.scheduledDate && j.scheduledDate.startsWith(thisMonth))
                .reduce((sum, j) => sum + (parseFloat(j.total) || 0), 0),

            // Three tile categories
            upcomingJobs: jobs
                .filter(j => j.status === 'scheduled' && j.scheduledDate >= today)
                .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate)),

            inProgressJobs: jobs
                .filter(j => j.status === 'in_progress')
                .sort((a, b) => (b.scheduledDate || '').localeCompare(a.scheduledDate || '')),

            completedLast30Days: jobs
                .filter(j => j.status === 'completed' || j.status === 'invoiced')
                .sort((a, b) => {
                    const aDate = a.completedDate || a.scheduledDate || '';
                    const bDate = b.completedDate || b.scheduledDate || '';
                    return bDate.localeCompare(aDate);
                })
                .slice(0, 20) // Show last 20 completed jobs
        };

        return stats;
    }

    getCalendarData(year, month) {
        const jobs = this.getJobs();
        const monthStr = `${year}-${String(month).padStart(2, '0')}`;
        return jobs.filter(j => j.scheduledDate && j.scheduledDate.startsWith(monthStr));
    }

    generateInvoice(jobId) {
        const job = this.getJobs().find(j => j.id == jobId);
        if (!job) return null;

        // Handle both string and number IDs for client matching
        const client = this.getClients().find(c => c.id == job.clientId || String(c.id) === String(job.clientId));
        const team = this.getTeam();
        const assigned = team.find(t => t.id == job.assignedTo || String(t.id) === String(job.assignedTo));
        const settings = this.getSettings();

        const subtotal = parseFloat(job.total) || 0;
        const tax = subtotal * (settings.taxRate || 0.10);
        const total = subtotal + tax;

        return {
            job,
            client,
            assigned,
            settings,
            subtotal,
            tax,
            total
        };
    }
}

const db = new DataManager();

// HTML Template
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Jobber Pro - Field Service Management</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f7fa;
            color: #1a202c;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 1.5rem 2rem;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }

        .header h1 {
            font-size: 1.8rem;
            margin-bottom: 0.5rem;
        }

        .header p {
            opacity: 0.9;
            font-size: 0.9rem;
        }

        .nav {
            background: white;
            border-bottom: 2px solid #e2e8f0;
            padding: 0 2rem;
            display: flex;
            gap: 0.5rem;
            overflow-x: auto;
        }

        .nav-btn {
            padding: 1rem 1.5rem;
            border: none;
            background: none;
            cursor: pointer;
            font-weight: 600;
            color: #4a5568;
            border-bottom: 3px solid transparent;
            transition: all 0.3s;
            white-space: nowrap;
        }

        .nav-btn:hover {
            color: #667eea;
        }

        .nav-btn.active {
            color: #667eea;
            border-bottom-color: #667eea;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem;
        }

        .view {
            display: none;
        }

        .view.active {
            display: block;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .stat-card {
            background: white;
            padding: 1.5rem;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
            border-left: 4px solid #667eea;
        }

        .stat-card h3 {
            font-size: 0.875rem;
            color: #718096;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 0.5rem;
        }

        .stat-card .value {
            font-size: 2rem;
            font-weight: 700;
            color: #1a202c;
        }

        .stat-card .subtext {
            font-size: 0.875rem;
            color: #718096;
            margin-top: 0.5rem;
        }

        .card {
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
            padding: 1.5rem;
            margin-bottom: 1.5rem;
        }

        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
            flex-wrap: wrap;
            gap: 1rem;
        }

        .card-header h2 {
            font-size: 1.5rem;
            color: #1a202c;
        }

        .btn {
            padding: 0.75rem 1.5rem;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 0.875rem;
            transition: all 0.3s;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
        }

        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }

        .btn-primary {
            background: #667eea;
            color: white;
        }

        .btn-success {
            background: #48bb78;
            color: white;
        }

        .btn-danger {
            background: #f56565;
            color: white;
        }

        .btn-secondary {
            background: #e2e8f0;
            color: #4a5568;
        }

        .btn-small {
            padding: 0.5rem 1rem;
            font-size: 0.75rem;
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        thead {
            background: #f7fafc;
        }

        th {
            text-align: left;
            padding: 1rem;
            font-weight: 600;
            color: #4a5568;
            font-size: 0.875rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        td {
            padding: 1rem;
            border-bottom: 1px solid #e2e8f0;
        }

        tbody tr:hover {
            background: #f7fafc;
        }

        .status-badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 12px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }

        .status-scheduled {
            background: #bee3f8;
            color: #2c5282;
        }

        .status-in_progress {
            background: #feebc8;
            color: #7c2d12;
        }

        .status-completed {
            background: #c6f6d5;
            color: #22543d;
        }

        .status-invoiced {
            background: #e9d8fd;
            color: #553c9a;
        }

        .status-prospecting {
            background: #fed7d7;
            color: #742a2a;
        }

        .status-bid_lost {
            background: #e2e8f0;
            color: #4a5568;
        }

        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 1000;
            align-items: center;
            justify-content: center;
            padding: 1rem;
        }

        .modal.active {
            display: flex;
        }

        .modal-content {
            background: white;
            border-radius: 12px;
            max-width: 600px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }

        .modal-header {
            padding: 1.5rem;
            border-bottom: 2px solid #e2e8f0;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .modal-header h2 {
            font-size: 1.5rem;
        }

        .modal-body {
            padding: 1.5rem;
        }

        .modal-footer {
            padding: 1.5rem;
            border-top: 2px solid #e2e8f0;
            display: flex;
            justify-content: flex-end;
            gap: 0.5rem;
        }

        .close-btn {
            background: none;
            border: none;
            font-size: 1.5rem;
            cursor: pointer;
            color: #718096;
            padding: 0;
            width: 2rem;
            height: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .form-group {
            margin-bottom: 1.5rem;
        }

        .form-group label {
            display: block;
            font-weight: 600;
            margin-bottom: 0.5rem;
            color: #4a5568;
        }

        .form-group input,
        .form-group select,
        .form-group textarea {
            width: 100%;
            padding: 0.75rem;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 1rem;
            font-family: inherit;
        }

        .form-group input:focus,
        .form-group select:focus,
        .form-group textarea:focus {
            outline: none;
            border-color: #667eea;
        }

        .form-group textarea {
            resize: vertical;
            min-height: 100px;
        }

        .empty-state {
            text-align: center;
            padding: 4rem 2rem;
            color: #a0aec0;
        }

        .empty-state h3 {
            font-size: 1.5rem;
            margin-bottom: 0.5rem;
        }

        /* Report Styles */
        .report-section {
            margin-bottom: 3rem;
            page-break-inside: avoid;
        }

        .report-section h3 {
            color: #667eea;
            padding: 1rem;
            background: #f8f9fa;
            border-left: 4px solid #667eea;
            margin-bottom: 1rem;
        }

        @media print {
            .no-print, .card-header, .nav, .header button, #reports .card > div:first-child {
                display: none !important;
            }
            .report-section {
                page-break-inside: avoid;
            }
            body {
                background: white;
            }
            .card {
                box-shadow: none;
                border: none;
            }
        }

        /* Calendar Styles */
        .calendar-day-header {
            background: #667eea;
            color: white;
            padding: 1rem;
            text-align: center;
            font-weight: 600;
            font-size: 0.875rem;
        }
        .calendar-day {
            background: white;
            min-height: 100px;
            padding: 0.5rem;
            position: relative;
        }
        .calendar-day.other-month {
            background: #f7fafc;
            opacity: 0.5;
        }
        .calendar-day.today {
            background: #edf2ff;
            border: 2px solid #667eea;
        }
        .day-number {
            font-weight: 600;
            color: #1a202c;
            margin-bottom: 0.5rem;
        }
        .calendar-job {
            background: #667eea;
            color: white;
            padding: 0.25rem 0.5rem;
            margin-bottom: 0.25rem;
            border-radius: 4px;
            font-size: 0.75rem;
            cursor: pointer;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .calendar-job:hover {
            background: #5568d3;
        }
        .calendar-job.in_progress { background: #ed8936; }
        .calendar-job.completed { background: #48bb78; }
        .calendar-job.invoiced { background: #9f7aea; }

        .calendar-grid {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            gap: 0.5rem;
            margin-top: 1rem;
        }

        .calendar-day {
            aspect-ratio: 1;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            padding: 0.5rem;
            font-size: 0.875rem;
        }

        .calendar-day-header {
            font-weight: 600;
            text-align: center;
            padding: 0.5rem;
        }

        .job-count {
            background: #667eea;
            color: white;
            border-radius: 50%;
            width: 1.5rem;
            height: 1.5rem;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 0.75rem;
            font-weight: 600;
        }

        @media (max-width: 768px) {
            .container { padding: 1rem; }
            .header { padding: 1rem; }
            .header h1 { font-size: 1.5rem; }
            .stats-grid { grid-template-columns: 1fr; }
            table { font-size: 0.875rem; }
            th, td { padding: 0.75rem 0.5rem; }
        }
    </style>
</head>
<body>
    <div class="header">
        <div style="display: flex; align-items: center; gap: 1rem;">
            <img id="header-logo" src="" alt="" style="max-height: 60px; max-width: 150px; display: none;">
            <div>
                <h1>⚡ Jobber Pro</h1>
                <p>Field Service Management System</p>
            </div>
        </div>
        <div style="text-align: right; color: white; font-size: 0.9rem;">
            <div style="font-weight: 600; margin-bottom: 0.25rem;" id="currentUserName">Loading...</div>
            <div style="font-size: 0.8rem; opacity: 0.9;">Last Login: <span id="lastLoginTime">--</span></div>
            <div style="font-size: 0.8rem; opacity: 0.9; margin-top: 0.25rem;" id="currentDateTime">--</div>
            <button onclick="logout()" style="margin-top: 0.5rem; padding: 0.25rem 0.75rem; background: rgba(255,255,255,0.2); border: 1px solid white; color: white; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">Logout</button>
        </div>
    </div>

    <div class="nav">
        <button class="nav-btn active" onclick="showView('dashboard')" data-admin-only>📊 Dashboard</button>
        <button class="nav-btn" onclick="showView('clients')" data-admin-only>👥 Clients</button>
        <button class="nav-btn" onclick="showView('jobs')">📋 Jobs</button>
        <button class="nav-btn" onclick="showView('calendar')">📅 Calendar</button>
        <button class="nav-btn" onclick="showView('team')" data-admin-only>👷 Team</button>
        <button class="nav-btn" onclick="showView('reports')" data-admin-only>📈 Reports</button>
        <button class="nav-btn" onclick="showView('settings')" data-admin-only>⚙️ Settings</button>
    </div>

    <div class="container">
        <!-- Dashboard View -->
        <div id="dashboard" class="view active">
            <div class="stats-grid">
                <div class="stat-card">
                    <h3>Total Clients</h3>
                    <div class="value" id="stat-clients">0</div>
                </div>
                <div class="stat-card">
                    <h3>Jobs This Month</h3>
                    <div class="value" id="stat-jobs-month">0</div>
                </div>
                <div class="stat-card">
                    <h3>Revenue This Month</h3>
                    <div class="value" id="stat-revenue">$0</div>
                </div>
                <div class="stat-card">
                    <h3>Jobs Today</h3>
                    <div class="value" id="stat-jobs-today">0</div>
                </div>
            </div>

            <div class="stats-grid">
                <div class="stat-card" style="border-left-color: #f56565;">
                    <h3>Prospecting</h3>
                    <div class="value" id="stat-prospecting">0</div>
                </div>
                <div class="stat-card" style="border-left-color: #4299e1;">
                    <h3>Scheduled</h3>
                    <div class="value" id="stat-scheduled">0</div>
                </div>
                <div class="stat-card" style="border-left-color: #ed8936;">
                    <h3>In Progress</h3>
                    <div class="value" id="stat-in-progress">0</div>
                </div>
                <div class="stat-card" style="border-left-color: #48bb78;">
                    <h3>Completed</h3>
                    <div class="value" id="stat-completed">0</div>
                </div>
                <div class="stat-card" style="border-left-color: #9f7aea;">
                    <h3>Invoiced</h3>
                    <div class="value" id="stat-invoiced">0</div>
                </div>
                <div class="stat-card" style="border-left-color: #718096;">
                    <h3>Bid Lost</h3>
                    <div class="value" id="stat-bid-lost">0</div>
                </div>
            </div>

            <!-- Job Status Tiles -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 1.5rem;">
                <!-- Upcoming Jobs Tile -->
                <div class="card">
                    <div class="card-header">
                        <h2>📅 Upcoming <span id="upcoming-count" style="color: #718096; font-size: 0.9em;">(0)</span></h2>
                    </div>
                    <div id="upcoming-jobs-list"></div>
                </div>

                <!-- In Progress Jobs Tile -->
                <div class="card">
                    <div class="card-header">
                        <h2>🔧 In Progress <span id="in-progress-count" style="color: #718096; font-size: 0.9em;">(0)</span></h2>
                    </div>
                    <div id="in-progress-jobs-list"></div>
                </div>

                <!-- Completed Jobs Tile -->
                <div class="card">
                    <div class="card-header">
                        <h2>✅ Completed <span id="completed-count" style="color: #718096; font-size: 0.9em;">(0)</span></h2>
                    </div>
                    <div id="completed-jobs-list"></div>
                </div>
            </div>
        </div>

        <!-- Clients View -->
        <div id="clients" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>Clients</h2>
                    <div style="display: flex; gap: 1rem; align-items: center;">
                        <input type="text" id="client-search" placeholder="🔍 Search clients..." style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 250px;" oninput="filterClients()">
                        <button class="btn btn-secondary" onclick="exportClientsToExcel()">📊 Export to Excel</button>
                        <button class="btn btn-primary" onclick="openClientModal()">+ Add Client</button>
                    </div>
                </div>

                <!-- Client Stats -->
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem;">
                    <div class="stat-card">
                        <h3>Total Clients</h3>
                        <div class="value" id="stat-total-clients">0</div>
                    </div>
                    <div class="stat-card" style="border-left-color: #48bb78;">
                        <h3>Repeat Clients</h3>
                        <div class="value" id="stat-repeat-clients">0</div>
                        <small style="color: #718096;">Multiple jobs</small>
                    </div>
                </div>

                <!-- Client Distribution by ZIP -->
                <div class="card" style="margin-bottom: 2rem;">
                    <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="toggleZipDistribution()">
                        <h3>Client Distribution by ZIP Code</h3>
                        <span id="zip-toggle-icon" style="font-size: 1.5rem; user-select: none;">▼</span>
                    </div>
                    <div id="zip-distribution" style="padding: 1rem;"></div>
                </div>

                <div id="clients-list"></div>
            </div>
        </div>

        <!-- Client Detail View -->
        <div id="client-detail" class="view">
            <div class="card">
                <div class="card-header">
                    <button class="btn btn-secondary" onclick="showView('clients')">← Back to Clients</button>
                    <h2 id="client-detail-name"></h2>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 2rem;">
                    <div>
                        <h3 style="margin-bottom: 1rem; color: #667eea;">Contact Information</h3>
                        <div id="client-detail-info" style="background: #f8f9fa; padding: 1.5rem; border-radius: 8px;"></div>
                    </div>
                    <div>
                        <h3 style="margin-bottom: 1rem; color: #667eea;">Jobs</h3>
                        <div id="client-detail-jobs"></div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Jobs View -->
        <div id="jobs" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>Jobs</h2>
                    <div style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
                        <select id="filter-status" onchange="filterJobs()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 150px;">
                            <option value="">All Statuses</option>
                            <option value="prospecting">Prospecting</option>
                            <option value="scheduled">Scheduled</option>
                            <option value="in_progress">In Progress</option>
                            <option value="completed">Completed</option>
                            <option value="invoiced">Invoiced</option>
                            <option value="bid_lost">Bid Lost</option>
                        </select>
                        <select id="filter-client" onchange="filterJobs()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 180px;">
                            <option value="">All Clients</option>
                        </select>
                        <select id="filter-assigned" onchange="filterJobs()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 180px;">
                            <option value="">All Team Members</option>
                        </select>
                        <button class="btn btn-secondary" onclick="clearJobFilters()" style="margin-left: auto;">Clear Filters</button>
                        <button class="btn btn-secondary" onclick="exportJobsToExcel()">📊 Export to Excel</button>
                        <button class="btn btn-primary" onclick="openJobModal()">+ Create Job</button>
                    </div>
                </div>
                <div id="jobs-list"></div>
            </div>
        </div>

        <!-- Calendar View -->
        <div id="calendar" class="view">
            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
                    <h2>Calendar</h2>
                    <div style="display: flex; gap: 1rem; align-items: center;">
                        <button class="btn btn-secondary" onclick="changeMonth(-1)">‹ Prev</button>
                        <h2 id="calendar-month-year" style="min-width: 200px; text-align: center;"></h2>
                        <button class="btn btn-secondary" onclick="changeMonth(1)">Next ›</button>
                        <button class="btn btn-primary" onclick="goToToday()">Today</button>
                    </div>
                </div>
                <div id="calendar-grid" style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; background: #e2e8f0; border: 1px solid #e2e8f0;"></div>
            </div>
        </div>

        <!-- Team View -->
        <div id="team" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>Team Members</h2>
                    <div style="display: flex; gap: 1rem; align-items: center;">
                        <input type="text" id="team-search" placeholder="🔍 Search team members..." style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 250px;" oninput="filterTeam()">
                        <button class="btn btn-primary" onclick="openTeamModal()">+ Add Team Member</button>
                    </div>
                </div>
                <div id="team-list"></div>
            </div>
        </div>

        <!-- Team Member Detail View -->
        <div id="team-detail" class="view">
            <div class="card">
                <div class="card-header">
                    <button class="btn btn-secondary" onclick="showView('team')">← Back to Team</button>
                    <h2 id="team-detail-name"></h2>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 2rem;">
                    <div>
                        <h3 style="margin-bottom: 1rem; color: #667eea;">Team Member Info</h3>
                        <div id="team-detail-info" style="background: #f8f9fa; padding: 1.5rem; border-radius: 8px;"></div>
                    </div>
                    <div>
                        <h3 style="margin-bottom: 1rem; color: #667eea;">Assigned Jobs</h3>
                        <div id="team-detail-jobs"></div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Reports View -->
        <div id="reports" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>Business Reports</h2>
                </div>
                <div style="padding: 1.5rem; background: #f8f9fa; border-radius: 8px; margin-bottom: 2rem;">
                    <h3 style="margin-bottom: 1rem; color: #667eea;">Filters</h3>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
                        <div>
                            <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">Date Range</label>
                            <select id="report-date-range" onchange="updateReportDateRange()" style="width: 100%; padding: 0.5rem; border: 2px solid #e2e8f0; border-radius: 8px;">
                                <option value="today">Today</option>
                                <option value="yesterday">Yesterday</option>
                                <option value="this-week">This Week</option>
                                <option value="last-week">Last Week</option>
                                <option value="this-month" selected>This Month</option>
                                <option value="last-month">Last Month</option>
                                <option value="this-quarter">This Quarter</option>
                                <option value="last-quarter">Last Quarter</option>
                                <option value="this-year">This Year</option>
                                <option value="last-year">Last Year</option>
                                <option value="all-time">All Time</option>
                                <option value="custom">Custom Range</option>
                            </select>
                        </div>
                        <div id="custom-date-range" style="display: none; grid-column: span 2;">
                            <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">From</label>
                            <input type="date" id="report-date-from" style="width: 100%; padding: 0.5rem; border: 2px solid #e2e8f0; border-radius: 8px; margin-bottom: 0.5rem;">
                            <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">To</label>
                            <input type="date" id="report-date-to" style="width: 100%; padding: 0.5rem; border: 2px solid #e2e8f0; border-radius: 8px;">
                        </div>
                        <div>
                            <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">Client</label>
                            <select id="report-filter-client" style="width: 100%; padding: 0.5rem; border: 2px solid #e2e8f0; border-radius: 8px;">
                                <option value="">All Clients</option>
                            </select>
                        </div>
                        <div>
                            <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">Team Member</label>
                            <select id="report-filter-team" style="width: 100%; padding: 0.5rem; border: 2px solid #e2e8f0; border-radius: 8px;">
                                <option value="">All Team Members</option>
                            </select>
                        </div>
                        <div>
                            <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">Status</label>
                            <select id="report-filter-status" style="width: 100%; padding: 0.5rem; border: 2px solid #e2e8f0; border-radius: 8px;">
                                <option value="">All Statuses</option>
                                <option value="prospecting">Prospecting</option>
                                <option value="scheduled">Scheduled</option>
                                <option value="in_progress">In Progress</option>
                                <option value="completed">Completed</option>
                                <option value="invoiced">Invoiced</option>
                                <option value="bid_lost">Bid Lost</option>
                            </select>
                        </div>
                        <div style="display: flex; align-items: flex-end; gap: 0.5rem;">
                            <button class="btn btn-primary" onclick="generateReports()" style="flex: 1;">Generate Reports</button>
                            <button class="btn btn-secondary" onclick="printReports()">🖨️ Print</button>
                        </div>
                    </div>
                </div>

                <div id="reports-container">
                    <!-- Revenue Summary Report -->
                    <div class="report-section">
                        <h3>📊 Revenue Summary</h3>
                        <div id="revenue-report"></div>
                    </div>

                    <!-- Jobs by Status Report -->
                    <div class="report-section">
                        <h3>📋 Jobs by Status</h3>
                        <div id="jobs-status-report"></div>
                    </div>

                    <!-- Top Clients Report -->
                    <div class="report-section">
                        <h3>👥 Top Clients</h3>
                        <div id="top-clients-report"></div>
                    </div>

                    <!-- Team Performance Report -->
                    <div class="report-section">
                        <h3>👷 Team Performance</h3>
                        <div id="team-performance-report"></div>
                    </div>

                    <!-- Revenue Trend Report -->
                    <div class="report-section">
                        <h3>📈 Revenue by Month</h3>
                        <div id="revenue-trend-report"></div>
                    </div>

                    <!-- Detailed Jobs List -->
                    <div class="report-section">
                        <h3>📝 Detailed Jobs List</h3>
                        <div id="jobs-detail-report"></div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Settings View -->
        <div id="settings" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>Settings</h2>
                </div>
                <form id="settingsForm" style="max-width: 600px;">
                    <h3 style="margin-bottom: 1rem; color: #667eea;">Company Information</h3>
                    <div class="form-group">
                        <label>Company Logo</label>
                        <div style="display: flex; align-items: center; gap: 1rem;">
                            <img id="logo-preview" src="" alt="Logo preview" style="max-width: 150px; max-height: 100px; display: none; border: 2px solid #e2e8f0; border-radius: 8px; padding: 0.5rem;">
                            <div>
                                <input type="file" id="logo-upload" accept="image/*" style="display: none;" onchange="handleLogoUpload(event)">
                                <button type="button" class="btn btn-secondary" onclick="document.getElementById('logo-upload').click()">Upload Logo</button>
                                <button type="button" class="btn btn-danger btn-small" id="remove-logo" onclick="removeLogo()" style="display: none; margin-left: 0.5rem;">Remove</button>
                            </div>
                        </div>
                        <small style="color: #718096; display: block; margin-top: 0.5rem;">Recommended: PNG or JPG, max 500KB</small>
                        <input type="hidden" name="companyLogo" id="companyLogo">
                    </div>
                    <div class="form-group">
                        <label>Company Name</label>
                        <input type="text" name="companyName" required>
                    </div>
                    <div class="form-group">
                        <label>Address</label>
                        <textarea name="companyAddress" rows="3"></textarea>
                    </div>
                    <div class="form-group">
                        <label>Phone</label>
                        <input type="tel" name="companyPhone">
                    </div>
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" name="companyEmail">
                    </div>

                    <h3 style="margin: 2rem 0 1rem 0; color: #667eea;">Billing Settings</h3>
                    <div class="form-group">
                        <label>Default Hourly Rate ($)</label>
                        <input type="number" name="hourlyRate" step="0.01" min="0">
                    </div>
                    <div class="form-group">
                        <label>Tax Rate (%)</label>
                        <input type="number" name="taxRatePercent" step="0.001" min="0" placeholder="e.g., 6.625 for NJ">
                        <small style="color: #718096; display: block; margin-top: 0.5rem;">NJ sales tax is 6.625%</small>
                    </div>

                    <div style="margin-top: 2rem;">
                        <button type="button" class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
                    </div>
                </form>
            </div>

            <!-- Password Change Section -->
            <div class="card" style="margin-top: 2rem;">
                <div class="card-header">
                    <h2>Change Password</h2>
                </div>
                <form id="passwordForm" style="max-width: 600px;">
                    <div class="form-group">
                        <label>Current Password</label>
                        <input type="password" id="currentPassword" required>
                    </div>
                    <div class="form-group">
                        <label>New Password</label>
                        <input type="password" id="newPassword" required minlength="6">
                        <small style="color: #718096; display: block; margin-top: 0.5rem;">Minimum 6 characters</small>
                    </div>
                    <div class="form-group">
                        <label>Confirm New Password</label>
                        <input type="password" id="confirmPassword" required minlength="6">
                    </div>
                    <div style="margin-top: 2rem;">
                        <button type="button" class="btn btn-primary" onclick="changePassword()">Change Password</button>
                    </div>
                </form>
            </div>

            <!-- User Management Section (Admin Only) -->
            <div class="card" id="userManagementSection" style="margin-top: 2rem; display: none;">
                <div class="card-header">
                    <h2>User Management</h2>
                    <button class="btn btn-primary" onclick="showAddUserModal()">+ Add User</button>
                </div>
                <div id="usersList"></div>
            </div>
        </div>
    </div>

    <!-- Client Modal -->
    <div id="clientModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 id="clientModalTitle">Add Client</h2>
                <button class="close-btn" onclick="closeModal('clientModal')">&times;</button>
            </div>
            <div class="modal-body">
                <form id="clientForm">
                    <div class="form-group">
                        <label>Name *</label>
                        <input type="text" name="name" required>
                    </div>
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" name="email">
                    </div>
                    <div class="form-group">
                        <label>Phone *</label>
                        <input type="tel" name="phone" required placeholder="(555)555-5555" oninput="maskPhoneInput(this)">
                    </div>
                    <h3 style="margin-top: 1.5rem; margin-bottom: 0.5rem;">Address</h3>
                    <div class="form-group">
                        <label>Street Line 1</label>
                        <input type="text" name="addressLine1">
                    </div>
                    <div class="form-group">
                        <label>Street Line 2</label>
                        <input type="text" name="addressLine2">
                    </div>
                    <div class="form-group">
                        <label>Street Line 3</label>
                        <input type="text" name="addressLine3">
                    </div>
                    <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 1rem;">
                        <div class="form-group">
                            <label>City</label>
                            <input type="text" name="city">
                        </div>
                        <div class="form-group">
                            <label>State</label>
                            <input type="text" name="state" list="statesList" maxlength="2" style="text-transform: uppercase;">
                        </div>
                        <div class="form-group">
                            <label>ZIP</label>
                            <input type="text" name="zipCode" maxlength="10">
                        </div>
                    </div>
                    <datalist id="statesList">
                        <option value="AL"><option value="AK"><option value="AZ"><option value="AR"><option value="CA">
                        <option value="CO"><option value="CT"><option value="DE"><option value="FL"><option value="GA">
                        <option value="HI"><option value="ID"><option value="IL"><option value="IN"><option value="IA">
                        <option value="KS"><option value="KY"><option value="LA"><option value="ME"><option value="MD">
                        <option value="MA"><option value="MI"><option value="MN"><option value="MS"><option value="MO">
                        <option value="MT"><option value="NE"><option value="NV"><option value="NH"><option value="NJ">
                        <option value="NM"><option value="NY"><option value="NC"><option value="ND"><option value="OH">
                        <option value="OK"><option value="OR"><option value="PA"><option value="RI"><option value="SC">
                        <option value="SD"><option value="TN"><option value="TX"><option value="UT"><option value="VT">
                        <option value="VA"><option value="WA"><option value="WV"><option value="WI"><option value="WY">
                    </datalist>
                    <div class="form-group">
                        <label>Marketing Channel</label>
                        <select name="marketingChannel">
                            <option value="">Select...</option>
                            <option value="referral">Referral</option>
                            <option value="google">Google Search</option>
                            <option value="social">Social Media</option>
                            <option value="website">Website</option>
                            <option value="repeat">Repeat Customer</option>
                            <option value="other">Other</option>
                        </select>
                    </div>
                    <div class="form-group" style="margin-top: 1rem;">
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                            <input type="checkbox" name="isPropertyManagement" id="isPropertyManagementCheckbox" onchange="togglePropertyManagementFields()" style="width: auto; cursor: pointer;">
                            <span>Property Management?</span>
                        </label>
                    </div>
                    <div id="propertyManagementFields" style="display: none; border-left: 3px solid #667eea; padding-left: 1rem; margin-top: 1rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                            <h3 style="margin: 0; color: #667eea;">Service Locations</h3>
                            <button type="button" class="btn btn-primary btn-small" onclick="addServiceLocation()">+ Add Location</button>
                        </div>
                        <div id="serviceLocationsContainer"></div>
                    </div>
                    <div class="form-group">
                        <label>Notes</label>
                        <textarea name="notes"></textarea>
                    </div>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('clientModal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveClient()">Save Client</button>
            </div>
        </div>
    </div>

    <!-- Job Modal -->
    <div id="jobModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 id="jobModalTitle">Create Job</h2>
                <button class="close-btn" onclick="closeModal('jobModal')">&times;</button>
            </div>
            <div class="modal-body">
                <form id="jobForm">
                    <input type="hidden" name="id">
                    <div class="form-group">
                        <label>Client *</label>
                        <select name="clientId" required id="jobClientSelect">
                            <option value="">Select a client...</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Job Title *</label>
                        <input type="text" name="title" required>
                    </div>
                    <div class="form-group">
                        <label>Description</label>
                        <textarea name="description"></textarea>
                    </div>
                    <div class="form-group">
                        <label>Scheduled Date *</label>
                        <input type="date" name="scheduledDate" required>
                    </div>
                    <div class="form-group">
                        <label>Scheduled Time</label>
                        <input type="time" name="scheduledTime">
                    </div>
                    <div class="form-group">
                        <label>Assigned To</label>
                        <select name="assignedTo" id="jobTeamSelect" onchange="handleTeamMemberChange()">
                            <option value="">Unassigned</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Status *</label>
                        <select name="status" required>
                            <option value="prospecting">Prospecting</option>
                            <option value="scheduled">Scheduled</option>
                            <option value="in_progress">In Progress</option>
                            <option value="completed">Completed</option>
                            <option value="invoiced">Invoiced</option>
                            <option value="bid_lost">Bid Lost</option>
                        </select>
                    </div>

                    <div class="form-group" style="margin-top: 1rem;">
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                            <input type="checkbox" name="taxWaived" id="taxWaivedCheckbox" onchange="updateJobTotal()" style="width: auto; cursor: pointer;">
                            <span>Tax Exempt / Waive Tax</span>
                        </label>
                    </div>

                    <div style="margin-top: 2rem;">
                        <h3 style="margin-bottom: 1rem;">Labor</h3>
                        <div id="laborItems"></div>
                        <button type="button" class="btn btn-secondary" onclick="addLaborItem()" style="margin-top: 0.5rem;">+ Add Labor</button>
                    </div>

                    <div style="margin-top: 2rem;">
                        <h3 style="margin-bottom: 1rem;">Materials</h3>
                        <div id="materialItems"></div>
                        <button type="button" class="btn btn-secondary" onclick="addMaterialItem()" style="margin-top: 0.5rem;">+ Add Material</button>
                    </div>

                    <div style="margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #ddd;">
                        <h3>Total Billed: $<span id="jobTotalDisplay">0.00</span></h3>
                    </div>

                    <div style="margin-top: 2rem;">
                        <h3 style="margin-bottom: 1rem;">Payments Received</h3>
                        <div id="paymentItems"></div>
                        <button type="button" class="btn btn-secondary" onclick="addPaymentItem()" style="margin-top: 0.5rem;">+ Add Payment</button>

                        <div style="margin-top: 1rem; padding: 1rem; background-color: #f7fafc; border-radius: 8px;">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                                <span>Subtotal:</span>
                                <span>$<span id="subtotalSummary">0.00</span></span>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                                <span>Tax:</span>
                                <span>$<span id="taxSummary">0.00</span></span>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; padding-top: 0.5rem; border-top: 1px solid #cbd5e0;">
                                <strong>Total Billed:</strong>
                                <strong>$<span id="totalBilledSummary">0.00</span></strong>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                                <strong>Total Paid:</strong>
                                <span style="color: #48bb78;">$<span id="totalPaidSummary">0.00</span></span>
                            </div>
                            <div style="display: flex; justify-content: space-between; padding-top: 0.5rem; border-top: 1px solid #cbd5e0;">
                                <strong>Balance Owed:</strong>
                                <strong style="color: #e53e3e;">$<span id="balanceOwedSummary">0.00</span></strong>
                            </div>
                        </div>
                    </div>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('jobModal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveJob()">Save Job</button>
            </div>
        </div>
    </div>

    <!-- Team Modal -->
    <div id="teamModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 id="teamModalTitle">Add Team Member</h2>
                <button class="close-btn" onclick="closeModal('teamModal')">&times;</button>
            </div>
            <div class="modal-body">
                <form id="teamForm">
                    <div class="form-group">
                        <label>Name *</label>
                        <input type="text" name="name" required>
                    </div>
                    <div class="form-group">
                        <label>Role *</label>
                        <input type="text" name="role" required>
                    </div>
                    <div class="form-group">
                        <label>Phone</label>
                        <input type="tel" name="phone" placeholder="(555)555-5555" oninput="maskPhoneInput(this)">
                    </div>
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" name="email">
                    </div>
                    <div class="form-group">
                        <label>Hourly Rate ($)</label>
                        <input type="number" name="hourlyRate" step="0.01" min="0" placeholder="75.00">
                    </div>
                    <h3 style="margin-top: 1.5rem; margin-bottom: 0.5rem;">Address</h3>
                    <div class="form-group">
                        <label>Street Line 1</label>
                        <input type="text" name="addressLine1">
                    </div>
                    <div class="form-group">
                        <label>Street Line 2</label>
                        <input type="text" name="addressLine2">
                    </div>
                    <div class="form-group">
                        <label>Street Line 3</label>
                        <input type="text" name="addressLine3">
                    </div>
                    <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 1rem;">
                        <div class="form-group">
                            <label>City</label>
                            <input type="text" name="city">
                        </div>
                        <div class="form-group">
                            <label>State</label>
                            <input type="text" name="state" list="statesListTeam" maxlength="2" style="text-transform: uppercase;">
                        </div>
                        <div class="form-group">
                            <label>ZIP</label>
                            <input type="text" name="zipCode" maxlength="10">
                        </div>
                    </div>
                    <datalist id="statesListTeam">
                        <option value="AL"><option value="AK"><option value="AZ"><option value="AR"><option value="CA">
                        <option value="CO"><option value="CT"><option value="DE"><option value="FL"><option value="GA">
                        <option value="HI"><option value="ID"><option value="IL"><option value="IN"><option value="IA">
                        <option value="KS"><option value="KY"><option value="LA"><option value="ME"><option value="MD">
                        <option value="MA"><option value="MI"><option value="MN"><option value="MS"><option value="MO">
                        <option value="MT"><option value="NE"><option value="NV"><option value="NH"><option value="NJ">
                        <option value="NM"><option value="NY"><option value="NC"><option value="ND"><option value="OH">
                        <option value="OK"><option value="OR"><option value="PA"><option value="RI"><option value="SC">
                        <option value="SD"><option value="TN"><option value="TX"><option value="UT"><option value="VT">
                        <option value="VA"><option value="WA"><option value="WV"><option value="WI"><option value="WY">
                    </datalist>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('teamModal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveTeamMember()">Save</button>
            </div>
        </div>
    </div>

    <!-- Add User Modal -->
    <div id="addUserModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 id="addUserModalTitle">Add User</h2>
                <button class="close-btn" onclick="closeUserModal()">&times;</button>
            </div>
            <div class="modal-body">
                <form id="addUserForm">
                    <div class="form-group">
                        <label>Full Name *</label>
                        <input type="text" name="name" required>
                    </div>
                    <div class="form-group">
                        <label>Email *</label>
                        <input type="email" name="email" required>
                    </div>
                    <div class="form-group">
                        <label>Password *</label>
                        <input type="password" name="password" required minlength="6">
                        <small style="color: #718096; display: block; margin-top: 0.5rem;">Minimum 6 characters</small>
                    </div>
                    <div class="form-group">
                        <label>Role *</label>
                        <select name="role" required>
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                        </select>
                    </div>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeUserModal()">Cancel</button>
                <button class="btn btn-primary" onclick="saveUser()">Add User</button>
            </div>
        </div>
    </div>

    <script>
        let clients = [];
        let jobs = [];
        let settings = {};
        let team = [];
        let hasUnsavedChanges = false;
        let currentUserRole = 'user'; // Default to user, updated on load
        let isAdmin = false;

        // Helper function to calculate total with tax
        function calculateTotalWithTax(total) {
            // job.total is already stored WITH tax included (or without if taxWaived)
            // So just return it as-is
            return total;
        }

        // Phone number formatting
        function formatPhoneNumber(phone) {
            if (!phone) return '';
            const cleaned = phone.replace(/\D/g, '');
            if (cleaned.length === 10) {
                return `(${cleaned.slice(0,3)})${cleaned.slice(3,6)}-${cleaned.slice(6)}`;
            }
            return phone;
        }

        function maskPhoneInput(input) {
            let value = input.value.replace(/\D/g, '');
            if (value.length > 10) value = value.slice(0, 10);
            if (value.length >= 6) {
                input.value = `(${value.slice(0,3)})${value.slice(3,6)}-${value.slice(6)}`;
            } else if (value.length >= 3) {
                input.value = `(${value.slice(0,3)})${value.slice(3)}`;
            } else if (value.length > 0) {
                input.value = `(${value}`;
            }
        }

        // Track form changes
        function markFormDirty() {
            hasUnsavedChanges = true;
        }

        function markFormClean() {
            hasUnsavedChanges = false;
        }

        // Navigation
        function showView(viewName) {
            // Check permissions - users can only access jobs and calendar
            const adminOnlyViews = ['dashboard', 'clients', 'team', 'reports', 'settings'];
            if (!isAdmin && adminOnlyViews.includes(viewName)) {
                alert('You do not have permission to access this section.');
                return;
            }

            // Check for unsaved changes
            if (hasUnsavedChanges) {
                if (!confirm('You have unsaved changes. Do you want to discard them?')) {
                    return;
                }
                hasUnsavedChanges = false;
            }

            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

            document.getElementById(viewName).classList.add('active');
            if (event && event.target) {
                event.target.classList.add('active');
            }

            if (viewName === 'dashboard') loadDashboard();
            if (viewName === 'clients') loadClients();
            if (viewName === 'jobs') loadJobs();
            if (viewName === 'calendar') loadCalendar();
            if (viewName === 'team') loadTeam();
            if (viewName === 'reports') loadReports();
            if (viewName === 'settings') {
                loadSettings();
                loadUsers();
            }
        }

        // Add change listeners to all forms
        window.addEventListener('DOMContentLoaded', () => {
            // Settings form
            const settingsForm = document.getElementById('settingsForm');
            if (settingsForm) {
                settingsForm.addEventListener('input', markFormDirty);
                settingsForm.addEventListener('change', markFormDirty);
            }

            // Client form
            const clientForm = document.getElementById('clientForm');
            if (clientForm) {
                clientForm.addEventListener('input', markFormDirty);
                clientForm.addEventListener('change', markFormDirty);
            }

            // Job form
            const jobForm = document.getElementById('jobForm');
            if (jobForm) {
                jobForm.addEventListener('input', markFormDirty);
                jobForm.addEventListener('change', markFormDirty);
            }

            // Team form
            const teamForm = document.getElementById('teamForm');
            if (teamForm) {
                teamForm.addEventListener('input', markFormDirty);
                teamForm.addEventListener('change', markFormDirty);
            }
        });

        // Modals
        let currentEditingClientId = null;

        function editClient(clientId) {
            if (!isAdmin) {
                alert('You do not have permission to edit clients.');
                return;
            }
            const client = clients.find(c => c.id == clientId || c._id == clientId);
            if (client) {
                openClientModal(client);
            }
        }

        function openClientModal(client = null) {
            if (!isAdmin) {
                alert('You do not have permission to create or edit clients.');
                return;
            }

            const form = document.getElementById('clientForm');
            currentEditingClientId = null;

            if (client) {
                document.getElementById('clientModalTitle').textContent = 'Edit Client';
                currentEditingClientId = client._id || client.id;

                // Populate form fields
                Object.keys(client).forEach(key => {
                    const input = form.elements[key];
                    if (input && input.type !== 'checkbox') {
                        input.value = client[key] || '';
                    }
                });

                // Handle property management checkbox
                const pmCheckbox = document.getElementById('isPropertyManagementCheckbox');
                pmCheckbox.checked = client.isPropertyManagement || false;

                // Load service locations
                serviceLocations = client.serviceLocations || [];
                togglePropertyManagementFields();
                renderServiceLocations();

                // Migrate old address field to new structured fields if needed
                if (client.address && !client.addressLine1) {
                    form.elements.addressLine1.value = client.address;
                }
            } else {
                document.getElementById('clientModalTitle').textContent = 'Add Client';
                form.reset();
                serviceLocations = [];
                document.getElementById('propertyManagementFields').style.display = 'none';
                renderServiceLocations();
            }

            document.getElementById('clientModal').classList.add('active');
        }

        let currentEditingJobId = null;

        function editJob(jobId) {
            if (!isAdmin) {
                alert('You do not have permission to edit jobs.');
                return;
            }
            // Search in all job arrays
            let job = jobs.find(j => j.id == jobId || j._id == jobId);
            if (!job && window.upcomingJobs) {
                job = window.upcomingJobs.find(j => j.id == jobId || j._id == jobId);
            }
            if (!job && window.inProgressJobs) {
                job = window.inProgressJobs.find(j => j.id == jobId || j._id == jobId);
            }
            if (!job && window.completedJobs) {
                job = window.completedJobs.find(j => j.id == jobId || j._id == jobId);
            }
            if (job) {
                openJobModal(job);
            } else {
                console.error('Job not found:', jobId);
            }
        }

        function openJobModal(job = null) {
            if (!isAdmin) {
                alert('You do not have permission to create or edit jobs.');
                return;
            }

            const form = document.getElementById('jobForm');

            // Populate dropdowns FIRST
            populateJobSelects();

            // Reset line items
            laborItems = [];
            materialItems = [];
            paymentItems = [];
            currentEditingJobId = null;

            if (job) {
                document.getElementById('jobModalTitle').textContent = 'Edit Job';
                currentEditingJobId = job._id || job.id;

                // Set all form values including dropdowns
                Object.keys(job).forEach(key => {
                    const input = form.elements[key];
                    if (input) {
                        // For checkboxes, set the checked property
                        if (input.type === 'checkbox') {
                            input.checked = job[key] || false;
                        }
                        // For select dropdowns, ensure the value exists in options before setting
                        else if (input.tagName === 'SELECT') {
                            input.value = job[key] || '';
                        } else {
                            input.value = job[key] || '';
                        }
                    }
                });

                // Load line items if they exist
                if (job.laborItems) laborItems = [...job.laborItems];
                if (job.materialItems) materialItems = [...job.materialItems];
                if (job.payments) paymentItems = [...job.payments];
            } else {
                document.getElementById('jobModalTitle').textContent = 'Create Job';
                form.reset();
            }

            renderLineItems();
            document.getElementById('jobModal').classList.add('active');
        }

        let currentEditingTeamId = null;

        function editTeamMember(teamId) {
            if (!isAdmin) {
                alert('You do not have permission to edit team members.');
                return;
            }
            const member = team.find(t => t.id == teamId || t._id == teamId);
            if (member) {
                openTeamModal(member);
            }
        }

        function openTeamModal(member = null) {
            if (!isAdmin) {
                alert('You do not have permission to create or edit team members.');
                return;
            }

            const form = document.getElementById('teamForm');
            currentEditingTeamId = null;

            if (member) {
                document.getElementById('teamModalTitle').textContent = 'Edit Team Member';
                currentEditingTeamId = member._id || member.id;

                // Populate form fields
                Object.keys(member).forEach(key => {
                    const input = form.elements[key];
                    if (input) {
                        input.value = member[key] || '';
                    }
                });
            } else {
                document.getElementById('teamModalTitle').textContent = 'Add Team Member';
                form.reset();
            }

            document.getElementById('teamModal').classList.add('active');
        }

        function closeModal(modalId) {
            // Check for unsaved changes in modal forms
            if (hasUnsavedChanges) {
                if (!confirm('You have unsaved changes. Do you want to discard them?')) {
                    return;
                }
                hasUnsavedChanges = false;
            }
            document.getElementById(modalId).classList.remove('active');
        }

        function populateJobSelects() {
            const clientSelect = document.getElementById('jobClientSelect');
            const teamSelect = document.getElementById('jobTeamSelect');

            clientSelect.innerHTML = '<option value="">Select a client...</option>' +
                clients.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');

            teamSelect.innerHTML = '<option value="">Unassigned</option>' +
                team.filter(t => t.active).map(t => \`<option value="\${t.id}">\${t.name}</option>\`).join('');
        }

        // Save functions
        async function saveClient() {
            const form = document.getElementById('clientForm');
            const formData = new FormData(form);
            const client = Object.fromEntries(formData);

            // Convert checkbox to boolean
            client.isPropertyManagement = document.getElementById('isPropertyManagementCheckbox').checked;

            // Add service locations if property management is enabled
            if (client.isPropertyManagement) {
                client.serviceLocations = serviceLocations;
            }

            // If editing, include the _id
            if (currentEditingClientId) {
                client._id = currentEditingClientId;
            }

            const response = await fetch('/api/clients', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(client)
            });

            if (response.ok) {
                markFormClean();
                closeModal('clientModal');
                loadClients();
            }
        }

        let laborItems = [];
        let materialItems = [];
        let paymentItems = [];

        function addLaborItem() {
            const id = Date.now();
            const selectElement = document.getElementById('jobTeamSelect');
            const selectedTeamId = selectElement.value;

            let defaultRate = settings.hourlyRate || 75;

            // If a team member is assigned, use their rate
            if (selectedTeamId) {
                const teamMember = team.find(t => t.id == selectedTeamId);
                if (teamMember && teamMember.hourlyRate) {
                    defaultRate = parseFloat(teamMember.hourlyRate);
                }
            }

            laborItems.push({ id, description: '', hours: 0, rate: defaultRate });
            renderLineItems();
            markFormDirty();
        }

        function addMaterialItem() {
            const id = Date.now();
            materialItems.push({ id, description: '', quantity: 0, price: 0 });
            renderLineItems();
            markFormDirty();
        }

        function addPaymentItem() {
            const id = Date.now();
            const today = new Date().toISOString().split('T')[0];
            paymentItems.push({ id, date: today, amount: 0, method: 'cash', notes: '' });
            renderLineItems();
            markFormDirty();
        }

        function handleTeamMemberChange() {
            const selectElement = document.getElementById('jobTeamSelect');
            const selectedTeamId = selectElement.value;

            if (!selectedTeamId) return;

            const teamMember = team.find(t => t.id == selectedTeamId);
            if (!teamMember || !teamMember.hourlyRate) return;

            // Update all existing labor items with the team member's rate
            laborItems.forEach(item => {
                item.rate = parseFloat(teamMember.hourlyRate);
            });

            // If no labor items exist, add one with the team member's rate
            if (laborItems.length === 0) {
                const id = Date.now();
                laborItems.push({ id, description: '', hours: 0, rate: parseFloat(teamMember.hourlyRate) });
            }

            renderLineItems();
            markFormDirty();
        }

        function removeLaborItem(id) {
            laborItems = laborItems.filter(item => item.id !== id);
            renderLineItems();
            markFormDirty();
        }

        function removeMaterialItem(id) {
            materialItems = materialItems.filter(item => item.id !== id);
            renderLineItems();
            markFormDirty();
        }

        function removePaymentItem(id) {
            paymentItems = paymentItems.filter(item => item.id !== id);
            renderLineItems();
            markFormDirty();
        }

        function renderLineItems() {
            const laborContainer = document.getElementById('laborItems');
            const materialContainer = document.getElementById('materialItems');
            const paymentContainer = document.getElementById('paymentItems');

            laborContainer.innerHTML = laborItems.map(item => \`
                <div class="line-item" style="display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 40px; gap: 0.5rem; margin-bottom: 0.5rem; align-items: end;">
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Description</label>
                        <input type="text" value="\${item.description}" onchange="updateLaborItem(\${item.id}, 'description', this.value)" placeholder="Labor description">
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Hours</label>
                        <input type="number" value="\${item.hours}" onchange="updateLaborItem(\${item.id}, 'hours', this.value)" step="0.5" min="0">
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Rate ($)</label>
                        <input type="number" value="\${item.rate}" onchange="updateLaborItem(\${item.id}, 'rate', this.value)" step="0.01" min="0">
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Total</label>
                        <input type="text" value="$\${(item.hours * item.rate).toFixed(2)}" readonly style="background: #f5f5f5;">
                    </div>
                    <button type="button" onclick="removeLaborItem(\${item.id})" style="background: #dc3545; color: white; border: none; padding: 0.5rem; border-radius: 4px; cursor: pointer; height: 38px;">×</button>
                </div>
            \`).join('');

            materialContainer.innerHTML = materialItems.map(item => \`
                <div class="line-item" style="display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 40px; gap: 0.5rem; margin-bottom: 0.5rem; align-items: end;">
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Description</label>
                        <input type="text" value="\${item.description}" onchange="updateMaterialItem(\${item.id}, 'description', this.value)" placeholder="Material description">
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Quantity</label>
                        <input type="number" value="\${item.quantity}" onchange="updateMaterialItem(\${item.id}, 'quantity', this.value)" step="1" min="0">
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Price ($)</label>
                        <input type="number" value="\${item.price}" onchange="updateMaterialItem(\${item.id}, 'price', this.value)" step="0.01" min="0">
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Total</label>
                        <input type="text" value="$\${(item.quantity * item.price).toFixed(2)}" readonly style="background: #f5f5f5;">
                    </div>
                    <button type="button" onclick="removeMaterialItem(\${item.id})" style="background: #dc3545; color: white; border: none; padding: 0.5rem; border-radius: 4px; cursor: pointer; height: 38px;">×</button>
                </div>
            \`).join('');

            paymentContainer.innerHTML = paymentItems.map(item => \`
                <div class="line-item" style="display: grid; grid-template-columns: 1fr 1fr 1.5fr 2fr 40px; gap: 0.5rem; margin-bottom: 0.5rem; align-items: end;">
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Date</label>
                        <input type="date" value="\${item.date}" onchange="updatePaymentItem(\${item.id}, 'date', this.value)">
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Amount ($)</label>
                        <input type="number" value="\${item.amount}" onchange="updatePaymentItem(\${item.id}, 'amount', this.value)" step="0.01" min="0">
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Method</label>
                        <select value="\${item.method}" onchange="updatePaymentItem(\${item.id}, 'method', this.value)">
                            <option value="cash" \${item.method === 'cash' ? 'selected' : ''}>Cash</option>
                            <option value="check" \${item.method === 'check' ? 'selected' : ''}>Check</option>
                            <option value="venmo" \${item.method === 'venmo' ? 'selected' : ''}>Venmo</option>
                            <option value="credit_card" \${item.method === 'credit_card' ? 'selected' : ''}>Credit Card</option>
                            <option value="other" \${item.method === 'other' ? 'selected' : ''}>Other</option>
                        </select>
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label style="font-size: 0.85rem;">Notes\${item.method === 'other' ? ' *' : ''}</label>
                        <input type="text" value="\${item.notes || ''}" onchange="updatePaymentItem(\${item.id}, 'notes', this.value)" placeholder="\${item.method === 'other' ? 'Required for Other' : 'Optional notes'}">
                    </div>
                    <button type="button" onclick="removePaymentItem(\${item.id})" style="background: #dc3545; color: white; border: none; padding: 0.5rem; border-radius: 4px; cursor: pointer; height: 38px;">×</button>
                </div>
            \`).join('');

            updateJobTotal();
        }

        function updateLaborItem(id, field, value) {
            const item = laborItems.find(i => i.id === id);
            if (item) {
                item[field] = field === 'description' ? value : parseFloat(value) || 0;
                renderLineItems();
                markFormDirty();
            }
        }

        function updateMaterialItem(id, field, value) {
            const item = materialItems.find(i => i.id === id);
            if (item) {
                item[field] = field === 'description' ? value : parseFloat(value) || 0;
                renderLineItems();
                markFormDirty();
            }
        }

        function updatePaymentItem(id, field, value) {
            const item = paymentItems.find(i => i.id === id);
            if (item) {
                if (field === 'amount') {
                    item[field] = parseFloat(value) || 0;
                } else {
                    item[field] = value;
                }
                renderLineItems();
                markFormDirty();
            }
        }

        function updateJobTotal() {
            const laborTotal = laborItems.reduce((sum, item) => sum + (item.hours * item.rate), 0);
            const materialTotal = materialItems.reduce((sum, item) => sum + (item.quantity * item.price), 0);
            const subtotal = laborTotal + materialTotal;

            const taxWaived = document.getElementById('taxWaivedCheckbox')?.checked || false;
            const taxRate = settings.taxRate || 0.06625;
            const tax = taxWaived ? 0 : subtotal * taxRate;
            const totalWithTax = subtotal + tax;

            document.getElementById('jobTotalDisplay').textContent = totalWithTax.toFixed(2);

            const paymentTotal = paymentItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
            const balance = totalWithTax - paymentTotal;
            const isPaidInFull = Math.abs(balance) < 0.01;
            const balanceDisplay = isPaidInFull ? 0 : balance;

            document.getElementById('subtotalSummary').textContent = subtotal.toFixed(2);
            document.getElementById('taxSummary').textContent = tax.toFixed(2);
            document.getElementById('totalBilledSummary').textContent = totalWithTax.toFixed(2);
            document.getElementById('totalPaidSummary').textContent = paymentTotal.toFixed(2);
            document.getElementById('balanceOwedSummary').textContent = balanceDisplay.toFixed(2);

            // Update balance color based on payment status
            const balanceElement = document.getElementById('balanceOwedSummary').parentElement;
            balanceElement.style.color = isPaidInFull ? '#48bb78' : '#e53e3e';
        }

        async function saveJob() {
            const form = document.getElementById('jobForm');
            const formData = new FormData(form);
            const job = Object.fromEntries(formData);

            // If editing, include the _id
            if (currentEditingJobId) {
                job._id = currentEditingJobId;
            }

            // Add line items and payments
            job.laborItems = laborItems;
            job.materialItems = materialItems;
            job.payments = paymentItems;

            // Handle checkbox - it won't be in formData if unchecked
            job.taxWaived = document.getElementById('taxWaivedCheckbox').checked;

            // Calculate totals
            const laborTotal = laborItems.reduce((sum, item) => sum + (item.hours * item.rate), 0);
            const materialTotal = materialItems.reduce((sum, item) => sum + (item.quantity * item.price), 0);
            const subtotal = laborTotal + materialTotal;
            const taxRate = settings.taxRate || 0.06625;
            const taxAmount = job.taxWaived ? 0 : subtotal * taxRate;
            job.total = subtotal + taxAmount;

            const paymentTotal = paymentItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
            job.totalPaid = paymentTotal;
            job.balanceOwed = job.total - paymentTotal;

            const response = await fetch('/api/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(job)
            });

            if (response.ok) {
                markFormClean();
                closeModal('jobModal');
                loadJobs();
                loadDashboard();
            }
        }

        async function saveTeamMember() {
            const form = document.getElementById('teamForm');
            const formData = new FormData(form);
            const member = Object.fromEntries(formData);

            // If editing, include the _id
            if (currentEditingTeamId) {
                member._id = currentEditingTeamId;
            }

            const response = await fetch('/api/team', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(member)
            });

            if (response.ok) {
                markFormClean();
                closeModal('teamModal');
                loadTeam();
            }
        }

        // Load functions
        async function loadDashboard() {
            const response = await fetch('/api/dashboard');
            const stats = await response.json();

            document.getElementById('stat-clients').textContent = stats.totalClients;
            document.getElementById('stat-jobs-month').textContent = stats.jobsThisMonth;
            document.getElementById('stat-revenue').textContent = '$' + (stats.revenueThisMonth || 0).toFixed(2);
            document.getElementById('stat-jobs-today').textContent = stats.jobsToday;

            document.getElementById('stat-prospecting').textContent = stats.prospecting;
            document.getElementById('stat-scheduled').textContent = stats.scheduled;
            document.getElementById('stat-in-progress').textContent = stats.inProgress;
            document.getElementById('stat-completed').textContent = stats.completed;
            document.getElementById('stat-invoiced').textContent = stats.invoiced;
            document.getElementById('stat-bid-lost').textContent = stats.bidLost;

            // Render job list helper function
            const renderJobList = (jobs, emptyMessage) => {
                if (!jobs || jobs.length === 0) {
                    return \`<div class="empty-state" style="padding: 2rem;"><p style="color: #a0aec0;">\${emptyMessage}</p></div>\`;
                }

                return '<div style="max-height: 400px; overflow-y: auto;"><table style="font-size: 0.875rem;"><tbody>' +
                    jobs.map(j => {
                        const client = clients.find(c => c.id == j.clientId);
                        const assigned = team.find(t => t.id == j.assignedTo);
                        return \`<tr style="cursor: pointer; border-bottom: 1px solid #e2e8f0;" onclick="editJob('\${j.id}')">
                            <td style="padding: 0.75rem;">
                                <div style="font-weight: 600; margin-bottom: 0.25rem;">\${j.title}</div>
                                <div style="font-size: 0.75rem; color: #718096;">
                                    \${client ? client.name : 'Unknown'} • \${j.scheduledDate || 'No date'}
                                    \${assigned ? ' • ' + assigned.name : ''}
                                </div>
                            </td>
                        </tr>\`;
                    }).join('') +
                    '</tbody></table></div>';
            };

            // Store job arrays globally for editJob to access
            window.upcomingJobs = stats.upcomingJobs || [];
            window.inProgressJobs = stats.inProgressJobs || [];
            window.completedJobs = stats.completedLast30Days || [];

            // Upcoming jobs
            document.getElementById('upcoming-count').textContent = `(${stats.upcomingJobs?.length || 0})`;
            document.getElementById('upcoming-jobs-list').innerHTML =
                renderJobList(stats.upcomingJobs, 'No upcoming jobs');

            // In Progress jobs
            document.getElementById('in-progress-count').textContent = `(${stats.inProgressJobs?.length || 0})`;
            document.getElementById('in-progress-jobs-list').innerHTML =
                renderJobList(stats.inProgressJobs, 'No jobs in progress');

            // Completed last 30 days
            document.getElementById('completed-count').textContent = `(${stats.completedLast30Days?.length || 0})`;
            document.getElementById('completed-jobs-list').innerHTML =
                renderJobList(stats.completedLast30Days, 'No completed jobs');
        }

        async function loadClients() {
            const response = await fetch('/api/clients');
            clients = await response.json();

            // Always reload jobs to ensure fresh data for stats
            const jobsResponse = await fetch('/api/jobs');
            jobs = await jobsResponse.json();

            // Calculate stats
            const totalClients = clients.length;
            const clientJobCounts = {};

            jobs.forEach(j => {
                if (j.clientId) {
                    clientJobCounts[j.clientId] = (clientJobCounts[j.clientId] || 0) + 1;
                }
            });

            const repeatClients = Object.values(clientJobCounts).filter(count => count > 1).length;

            document.getElementById('stat-total-clients').textContent = totalClients;
            document.getElementById('stat-repeat-clients').textContent = repeatClients;

            // Render ZIP distribution
            renderZipDistribution();

            const container = document.getElementById('clients-list');
            if (clients.length === 0) {
                container.innerHTML = '<div class="empty-state"><h3>No clients yet</h3><p>Add your first client to get started</p></div>';
                return;
            }

            container.innerHTML = '<table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>City, State</th><th>Marketing Channel</th><th>Actions</th></tr></thead><tbody>' +
                clients.map(c => {
                    const cityState = [c.city, c.state].filter(x => x).join(', ') || (c.address ? c.address.substring(0, 30) : '-');
                    return \`<tr style="cursor: pointer;" onclick="viewClientDetail('\${c.id}')">
                        <td><strong>\${c.name}</strong></td>
                        <td>\${c.email || '-'}</td>
                        <td>\${formatPhoneNumber(c.phone)}</td>
                        <td>\${cityState}</td>
                        <td>\${c.marketingChannel || '-'}</td>
                        <td onclick="event.stopPropagation()">
                            <button class="btn btn-secondary btn-small" onclick="editClient('\${c.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Edit</button>
                            <button class="btn btn-danger btn-small" onclick="deleteClient('\${c.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Delete</button>
                        </td>
                    </tr>\`;
                }).join('') +
                '</tbody></table>';
        }

        let serviceLocations = [];

        function togglePropertyManagementFields() {
            const checkbox = document.getElementById('isPropertyManagementCheckbox');
            const fields = document.getElementById('propertyManagementFields');
            fields.style.display = checkbox.checked ? 'block' : 'none';
        }

        function addServiceLocation() {
            const id = Date.now();
            serviceLocations.push({
                id: id,
                address: '',
                name: '',
                contact: '',
                notes: ''
            });
            renderServiceLocations();
        }

        function removeServiceLocation(id) {
            serviceLocations = serviceLocations.filter(loc => loc.id !== id);
            renderServiceLocations();
        }

        function renderServiceLocations() {
            const container = document.getElementById('serviceLocationsContainer');

            if (serviceLocations.length === 0) {
                container.innerHTML = '<p style="color: #718096; padding: 1rem; text-align: center;">No service locations added yet.</p>';
                return;
            }

            container.innerHTML = serviceLocations.map((loc, index) => \`
                <div style="background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                        <strong style="color: #2d3748;">Location #\${index + 1}</strong>
                        <button type="button" class="btn btn-danger btn-small" onclick="removeServiceLocation(\${loc.id})">Remove</button>
                    </div>
                    <div class="form-group">
                        <label>Service Address</label>
                        <textarea onchange="updateServiceLocation(\${loc.id}, 'address', this.value)" rows="2">\${loc.address || ''}</textarea>
                    </div>
                    <div class="form-group">
                        <label>Service Name</label>
                        <input type="text" onchange="updateServiceLocation(\${loc.id}, 'name', this.value)" value="\${loc.name || ''}">
                    </div>
                    <div class="form-group">
                        <label>Service Contact</label>
                        <input type="text" onchange="updateServiceLocation(\${loc.id}, 'contact', this.value)" value="\${loc.contact || ''}">
                    </div>
                    <div class="form-group">
                        <label>Notes</label>
                        <textarea onchange="updateServiceLocation(\${loc.id}, 'notes', this.value)" rows="2">\${loc.notes || ''}</textarea>
                    </div>
                </div>
            \`).join('');
        }

        function updateServiceLocation(id, field, value) {
            const location = serviceLocations.find(loc => loc.id === id);
            if (location) {
                location[field] = value;
            }
        }

        function toggleZipDistribution() {
            const container = document.getElementById('zip-distribution');
            const icon = document.getElementById('zip-toggle-icon');

            if (container.style.display === 'none') {
                container.style.display = 'block';
                icon.textContent = '▼';
            } else {
                container.style.display = 'none';
                icon.textContent = '▶';
            }
        }

        function renderZipDistribution() {
            // Count clients by full ZIP code
            const zipCounts = {};
            const zipCities = {};

            clients.forEach(c => {
                if (c.zipCode && c.state && c.state.toUpperCase() === 'NJ') {
                    const zip = c.zipCode.substring(0, 5);
                    zipCounts[zip] = (zipCounts[zip] || 0) + 1;
                    if (!zipCities[zip] && c.city) {
                        zipCities[zip] = c.city;
                    }
                }
            });

            const container = document.getElementById('zip-distribution');

            if (Object.keys(zipCounts).length === 0) {
                container.innerHTML = '<p style="color: #718096; text-align: center; padding: 2rem;">No NJ client ZIP codes to display</p>';
                return;
            }

            // Sort by count descending
            const sortedZips = Object.entries(zipCounts).sort((a, b) => b[1] - a[1]);

            // Create bar chart style visualization
            const maxCount = Math.max(...Object.values(zipCounts));
            container.innerHTML = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 1rem;">' +
                sortedZips.map(([zip, count]) => {
                    const percentage = (count / maxCount) * 100;
                    const city = zipCities[zip] || 'Unknown';
                    return `
                        <div style="padding: 1rem; background: white; border-radius: 8px; border: 1px solid #e2e8f0;">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                                <strong style="color: #667eea;">${zip}</strong>
                                <span style="font-weight: 600; color: #2d3748;">${count} client${count !== 1 ? 's' : ''}</span>
                            </div>
                            <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.5rem;">${city}</div>
                            <div style="background: #e2e8f0; height: 8px; border-radius: 4px; overflow: hidden;">
                                <div style="background: #667eea; height: 100%; width: ${percentage}%; transition: width 0.3s;"></div>
                            </div>
                        </div>
                    `;
                }).join('') +
                '</div>';
        }

        function filterClients() {
            const searchTerm = document.getElementById('client-search').value.toLowerCase();
            const table = document.querySelector('#clients-list table');
            if (!table) return;

            const rows = table.querySelectorAll('tbody tr');
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(searchTerm) ? '' : 'none';
            });
        }

        function exportClientsToExcel() {
            // Apply current search filter
            const searchTerm = document.getElementById('client-search').value.toLowerCase();

            const filteredClients = clients.filter(c => {
                if (!searchTerm) return true;
                const searchText = `${c.name} ${c.email || ''} ${c.phone || ''} ${c.addressLine1 || ''} ${c.city || ''} ${c.state || ''}`.toLowerCase();
                return searchText.includes(searchTerm);
            });

            if (filteredClients.length === 0) {
                alert('No clients to export');
                return;
            }

            // Create CSV content
            const headers = ['Name', 'Email', 'Phone', 'Address Line 1', 'Address Line 2', 'Address Line 3', 'City', 'State', 'ZIP Code', 'Marketing Channel', 'Notes', 'Date Added'];
            const rows = filteredClients.map(c => {
                return [
                    c.name || '',
                    c.email || '',
                    formatPhoneNumber(c.phone) || '',
                    c.addressLine1 || '',
                    c.addressLine2 || '',
                    c.addressLine3 || '',
                    c.city || '',
                    c.state || '',
                    c.zipCode || '',
                    c.marketingChannel || '',
                    (c.notes || '').replace(/"/g, '""'), // Escape quotes
                    c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''
                ];
            });

            // Build CSV
            let csv = headers.map(h => `"${h}"`).join(',') + '\n';
            rows.forEach(row => {
                csv += row.map(cell => `"${cell}"`).join(',') + '\n';
            });

            // Create download
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            const timestamp = new Date().toISOString().split('T')[0];
            link.setAttribute('href', url);
            link.setAttribute('download', `clients_export_${timestamp}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }

        async function viewClientDetail(clientId) {
            const client = clients.find(c => c.id == clientId);
            if (!client) return;

            // Show client detail view
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('client-detail').classList.add('active');

            // Update client info
            document.getElementById('client-detail-name').textContent = client.name;
            document.getElementById('client-detail-info').innerHTML = \`
                <p style="margin-bottom: 0.75rem;"><strong>Email:</strong> \${client.email || 'N/A'}</p>
                <p style="margin-bottom: 0.75rem;"><strong>Phone:</strong> \${formatPhoneNumber(client.phone) || 'N/A'}</p>
                <p style="margin-bottom: 0.75rem;"><strong>Address:</strong><br>\${(client.address || 'N/A').replace(/\\n/g, '<br>')}</p>
                <p style="margin-bottom: 0.75rem;"><strong>Notes:</strong><br>\${client.notes || 'N/A'}</p>
                <p style="margin-bottom: 0.75rem; color: #718096; font-size: 0.875rem;"><strong>Added:</strong> \${new Date(client.createdAt).toLocaleDateString()}</p>
            \`;

            // Load client jobs
            const clientJobs = jobs.filter(j => j.clientId == client.id || String(j.clientId) === String(client.id));
            const jobsContainer = document.getElementById('client-detail-jobs');

            if (clientJobs.length === 0) {
                jobsContainer.innerHTML = '<div class="empty-state"><h3>No jobs yet</h3><p>Create a job for this client</p></div>';
                return;
            }

            jobsContainer.innerHTML = '<table><thead><tr><th>Date</th><th>Job</th><th>Status</th><th>Total</th><th>Actions</th></tr></thead><tbody>' +
                clientJobs.map(j => {
                    const assigned = team.find(t => t.id == j.assignedTo);
                    return \`<tr>
                        <td>\${j.scheduledDate}<br><small>\${j.scheduledTime || ''}</small></td>
                        <td>
                            <strong>\${j.title}</strong><br>
                            <small>\${(j.description || '').substring(0, 50)}</small>
                        </td>
                        <td><span class="status-badge status-\${j.status}">\${j.status.replace('_', ' ')}</span></td>
                        <td>\${j.totalWithTax ? '$' + j.totalWithTax.toFixed(2) : (j.total ? '$' + calculateTotalWithTax(parseFloat(j.total)).toFixed(2) : '-')}</td>
                        <td>
                            <button class="btn btn-secondary btn-small" onclick='openJobModal(\${JSON.stringify(j).replace(/'/g, "&apos;")})'>Edit</button>
                            <button class="btn btn-primary btn-small" onclick="window.open('/invoice/\${j.id}', '_blank')">📄</button>
                        </td>
                    </tr>\`;
                }).join('') +
                '</tbody></table>';
        }

        async function loadJobs() {
            const response = await fetch('/api/jobs');
            jobs = await response.json();

            // Populate filter dropdowns
            const clientFilter = document.getElementById('filter-client');
            const assignedFilter = document.getElementById('filter-assigned');

            // Preserve current selections
            const currentClient = clientFilter.value;
            const currentAssigned = assignedFilter.value;

            clientFilter.innerHTML = '<option value="">All Clients</option>' +
                clients.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
            clientFilter.value = currentClient;

            assignedFilter.innerHTML = '<option value="">All Team Members</option>' +
                team.map(t => \`<option value="\${t.id}">\${t.name}</option>\`).join('');
            assignedFilter.value = currentAssigned;

            renderJobsTable();
        }

        function renderJobsTable() {
            const container = document.getElementById('jobs-list');

            if (jobs.length === 0) {
                container.innerHTML = '<div class="empty-state"><h3>No jobs yet</h3><p>Create your first job to get started</p></div>';
                return;
            }

            // Apply filters
            const statusFilter = document.getElementById('filter-status').value;
            const clientFilter = document.getElementById('filter-client').value;
            const assignedFilter = document.getElementById('filter-assigned').value;

            const filteredJobs = jobs.filter(j => {
                if (statusFilter && j.status !== statusFilter) return false;
                if (clientFilter && j.clientId !== clientFilter) return false;
                if (assignedFilter && j.assignedTo !== assignedFilter) return false;
                return true;
            });

            if (filteredJobs.length === 0) {
                container.innerHTML = '<div class="empty-state"><h3>No jobs match filters</h3><p>Try adjusting your filters</p></div>';
                return;
            }

            container.innerHTML = '<table><thead><tr><th>Date</th><th>Client</th><th>Job</th><th>Assigned To</th><th>Status</th><th>Billed / Paid / Owed</th><th>Actions</th></tr></thead><tbody>' +
                filteredJobs.map(j => {
                    const client = clients.find(c => c.id == j.clientId);
                    const assigned = team.find(t => t.id == j.assignedTo);
                    const total = j.totalWithTax ? j.totalWithTax : (j.total ? calculateTotalWithTax(parseFloat(j.total)) : 0);
                    const paid = j.totalPaid ? parseFloat(j.totalPaid) : 0;
                    const owed = total - paid;
                    const isPaidInFull = Math.abs(owed) < 0.01;
                    const owedDisplay = isPaidInFull ? 0 : owed;
                    const paymentStatus = isPaidInFull ? '✓' : owed < total ? '◐' : '';
                    return \`<tr>
                        <td>\${j.scheduledDate}<br><small>\${j.scheduledTime || ''}</small></td>
                        <td>\${client ? client.name : 'Unknown'}</td>
                        <td><strong>\${j.title}</strong><br><small>\${j.description || ''}</small></td>
                        <td>\${assigned ? assigned.name : 'Unassigned'}</td>
                        <td><span class="status-badge status-\${j.status}">\${j.status.replace('_', ' ')}</span></td>
                        <td>
                            <div style="font-size: 0.9rem;">
                                <div>$\${total.toFixed(2)} / <span style="color: #48bb78;">$\${paid.toFixed(2)}</span> / <span style="color: \${isPaidInFull ? '#48bb78' : '#e53e3e'};">$\${owedDisplay.toFixed(2)}</span> \${paymentStatus}</div>
                            </div>
                        </td>
                        <td>
                            <button class="btn btn-secondary btn-small" onclick="editJob('\${j.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Edit</button>
                            <button class="btn btn-primary btn-small" onclick="window.open('/invoice/\${j.id}', '_blank')">📄 Invoice</button>
                            <button class="btn btn-danger btn-small" onclick="deleteJob('\${j.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Delete</button>
                        </td>
                    </tr>\`;
                }).join('') +
                '</tbody></table>';
        }

        function filterJobs() {
            renderJobsTable();
        }

        function clearJobFilters() {
            document.getElementById('filter-status').value = '';
            document.getElementById('filter-client').value = '';
            document.getElementById('filter-assigned').value = '';
            renderJobsTable();
        }

        function exportJobsToExcel() {
            // Apply current filters to export
            const statusFilter = document.getElementById('filter-status').value;
            const clientFilter = document.getElementById('filter-client').value;
            const assignedFilter = document.getElementById('filter-assigned').value;

            const filteredJobs = jobs.filter(j => {
                if (statusFilter && j.status !== statusFilter) return false;
                if (clientFilter && j.clientId !== clientFilter) return false;
                if (assignedFilter && j.assignedTo !== assignedFilter) return false;
                return true;
            });

            if (filteredJobs.length === 0) {
                alert('No jobs to export');
                return;
            }

            // Create CSV content
            const headers = ['Date', 'Time', 'Client', 'Job Title', 'Description', 'Assigned To', 'Status', 'Total Billed', 'Total Paid', 'Balance Owed'];
            const rows = filteredJobs.map(j => {
                const client = clients.find(c => c.id == j.clientId);
                const assigned = team.find(t => t.id == j.assignedTo);
                const total = j.totalWithTax ? j.totalWithTax : (j.total ? calculateTotalWithTax(parseFloat(j.total)) : 0);
                const paid = j.totalPaid ? parseFloat(j.totalPaid) : 0;
                const owed = total - paid;
                const isPaidInFull = Math.abs(owed) < 0.01;
                const owedDisplay = isPaidInFull ? 0 : owed;

                return [
                    j.scheduledDate || '',
                    j.scheduledTime || '',
                    client ? client.name : 'Unknown',
                    j.title || '',
                    (j.description || '').replace(/"/g, '""'), // Escape quotes
                    assigned ? assigned.name : 'Unassigned',
                    j.status.replace('_', ' '),
                    total.toFixed(2),
                    paid.toFixed(2),
                    owedDisplay.toFixed(2)
                ];
            });

            // Build CSV
            let csv = headers.map(h => `"${h}"`).join(',') + '\n';
            rows.forEach(row => {
                csv += row.map(cell => `"${cell}"`).join(',') + '\n';
            });

            // Create download
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            const timestamp = new Date().toISOString().split('T')[0];
            link.setAttribute('href', url);
            link.setAttribute('download', `jobs_export_${timestamp}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }

        async function loadTeam() {
            const response = await fetch('/api/team');
            team = await response.json();

            const container = document.getElementById('team-list');
            if (team.length === 0) {
                container.innerHTML = '<div class="empty-state"><h3>No team members yet</h3><p>Add your first team member</p></div>';
                return;
            }

            container.innerHTML = '<table><thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Email</th><th>City, State</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
                team.map(t => {
                    const cityState = [t.city, t.state].filter(x => x).join(', ') || '-';
                    return \`<tr style="cursor: pointer;" onclick="viewTeamDetail('\${t.id}')">
                        <td><strong>\${t.name}</strong></td>
                        <td>\${t.role}</td>
                        <td>\${formatPhoneNumber(t.phone) || '-'}</td>
                        <td>\${t.email || '-'}</td>
                        <td>\${cityState}</td>
                        <td><span class="status-badge \${t.active ? 'status-completed' : 'status-scheduled'}">\${t.active ? 'Active' : 'Inactive'}</span></td>
                        <td onclick="event.stopPropagation()">
                            <button class="btn btn-secondary btn-small" onclick="editTeamMember('\${t.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Edit</button>
                            <button class="btn btn-danger btn-small" onclick="deleteTeamMember('\${t.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Delete</button>
                        </td>
                    </tr>\`;
                }).join('') +
                '</tbody></table>';
        }

        function filterTeam() {
            const searchTerm = document.getElementById('team-search').value.toLowerCase();
            const table = document.querySelector('#team-list table');
            if (!table) return;

            const rows = table.querySelectorAll('tbody tr');
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(searchTerm) ? '' : 'none';
            });
        }

        async function viewTeamDetail(teamId) {
            const member = team.find(t => t.id == teamId);
            if (!member) return;

            // Show team detail view
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('team-detail').classList.add('active');

            // Update member info
            document.getElementById('team-detail-name').textContent = member.name;
            document.getElementById('team-detail-info').innerHTML = \`
                <p style="margin-bottom: 0.75rem;"><strong>Role:</strong> \${member.role}</p>
                <p style="margin-bottom: 0.75rem;"><strong>Phone:</strong> \${formatPhoneNumber(member.phone) || 'N/A'}</p>
                <p style="margin-bottom: 0.75rem;"><strong>Email:</strong> \${member.email || 'N/A'}</p>
                <p style="margin-bottom: 0.75rem;"><strong>Status:</strong> <span class="status-badge \${member.active ? 'status-completed' : 'status-scheduled'}">\${member.active ? 'Active' : 'Inactive'}</span></p>
            \`;

            // Load member's jobs
            const memberJobs = jobs.filter(j => j.assignedTo == member.id || String(j.assignedTo) === String(member.id));
            const jobsContainer = document.getElementById('team-detail-jobs');

            if (memberJobs.length === 0) {
                jobsContainer.innerHTML = '<div class="empty-state"><h3>No jobs assigned</h3><p>Assign jobs to this team member</p></div>';
                return;
            }

            // Calculate total hours and revenue
            const totalHours = memberJobs.reduce((sum, j) => sum + (parseFloat(j.hours) || 0), 0);
            const totalRevenue = memberJobs.reduce((sum, j) => sum + (parseFloat(j.total) || 0), 0);

            jobsContainer.innerHTML = \`
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-bottom: 1.5rem;">
                    <div style="background: #f8f9fa; padding: 1rem; border-radius: 8px;">
                        <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.25rem;">Total Jobs</div>
                        <div style="font-size: 1.5rem; font-weight: 700;">\${memberJobs.length}</div>
                    </div>
                    <div style="background: #f8f9fa; padding: 1rem; border-radius: 8px;">
                        <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.25rem;">Total Hours</div>
                        <div style="font-size: 1.5rem; font-weight: 700;">\${totalHours.toFixed(1)}</div>
                    </div>
                    <div style="background: #f8f9fa; padding: 1rem; border-radius: 8px;">
                        <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.25rem;">Total Revenue</div>
                        <div style="font-size: 1.5rem; font-weight: 700;">$\${totalRevenue.toFixed(2)}</div>
                    </div>
                    <div style="background: #f8f9fa; padding: 1rem; border-radius: 8px;">
                        <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.25rem;">Avg Rate</div>
                        <div style="font-size: 1.5rem; font-weight: 700;">$\${totalHours > 0 ? (totalRevenue / totalHours).toFixed(2) : '0.00'}/hr</div>
                    </div>
                </div>
                <table><thead><tr><th>Date</th><th>Client</th><th>Job</th><th>Status</th><th>Hours</th><th>Total</th><th>Actions</th></tr></thead><tbody>\` +
                memberJobs.map(j => {
                    const client = clients.find(c => c.id == j.clientId || String(c.id) === String(j.clientId));
                    return \`<tr>
                        <td>\${j.scheduledDate}<br><small>\${j.scheduledTime || ''}</small></td>
                        <td>\${client ? client.name : 'Unknown'}</td>
                        <td>
                            <strong>\${j.title}</strong><br>
                            <small>\${(j.description || '').substring(0, 50)}</small>
                        </td>
                        <td><span class="status-badge status-\${j.status}">\${j.status.replace('_', ' ')}</span></td>
                        <td>\${j.hours || 0}</td>
                        <td>\${j.totalWithTax ? '$' + j.totalWithTax.toFixed(2) : (j.total ? '$' + calculateTotalWithTax(parseFloat(j.total)).toFixed(2) : '-')}</td>
                        <td>
                            <button class="btn btn-secondary btn-small" onclick='openJobModal(\${JSON.stringify(j).replace(/'/g, "&apos;")})'>Edit</button>
                            <button class="btn btn-primary btn-small" onclick="window.open('/invoice/\${j.id}', '_blank')">📄</button>
                        </td>
                    </tr>\`;
                }).join('') +
                '</tbody></table>';
        }

        // Report functions
        function updateReportDateRange() {
            const range = document.getElementById('report-date-range').value;
            const customDiv = document.getElementById('custom-date-range');

            if (range === 'custom') {
                customDiv.style.display = 'block';
            } else {
                customDiv.style.display = 'none';
            }
        }

        function getReportDateRange() {
            const range = document.getElementById('report-date-range').value;
            const today = new Date();
            let startDate, endDate = new Date();

            switch(range) {
                case 'today':
                    startDate = new Date(today);
                    break;
                case 'yesterday':
                    startDate = new Date(today);
                    startDate.setDate(startDate.getDate() - 1);
                    endDate = new Date(startDate);
                    break;
                case 'this-week':
                    startDate = new Date(today);
                    startDate.setDate(today.getDate() - today.getDay());
                    break;
                case 'last-week':
                    startDate = new Date(today);
                    startDate.setDate(today.getDate() - today.getDay() - 7);
                    endDate = new Date(startDate);
                    endDate.setDate(endDate.getDate() + 6);
                    break;
                case 'this-month':
                    startDate = new Date(today.getFullYear(), today.getMonth(), 1);
                    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0); // Last day of current month
                    break;
                case 'last-month':
                    startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                    endDate = new Date(today.getFullYear(), today.getMonth(), 0);
                    break;
                case 'this-quarter':
                    const quarter = Math.floor(today.getMonth() / 3);
                    startDate = new Date(today.getFullYear(), quarter * 3, 1);
                    break;
                case 'last-quarter':
                    const lastQuarter = Math.floor(today.getMonth() / 3) - 1;
                    startDate = new Date(today.getFullYear(), lastQuarter * 3, 1);
                    endDate = new Date(today.getFullYear(), lastQuarter * 3 + 3, 0);
                    break;
                case 'this-year':
                    startDate = new Date(today.getFullYear(), 0, 1);
                    break;
                case 'last-year':
                    startDate = new Date(today.getFullYear() - 1, 0, 1);
                    endDate = new Date(today.getFullYear() - 1, 11, 31);
                    break;
                case 'custom':
                    startDate = new Date(document.getElementById('report-date-from').value);
                    endDate = new Date(document.getElementById('report-date-to').value);
                    break;
                case 'all-time':
                default:
                    startDate = new Date('2000-01-01');
                    break;
            }

            return {
                startDate: startDate.toISOString().split('T')[0],
                endDate: endDate.toISOString().split('T')[0],
                label: range.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
            };
        }

        async function generateReports() {
            console.log('generateReports called');
            try {
                console.log('Jobs array:', jobs);
                const { startDate, endDate, label } = getReportDateRange();
                console.log('Date range:', startDate, 'to', endDate, label);
                const clientFilter = document.getElementById('report-filter-client').value;
                const teamFilter = document.getElementById('report-filter-team').value;
                const statusFilter = document.getElementById('report-filter-status').value;

                // Ensure jobs are loaded
                if (!jobs || jobs.length === 0) {
                    alert('No jobs data available. Please wait for data to load.');
                    return;
                }

                // Filter jobs based on criteria
                let filteredJobs = jobs.filter(j => {
                    if (!j.scheduledDate) return false;
                    if (j.scheduledDate < startDate || j.scheduledDate > endDate) return false;
                    if (clientFilter && j.clientId !== clientFilter) return false;
                    if (teamFilter && j.assignedTo !== teamFilter) return false;
                    if (statusFilter && j.status !== statusFilter) return false;
                    return true;
                });

                const settings = await fetch('/api/settings').then(r => r.json()).catch(() => ({}));

                // Generate Revenue Summary
                generateRevenueSummary(filteredJobs, settings, label);

                // Generate Jobs by Status
                generateJobsByStatus(filteredJobs);

                // Generate Top Clients
                generateTopClients(filteredJobs);

                // Generate Team Performance
                generateTeamPerformance(filteredJobs);

                // Generate Revenue Trend
                generateRevenueTrend(filteredJobs);

                // Generate Detailed Jobs List
                generateDetailedJobsList(filteredJobs);

                console.log('Reports generated successfully');
            } catch (error) {
                console.error('Error generating reports:', error);
                alert('Error generating reports: ' + error.message);
            }
        }

        function generateRevenueSummary(filteredJobs, settings, period) {
            const completedJobs = filteredJobs.filter(j => j.status === 'completed' || j.status === 'invoiced');
            const subtotal = completedJobs.reduce((sum, j) => sum + (parseFloat(j.total) || 0), 0);
            const tax = subtotal * (settings.taxRate || 0.06625);
            const total = subtotal + tax;

            const laborTotal = completedJobs.reduce((sum, j) => {
                return sum + (j.laborItems || []).reduce((s, item) => s + (item.hours * item.rate), 0);
            }, 0);

            const materialTotal = completedJobs.reduce((sum, j) => {
                return sum + (j.materialItems || []).reduce((s, item) => s + (item.quantity * item.price), 0);
            }, 0);

            document.getElementById('revenue-report').innerHTML = \`
                <div style="background: white; padding: 1.5rem; border-radius: 8px; border: 1px solid #e2e8f0;">
                    ${settings.companyLogo ? \`<img src="\${settings.companyLogo}" alt="Logo" style="max-height: 60px; margin-bottom: 1rem;">\` : ''}
                    <h4 style="margin-bottom: 0.5rem; color: #2d3748;">Revenue Summary - \${period}</h4>
                    <table style="width: 100%; margin-top: 1rem;">
                        <tr><td style="padding: 0.5rem;">Total Jobs:</td><td style="text-align: right; font-weight: 600;">\${completedJobs.length}</td></tr>
                        <tr><td style="padding: 0.5rem;">Labor Revenue:</td><td style="text-align: right;">$\${laborTotal.toFixed(2)}</td></tr>
                        <tr><td style="padding: 0.5rem;">Material Revenue:</td><td style="text-align: right;">$\${materialTotal.toFixed(2)}</td></tr>
                        <tr style="border-top: 2px solid #e2e8f0;"><td style="padding: 0.5rem; font-weight: 600;">Subtotal:</td><td style="text-align: right; font-weight: 600;">$\${subtotal.toFixed(2)}</td></tr>
                        <tr><td style="padding: 0.5rem;">Tax (\${((settings.taxRate || 0.06625) * 100).toFixed(3)}%):</td><td style="text-align: right;">$\${tax.toFixed(2)}</td></tr>
                        <tr style="border-top: 2px solid #667eea; color: #667eea;"><td style="padding: 0.5rem; font-weight: 700; font-size: 1.2rem;">Total Revenue:</td><td style="text-align: right; font-weight: 700; font-size: 1.2rem;">$\${total.toFixed(2)}</td></tr>
                    </table>
                </div>
            \`;
        }

        function generateJobsByStatus(filteredJobs) {
            if (!filteredJobs || filteredJobs.length === 0) {
                document.getElementById('jobs-status-report').innerHTML = '<p style="padding: 1rem; color: #718096;">No jobs found for the selected period.</p>';
                return;
            }

            const statusCounts = {
                scheduled: filteredJobs.filter(j => j.status === 'scheduled').length,
                in_progress: filteredJobs.filter(j => j.status === 'in_progress').length,
                completed: filteredJobs.filter(j => j.status === 'completed').length,
                invoiced: filteredJobs.filter(j => j.status === 'invoiced').length
            };

            const total = filteredJobs.length;

            document.getElementById('jobs-status-report').innerHTML = \`
                <table style="width: 100%; border-collapse: collapse;">
                    <thead style="background: #667eea; color: white;">
                        <tr>
                            <th style="padding: 1rem; text-align: left;">Status</th>
                            <th style="padding: 1rem; text-align: right;">Count</th>
                            <th style="padding: 1rem; text-align: right;">Percentage</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr><td style="padding: 0.75rem; border-bottom: 1px solid #e2e8f0;">Prospecting</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${statusCounts.prospecting || 0}</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${((statusCounts.prospecting || 0) / total * 100).toFixed(1)}%</td></tr>
                        <tr><td style="padding: 0.75rem; border-bottom: 1px solid #e2e8f0;">Scheduled</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${statusCounts.scheduled}</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${((statusCounts.scheduled / total) * 100).toFixed(1)}%</td></tr>
                        <tr><td style="padding: 0.75rem; border-bottom: 1px solid #e2e8f0;">In Progress</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${statusCounts.in_progress}</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${((statusCounts.in_progress / total) * 100).toFixed(1)}%</td></tr>
                        <tr><td style="padding: 0.75rem; border-bottom: 1px solid #e2e8f0;">Completed</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${statusCounts.completed}</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${((statusCounts.completed / total) * 100).toFixed(1)}%</td></tr>
                        <tr><td style="padding: 0.75rem; border-bottom: 1px solid #e2e8f0;">Invoiced</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${statusCounts.invoiced}</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${((statusCounts.invoiced / total) * 100).toFixed(1)}%</td></tr>
                        <tr><td style="padding: 0.75rem; border-bottom: 1px solid #e2e8f0;">Bid Lost</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${statusCounts.bid_lost || 0}</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${((statusCounts.bid_lost || 0) / total * 100).toFixed(1)}%</td></tr>
                        <tr style="background: #f8f9fa; font-weight: 600;"><td style="padding: 0.75rem;">Total</td><td style="padding: 0.75rem; text-align: right;">\${total}</td><td style="padding: 0.75rem; text-align: right;">100%</td></tr>
                    </tbody>
                </table>
            \`;
        }

        function generateTopClients(filteredJobs) {
            if (!filteredJobs || filteredJobs.length === 0) {
                document.getElementById('top-clients-report').innerHTML = '<p style="padding: 1rem; color: #718096;">No jobs found for the selected period.</p>';
                return;
            }

            const clientStats = {};

            filteredJobs.forEach(j => {
                const client = clients.find(c => c.id === j.clientId);
                const clientName = client ? client.name : 'Unknown';

                if (!clientStats[clientName]) {
                    clientStats[clientName] = { count: 0, revenue: 0 };
                }
                clientStats[clientName].count++;
                if (j.status === 'completed' || j.status === 'invoiced') {
                    clientStats[clientName].revenue += parseFloat(j.total) || 0;
                }
            });

            const topClients = Object.entries(clientStats)
                .sort((a, b) => b[1].revenue - a[1].revenue)
                .slice(0, 10);

            if (topClients.length === 0) {
                document.getElementById('top-clients-report').innerHTML = '<p style="padding: 1rem; color: #718096;">No client data available.</p>';
                return;
            }

            document.getElementById('top-clients-report').innerHTML = \`
                <table style="width: 100%; border-collapse: collapse;">
                    <thead style="background: #667eea; color: white;">
                        <tr>
                            <th style="padding: 1rem; text-align: left;">Client</th>
                            <th style="padding: 1rem; text-align: right;">Jobs</th>
                            <th style="padding: 1rem; text-align: right;">Revenue</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${topClients.map(([name, stats]) => \`
                            <tr>
                                <td style="padding: 0.75rem; border-bottom: 1px solid #e2e8f0;">\${name}</td>
                                <td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${stats.count}</td>
                                <td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">$\${stats.revenue.toFixed(2)}</td>
                            </tr>
                        \`).join('')}
                    </tbody>
                </table>
            \`;
        }

        function generateTeamPerformance(filteredJobs) {
            const teamStats = {};

            filteredJobs.forEach(j => {
                const member = team.find(t => t.id === j.assignedTo);
                const memberName = member ? member.name : 'Unassigned';

                if (!teamStats[memberName]) {
                    teamStats[memberName] = { count: 0, revenue: 0 };
                }
                teamStats[memberName].count++;
                if (j.status === 'completed' || j.status === 'invoiced') {
                    teamStats[memberName].revenue += parseFloat(j.total) || 0;
                }
            });

            const sortedTeam = Object.entries(teamStats)
                .sort((a, b) => b[1].revenue - a[1].revenue);

            document.getElementById('team-performance-report').innerHTML = \`
                <table style="width: 100%; border-collapse: collapse;">
                    <thead style="background: #667eea; color: white;">
                        <tr>
                            <th style="padding: 1rem; text-align: left;">Team Member</th>
                            <th style="padding: 1rem; text-align: right;">Jobs Completed</th>
                            <th style="padding: 1rem; text-align: right;">Revenue Generated</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${sortedTeam.map(([name, stats]) => \`
                            <tr>
                                <td style="padding: 0.75rem; border-bottom: 1px solid #e2e8f0;">\${name}</td>
                                <td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${stats.count}</td>
                                <td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">$\${stats.revenue.toFixed(2)}</td>
                            </tr>
                        \`).join('')}
                    </tbody>
                </table>
            \`;
        }

        function generateRevenueTrend(filteredJobs) {
            const monthlyRevenue = {};

            filteredJobs.forEach(j => {
                if (j.status === 'completed' || j.status === 'invoiced') {
                    const month = j.scheduledDate.substring(0, 7); // YYYY-MM
                    if (!monthlyRevenue[month]) monthlyRevenue[month] = 0;
                    monthlyRevenue[month] += parseFloat(j.total) || 0;
                }
            });

            const sortedMonths = Object.entries(monthlyRevenue).sort((a, b) => a[0].localeCompare(b[0]));

            document.getElementById('revenue-trend-report').innerHTML = \`
                <table style="width: 100%; border-collapse: collapse;">
                    <thead style="background: #667eea; color: white;">
                        <tr>
                            <th style="padding: 1rem; text-align: left;">Month</th>
                            <th style="padding: 1rem; text-align: right;">Revenue</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${sortedMonths.map(([month, revenue]) => \`
                            <tr>
                                <td style="padding: 0.75rem; border-bottom: 1px solid #e2e8f0;">\${new Date(month + '-01').toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}</td>
                                <td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">$\${revenue.toFixed(2)}</td>
                            </tr>
                        \`).join('')}
                        <tr style="background: #f8f9fa; font-weight: 600;">
                            <td style="padding: 0.75rem;">Total</td>
                            <td style="padding: 0.75rem; text-align: right;">$\${sortedMonths.reduce((sum, [_, rev]) => sum + rev, 0).toFixed(2)}</td>
                        </tr>
                    </tbody>
                </table>
            \`;
        }

        function generateDetailedJobsList(filteredJobs) {
            document.getElementById('jobs-detail-report').innerHTML = \`
                <table style="width: 100%; border-collapse: collapse; font-size: 0.875rem;">
                    <thead style="background: #667eea; color: white;">
                        <tr>
                            <th style="padding: 0.75rem; text-align: left;">Date</th>
                            <th style="padding: 0.75rem; text-align: left;">Client</th>
                            <th style="padding: 0.75rem; text-align: left;">Job</th>
                            <th style="padding: 0.75rem; text-align: left;">Assigned To</th>
                            <th style="padding: 0.75rem; text-align: left;">Status</th>
                            <th style="padding: 0.75rem; text-align: right;">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${filteredJobs.map(j => {
                            const client = clients.find(c => c.id === j.clientId);
                            const member = team.find(t => t.id === j.assignedTo);
                            return \`
                                <tr>
                                    <td style="padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">\${j.scheduledDate}</td>
                                    <td style="padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">\${client ? client.name : 'Unknown'}</td>
                                    <td style="padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">\${j.title}</td>
                                    <td style="padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">\${member ? member.name : 'Unassigned'}</td>
                                    <td style="padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">\${j.status.replace('_', ' ')}</td>
                                    <td style="padding: 0.5rem; text-align: right; border-bottom: 1px solid #e2e8f0;">$\${(j.totalWithTax || calculateTotalWithTax(parseFloat(j.total) || 0)).toFixed(2)}</td>
                                </tr>
                            \`;
                        }).join('')}
                    </tbody>
                </table>
            \`;
        }

        function printReports() {
            window.print();
        }

        async function loadReports() {
            try {
                // Load jobs if not already loaded
                if (!jobs || jobs.length === 0) {
                    const response = await fetch('/api/jobs');
                    jobs = await response.json();
                }

                // Populate filter dropdowns
                const clientFilter = document.getElementById('report-filter-client');
                const teamFilter = document.getElementById('report-filter-team');

                clientFilter.innerHTML = '<option value="">All Clients</option>' +
                    clients.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');

                teamFilter.innerHTML = '<option value="">All Team Members</option>' +
                    team.map(t => \`<option value="\${t.id}">\${t.name}</option>\`).join('');

                // Generate reports with default filters
                await generateReports();
            } catch (error) {
                console.error('Error loading reports:', error);
                alert('Error loading reports: ' + error.message);
            }
        }

        async function loadSettings() {
            const response = await fetch('/api/settings');
            const settings = await response.json();

            const form = document.getElementById('settingsForm');
            form.elements.companyName.value = settings.companyName || '';
            form.elements.companyAddress.value = settings.companyAddress || '';
            form.elements.companyPhone.value = settings.companyPhone || '';
            form.elements.companyEmail.value = settings.companyEmail || '';
            form.elements.hourlyRate.value = settings.hourlyRate || 75;
            form.elements.taxRatePercent.value = ((settings.taxRate || 0.06625) * 100).toFixed(3);

            // Load logo if exists
            if (settings.companyLogo) {
                document.getElementById('companyLogo').value = settings.companyLogo;
                const preview = document.getElementById('logo-preview');
                preview.src = settings.companyLogo;
                preview.style.display = 'block';
                document.getElementById('remove-logo').style.display = 'inline-block';
            }

            // Mark form as clean after loading
            markFormClean();
        }

        function handleLogoUpload(event) {
            const file = event.target.files[0];
            if (!file) return;

            // Check file size (max 500KB)
            if (file.size > 500000) {
                alert('File too large! Please use an image under 500KB.');
                return;
            }

            // Check file type
            if (!file.type.match('image.*')) {
                alert('Please upload an image file (PNG, JPG, etc.)');
                return;
            }

            // Read and convert to base64
            const reader = new FileReader();
            reader.onload = function(e) {
                const base64 = e.target.result;
                document.getElementById('companyLogo').value = base64;

                // Show preview
                const preview = document.getElementById('logo-preview');
                preview.src = base64;
                preview.style.display = 'block';
                document.getElementById('remove-logo').style.display = 'inline-block';
            };
            reader.readAsDataURL(file);
        }

        function removeLogo() {
            document.getElementById('companyLogo').value = '';
            document.getElementById('logo-preview').src = '';
            document.getElementById('logo-preview').style.display = 'none';
            document.getElementById('remove-logo').style.display = 'none';
            document.getElementById('logo-upload').value = '';
        }

        async function saveSettings() {
            const form = document.getElementById('settingsForm');
            const settings = {
                companyName: form.elements.companyName.value,
                companyAddress: form.elements.companyAddress.value,
                companyPhone: form.elements.companyPhone.value,
                companyEmail: form.elements.companyEmail.value,
                hourlyRate: parseFloat(form.elements.hourlyRate.value),
                taxRate: parseFloat(form.elements.taxRatePercent.value) / 100,
                companyLogo: document.getElementById('companyLogo').value || null
            };

            const response = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });

            if (response.ok) {
                markFormClean();
                alert('Settings saved successfully!');
                // Update header logo
                loadHeaderLogo();
            }
        }

        // Password change
        async function changePassword() {
            const currentPassword = document.getElementById('currentPassword').value;
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;

            if (!currentPassword || !newPassword || !confirmPassword) {
                alert('All password fields are required');
                return;
            }

            if (newPassword !== confirmPassword) {
                alert('New passwords do not match');
                return;
            }

            if (newPassword.length < 6) {
                alert('New password must be at least 6 characters');
                return;
            }

            const response = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword })
            });

            const data = await response.json();

            if (response.ok) {
                alert('Password changed successfully!');
                document.getElementById('passwordForm').reset();
            } else {
                alert(data.error || 'Password change failed');
            }
        }

        // User management
        let currentEditingUserId = null;

        async function loadUsers() {
            const response = await fetch('/api/users');
            if (response.ok) {
                const users = await response.json();
                const usersList = document.getElementById('usersList');
                usersList.innerHTML = users.map(user => \`
                    <div style="padding: 1rem; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong>\${user.name}</strong>
                            <div style="color: #718096; font-size: 0.9rem;">
                                \${user.email} •
                                <span style="color: \${user.role === 'admin' ? '#667eea' : '#48bb78'}; font-weight: 600;">\${user.role.toUpperCase()}</span>
                            </div>
                            <div style="color: #a0aec0; font-size: 0.8rem;">
                                Created: \${new Date(user.createdAt).toLocaleDateString()}
                            </div>
                        </div>
                        <div>
                            <button class="btn btn-primary btn-small" onclick="editUser('\${user._id}')" style="margin-right: 0.5rem;">Edit</button>
                            <button class="btn btn-danger btn-small" onclick="deleteUser('\${user._id}')">Delete</button>
                        </div>
                    </div>
                \`).join('');
                document.getElementById('userManagementSection').style.display = 'block';
            }
        }

        function showAddUserModal() {
            currentEditingUserId = null;
            document.getElementById('addUserModalTitle').textContent = 'Add User';
            document.getElementById('addUserForm').reset();
            // Show password field for new users
            document.getElementById('addUserForm').elements.password.parentElement.style.display = 'block';
            document.getElementById('addUserForm').elements.password.required = true;
            document.getElementById('addUserModal').style.display = 'flex';
        }

        async function editUser(userId) {
            const response = await fetch('/api/users');
            if (response.ok) {
                const users = await response.json();
                const user = users.find(u => u._id === userId);
                if (user) {
                    currentEditingUserId = userId;
                    document.getElementById('addUserModalTitle').textContent = 'Edit User';
                    const form = document.getElementById('addUserForm');
                    form.elements.name.value = user.name;
                    form.elements.email.value = user.email;
                    form.elements.role.value = user.role;
                    // Hide password field for editing, make it optional
                    form.elements.password.parentElement.style.display = 'block';
                    form.elements.password.required = false;
                    form.elements.password.value = '';
                    form.elements.password.placeholder = 'Leave blank to keep current password';
                    document.getElementById('addUserModal').style.display = 'flex';
                }
            }
        }

        function closeUserModal() {
            currentEditingUserId = null;
            document.getElementById('addUserModal').style.display = 'none';
        }

        async function saveUser() {
            const form = document.getElementById('addUserForm');
            const userData = {
                name: form.elements.name.value,
                email: form.elements.email.value,
                role: form.elements.role.value
            };

            // Only include password if it's provided
            if (form.elements.password.value) {
                userData.password = form.elements.password.value;
            }

            let response;
            if (currentEditingUserId) {
                // Update existing user
                response = await fetch(\`/api/users/\${currentEditingUserId}\`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(userData)
                });
            } else {
                // Create new user
                if (!userData.password) {
                    alert('Password is required for new users');
                    return;
                }
                response = await fetch('/api/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(userData)
                });
            }

            const data = await response.json();

            if (response.ok) {
                alert(currentEditingUserId ? 'User updated successfully!' : 'User created successfully!');
                closeUserModal();
                loadUsers();
            } else {
                alert(data.error || 'Failed to save user');
            }
        }

        async function deleteUser(userId) {
            if (!confirm('⚠️ Are you sure you want to delete this user?\n\nThis action cannot be undone.')) return;

            const response = await fetch(\`/api/users/\${userId}\`, {
                method: 'DELETE'
            });

            const data = await response.json();

            if (response.ok) {
                alert('User deleted successfully');
                loadUsers();
            } else {
                alert(data.error || 'Failed to delete user');
            }
        }

        // Delete functions
        async function deleteClient(id) {
            if (!isAdmin) {
                alert('You do not have permission to delete clients.');
                return;
            }
            const client = clients.find(c => c.id == id);
            const clientName = client ? client.name : 'this client';
            if (!confirm(\`⚠️ Are you sure you want to delete \${clientName}?\n\nThis will also affect all jobs associated with this client.\`)) return;
            await fetch(\`/api/clients/\${id}\`, { method: 'DELETE' });
            loadClients();
        }

        async function deleteJob(id) {
            if (!isAdmin) {
                alert('You do not have permission to delete jobs.');
                return;
            }
            const job = jobs.find(j => j.id == id);
            const jobTitle = job ? job.title : 'this job';
            if (!confirm(\`⚠️ Are you sure you want to delete "\${jobTitle}"?\n\nThis action cannot be undone.\`)) return;
            await fetch(\`/api/jobs/\${id}\`, { method: 'DELETE' });
            loadJobs();
            loadDashboard();
        }

        async function deleteTeamMember(id) {
            if (!isAdmin) {
                alert('You do not have permission to delete team members.');
                return;
            }
            const member = team.find(t => t.id == id);
            const memberName = member ? member.name : 'this team member';
            if (!confirm(\`⚠️ Are you sure you want to delete \${memberName}?\n\nThis will affect all jobs assigned to them.\`)) return;
            await fetch(\`/api/team/\${id}\`, { method: 'DELETE' });
            loadTeam();
        }

        // Calendar functions
        let currentYear = new Date().getFullYear();
        let currentMonth = new Date().getMonth() + 1;

        async function loadCalendar() {
            const response = await fetch(\`/api/calendar?year=\${currentYear}&month=\${currentMonth}\`);
            const calendarJobs = await response.json();

            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

            document.getElementById('calendar-month-year').textContent =
                \`\${monthNames[currentMonth - 1]} \${currentYear}\`;

            const firstDay = new Date(currentYear, currentMonth - 1, 1);
            const lastDay = new Date(currentYear, currentMonth, 0);
            const daysInMonth = lastDay.getDate();
            const startDay = firstDay.getDay();

            const grid = document.getElementById('calendar-grid');
            grid.innerHTML = '';

            // Day headers
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            dayNames.forEach(day => {
                const header = document.createElement('div');
                header.className = 'calendar-day-header';
                header.textContent = day;
                grid.appendChild(header);
            });

            // Previous month days
            const prevMonthDays = new Date(currentYear, currentMonth - 1, 0).getDate();
            for (let i = startDay - 1; i >= 0; i--) {
                const day = document.createElement('div');
                day.className = 'calendar-day other-month';
                day.innerHTML = \`<div class="day-number">\${prevMonthDays - i}</div>\`;
                grid.appendChild(day);
            }

            // Current month days
            const today = new Date().toISOString().split('T')[0];
            for (let i = 1; i <= daysInMonth; i++) {
                const dateStr = \`\${currentYear}-\${String(currentMonth).padStart(2, '0')}-\${String(i).padStart(2, '0')}\`;
                const day = document.createElement('div');
                day.className = 'calendar-day';
                if (dateStr === today) day.classList.add('today');

                let html = \`<div class="day-number">\${i}</div>\`;

                const dayJobs = calendarJobs.filter(j => j.scheduledDate === dateStr);
                dayJobs.forEach(j => {
                    const client = clients.find(c => c.id == j.clientId);
                    html += \`<div class="calendar-job \${j.status}" onclick='openJobModal(\${JSON.stringify(j).replace(/'/g, "&apos;")})' title="\${j.title} - \${client ? client.name : 'Unknown'}">\${j.title}</div>\`;
                });

                day.innerHTML = html;
                grid.appendChild(day);
            }

            // Next month days
            const totalCells = startDay + daysInMonth;
            const remainingCells = 7 - (totalCells % 7);
            if (remainingCells < 7) {
                for (let i = 1; i <= remainingCells; i++) {
                    const day = document.createElement('div');
                    day.className = 'calendar-day other-month';
                    day.innerHTML = \`<div class="day-number">\${i}</div>\`;
                    grid.appendChild(day);
                }
            }
        }

        function changeMonth(delta) {
            currentMonth += delta;
            if (currentMonth > 12) {
                currentMonth = 1;
                currentYear++;
            } else if (currentMonth < 1) {
                currentMonth = 12;
                currentYear--;
            }
            loadCalendar();
        }

        function goToToday() {
            const now = new Date();
            currentYear = now.getFullYear();
            currentMonth = now.getMonth() + 1;
            loadCalendar();
        }

        // Load header logo
        async function loadHeaderLogo() {
            const response = await fetch('/api/settings');
            const settings = await response.json();
            if (settings.companyLogo) {
                const logo = document.getElementById('header-logo');
                logo.src = settings.companyLogo;
                logo.style.display = 'block';
            }
        }

        // Load current user info
        async function loadCurrentUser() {
            try {
                const response = await fetch('/api/auth/me');
                const user = await response.json();
                document.getElementById('currentUserName').textContent = user.name;

                // Set user role
                currentUserRole = user.role || 'user';
                isAdmin = currentUserRole === 'admin';

                if (user.lastLogin) {
                    const lastLogin = new Date(user.lastLogin);
                    document.getElementById('lastLoginTime').textContent = lastLogin.toLocaleString();
                } else {
                    document.getElementById('lastLoginTime').textContent = 'First login';
                }

                // Apply permissions after loading user
                applyPermissions();
            } catch (error) {
                console.error('Error loading user info:', error);
            }
        }

        function applyPermissions() {
            if (!isAdmin) {
                // Hide all admin-only navigation tabs
                document.querySelectorAll('[data-admin-only]').forEach(btn => {
                    btn.style.display = 'none';
                });

                // Hide all admin-only views
                document.getElementById('dashboard').style.display = 'none';
                document.getElementById('clients').style.display = 'none';
                document.getElementById('team').style.display = 'none';
                document.getElementById('reports').style.display = 'none';
                document.getElementById('settings').style.display = 'none';

                // Show jobs view by default for users
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                document.getElementById('jobs').classList.add('active');
                document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
                document.querySelector('[onclick="showView(\'jobs\')"]').classList.add('active');

                // Hide all create/add buttons
                document.querySelectorAll('.btn-primary').forEach(btn => {
                    if (btn.textContent.includes('+') || btn.textContent.includes('Create') || btn.textContent.includes('Add')) {
                        btn.style.display = 'none';
                    }
                });

                // Hide user management section
                const userMgmt = document.getElementById('userManagementSection');
                if (userMgmt) userMgmt.style.display = 'none';
            }
        }

        // Update current date/time
        function updateDateTime() {
            const now = new Date();
            const options = {
                weekday: 'short',
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            };
            document.getElementById('currentDateTime').textContent = now.toLocaleString('en-US', options);
        }

        // Logout function
        async function logout() {
            if (confirm('Are you sure you want to logout?')) {
                await fetch('/api/auth/logout', { method: 'POST' });
                window.location.href = '/login';
            }
        }

        // Initial load
        Promise.all([
            fetch('/api/clients').then(r => r.json()).then(data => clients = data),
            fetch('/api/team').then(r => r.json()).then(data => team = data),
            fetch('/api/settings').then(r => r.json()).then(data => settings = data),
            loadHeaderLogo(),
            loadCurrentUser()
        ]).then(() => {
            loadDashboard();
        });

        // Update clock every second
        updateDateTime();
        setInterval(updateDateTime, 1000);

        // Auto-refresh dashboard every 30 seconds
        setInterval(() => {
            if (document.getElementById('dashboard').classList.contains('active')) {
                loadDashboard();
            }
        }, 30000);
    </script>
</body>
</html>`;

// API Routes
const handleRequest = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Main page
    if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(HTML_TEMPLATE);
        return;
    }

    // Dashboard stats
    if (path === '/api/dashboard' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.getDashboardStats()));
        return;
    }

    // Get clients
    if (path === '/api/clients' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.getClients()));
        return;
    }

    // Add client
    if (path === '/api/clients' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const client = JSON.parse(body);
            const clients = db.getClients();
            client.id = Date.now();
            client.createdAt = new Date().toISOString();
            clients.push(client);
            db.saveClients(clients);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    // Delete client
    if (path.startsWith('/api/clients/') && req.method === 'DELETE') {
        const id = parseInt(path.split('/')[3]);
        const clients = db.getClients().filter(c => c.id !== id);
        db.saveClients(clients);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Get jobs
    if (path === '/api/jobs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.getJobs()));
        return;
    }

    // Add/Update job
    if (path === '/api/jobs' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const job = JSON.parse(body);
            const jobs = db.getJobs();

            // Convert empty strings to null for proper handling
            if (job.clientId === '') job.clientId = null;
            if (job.assignedTo === '') job.assignedTo = null;

            if (job.id) {
                // Update existing
                const index = jobs.findIndex(j => j.id == job.id);
                if (index !== -1) {
                    jobs[index] = { ...jobs[index], ...job };
                }
            } else {
                // Add new
                job.id = Date.now();
                job.createdAt = new Date().toISOString();
                jobs.push(job);
            }

            db.saveJobs(jobs);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    // Delete job
    if (path.startsWith('/api/jobs/') && req.method === 'DELETE') {
        const id = parseInt(path.split('/')[3]);
        const jobs = db.getJobs().filter(j => j.id !== id);
        db.saveJobs(jobs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Get team
    if (path === '/api/team' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.getTeam()));
        return;
    }

    // Add team member
    if (path === '/api/team' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const member = JSON.parse(body);
            const team = db.getTeam();
            member.id = Date.now();
            member.active = true;
            team.push(member);
            db.saveTeam(team);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    // Delete team member
    if (path.startsWith('/api/team/') && req.method === 'DELETE') {
        const id = parseInt(path.split('/')[3]);
        const team = db.getTeam().filter(t => t.id !== id);
        db.saveTeam(team);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Get settings
    if (path === '/api/settings' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.getSettings()));
        return;
    }

    // Update settings
    if (path === '/api/settings' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const settings = JSON.parse(body);
            db.saveSettings(settings);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    // Calendar API
    if (path === '/api/calendar' && req.method === 'GET') {
        const year = url.searchParams.get('year');
        const month = url.searchParams.get('month');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.getCalendarData(year, month)));
        return;
    }

    // Invoice API - Generate invoice HTML
    if (path.startsWith('/invoice/')) {
        const jobId = path.split('/')[2];
        const invoiceData = db.generateInvoice(jobId);

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
    <title>Invoice #${job.id}</title>
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
        .status-prospecting { background: #fed7d7; color: #742a2a; }
        .status-scheduled { background: #bee3f8; color: #2c5282; }
        .status-in_progress { background: #feebc8; color: #7c2d12; }
        .status-completed { background: #c6f6d5; color: #22543d; }
        .status-invoiced { background: #e9d8fd; color: #553c9a; }
        .status-bid_lost { background: #e2e8f0; color: #4a5568; }
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
            <p><strong>Invoice #:</strong> ${job.id}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>Status:</strong> <span class="status-badge status-${job.status}">${job.status.replace('_', ' ')}</span></p>
        </div>
    </div>

    <div class="bill-to">
        <h3>Bill To:</h3>
        <p><strong>${client ? client.name : 'Unknown Client'}</strong></p>
        ${client && client.address ? `<p>${client.address.replace(/\n/g, '<br>')}</p>` : ''}
        ${client && client.phone ? `<p>Phone: ${client.phone}</p>` : ''}
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

// Start server
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('🚀 Jobber Pro - Field Service Management');
    console.log('='.repeat(60));
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`📁 Data: ${DATA_DIR}`);
    console.log('');
    console.log('💡 Press Ctrl+C to stop');
    console.log('='.repeat(60));
    console.log('');

    // Auto-open browser
    const cmd = process.platform === 'win32' ? 'start' :
                process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${cmd} http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down...');
    server.close(() => {
        console.log('✅ Server stopped');
        process.exit(0);
    });
});
