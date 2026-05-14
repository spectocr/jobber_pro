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

            // Accounts Receivable - all unpaid balances
            totalAccountsReceivable: jobs
                .filter(j => j.status === 'completed' || j.status === 'invoiced')
                .reduce((sum, j) => {
                    const total = j.totalWithTax || parseFloat(j.total) || 0;
                    const paid = parseFloat(j.totalPaid) || 0;
                    return sum + Math.max(0, total - paid);
                }, 0),

            accountsReceivableJobs: jobs
                .filter(j => {
                    if (j.status !== 'completed' && j.status !== 'invoiced') return false;
                    const total = j.totalWithTax || parseFloat(j.total) || 0;
                    const paid = parseFloat(j.totalPaid) || 0;
                    return total > paid;
                })
                .map(j => ({
                    ...j,
                    balanceOwed: (j.totalWithTax || parseFloat(j.total) || 0) - (parseFloat(j.totalPaid) || 0)
                }))
                .sort((a, b) => b.balanceOwed - a.balanceOwed),

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
        const assignedIds = Array.isArray(job.assignedTo) ? job.assignedTo : (job.assignedTo ? [job.assignedTo] : []);
        const assignedNames = assignedIds.map(id => { const m = team.find(t => t.id == id || String(t.id) === String(id)); return m ? m.name : null; }).filter(Boolean).join(', ') || 'Unassigned';
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
    <title id="page-title">Jobber Pro - Field Service Management</title>
    <link rel="icon" id="page-favicon" type="image/x-icon" href="">
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
            padding: 0.75rem 2rem;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
            height: 72px;
        }

        .header h1 {
            font-size: 1.5rem;
            margin: 0;
        }

        .header p {
            display: none;
        }

        .nav {
            background: white;
            border-bottom: 2px solid #e2e8f0;
            padding: 0 2rem;
            display: flex;
            align-items: stretch;
            overflow: visible;
        }

        .nav-scroll {
            display: flex;
            gap: 0.5rem;
            overflow-x: auto;
            flex: 1;
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

        .admin-menu-wrapper {
            position: relative;
            margin-left: auto;
        }

        .admin-dropdown {
            position: absolute;
            top: 100%;
            right: 0;
            background: white;
            border: 1px solid #e2e8f0;
            border-radius: 0 0 8px 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.12);
            min-width: 180px;
            z-index: 1000;
            display: flex;
            flex-direction: column;
        }

        .admin-dropdown .admin-item {
            border-bottom: none;
            border-radius: 0;
            text-align: left;
            padding: 0.75rem 1.25rem;
            width: 100%;
        }

        .admin-dropdown .admin-item:last-child {
            border-radius: 0 0 8px 8px;
        }

        .admin-dropdown .admin-item:hover {
            background: #f7f8fc;
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

        .calendar-view.active {
            display: flex;
            flex-direction: column;
            height: calc(100vh - 200px);
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
        .jm-item { display:block; width:100%; text-align:left; padding:0.45rem 1rem; background:none; border:none; cursor:pointer; font-size:0.84rem; color:#374151; white-space:nowrap; }
        .jm-item:hover { background:#f8fafc; }

        .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            padding: 0.35rem 0.75rem;
            border-radius: 999px;
            font-size: 0.75rem;
            font-weight: 600;
            border: 2px solid #e2e8f0;
            background: white;
            color: #4a5568;
            cursor: pointer;
            transition: all 0.15s;
            white-space: nowrap;
        }
        .status-pill:hover { border-color: #a0aec0; }
        .status-pill.active { background: #1a365d; color: white; border-color: #1a365d; }
        .status-pill .pill-count {
            background: rgba(0,0,0,0.12);
            border-radius: 999px;
            padding: 0 0.4rem;
            font-size: 0.7rem;
            min-width: 1.3em;
            text-align: center;
        }
        .status-pill.active .pill-count { background: rgba(255,255,255,0.25); }

        .btn-icon {
            background: none;
            border: none;
            padding: 0.5rem;
            cursor: pointer;
            font-size: 1.2rem;
            transition: all 0.2s;
            border-radius: 4px;
        }

        .btn-icon:hover {
            background: rgba(0,0,0,0.05);
            transform: scale(1.1);
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

        th.sortable {
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
        }
        th.sortable:hover { color: #2d3748; }
        th.sortable .sort-arrow { margin-left: 4px; opacity: 0.4; font-size: 0.75em; }
        th.sortable.sort-asc .sort-arrow,
        th.sortable.sort-desc .sort-arrow { opacity: 1; color: #667eea; }

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

        .status-to_be_scheduled {
            background: #fefcbf;
            color: #744210;
        }

        .settings-tab {
            padding: 0.75rem 1.5rem;
            background: none;
            border: none;
            border-bottom: 3px solid transparent;
            color: #718096;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }

        .settings-tab:hover {
            color: #667eea;
            background: #f7fafc;
        }

        .settings-tab.active {
            color: #667eea;
            border-bottom-color: #667eea;
        }

        .settings-tab-content {
            animation: fadeIn 0.3s;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
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
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .modal-header {
            padding: 1.5rem;
            border-bottom: 2px solid #e2e8f0;
            position: sticky;
            top: 0;
            background: white;
            z-index: 10;
            flex-shrink: 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .modal-header h2 {
            font-size: 1.5rem;
        }

        .modal-body {
            padding: 1.5rem;
            flex: 1;
            overflow-y: auto;
        }

        /* Workflow Stepper */
        .wf-wrap{padding:0.75rem 0 0.25rem;}
        .wf-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:0.85rem;}
        .wf-hdr-title{font-weight:700;font-size:0.85rem;color:#2d3748;}
        .wf-pill{background:#f0ebff;color:#553c9a;padding:0.2rem 0.65rem;border-radius:999px;font-size:0.73rem;font-weight:700;}
        .wf-stages-wrap{position:relative;display:flex;padding:0 0.75rem;}
        .wf-track-bg{position:absolute;top:16px;left:calc(0.75rem + 16px);right:calc(0.75rem + 16px);height:3px;background:#e2e8f0;border-radius:2px;}
        .wf-track-fill{position:absolute;top:0;left:0;height:100%;background:linear-gradient(90deg,#48bb78 0%,#667eea 100%);border-radius:2px;transition:width 0.4s ease;}
        .wf-stage{flex:1;display:flex;flex-direction:column;align-items:center;position:relative;z-index:1;}
        .wf-dot{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:700;}
        .wf-dot.wf-done{background:#48bb78;color:white;}
        .wf-dot.wf-now{background:#553c9a;color:white;animation:wfpulse 1.8s infinite;}
        .wf-dot.wf-wait{background:#e2e8f0;color:#a0aec0;}
        @keyframes wfpulse{0%,100%{box-shadow:0 0 0 3px rgba(85,60,154,0.25)}50%{box-shadow:0 0 0 8px rgba(85,60,154,0.05)}}
        .wf-lbl{font-size:0.64rem;font-weight:600;color:#4a5568;text-align:center;margin-top:0.35rem;line-height:1.3;max-width:52px;}
        .wf-st{font-size:0.59rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;margin-top:0.15rem;padding:1px 5px;border-radius:999px;}
        .wf-st.wf-done{background:#c6f6d5;color:#22543d;}
        .wf-st.wf-now{background:#e9d8fd;color:#553c9a;}

        .modal-footer {
            padding: 1.5rem;
            border-top: 2px solid #e2e8f0;
            display: flex;
            justify-content: flex-end;
            gap: 0.5rem;
            position: sticky;
            bottom: 0;
            background: white;
            z-index: 10;
            flex-shrink: 0;
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
            padding: 0.75rem;
            text-align: center;
            font-weight: 600;
            font-size: 0.875rem;
        }
        .calendar-day {
            background: white;
            padding: 0.5rem;
            position: relative;
            border: 1px solid #e2e8f0;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
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
            flex-shrink: 0;
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
            flex-shrink: 0;
        }
        .calendar-job:hover {
            background: #5568d3;
        }
        .calendar-job.to_be_scheduled { background: #d69e2e; }
        .calendar-job.in_progress { background: #ed8936; }
        .calendar-job.completed { background: #48bb78; }
        .calendar-job.invoiced { background: #9f7aea; }

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

        /* Responsive Design */
        @media (max-width: 1200px) {
            .container {
                max-width: 100%;
                padding: 1.5rem;
            }
            .stats-grid {
                grid-template-columns: repeat(2, 1fr);
            }
        }

        @media (max-width: 768px) {
            /* Header */
            .header {
                padding: 0.75rem 1rem;
                height: auto;
                min-height: 60px;
                flex-direction: column;
                gap: 0.5rem;
            }
            .header h1 {
                font-size: 1.25rem;
            }
            .header > div:first-child {
                width: 100%;
                justify-content: center;
            }
            .header > div:last-child {
                width: 100%;
                font-size: 0.75rem;
                text-align: center;
            }
            .header > div:last-child > div {
                display: flex;
                flex-wrap: wrap;
                justify-content: center;
                gap: 0.5rem;
                font-size: 0.7rem;
            }

            /* Navigation */
            .nav {
                padding: 0 0.5rem;
            }
            .nav-scroll {
                gap: 0.25rem;
            }
            .nav-btn {
                padding: 0.75rem 1rem;
                font-size: 0.75rem;
            }
            .admin-dropdown {
                right: 0;
                min-width: 160px;
            }

            /* Container */
            .container {
                padding: 1rem;
            }

            /* Stats Grid */
            .stats-grid {
                grid-template-columns: 1fr;
                gap: 1rem;
            }
            .stat-card {
                padding: 1rem;
            }
            .stat-card .value {
                font-size: 1.5rem;
            }

            /* Cards */
            .card {
                padding: 1rem;
                margin-bottom: 1rem;
            }
            .card-header {
                flex-direction: column;
                align-items: flex-start;
            }
            .card-header h2 {
                font-size: 1.25rem;
            }

            /* Tables */
            table {
                font-size: 0.75rem;
                display: block;
                overflow-x: auto;
                white-space: nowrap;
            }
            th, td {
                padding: 0.5rem 0.25rem;
            }

            /* Buttons */
            .btn {
                padding: 0.5rem 1rem;
                font-size: 0.75rem;
                width: 100%;
                justify-content: center;
            }
            .btn-small {
                padding: 0.35rem 0.75rem;
                font-size: 0.7rem;
                width: auto;
            }

            /* Modals - Full screen on mobile */
            .modal {
                padding: 0;
                align-items: stretch;
            }
            .modal-content {
                width: 100%;
                max-width: 100%;
                height: 100%;
                max-height: 100vh;
                border-radius: 0;
                margin: 0;
                display: flex;
                flex-direction: column;
            }
            .modal-header {
                padding: 1rem;
                flex-shrink: 0;
                position: sticky;
                top: 0;
                background: white;
                z-index: 10;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            .modal-header h2 {
                font-size: 1.1rem;
            }
            .close-btn {
                font-size: 1.75rem;
                width: 2.5rem;
                height: 2.5rem;
            }
            .modal-body {
                padding: 1rem;
                flex: 1;
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
            }
            .modal-footer {
                flex-direction: column;
                gap: 0.75rem;
                padding: 1rem;
                flex-shrink: 0;
                position: sticky;
                bottom: 0;
                background: white;
                box-shadow: 0 -2px 4px rgba(0,0,0,0.1);
            }
            .modal-footer .btn {
                width: 100%;
                padding: 0.875rem;
                font-size: 0.875rem;
            }

            /* Forms */
            .form-group {
                margin-bottom: 1rem;
            }
            .form-group label {
                font-size: 0.875rem;
                font-weight: 600;
            }
            .form-group input,
            .form-group select,
            .form-group textarea {
                font-size: 16px; /* Prevent iOS zoom on focus */
                padding: 0.875rem;
                border-radius: 8px;
                min-height: 44px; /* Apple touch target size */
            }
            .form-group input[type="checkbox"] {
                width: 1.25rem;
                height: 1.25rem;
            }
            .form-group small {
                font-size: 0.75rem;
            }

            /* Line items (labor, materials, payments) */
            .line-item {
                display: block !important;
                background: #f7fafc;
                padding: 1rem;
                border-radius: 8px;
                margin-bottom: 1rem !important;
                position: relative;
            }
            .line-item .form-group {
                margin-bottom: 0.75rem;
            }
            .line-item button[type="button"] {
                position: absolute;
                top: 0.5rem;
                right: 0.5rem;
                width: 2rem !important;
                height: 2rem !important;
                padding: 0 !important;
                font-size: 1.5rem;
            }

            /* Calendar */
            .calendar-view.active {
                height: auto;
                min-height: 0;
            }
            #calendar-grid {
                gap: 1px;
                grid-auto-rows: auto !important;
            }
            .calendar-day-header {
                font-size: 0.75rem;
                padding: 0.4rem 0.2rem;
            }

            /* Reports */
            .report-section {
                margin-bottom: 1.5rem;
            }
            .report-section h3 {
                font-size: 1.1rem;
            }

            /* Hide long text on mobile */
            .stat-card .subtext {
                font-size: 0.75rem;
            }

            /* Client Modal - Stack City/State/ZIP on mobile */
            .city-state-zip-grid {
                display: block !important;
                grid-template-columns: none !important;
            }
            .city-state-zip-grid .form-group {
                margin-bottom: 1rem;
            }

            /* Service locations on mobile */
            .service-location-item {
                padding: 1rem !important;
            }

            /* Client detail jobs - card layout on mobile */
            #client-detail-jobs table thead {
                display: none;
            }
            #client-detail-jobs table,
            #client-detail-jobs table tbody {
                display: block;
            }
            #client-detail-jobs table tr {
                display: grid;
                grid-template-columns: 1fr 1fr;
                grid-template-rows: auto auto auto;
                gap: 0.5rem;
                background: #f7fafc;
                padding: 1rem;
                border-radius: 8px;
                margin-bottom: 0.75rem;
                border: 1px solid #e2e8f0;
            }
            #client-detail-jobs table td {
                display: flex;
                flex-direction: column;
                padding: 0;
            }
            #client-detail-jobs table tr td:nth-child(1) {
                grid-column: 1;
                grid-row: 1;
            }
            #client-detail-jobs table tr td:nth-child(2) {
                grid-column: 2;
                grid-row: 1;
            }
            #client-detail-jobs table tr td:nth-child(3) {
                grid-column: 1;
                grid-row: 2;
            }
            #client-detail-jobs table tr td:nth-child(4) {
                grid-column: 2;
                grid-row: 2;
            }
            #client-detail-jobs table tr td:nth-child(5) {
                grid-column: 1 / -1;
                grid-row: 3;
                display: flex;
                flex-direction: row;
                gap: 0.5rem;
            }
            #client-detail-jobs table tr td:nth-child(5) button {
                flex: 1;
            }
            #client-detail-jobs table td::before {
                content: attr(data-label);
                font-weight: 600;
                font-size: 0.75rem;
                color: #718096;
                margin-bottom: 0.25rem;
                text-transform: uppercase;
            }

            /* Client detail - stack vertically, contact first on mobile */
            #client-detail .card > div[style*="grid-template-columns"] {
                display: flex !important;
                flex-direction: column !important;
                gap: 2rem !important;
            }

            /* Team detail - stack vertically on mobile */
            .team-detail-grid {
                display: flex !important;
                flex-direction: column !important;
                gap: 1.5rem !important;
            }

            /* Settings tabs - horizontal scroll on mobile */
            .settings-tabs-bar {
                overflow-x: auto;
                -webkit-overflow-scrolling: touch;
                scrollbar-width: none;
            }
            .settings-tabs-bar::-webkit-scrollbar { display: none; }
            .settings-tabs-bar > div {
                display: flex;
                gap: 0;
                min-width: max-content;
            }
            .settings-tab {
                padding: 0.6rem 0.9rem !important;
                font-size: 0.8rem !important;
                white-space: nowrap;
            }

            /* Calendar mobile: compact grid */
            .calendar-day-mobile {
                background: white;
                border: 1px solid #e2e8f0;
                padding: 0.3rem;
                min-height: 48px;
                display: flex;
                flex-direction: column;
                align-items: center;
                cursor: pointer;
                user-select: none;
            }
            .calendar-day-mobile.today { background: #edf2ff; border-color: #667eea; }
            .calendar-day-mobile.other-month { background: #f7fafc; opacity: 0.5; }
            .calendar-day-mobile.selected { background: #667eea; border-color: #4c51bf; }
            .calendar-day-mobile.selected .day-num { color: white !important; }
            .calendar-day-mobile .day-num { font-size: 0.8rem; font-weight: 600; color: #1a202c; }
            .cal-badge { width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.65rem; font-weight: 700; color: white; margin-top: 2px; }
        }

        @media (max-width: 480px) {
            .header h1 {
                font-size: 1.1rem;
            }
            .nav-btn {
                padding: 0.6rem 0.75rem;
                font-size: 0.7rem;
            }
            .container {
                padding: 0.75rem;
            }
            .card {
                padding: 0.75rem;
                border-radius: 8px;
            }
            .stat-card .value {
                font-size: 1.25rem;
            }
            table {
                font-size: 0.7rem;
            }
            th, td {
                padding: 0.4rem 0.2rem;
            }
            .modal-header h2 {
                font-size: 1rem;
            }
            .modal-body {
                padding: 0.75rem;
            }
            .modal-footer {
                padding: 0.75rem;
            }
        }

        /* Landscape mobile optimization */
        @media (max-width: 768px) and (orientation: landscape) {
            .header {
                flex-direction: row;
                min-height: 50px;
            }
            .header > div:last-child > div {
                font-size: 0.65rem;
            }
            .calendar-view.active {
                height: auto;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <div style="display: flex; align-items: center; gap: 1rem;">
            <img id="header-logo" src="" alt="" style="max-height: 50px; max-width: 120px; display: none;">
            <h1 id="header-app-name">⚡ Jobber Pro</h1>
        </div>
        <div style="display: flex; align-items: center; gap: 2rem; color: white; font-size: 0.9rem;">
            <div style="display: flex; align-items: center; gap: 1.5rem;">
                <div>
                    <span style="font-weight: 600;" id="currentUserName">Loading...</span>
                    <span style="opacity: 0.8; margin-left: 0.5rem;">(<span id="currentUserRole">--</span>)</span>
                </div>
                <div style="opacity: 0.9; font-size: 0.85rem;">Last Login: <span id="lastLoginTime">--</span></div>
                <div style="opacity: 0.9; font-size: 0.85rem;" id="currentDateTime">--</div>
            </div>
            <button onclick="logout()" style="padding: 0.4rem 1rem; background: rgba(255,255,255,0.2); border: 1px solid white; color: white; border-radius: 4px; cursor: pointer; font-size: 0.85rem; font-weight: 500;">Logout</button>
        </div>
    </div>

    <div class="nav">
        <div class="nav-scroll">
            <button class="nav-btn active" onclick="showView('dashboard')" data-admin-only>📊 Dashboard</button>
            <button class="nav-btn" onclick="showView('clients')" data-admin-only>👥 Clients</button>
            <button class="nav-btn" onclick="showView('quotes')" data-admin-only style="position:relative;">
                💰 Quotes
                <span id="quotes-badge" style="display:none;position:absolute;top:6px;right:4px;background:#e53e3e;color:white;border-radius:10px;padding:2px 6px;font-size:0.7rem;font-weight:bold;"></span>
            </button>
            <button class="nav-btn" onclick="showView('jobs')">📋 Jobs</button>
            <button class="nav-btn" onclick="showView('leads')" data-admin-only style="position:relative;">
                🎯 Leads
                <span id="leads-badge" style="display:none;position:absolute;top:6px;right:4px;background:#e53e3e;color:white;border-radius:10px;padding:2px 6px;font-size:0.7rem;font-weight:bold;"></span>
            </button>
            <button class="nav-btn" onclick="showView('calendar')">📅 Calendar</button>
            <button class="nav-btn" onclick="showView('messages')" data-admin-only style="position:relative;">
                💬 Messages
                <span id="messages-badge" style="display:none;position:absolute;top:6px;right:4px;background:#e53e3e;color:white;border-radius:10px;padding:2px 6px;font-size:0.7rem;font-weight:bold;"></span>
            </button>
            <button class="nav-btn" onclick="showView('timeclock')" data-user-only>⏱️ Time Clock</button>
            <button class="nav-btn" onclick="showView('mypay')" data-user-only>💵 My Pay</button>
        </div>
        <div class="admin-menu-wrapper" data-admin-only>
            <button class="nav-btn" id="admin-menu-btn" onclick="toggleAdminMenu(event)">⚙️ Admin ▾</button>
            <div id="admin-dropdown" class="admin-dropdown" style="display:none;">
                <button class="nav-btn admin-item" onclick="showView('team')">👷 Team</button>
                <button class="nav-btn admin-item" onclick="showView('timeclock')">⏱️ Time Clock</button>
                <button class="nav-btn admin-item" onclick="showView('expenses')">💰 Expenses</button>
                <button class="nav-btn admin-item" onclick="showView('vendors')">🏪 Vendors</button>
                <button class="nav-btn admin-item" onclick="showView('portfolio')">🖼️ Portfolio</button>
                <button class="nav-btn admin-item" onclick="showView('activity')">📜 Activity</button>
                <button class="nav-btn admin-item" onclick="showView('reports')">📈 Reports</button>
                <button class="nav-btn admin-item" onclick="showView('analytics')">📊 Analytics</button>
                <button class="nav-btn admin-item" onclick="showView('settings')">⚙️ Settings</button>
            </div>
        </div>
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
                    <div id="stat-jobs-month-delta" style="margin-top:0.3rem;min-height:1.1rem;font-size:0.75rem;"></div>
                </div>
                <div class="stat-card">
                    <h3>Revenue This Month</h3>
                    <div class="value" id="stat-revenue">$0</div>
                    <div id="stat-revenue-delta" style="margin-top:0.3rem;min-height:1.1rem;font-size:0.75rem;"></div>
                </div>
                <div class="stat-card" style="border-left-color: #48bb78;">
                    <h3>Profit This Month</h3>
                    <div class="value" id="stat-profit">$0</div>
                </div>
                <div class="stat-card">
                    <h3>Jobs Today</h3>
                    <div class="value" id="stat-jobs-today">0</div>
                </div>
                <div class="stat-card" style="border-left-color: #f56565;">
                    <h3>Prospecting</h3>
                    <div class="value" id="stat-prospecting">0</div>
                </div>
                <div class="stat-card" style="border-left-color: #d69e2e;">
                    <h3>To Be Scheduled</h3>
                    <div class="value" id="stat-to-be-scheduled">0</div>
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
                <div class="stat-card" style="border-left-color: #e53e3e;">
                    <h3>Accounts Receivable</h3>
                    <div class="value" id="stat-ar">$0</div>
                </div>
            </div>

            <!-- Revenue Trend Chart -->
            <div class="card" style="margin-bottom:1.5rem;">
                <div class="card-header" style="padding-bottom:0;">
                    <h2>📈 Revenue — Last 6 Months</h2>
                </div>
                <div style="padding:1rem 1.5rem 0.75rem;">
                    <svg id="revenueTrendSvg" width="100%" height="160" viewBox="0 0 600 160" preserveAspectRatio="xMidYMid meet" style="display:block;"></svg>
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

                <!-- Accounts Receivable Tile -->
                <div class="card">
                    <div class="card-header">
                        <h2>💰 Accounts Receivable <span id="ar-count" style="color: #718096; font-size: 0.9em;">(0)</span></h2>
                    </div>
                    <div id="ar-jobs-list"></div>
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

                <!-- Client Stats - Collapsible -->
                <div class="card" style="margin-bottom: 2rem;">
                    <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; padding: 1rem;" onclick="toggleClientStats()">
                        <h3 style="margin: 0;">📊 Client Statistics</h3>
                        <span id="stats-toggle-icon" style="font-size: 1.5rem; user-select: none;">▶</span>
                    </div>
                    <div id="client-stats-content" style="display: none; padding: 1rem;">
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1rem;">
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
                        <div style="margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid #e2e8f0;">
                            <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; margin-bottom: 1rem;" onclick="toggleZipDistribution()">
                                <h3 style="margin: 0;">Client Distribution by ZIP Code</h3>
                                <span id="zip-toggle-icon" style="font-size: 1.5rem; user-select: none;">▶</span>
                            </div>
                            <div id="zip-distribution" style="display: none;"></div>
                        </div>
                    </div>
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
                    <button class="btn btn-secondary" onclick="openSendComplianceModal(_currentClientId)" style="font-size: 0.85rem; margin-left: auto;">📎 Send Compliance Docs</button>
                </div>
                <!-- Client Relationship Stats -->
                <div id="client-stats-section" style="margin-bottom: 2rem;">
                    <h3 style="margin-bottom: 1rem; color: #667eea;">📊 Client Relationship Overview</h3>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem;">
                        <div class="stat-card">
                            <h3>Total Jobs</h3>
                            <div class="value" id="client-stat-total-jobs">0</div>
                        </div>
                        <div class="stat-card" style="border-left-color: #8b5cf6;">
                            <h3>Client Since</h3>
                            <div class="value" style="font-size: 1.25rem;" id="client-stat-since">--</div>
                        </div>
                        <div class="stat-card" style="border-left-color: #48bb78;">
                            <h3>Total Revenue</h3>
                            <div class="value" id="client-stat-total-revenue">$0</div>
                        </div>
                        <div class="stat-card" style="border-left-color: #10b981;">
                            <h3>Net Profit</h3>
                            <div class="value" id="client-stat-net-profit">$0</div>
                        </div>
                        <div class="stat-card" style="border-left-color: #f59e0b;">
                            <h3>Avg Job Value</h3>
                            <div class="value" id="client-stat-avg-job">$0</div>
                        </div>
                        <div class="stat-card" style="border-left-color: #667eea;">
                            <h3>Total Paid</h3>
                            <div class="value" id="client-stat-total-paid">$0</div>
                        </div>
                        <div class="stat-card" style="border-left-color: #e53e3e;">
                            <h3>Outstanding</h3>
                            <div class="value" id="client-stat-outstanding">$0</div>
                        </div>
                    </div>
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

        <!-- Quotes View -->
        <div id="quotes" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>Quotes & Estimates</h2>
                    <div style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
                        <select id="filter-quote-status" onchange="filterQuotes()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 150px;">
                            <option value="">All Statuses</option>
                            <option value="draft">Draft</option>
                            <option value="sent">Sent</option>
                            <option value="in_review">In Review</option>
                            <option value="approved">Approved</option>
                            <option value="rejected">Rejected</option>
                            <option value="expired">Expired</option>
                        </select>
                        <input type="text" id="filter-quote-client" placeholder="🔍 Search client..." oninput="filterQuotes()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 180px;">
                        <button class="btn btn-secondary" onclick="clearQuoteFilters()">Clear Filters</button>
                        <button class="btn btn-primary" onclick="showAddQuoteModal()">+ New Quote</button>
                    </div>
                </div>
                <div id="quotes-list"></div>
            </div>
        </div>

        <!-- Jobs View -->
        <div id="jobs" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>Jobs</h2>
                    <div style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
                        <input type="hidden" id="filter-status" value="ACTIVE_WORK">
                        <div id="job-status-pills" style="display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center;"></div>
                        <input type="text" id="filter-client" placeholder="🔍 Search client..." oninput="filterJobs()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 180px;">
                        <select id="filter-assigned" onchange="filterJobs()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 180px;">
                            <option value="">All Team Members</option>
                        </select>
                        <button class="btn btn-secondary" onclick="clearJobFilters()" style="margin-left: auto;">Clear Filters</button>
                        <button class="btn btn-secondary" onclick="exportJobsToExcel()" data-admin-only>📊 Export to Excel</button>
                        <button class="btn btn-primary" onclick="openJobModal()" data-admin-only>+ Create Job</button>
                    </div>
                </div>
                <div id="jobs-list"></div>
            </div>
        </div>

        <!-- Time Clock View -->
        <div id="timeclock" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>⏱️ Time Clock</h2>
                </div>

                <!-- Clock In/Out Section -->
                <div id="clockStatus" style="padding: 2rem; text-align: center; background: #f7fafc; border-radius: 12px; margin-bottom: 2rem;">
                    <div id="clockedOutView">
                        <h3 style="color: #718096; margin-bottom: 1rem;">Not Clocked In</h3>
                        <select id="clockInJobSelect" style="width: 100%; max-width: 400px; padding: 0.75rem; border: 2px solid #cbd5e0; border-radius: 8px; margin-bottom: 1rem; font-size: 1rem;">
                            <option value="">Select a job to clock in...</option>
                        </select>
                        <br>
                        <button class="btn btn-primary" onclick="clockIn()" style="font-size: 1.25rem; padding: 1rem 2rem;">🕐 Clock In</button>
                    </div>

                    <div id="clockedInView" style="display: none;">
                        <div style="background: white; padding: 2rem; border-radius: 12px; border: 3px solid #48bb78;">
                            <h3 style="color: #48bb78; margin-bottom: 0.5rem;">⏱️ Currently Working</h3>
                            <h2 style="color: #1a202c; margin-bottom: 1rem;" id="currentJobTitle">Job Name</h2>
                            <div style="font-size: 3rem; font-weight: 700; color: #667eea; margin: 1.5rem 0;" id="timerDisplay">0:00:00</div>
                            <p style="color: #718096; margin-bottom: 1.5rem;">Started at <span id="clockInTime">--:--</span></p>
                            <button class="btn btn-danger" onclick="openClockOutSurvey()" style="font-size: 1.25rem; padding: 1rem 2rem;">🕐 Clock Out</button>
                        </div>
                    </div>
                </div>

                <!-- Today's Time Entries -->
                <div>
                    <h3 style="margin-bottom: 1rem;">📋 Today's Time Log</h3>
                    <div id="todayTimeEntries"></div>
                </div>
            </div>

            <!-- Admin Approval Queue (Admin Only) -->
            <div class="card" id="approvalQueueCard" style="display: none;">
                <div class="card-header">
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 1rem;">
                        <div style="display: flex; gap: 1rem; align-items: center;">
                            <h2>⏳ Pending Approval Queue</h2>
                            <span id="pendingCount" style="background: #ffc107; color: #000; padding: 0.25rem 0.75rem; border-radius: 12px; font-weight: 600;">0</span>
                        </div>
                        <select id="approvalEmployeeFilter" onchange="loadApprovalQueue()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 180px;">
                            <option value="">All Employees</option>
                        </select>
                    </div>
                </div>
                <div id="approvalQueue"></div>
            </div>

            <!-- Recent Time Entries (Admin Only) -->
            <div class="card" id="allTimeEntriesCard" style="display: none;">
                <div class="card-header">
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 1rem;">
                        <h2>Recent Time Entries (All Team)</h2>
                        <div style="display: flex; gap: 1rem;">
                            <select id="entriesEmployeeFilter" onchange="loadAllTimeEntries()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 180px;">
                                <option value="">All Employees</option>
                            </select>
                            <select id="entriesStatusFilter" onchange="loadAllTimeEntries()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 150px;">
                                <option value="">All Status</option>
                                <option value="active">Active</option>
                                <option value="pending">Pending</option>
                                <option value="approved">Approved</option>
                                <option value="rejected">Rejected</option>
                            </select>
                            <button class="btn btn-secondary" onclick="exportTimeEntries()">📊 Export</button>
                        </div>
                    </div>
                </div>
                <div id="allTimeEntries"></div>
            </div>
        </div>

        <!-- My Pay View (User Only) -->
        <div id="mypay" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>💵 My Pay</h2>
                </div>

                <!-- Summary Cards -->
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem;">
                    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 1.5rem; border-radius: 12px; color: white;">
                        <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">Today</div>
                        <div style="font-size: 2rem; font-weight: 700;" id="payToday">$0.00</div>
                    </div>
                    <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 1.5rem; border-radius: 12px; color: white;">
                        <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">Month to Date</div>
                        <div style="font-size: 2rem; font-weight: 700;" id="payMTD">$0.00</div>
                    </div>
                    <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); padding: 1.5rem; border-radius: 12px; color: white;">
                        <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">Year to Date</div>
                        <div style="font-size: 2rem; font-weight: 700;" id="payYTD">$0.00</div>
                    </div>
                    <div style="background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%); padding: 1.5rem; border-radius: 12px; color: white;">
                        <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">All Time</div>
                        <div style="font-size: 2rem; font-weight: 700;" id="payAllTime">$0.00</div>
                    </div>
                </div>

                <!-- Filter -->
                <div style="margin-bottom: 1rem;">
                    <select id="payPeriodFilter" onchange="loadMyPay()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; min-width: 180px;">
                        <option value="today">Today</option>
                        <option value="week">This Week</option>
                        <option value="month" selected>This Month</option>
                        <option value="year">This Year</option>
                        <option value="all">All Time</option>
                    </select>
                </div>

                <!-- Detailed Entries -->
                <div>
                    <h3 style="margin-bottom: 1rem;">Payment History</h3>
                    <div id="myPayDetails"></div>
                </div>
            </div>
        </div>

        <!-- Calendar View -->
        <div id="calendar" class="view calendar-view">
            <div class="card" style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; flex-shrink: 0; flex-wrap: wrap; gap: 0.5rem;">
                    <button class="btn btn-secondary" onclick="changeMonth(-1)">‹ Prev</button>
                    <h2 id="calendar-month-year" style="text-align: center; flex: 1; min-width: 120px;"></h2>
                    <div style="display: flex; gap: 0.5rem;">
                        <button class="btn btn-secondary" onclick="changeMonth(1)">Next ›</button>
                        <button class="btn btn-primary" onclick="goToToday()">Today</button>
                    </div>
                </div>
                <div id="calendar-grid" style="flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; background: #e2e8f0; border: 1px solid #e2e8f0; grid-auto-rows: 1fr; overflow: auto;"></div>
                <div id="calendar-agenda" style="display:none; margin-top:1rem; padding-top:1rem; border-top:2px solid #e2e8f0;"></div>
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
                <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 2rem;" class="team-detail-grid">
                    <div>
                        <h3 style="margin-bottom: 1rem; color: #667eea;">Team Member Info</h3>
                        <div id="team-detail-info" style="background: #f8f9fa; padding: 1.5rem; border-radius: 8px;"></div>
                    </div>
                    <div>
                        <h3 style="margin-bottom: 1rem; color: #667eea;">Assigned Jobs</h3>
                        <div id="team-detail-jobs"></div>
                    </div>
                </div>

                <!-- Pay Summary Stats -->
                <div style="margin-top: 2rem;">
                    <h3 style="margin-bottom: 1rem; color: #667eea;">Pay Summary</h3>
                    <div id="team-pay-summary" style="margin-bottom: 2rem;"></div>
                </div>

                <!-- Pay History -->
                <div>
                    <h3 style="margin-bottom: 1rem; color: #667eea;">Payment History</h3>
                    <div id="team-pay-history"></div>
                </div>
            </div>
        </div>

        <!-- Messages View -->
        <div id="messages" class="view">
            <div style="display: flex; gap: 0; margin-bottom: 1.5rem; border-bottom: 2px solid #e2e8f0;">
                <button id="msg-tab-inbound" onclick="switchMessagesTab('inbound')" style="padding: 0.75rem 1.5rem; background: none; border: none; border-bottom: 3px solid #667eea; color: #667eea; font-weight: 600; cursor: pointer; font-size: 1rem; margin-bottom: -2px;">💬 Client Messages</button>
                <button id="msg-tab-outbound" onclick="switchMessagesTab('outbound')" style="padding: 0.75rem 1.5rem; background: none; border: none; border-bottom: 3px solid transparent; color: #718096; font-weight: 600; cursor: pointer; font-size: 1rem; margin-bottom: -2px;">📤 Email History</button>
            </div>

            <!-- Inbound client messages -->
            <div id="msg-panel-inbound">
                <div class="card">
                    <div class="card-header">
                        <h2>Client Messages</h2>
                        <button class="btn btn-secondary" onclick="loadMessages()">🔄 Refresh</button>
                    </div>
                    <div id="messages-list"></div>
                </div>
            </div>

            <!-- Outbound email history -->
            <div id="msg-panel-outbound" style="display: none;">
                <div class="card">
                    <div class="card-header">
                        <h2>Email History</h2>
                        <button class="btn btn-secondary" onclick="loadEmailLogs()">🔄 Refresh</button>
                    </div>
                    <div style="margin-bottom: 1rem; display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center;">
                        <select id="email-log-filter" onchange="filterEmailLogs()" style="padding: 0.5rem 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px;">
                            <option value="">All Types</option>
                            <option value="invoice">Invoices</option>
                            <option value="quote">Quotes</option>
                            <option value="credentials">Credentials</option>
                            <option value="portal_access">Portal Access</option>
                            <option value="test">Test Emails</option>
                        </select>
                        <input type="text" id="email-log-search" placeholder="🔍 Search recipient or subject..." oninput="filterEmailLogs()" style="flex: 1; min-width: 200px; padding: 0.5rem 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px;">
                    </div>
                    <div id="email-logs-list"></div>
                </div>
            </div>
        </div>

        <!-- Leads View -->
        <div id="leads" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>🎯 Website Leads</h2>
                    <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;">
                        <input type="text" id="lead-search" placeholder="🔍 Name or phone..." oninput="filterLeads()" style="padding:0.6rem 0.875rem;border:2px solid #e2e8f0;border-radius:8px;min-width:180px;">
                        <select id="lead-status-filter" onchange="filterLeads()" style="padding:0.6rem 0.875rem;border:2px solid #e2e8f0;border-radius:8px;">
                            <option value="">All Statuses</option>
                            <option value="new">New</option>
                            <option value="contacted">Contacted</option>
                            <option value="quoted">Quoted</option>
                            <option value="won">Won</option>
                            <option value="lost">Lost</option>
                            <option value="rejected">Rejected</option>
                        </select>
                    </div>
                </div>
                <div id="leads-list"></div>
            </div>
        </div>

    <!-- Lead Detail Modal -->
    <div id="leadModal" class="modal">
        <div class="modal-content" style="max-width:640px;">
            <div class="modal-header">
                <h2 id="leadModalName">Lead</h2>
                <button class="close-btn" onclick="closeLeadModal()">&times;</button>
            </div>
            <div class="modal-body" id="leadModalBody"></div>
        </div>
    </div>

        <!-- Expenses View -->
        <!-- Vendors View -->
        <div id="vendors" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>🏪 Vendors & Suppliers</h2>
                    <button class="btn btn-primary" onclick="openVendorModal()">+ Add Vendor</button>
                </div>
                <div style="display:flex;gap:1rem;margin-bottom:1rem;flex-wrap:wrap;">
                    <input type="text" id="vendor-search" placeholder="🔍 Search vendors..." style="flex:1;min-width:200px;padding:0.75rem;border:2px solid #e2e8f0;border-radius:8px;" oninput="filterVendors()">
                    <select id="vendor-category-filter" onchange="filterVendors()" style="padding:0.75rem;border:2px solid #e2e8f0;border-radius:8px;">
                        <option value="">All Categories</option>
                        <option value="lumber">Lumber & Building Materials</option>
                        <option value="electrical">Electrical</option>
                        <option value="plumbing">Plumbing</option>
                        <option value="hvac">HVAC</option>
                        <option value="hardware">Hardware & Fasteners</option>
                        <option value="paint">Paint & Finishes</option>
                        <option value="flooring">Flooring</option>
                        <option value="roofing">Roofing</option>
                        <option value="tools">Tools & Equipment</option>
                        <option value="landscaping">Landscaping & Outdoor</option>
                        <option value="subcontractor">Subcontractor</option>
                        <option value="other">Other</option>
                    </select>
                </div>
                <div id="vendors-list"></div>
            </div>
        </div>

        <div id="expenses" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>Business Expenses</h2>
                    <button class="btn btn-primary" onclick="openExpenseModal()">+ Add Expense</button>
                </div>
                <div style="margin-bottom: 1rem; display: flex; gap: 1rem; align-items: center;">
                    <input type="text" id="expense-search" placeholder="🔍 Search expenses..." style="flex: 1; padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px;" oninput="filterExpenses()">
                    <select id="expense-category-filter" onchange="filterExpenses()" style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px;">
                        <option value="">All Categories</option>
                        <option value="vehicle">Vehicle & Fuel</option>
                        <option value="tools">Tools & Equipment</option>
                        <option value="materials">Materials & Supplies</option>
                        <option value="office">Office Expenses</option>
                        <option value="utilities">Utilities</option>
                        <option value="insurance">Insurance</option>
                        <option value="marketing">Marketing & Advertising</option>
                        <option value="meals">Meals & Entertainment</option>
                        <option value="travel">Travel</option>
                        <option value="professional">Professional Services</option>
                        <option value="other">Other</option>
                    </select>
                    <button class="btn btn-secondary" onclick="exportExpensesToExcel()">📊 Export</button>
                </div>
                <div id="expenses-list"></div>
            </div>
        </div>

        <!-- Portfolio View -->
        <div id="portfolio" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>🖼️ Portfolio</h2>
                    <button class="btn btn-primary" onclick="openPortfolioModal()">+ Add Work</button>
                </div>
                <div style="margin-bottom:1rem;display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;">
                    <input type="text" id="portfolio-search" placeholder="🔍 Search..." oninput="filterPortfolio()" style="padding:0.5rem 0.75rem;border:2px solid #e2e8f0;border-radius:8px;min-width:180px;">
                    <select id="portfolio-category-filter" onchange="filterPortfolio()" style="padding:0.5rem 0.75rem;border:2px solid #e2e8f0;border-radius:8px;">
                        <option value="">All Categories</option>
                        <option value="bathroom">Bathroom</option>
                        <option value="kitchen">Kitchen</option>
                        <option value="deck">Deck / Patio</option>
                        <option value="flooring">Flooring</option>
                        <option value="painting">Painting</option>
                        <option value="carpentry">Carpentry</option>
                        <option value="electrical">Electrical</option>
                        <option value="plumbing">Plumbing</option>
                        <option value="exterior">Exterior</option>
                        <option value="general">General</option>
                    </select>
                </div>
                <div id="portfolio-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1.25rem;"></div>
            </div>
        </div>

        <!-- Portfolio Modal -->
        <div id="portfolioModal" class="modal">
            <div class="modal-content" style="max-width:540px;">
                <div class="modal-header">
                    <h2 id="portfolioModalTitle">Add Work</h2>
                    <button onclick="closePortfolioModal()" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#718096;">×</button>
                </div>
                <div class="modal-body">
                    <input type="hidden" id="portfolioEditId">
                    <div style="margin-bottom:1rem;">
                        <label style="font-weight:600;display:block;margin-bottom:0.4rem;">Photo *</label>
                        <div id="portfolio-upload-zone" style="border:2px dashed #cbd5e0;border-radius:8px;padding:2rem;text-align:center;cursor:pointer;position:relative;background:#f8fafc;" onclick="document.getElementById('portfolioFileInput').click()">
                            <div id="portfolio-upload-preview" style="display:none;"><img id="portfolio-preview-img" style="max-height:200px;max-width:100%;border-radius:6px;"></div>
                            <div id="portfolio-upload-prompt">
                                <div style="font-size:2rem;">📷</div>
                                <div style="color:#4a5568;font-weight:600;">Click to upload photo</div>
                                <div style="color:#9ca3af;font-size:0.8rem;margin-top:0.25rem;">Any size — auto compressed</div>
                            </div>
                            <input type="file" id="portfolioFileInput" accept="image/*" style="display:none;" onchange="handlePortfolioPhoto(this)">
                        </div>
                    </div>
                    <div style="margin-bottom:1rem;">
                        <label style="font-weight:600;display:block;margin-bottom:0.4rem;">Title</label>
                        <input type="text" id="portfolioTitle" placeholder="e.g. Master Bath Remodel" style="width:100%;padding:0.6rem 0.75rem;border:2px solid #e2e8f0;border-radius:8px;box-sizing:border-box;">
                    </div>
                    <div style="margin-bottom:1rem;">
                        <label style="font-weight:600;display:block;margin-bottom:0.4rem;">Category</label>
                        <select id="portfolioCategory" style="width:100%;padding:0.6rem 0.75rem;border:2px solid #e2e8f0;border-radius:8px;">
                            <option value="">Select category...</option>
                            <option value="bathroom">Bathroom</option>
                            <option value="kitchen">Kitchen</option>
                            <option value="deck">Deck / Patio</option>
                            <option value="flooring">Flooring</option>
                            <option value="painting">Painting</option>
                            <option value="carpentry">Carpentry</option>
                            <option value="electrical">Electrical</option>
                            <option value="plumbing">Plumbing</option>
                            <option value="exterior">Exterior</option>
                            <option value="general">General</option>
                        </select>
                    </div>
                    <div style="margin-bottom:1.5rem;">
                        <label style="font-weight:600;display:block;margin-bottom:0.4rem;">Caption</label>
                        <textarea id="portfolioCaption" rows="3" placeholder="Brief description of the work done..." style="width:100%;padding:0.6rem 0.75rem;border:2px solid #e2e8f0;border-radius:8px;box-sizing:border-box;resize:vertical;"></textarea>
                    </div>
                    <div style="margin-bottom:1.5rem;">
                        <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer;font-weight:600;">
                            <input type="checkbox" id="portfolioCommercial" style="width:1.1rem;height:1.1rem;accent-color:#1d6fa4;">
                            Commercial job
                        </label>
                        <div style="font-size:0.78rem;color:#6b7280;margin-top:0.25rem;margin-left:1.7rem;">Shows in the commercial portfolio section on the property management page.</div>
                    </div>
                    <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                        <button class="btn btn-secondary" onclick="closePortfolioModal()">Cancel</button>
                        <button class="btn btn-primary" onclick="savePortfolioItem()">Save</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Reports View -->
        <div id="activity" class="view">
            <div class="card">
                <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
                    <h2>📜 Activity Log</h2>
                    <div style="display:flex;gap:0.5rem;align-items:center;">
                        <select id="activityFilterType" onchange="loadActivityLog()" style="padding:0.4rem 0.6rem;border:1.5px solid #e2e8f0;border-radius:6px;font-size:0.85rem;">
                            <option value="">All activity</option>
                            <option value="portal_submission">Portal submissions</option>
                            <option value="quote">Quotes</option>
                            <option value="job">Jobs</option>
                            <option value="payment">Payments</option>
                            <option value="email">Emails sent</option>
                        </select>
                        <button class="btn btn-secondary btn-small" onclick="loadActivityLog()">↻ Refresh</button>
                    </div>
                </div>
                <div id="activityLogList" style="margin-top:1rem;"></div>
            </div>
        </div>

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
                            <button class="btn btn-secondary" onclick="exportTaxPrep()">📥 Tax Prep CSV</button>
                        </div>
                    </div>
                </div>

                <div id="reports-container">
                    <!-- Tax Reconciliation Report -->
                    <div class="report-section" style="background: #f0f9ff; border: 2px solid #667eea; padding: 1.5rem; border-radius: 8px; margin-bottom: 2rem;">
                        <h3 style="color: #667eea; margin-bottom: 1rem;">💰 Tax Reconciliation</h3>
                        <div style="margin-bottom: 1rem;">
                            <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">Tax Year</label>
                            <select id="tax-year-select" onchange="generateTaxReconciliation()" style="padding: 0.5rem; border: 2px solid #667eea; border-radius: 8px; min-width: 200px;">
                                <option value="current">Current Year</option>
                            </select>
                        </div>
                        <div id="tax-reconciliation-report"></div>
                    </div>

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
        <!-- Analytics View -->
        <div id="analytics" class="view">
            <div class="card" style="margin-bottom:1.5rem;">
                <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
                    <h2>Website Analytics</h2>
                    <div style="display:flex;gap:0.75rem;align-items:center;">
                        <span id="analyticsActiveUsers" style="background:#c6f6d5;color:#22543d;padding:0.4rem 1rem;border-radius:20px;font-weight:700;font-size:0.95rem;display:none;">● <span id="analyticsActiveCount">0</span> active now</span>
                        <a href="https://clarity.microsoft.com" target="_blank" class="btn btn-secondary" style="font-size:0.85rem;">Open Clarity ↗</a>
                    </div>
                </div>
                <div id="analyticsBody">
                    <div style="text-align:center;padding:3rem;color:#718096;">Loading analytics...</div>
                </div>
            </div>
        </div>

        <div id="settings" class="view">
            <div class="card">
                <div class="card-header">
                    <h2>Settings</h2>
                </div>

                <!-- Settings Tabs -->
                <div class="settings-tabs-bar" style="border-bottom: 2px solid #e2e8f0; margin-bottom: 2rem;">
                    <div style="display: flex; gap: 0.5rem;">
                        <button class="settings-tab active" onclick="switchSettingsTab('company')" data-tab="company">🏢 Company</button>
                        <button class="settings-tab" onclick="switchSettingsTab('messaging')" data-tab="messaging">📱 SMS</button>
                        <button class="settings-tab" onclick="switchSettingsTab('email')" data-tab="email">📧 Email</button>
                        <button class="settings-tab" onclick="switchSettingsTab('account')" data-tab="account">🔒 Account</button>
                        <button class="settings-tab" id="usersTab" onclick="switchSettingsTab('users')" data-tab="users" style="display: none;">👥 Users</button>
                        <button class="settings-tab" onclick="switchSettingsTab('compliance')" data-tab="compliance" id="complianceTabBtn">🛡️ License & Insurance</button>
                    </div>
                </div>

                <!-- Company & Billing Tab -->
                <div id="companyTab" class="settings-tab-content">
                    <form id="settingsForm" style="max-width: 600px;">
                    <h3 style="margin-bottom: 1rem; color: #667eea;">App Branding</h3>
                    <div class="form-group">
                        <label>App Name</label>
                        <input type="text" name="appName" placeholder="Jobber Pro">
                        <small style="color: #718096; display: block; margin-top: 0.5rem;">This name appears in the browser tab and throughout the app</small>
                    </div>
                    <div class="form-group">
                        <label>Favicon</label>
                        <div style="display: flex; align-items: center; gap: 1rem;">
                            <img id="favicon-preview" src="" alt="Favicon preview" style="width: 32px; height: 32px; display: none; border: 2px solid #e2e8f0; border-radius: 4px;">
                            <div>
                                <input type="file" id="favicon-upload" accept="image/*,.ico" style="display: none;" onchange="handleFaviconUpload(event)">
                                <button type="button" class="btn btn-secondary" onclick="document.getElementById('favicon-upload').click()">Upload Favicon</button>
                                <button type="button" class="btn btn-danger btn-small" id="remove-favicon" onclick="removeFavicon()" style="display: none; margin-left: 0.5rem;">Remove</button>
                            </div>
                        </div>
                        <small style="color: #718096; display: block; margin-top: 0.5rem;">Recommended: ICO or PNG, 32x32px or 64x64px</small>
                        <input type="hidden" name="favicon" id="favicon">
                    </div>

                    <h3 style="margin: 2rem 0 1rem 0; color: #667eea;">Company Information</h3>
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
                    <div class="form-group">
                        <label>Contract Terms</label>
                        <textarea name="contractTerms" rows="6" placeholder="Enter contract terms and conditions that will appear at the bottom of invoices..."></textarea>
                        <small style="color: #718096; display: block; margin-top: 0.5rem;">These terms will be displayed at the bottom of all invoices</small>
                    </div>

                    <div style="margin-top: 2rem;">
                        <button type="button" class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
                    </div>
                </form>
                </div>

                <!-- SMS Messaging Tab -->
                <div id="messagingTab" class="settings-tab-content" style="display: none;">
                    <div style="max-width: 600px;">
                    <h3 style="margin-bottom: 1rem; color: #667eea;">SMS / Text Messaging</h3>
                    <div id="smsConfigStatus" style="padding: 1rem; border-radius: 8px; margin-bottom: 1rem;">
                        <p style="margin: 0;">Loading SMS status...</p>
                    </div>
                    <div style="margin-bottom: 1rem;">
                        <button type="button" class="btn btn-secondary" onclick="previewAppointmentReminders()">👁️ Preview Tomorrow's Reminders</button>
                        <button type="button" class="btn btn-primary" onclick="sendAppointmentReminders()" style="margin-left: 0.5rem;">📱 Send Tomorrow's Appointment Reminders</button>
                    </div>
                    <div id="reminderPreview" style="display: none; padding: 1rem; background: #f7fafc; border-radius: 8px; border: 1px solid #cbd5e0; margin-bottom: 1rem;">
                        <h4 style="margin: 0 0 0.5rem 0; color: #2d3748;">Reminders Preview</h4>
                        <div id="reminderPreviewList"></div>
                    </div>
                    <small style="color: #718096; display: block;">
                        SMS automatically sends when:<br>
                        • Job is scheduled (appointment confirmation)<br>
                        • Status changes (in progress, completed, invoiced)<br>
                        • Payment is recorded (receipt confirmation)<br>
                        Use the 📱 button next to clients to send custom messages.
                    </small>
                    </div>
                </div>

                <!-- Email Settings Tab -->
                <div id="emailTab" class="settings-tab-content" style="display: none;">
                    <div style="max-width: 800px;">

                    <div id="emailConfigStatus" style="padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem; border: 2px solid #e2e8f0;">
                        <p style="margin: 0; font-weight: 600;">Loading email status...</p>
                    </div>

                    <!-- Google Calendar Integration -->
                    <div style="margin-bottom: 3rem; padding-bottom: 3rem; border-bottom: 2px solid #e2e8f0;">
                        <h3 style="margin-bottom: 1rem; color: #667eea;">📅 Google Calendar Integration</h3>
                        <p style="color: #718096; margin-bottom: 1.5rem;">Automatically sync scheduled jobs to your Google Calendar.</p>

                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                                <input type="checkbox" id="calendarAutoSync" style="width: auto;">
                                <span>Automatically create calendar events when jobs are scheduled</span>
                            </label>
                            <small style="color: #718096; display: block; margin-top: 0.5rem; margin-left: 1.5rem;">
                                New jobs with scheduled dates will be added to your Google Calendar automatically
                            </small>
                        </div>

                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                                <input type="checkbox" id="calendarSendInvites" style="width: auto;">
                                <span>Send calendar invites to clients by default</span>
                            </label>
                            <small style="color: #718096; display: block; margin-top: 0.5rem; margin-left: 1.5rem;">
                                Clients will receive a calendar invite email when jobs are created
                            </small>
                        </div>

                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                                <input type="checkbox" id="calendarUpdateOnChange" style="width: auto;">
                                <span>Update calendar events when job details change</span>
                            </label>
                            <small style="color: #718096; display: block; margin-top: 0.5rem; margin-left: 1.5rem;">
                                Calendar events will be updated when you change job date, time, or details
                            </small>
                        </div>

                        <button type="button" class="btn btn-primary" onclick="saveCalendarSettings()">💾 Save Calendar Settings</button>

                        <div style="margin-top: 2rem; background: #f0f9ff; padding: 1rem; border-left: 4px solid #667eea; border-radius: 4px;">
                            <strong>ℹ️ Note:</strong> Calendar integration uses the same Gmail API credentials configured below.
                        </div>
                    </div>

                    <!-- Email Templates Section -->
                    <div style="margin-bottom: 3rem;">
                        <h3 style="margin-bottom: 1rem; color: #667eea;">✉️ Email Templates</h3>
                        <p style="color: #718096; margin-bottom: 1.5rem;">Customize the email templates sent to clients and team members.</p>

                        <div class="form-group">
                            <label style="font-weight: 600; font-size: 1rem;">Invoice Email Subject</label>
                            <input type="text" id="invoiceEmailSubject" placeholder="Invoice #{invoiceNumber} from {companyName}">
                            <small style="color: #718096; display: block; margin-top: 0.5rem;">
                                Variables: {invoiceNumber}, {companyName}, {clientName}, {total}
                            </small>
                        </div>

                        <div class="form-group">
                            <label style="font-weight: 600; font-size: 1rem;">Invoice Email Body</label>
                            <textarea id="invoiceEmailBody" rows="8" placeholder="Dear {clientName},&#10;&#10;Thank you for your business! Your invoice is ready for review.&#10;&#10;Invoice #{invoiceNumber}&#10;Job: {jobTitle}&#10;Total: ${total}&#10;&#10;View your invoice: {invoiceUrl}"></textarea>
                            <small style="color: #718096; display: block; margin-top: 0.5rem;">
                                Variables: {clientName}, {invoiceNumber}, {jobTitle}, {total}, {invoiceUrl}, {companyName}
                            </small>
                        </div>

                        <div class="form-group">
                            <label style="font-weight: 600; font-size: 1rem;">User Credentials Email Subject</label>
                            <input type="text" id="credentialsEmailSubject" placeholder="Your {companyName} Account Credentials">
                            <small style="color: #718096; display: block; margin-top: 0.5rem;">
                                Variables: {companyName}
                            </small>
                        </div>

                        <div class="form-group">
                            <label style="font-weight: 600; font-size: 1rem;">User Credentials Email Body</label>
                            <textarea id="credentialsEmailBody" rows="8" placeholder="Hi {name},&#10;&#10;Your account has been created!&#10;&#10;Email: {email}&#10;Temporary Password: {tempPassword}&#10;&#10;Login at: {loginUrl}&#10;&#10;Please change your password after logging in."></textarea>
                            <small style="color: #718096; display: block; margin-top: 0.5rem;">
                                Variables: {name}, {email}, {tempPassword}, {loginUrl}, {companyName}
                            </small>
                        </div>

                        <button type="button" class="btn btn-primary" onclick="saveEmailTemplates()">💾 Save Email Templates</button>
                    </div>

                    <!-- Collapsible Gmail API Configuration -->
                    <div style="border-top: 2px solid #e2e8f0; padding-top: 2rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; padding: 1rem; background: #f7fafc; border-radius: 8px; margin-bottom: 1rem;" onclick="toggleGmailApiConfig()">
                            <h3 style="margin: 0; color: #667eea;">⚙️ Gmail API Configuration</h3>
                            <span id="gmailApiToggleIcon" style="font-size: 1.5rem; user-select: none;">▶</span>
                        </div>

                        <div id="gmailApiConfigContent" style="display: none;">
                            <div style="background: #fffacd; padding: 1rem; border-left: 4px solid #f59e0b; margin-bottom: 1.5rem; border-radius: 4px;">
                                <strong>ℹ️ Setup Required:</strong>
                                <p style="margin: 0.5rem 0 0 0; font-size: 0.9rem;">
                                    To use email functionality, you need to set up Gmail API credentials.
                                    <a href="https://github.com/anthropics/claude-code" target="_blank" style="color: #667eea;">View Setup Guide</a>
                                </p>
                            </div>

                    <form id="emailSettingsForm">
                        <div class="form-group">
                            <label>Gmail Client ID</label>
                            <input type="text" id="gmailClientId" placeholder="your-app.apps.googleusercontent.com" style="font-family: monospace; font-size: 0.9rem;">
                            <small style="color: #718096; display: block; margin-top: 0.5rem;">
                                From Google Cloud Console OAuth 2.0 credentials
                            </small>
                        </div>

                        <div class="form-group">
                            <label style="display: flex; justify-content: space-between; align-items: center;">
                                <span>Gmail Client Secret</span>
                                <button type="button" class="btn btn-secondary btn-small" onclick="revealSecrets()" style="font-size: 0.8rem;">👁️ Reveal Secrets</button>
                            </label>
                            <input type="password" id="gmailClientSecret" placeholder="GOCSPX-..." style="font-family: monospace; font-size: 0.9rem;" readonly>
                            <small style="color: #718096; display: block; margin-top: 0.5rem;">
                                OAuth 2.0 client secret
                            </small>
                        </div>

                        <div class="form-group">
                            <label>Gmail Refresh Token</label>
                            <input type="password" id="gmailRefreshToken" placeholder="1//0..." style="font-family: monospace; font-size: 0.9rem;" readonly>
                            <small style="color: #718096; display: block; margin-top: 0.5rem;">
                                Generate from OAuth 2.0 Playground
                            </small>
                        </div>

                        <div class="form-group">
                            <label>Gmail User Email</label>
                            <input type="email" id="gmailUser" placeholder="your-email@gmail.com">
                            <small style="color: #718096; display: block; margin-top: 0.5rem;">
                                The Gmail account to send emails from
                            </small>
                        </div>

                        <div style="margin-top: 2rem; display: flex; gap: 1rem;">
                            <button type="button" class="btn btn-primary" onclick="saveEmailSettings()">💾 Save Email Settings</button>
                            <button type="button" class="btn btn-secondary" onclick="testEmailConnection()">📧 Send Test Email</button>
                        </div>
                    </form>

                    <div style="margin-top: 3rem; padding-top: 2rem; border-top: 2px solid #e2e8f0;">
                        <h3 style="margin-bottom: 1rem; color: #667eea;">Email Features</h3>
                        <ul style="color: #4a5568; line-height: 1.8;">
                            <li>📨 <strong>User Credentials:</strong> Send login info to new team members</li>
                            <li>📄 <strong>Invoice Emails:</strong> Email invoices directly to clients</li>
                            <li>✉️ <strong>Professional Templates:</strong> Beautiful HTML email designs</li>
                            <li>🔒 <strong>Secure OAuth2:</strong> No password storage, token-based authentication</li>
                        </ul>
                    </div>

                    <div style="margin-top: 2rem; background: #f7fafc; padding: 1.5rem; border-radius: 8px;">
                        <h4 style="margin: 0 0 1rem 0; color: #2d3748;">📚 Quick Setup Guide</h4>
                        <ol style="color: #4a5568; line-height: 1.8; padding-left: 1.5rem;">
                            <li>Go to <a href="https://console.cloud.google.com/" target="_blank" style="color: #667eea;">Google Cloud Console</a></li>
                            <li>Create a new project or select existing</li>
                            <li>Enable Gmail API</li>
                            <li>Create OAuth 2.0 credentials</li>
                            <li>Use <a href="https://developers.google.com/oauthplayground" target="_blank" style="color: #667eea;">OAuth Playground</a> to get refresh token</li>
                            <li>Enter credentials above and click Save</li>
                            <li>Test with the "Send Test Email" button</li>
                        </ol>
                    </div>
                        </div>
                    </div>
                    </div>
                </div>

                <!-- Account & Password Tab -->
                <div id="accountTab" class="settings-tab-content" style="display: none;">
                    <div style="max-width: 600px;">
                    <h3 style="margin-bottom: 1rem; color: #667eea;">Change Password</h3>
                <form id="passwordForm">
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
                </div>

                <!-- User Management Tab (Admin Only) -->
                <div id="usersTab-content" class="settings-tab-content" style="display: none;">
                    <h3 style="margin: 0 0 1rem 0; color: #667eea;">User Management</h3>

                    <!-- Sub-tabs -->
                    <div style="display: flex; gap: 0; margin-bottom: 1.5rem; border-bottom: 2px solid #e2e8f0;">
                        <button id="umTab-business" onclick="switchUserMgmtTab('business')" style="padding: 0.6rem 1.25rem; background: none; border: none; border-bottom: 3px solid #667eea; color: #667eea; font-weight: 600; cursor: pointer; font-size: 0.95rem; margin-bottom: -2px;">🏢 Business Users</button>
                        <button id="umTab-portal" onclick="switchUserMgmtTab('portal')" style="padding: 0.6rem 1.25rem; background: none; border: none; border-bottom: 3px solid transparent; color: #718096; font-weight: 600; cursor: pointer; font-size: 0.95rem; margin-bottom: -2px;">🏠 Client Portal Users</button>
                    </div>

                    <!-- Business Users panel -->
                    <div id="umPanel-business">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                            <span style="color: #718096; font-size: 0.9rem;">Staff and admin accounts that log into the app.</span>
                            <button class="btn btn-primary" onclick="showAddUserModal()">+ Add User</button>
                        </div>
                        <div style="padding: 1rem; background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; margin-bottom: 1rem;">
                            <strong>⚠️ Important:</strong> User's full name must exactly match their Team Member name for Time Clock job assignments to work.
                        </div>
                        <div id="usersList"></div>
                    </div>

                    <!-- Client Portal Users panel -->
                    <div id="umPanel-portal" style="display: none;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                            <span style="color: #718096; font-size: 0.9rem;">Clients with access to the client portal.</span>
                        </div>
                        <input type="text" id="portalUserSearch" placeholder="🔍 Search by name..." oninput="filterPortalUsers()" style="width: 100%; padding: 0.6rem 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; margin-bottom: 1rem; font-size: 0.95rem;">
                        <div id="portalUsersList"></div>
                    </div>
                </div>

                <!-- License & Insurance Tab -->
                <div id="complianceTab" class="settings-tab-content" style="display: none;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                        <div>
                            <h3 style="margin: 0 0 0.25rem 0; color: #667eea;">🛡️ License & Insurance Documents</h3>
                            <p style="margin: 0; color: #718096; font-size: 0.9rem;">Store your business credentials. Send them to clients on request.</p>
                        </div>
                        <button class="btn btn-primary" onclick="document.getElementById('compDocUploadForm').style.display = document.getElementById('compDocUploadForm').style.display === 'none' ? 'block' : 'none'">+ Add Document</button>
                    </div>

                    <div id="compDocExpiryWarning" style="display: none; background: #fef3c7; border: 1px solid #fcd34d; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem; color: #92400e;">
                        ⚠️ <span id="compDocExpiryText"></span>
                    </div>

                    <div id="compDocUploadForm" style="display: none; background: #f8fafc; border: 2px solid #e2e8f0; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;">
                        <h4 style="margin: 0 0 1rem 0; color: #4a5568;">Upload New Document</h4>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                            <div class="form-group" style="margin: 0;">
                                <label>Document Type</label>
                                <select id="compDocType" style="width: 100%; padding: 0.6rem; border: 2px solid #e2e8f0; border-radius: 8px;">
                                    <option value="license">License</option>
                                    <option value="gl_insurance">Insurance — General Liability</option>
                                    <option value="umbrella_insurance">Insurance — Umbrella</option>
                                    <option value="workers_comp">Workers Compensation</option>
                                    <option value="surety_bond">Surety Bond</option>
                                    <option value="other">Other</option>
                                </select>
                            </div>
                            <div class="form-group" style="margin: 0;">
                                <label>Expiration Date</label>
                                <input type="date" id="compDocExpiry" style="width: 100%; padding: 0.6rem; border: 2px solid #e2e8f0; border-radius: 8px;">
                            </div>
                        </div>
                        <div class="form-group" style="margin-bottom: 1rem;">
                            <label>Notes (optional)</label>
                            <input type="text" id="compDocNotes" placeholder="Policy number, issuer, etc." style="width: 100%; padding: 0.6rem; border: 2px solid #e2e8f0; border-radius: 8px;">
                        </div>
                        <div style="display: flex; align-items: center; gap: 1rem;">
                            <label style="background: #667eea; color: white; padding: 0.6rem 1.25rem; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 0.9rem; white-space: nowrap;">
                                📎 Choose File
                                <input type="file" id="compDocFile" accept=".pdf,.jpg,.jpeg,.png" style="display: none;" onchange="handleCompDocFileSelect(event)">
                            </label>
                            <span id="compDocFileName" style="color: #718096; font-size: 0.9rem;">No file chosen</span>
                            <button class="btn btn-primary" onclick="uploadComplianceDoc()" style="margin-left: auto;">Upload</button>
                        </div>
                    </div>

                    <div id="compDocsList"></div>
                </div>
            </div>
        </div>
    </div>

    <!-- Send Compliance Docs Modal -->
    <div id="sendComplianceModal" class="modal">
        <div class="modal-content" style="max-width: 520px;">
            <div class="modal-header">
                <h2>📎 Send Compliance Documents</h2>
                <button class="close-btn" onclick="closeModal('sendComplianceModal')">&times;</button>
            </div>
            <div class="modal-body">
                <p style="color: #4a5568; margin-bottom: 1rem;">Select which documents to send to <strong id="sendCompClientName"></strong>.</p>
                <div id="sendCompDocCheckboxes" style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1.25rem;"></div>
                <div class="form-group">
                    <label>Additional Message (optional)</label>
                    <textarea id="sendCompMessage" rows="3" placeholder="Please find our license and insurance documents attached..." style="width: 100%; padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; font-family: inherit; resize: vertical; box-sizing: border-box;"></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('sendComplianceModal')">Cancel</button>
                <button class="btn btn-primary" onclick="sendComplianceDocs()">📧 Send Email</button>
            </div>
        </div>
    </div>

    <!-- Edit Compliance Doc Modal -->
    <div id="editComplianceModal" class="modal">
        <div class="modal-content" style="max-width: 460px;">
            <div class="modal-header">
                <h2>✏️ Edit Document</h2>
                <button class="close-btn" onclick="closeModal('editComplianceModal')">&times;</button>
            </div>
            <div class="modal-body">
                <input type="hidden" id="editCompDocId">
                <div class="form-group">
                    <label>Document Type</label>
                    <select id="editCompDocType" style="width:100%;padding:0.6rem;border:2px solid #e2e8f0;border-radius:8px;">
                        <option value="license">License</option>
                        <option value="gl_insurance">Insurance — General Liability</option>
                        <option value="umbrella_insurance">Insurance — Umbrella</option>
                        <option value="workers_comp">Workers Compensation</option>
                        <option value="surety_bond">Surety Bond</option>
                        <option value="other">Other</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Expiration Date</label>
                    <input type="date" id="editCompDocExpiry" style="width:100%;padding:0.6rem;border:2px solid #e2e8f0;border-radius:8px;">
                </div>
                <div class="form-group">
                    <label>Notes</label>
                    <input type="text" id="editCompDocNotes" placeholder="Policy number, issuer, etc." style="width:100%;padding:0.6rem;border:2px solid #e2e8f0;border-radius:8px;">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('editComplianceModal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveComplianceDocEdit()">Save Changes</button>
            </div>
        </div>
    </div>

    <!-- Clock-Out Survey Modal -->
    <div id="clockOutSurveyModal" class="modal">
        <div class="modal-content" style="max-width:420px;">
            <div class="modal-header" style="background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px 12px 0 0;">
                <div>
                    <h2 style="color:white;margin-bottom:0.2rem;">Before You Go 👋</h2>
                    <p id="surveyJobLabel" style="color:rgba(255,255,255,0.8);font-size:0.9rem;margin:0;"></p>
                </div>
            </div>
            <div class="modal-body" style="padding:1.5rem;">
                <p style="color:#4a5568;font-weight:600;margin-bottom:0.75rem;">How did the job go?</p>
                <div id="starRating" style="display:flex;gap:0.5rem;font-size:2.5rem;margin-bottom:1.25rem;cursor:pointer;">
                    <span data-val="1" onclick="setSurveyRating(1)">☆</span>
                    <span data-val="2" onclick="setSurveyRating(2)">☆</span>
                    <span data-val="3" onclick="setSurveyRating(3)">☆</span>
                    <span data-val="4" onclick="setSurveyRating(4)">☆</span>
                    <span data-val="5" onclick="setSurveyRating(5)">☆</span>
                </div>
                <label style="font-weight:600;color:#4a5568;display:block;margin-bottom:0.4rem;">Notes / Lessons Learned</label>
                <textarea id="surveyComment" rows="3" placeholder="Anything worth noting for next time?" style="width:100%;padding:0.75rem;border:2px solid #e2e8f0;border-radius:8px;font-family:inherit;font-size:0.95rem;resize:vertical;box-sizing:border-box;"></textarea>
                <p id="surveyRatingError" style="color:#e53e3e;font-size:0.85rem;display:none;margin-top:0.4rem;">Please select a star rating.</p>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="clockOutSkipSurvey()">Skip & Clock Out</button>
                <button class="btn btn-danger" onclick="submitClockOutSurvey()">✅ Confirm Clock Out</button>
            </div>
        </div>
    </div>

    <!-- Vendor Modal -->
    <div id="vendorModal" class="modal">
        <div class="modal-content" style="max-width:560px;">
            <div class="modal-header">
                <h2 id="vendorModalTitle">Add Vendor</h2>
                <button class="close-btn" onclick="closeModal('vendorModal')">&times;</button>
            </div>
            <div class="modal-body">
                <form id="vendorForm">
                    <input type="hidden" id="vendorId">
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
                        <div class="form-group" style="grid-column:1/-1;">
                            <label>Vendor Name *</label>
                            <input type="text" id="vendorName" required placeholder="e.g. Home Depot, Ferguson Plumbing">
                        </div>
                        <div class="form-group">
                            <label>Category</label>
                            <select id="vendorCategory">
                                <option value="">Select category...</option>
                                <option value="lumber">Lumber & Building Materials</option>
                                <option value="electrical">Electrical</option>
                                <option value="plumbing">Plumbing</option>
                                <option value="hvac">HVAC</option>
                                <option value="hardware">Hardware & Fasteners</option>
                                <option value="paint">Paint & Finishes</option>
                                <option value="flooring">Flooring</option>
                                <option value="roofing">Roofing</option>
                                <option value="tools">Tools & Equipment</option>
                                <option value="landscaping">Landscaping & Outdoor</option>
                                <option value="subcontractor">Subcontractor</option>
                                <option value="other">Other</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Account #</label>
                            <input type="text" id="vendorAccountNumber" placeholder="Trade account number">
                        </div>
                        <div class="form-group">
                            <label>Phone</label>
                            <input type="tel" id="vendorPhone" placeholder="(555) 555-5555">
                        </div>
                        <div class="form-group">
                            <label>Email</label>
                            <input type="email" id="vendorEmail" placeholder="contact@vendor.com">
                        </div>
                        <div class="form-group" style="grid-column:1/-1;">
                            <label>Website</label>
                            <input type="text" id="vendorWebsite" placeholder="https://...">
                        </div>
                        <div class="form-group">
                            <label>Contact Person</label>
                            <input type="text" id="vendorContact" placeholder="Rep or account manager">
                        </div>
                        <div class="form-group">
                            <label>Address</label>
                            <input type="text" id="vendorAddress" placeholder="Store / office address">
                        </div>
                        <div class="form-group" style="grid-column:1/-1;">
                            <label>Notes</label>
                            <textarea id="vendorNotes" rows="3" placeholder="Payment terms, discount codes, hours, etc." style="width:100%;padding:0.75rem;border:2px solid #e2e8f0;border-radius:8px;font-family:inherit;resize:vertical;"></textarea>
                        </div>
                    </div>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('vendorModal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveVendor()">Save Vendor</button>
            </div>
        </div>
    </div>

    <!-- Deposit Request Modal -->
    <div id="depositModal" class="modal">
        <div class="modal-content" style="max-width:380px;">
            <div class="modal-header">
                <h2>💳 Request Deposit</h2>
                <button class="close-btn" onclick="closeModal('depositModal')">&times;</button>
            </div>
            <div class="modal-body">
                <p style="color:#718096;margin-bottom:1rem;">Client will receive an email with a secure payment link.</p>
                <div class="form-group">
                    <label>Deposit Amount ($)</label>
                    <input type="number" id="depositAmount" step="0.01" min="1" style="width:100%;padding:0.75rem;border:2px solid #e2e8f0;border-radius:8px;font-size:1.1rem;font-weight:700;color:#667eea;">
                    <small id="depositPctLabel" style="color:#718096;display:block;margin-top:0.4rem;"></small>
                </div>
                <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
                    <button class="btn btn-secondary btn-small" onclick="setDepositPct(25)">25%</button>
                    <button class="btn btn-secondary btn-small" onclick="setDepositPct(50)">50%</button>
                    <button class="btn btn-secondary btn-small" onclick="setDepositPct(75)">75%</button>
                    <button class="btn btn-secondary btn-small" onclick="setDepositPct(100)">100%</button>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('depositModal')">Cancel</button>
                <button class="btn btn-primary" onclick="sendDepositRequest()">Send Request</button>
            </div>
        </div>
    </div>

    <!-- Enter Card Modal (admin manual card entry) -->
    <div id="enterCardModal" class="modal">
        <div class="modal-content" style="max-width:420px;">
            <div class="modal-header">
                <h2>💳 Enter Card</h2>
                <button class="close-btn" onclick="closeModal('enterCardModal')">&times;</button>
            </div>
            <div class="modal-body">
                <p id="enterCardJobLabel" style="font-weight:600;color:#4a5568;margin-bottom:1rem;"></p>
                <div class="form-group" style="margin-bottom:1rem;">
                    <label style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;display:block;margin-bottom:0.35rem;">Amount ($)</label>
                    <input type="number" id="enterCardAmount" step="0.01" min="0.50" style="width:100%;padding:0.75rem;border:2px solid #e2e8f0;border-radius:8px;font-size:1.1rem;font-weight:700;color:#667eea;">
                </div>
                <div style="height:1px;background:#f1f5f9;margin:0.25rem 0 1rem;"></div>
                <div style="margin-bottom:0.9rem;">
                    <label style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;display:block;margin-bottom:0.35rem;">Card Number</label>
                    <div id="admin-card-number" style="height:46px;border:1.5px solid #e2e8f0;border-radius:8px;background:#f8fafc;overflow:hidden;display:flex;align-items:center;"></div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.875rem;margin-bottom:0.9rem;">
                    <div>
                        <label style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;display:block;margin-bottom:0.35rem;">Expiry</label>
                        <div id="admin-card-date" style="height:46px;border:1.5px solid #e2e8f0;border-radius:8px;background:#f8fafc;overflow:hidden;display:flex;align-items:center;"></div>
                    </div>
                    <div>
                        <label style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;display:block;margin-bottom:0.35rem;">CVV</label>
                        <div id="admin-card-cvv" style="height:46px;border:1.5px solid #e2e8f0;border-radius:8px;background:#f8fafc;overflow:hidden;display:flex;align-items:center;"></div>
                    </div>
                </div>
                <div style="margin-bottom:0.9rem;">
                    <label style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;display:block;margin-bottom:0.35rem;">ZIP Code</label>
                    <div id="admin-card-zip" style="height:46px;border:1.5px solid #e2e8f0;border-radius:8px;background:#f8fafc;overflow:hidden;display:flex;align-items:center;"></div>
                </div>
                <div id="enterCardError" style="display:none;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:0.65rem 0.875rem;border-radius:8px;font-size:0.85rem;margin-bottom:0.75rem;"></div>
                <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-size:0.85rem;color:#4a5568;margin-bottom:0.5rem;">
                    <input type="checkbox" id="enterCardSave" checked style="width:15px;height:15px;accent-color:#667eea;cursor:pointer;flex-shrink:0;">
                    Save card for future payments
                </label>
                <p style="font-size:0.75rem;color:#94a3b8;text-align:center;margin-top:0.5rem;">🔒 Tokenized via Clover · PCI compliant</p>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('enterCardModal')">Cancel</button>
                <button class="btn btn-primary" id="enterCardSubmitBtn" onclick="submitEnterCard()">Charge Card</button>
            </div>
        </div>
    </div>

    <!-- Charge Saved Card Modal -->
    <div id="chargeCardModal" class="modal">
        <div class="modal-content" style="max-width:380px;">
            <div class="modal-header">
                <h2>💳 Charge Saved Card</h2>
                <button class="close-btn" onclick="closeModal('chargeCardModal')">&times;</button>
            </div>
            <div class="modal-body">
                <p id="chargeCardInfo" style="color:#4a5568;margin-bottom:1rem;font-weight:600;"></p>
                <p style="color:#718096;font-size:0.875rem;margin-bottom:1rem;">The card on file will be charged immediately.</p>
                <div class="form-group">
                    <label>Amount ($)</label>
                    <input type="number" id="chargeCardAmount" step="0.01" min="0.50" style="width:100%;padding:0.75rem;border:2px solid #e2e8f0;border-radius:8px;font-size:1.1rem;font-weight:700;color:#667eea;">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('chargeCardModal')">Cancel</button>
                <button class="btn btn-primary" onclick="submitChargeCard()">Charge Card</button>
            </div>
        </div>
    </div>

    <!-- Login Log Modal -->
    <div id="loginLogModal" class="modal">
        <div class="modal-content" style="max-width:580px;">
            <div class="modal-header">
                <h2 id="loginLogTitle">Sign-In History</h2>
                <button class="close-btn" onclick="closeModal('loginLogModal')">&times;</button>
            </div>
            <div class="modal-body">
                <div id="loginLogContent"></div>
            </div>
        </div>
    </div>

    <!-- Portal Password Modal -->
    <div id="portalPwModal" class="modal">
        <div class="modal-content" style="max-width:380px;">
            <div class="modal-header">
                <h2>Change Access Code</h2>
                <button class="close-btn" onclick="closeModal('portalPwModal')">&times;</button>
            </div>
            <div class="modal-body">
                <p id="portalPwClientName" style="color:#718096;margin-bottom:1rem;"></p>
                <label style="font-weight:600;display:block;margin-bottom:0.4rem;">New Access Code</label>
                <input type="text" id="portalPwInput" placeholder="e.g. 1234 or a word" style="width:100%;padding:0.75rem;border:2px solid #e2e8f0;border-radius:8px;font-size:1rem;margin-bottom:1rem;">
                <p id="portalPwError" style="color:#e53e3e;display:none;margin-bottom:0.5rem;"></p>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('portalPwModal')">Cancel</button>
                <button class="btn btn-primary" onclick="savePortalPassword()">Save</button>
            </div>
        </div>
    </div>

    <!-- Client Modal -->
    <!-- Quote View Log Modal -->
    <div id="viewLogModal" class="modal">
        <div class="modal-content" style="max-width:520px;">
            <div class="modal-header">
                <h2>Quote View History</h2>
                <button class="close-btn" onclick="closeModal('viewLogModal')">&times;</button>
            </div>
            <div class="modal-body">
                <div id="viewLogContent"></div>
            </div>
        </div>
    </div>

    <div id="payDiagModal" class="modal">
        <div class="modal-content" style="max-width:640px;">
            <div class="modal-header">
                <h2>💳 Payment Diagnostics</h2>
                <button class="close-btn" onclick="closeModal('payDiagModal')">&times;</button>
            </div>
            <div class="modal-body">
                <div id="payDiagContent"></div>
            </div>
        </div>
    </div>

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
                    <div class="city-state-zip-grid" style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 1rem;">
                        <div class="form-group">
                            <label>City</label>
                            <input type="text" name="city" id="clientCity">
                        </div>
                        <div class="form-group">
                            <label>State</label>
                            <input type="text" name="state" id="clientState" list="statesList" maxlength="2" style="text-transform: uppercase;">
                        </div>
                        <div class="form-group">
                            <label>ZIP</label>
                            <input type="text" name="zipCode" id="clientZipCode" maxlength="10" oninput="prefillStateFromZip(this)">
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
                    <div class="form-group">
                        <label>Payment Terms</label>
                        <select name="paymentTerms">
                            <option value="">— None —</option>
                            <option value="due_receipt">Due on Receipt</option>
                            <option value="net_15">Net 15</option>
                            <option value="net_30">Net 30</option>
                            <option value="net_45">Net 45</option>
                            <option value="net_60">Net 60</option>
                            <option value="net_90">Net 90</option>
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

                    <div style="margin-top: 2rem; padding-top: 2rem; border-top: 2px solid #e2e8f0;">
                        <h3 style="margin-bottom: 1rem; color: #667eea;">🔐 Client Portal Access</h3>
                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                                <input type="checkbox" id="enablePortalAccess" onchange="togglePortalFields()" style="width: auto; cursor: pointer;">
                                <span>Enable Client Portal access for this client</span>
                            </label>
                            <small style="color: #718096; display: block; margin-top: 0.5rem;">
                                Allows client to view their quotes, jobs, and invoices online
                            </small>
                        </div>
                        <div id="portalFields" style="display: none; margin-top: 1rem;">
                            <div class="form-group">
                                <label>Portal Access Code</label>
                                <input type="text" id="portalPassword" placeholder="Set a simple access code (e.g., 1234)" autocomplete="new-password">
                                <small style="color: #718096; display: block; margin-top: 0.5rem;">
                                    Client will use this code to log in at /client-login
                                </small>
                            </div>
                            <button type="button" class="btn btn-secondary" id="sendPortalInfoBtn" onclick="sendPortalInfo()" style="display: none; margin-top: 0.5rem;">
                                📧 Email Portal Login Info to Client
                            </button>
                        </div>
                    </div>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('clientModal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveClient()">Save Client</button>
            </div>
        </div>
    </div>

    <!-- Send Portal Login Modal -->
    <div id="sendPortalModal" class="modal">
        <div class="modal-content" style="max-width:420px;">
            <div class="modal-header">
                <h2>📧 Send Portal Login</h2>
                <button class="close-btn" onclick="closeModal('sendPortalModal')">&times;</button>
            </div>
            <div class="modal-body">
                <p style="color:#4a5568;margin-bottom:1.25rem;">Choose which address/contact to send the portal login email to.</p>
                <div class="form-group">
                    <label>Send To</label>
                    <select id="portalSendToSelect" style="width:100%;padding:0.6rem;border:2px solid #e2e8f0;border-radius:8px;"></select>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('sendPortalModal')">Cancel</button>
                <button class="btn btn-primary" onclick="confirmSendPortalInfo()">📧 Send</button>
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
                <div id="jobWorkflowStepper" style="display:none;background:#f8f9ff;border:1.5px solid #e2e8f0;border-radius:10px;padding:0.75rem 1rem 0.5rem;margin-bottom:1.25rem;"></div>
                <form id="jobForm">
                    <input type="hidden" name="id">
                    <div class="form-group">
                        <label>Client *</label>
                        <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-start;">
                            <div style="position: relative; flex: 1; min-width: 200px;">
                                <input type="text" id="jobClientInput" placeholder="Type to search clients..." autocomplete="off" oninput="filterClientTypeahead()" onfocus="filterClientTypeahead()" style="width: 100%; padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 16px;">
                                <input type="hidden" name="clientId" id="jobClientSelect">
                                <div id="clientTypeaheadDropdown" style="display:none; position:absolute; top:100%; left:0; right:0; background:white; border:2px solid #667eea; border-top:none; border-radius:0 0 8px 8px; max-height:220px; overflow-y:auto; z-index:1000; box-shadow:0 4px 12px rgba(0,0,0,0.15);"></div>
                            </div>
                            <button type="button" class="btn btn-secondary" onclick="openClientModalFromJob()" style="white-space: nowrap;">+ Add Client</button>
                        </div>
                    </div>
                    <div class="form-group" id="serviceLocationGroup" style="display: none;">
                        <label>Service Location</label>
                        <select name="serviceLocationId" id="jobServiceLocationSelect" onchange="updateLocationDisplay()">
                            <option value="">Select a location...</option>
                        </select>
                        <div id="locationInfoDisplay" style="display:none; margin-top:0.5rem; padding:0.6rem 0.85rem; background:#f0f4ff; border-left:3px solid #667eea; border-radius:0 6px 6px 0; font-size:0.875rem; color:#4a5568; line-height:1.5;"></div>
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
                        <div id="jobTeamCheckboxes" style="background:#f8f9fa; border:2px solid #e2e8f0; border-radius:8px; padding:0.75rem; max-height:160px; overflow-y:auto; display:flex; flex-direction:column; gap:0.5rem;"></div>
                    </div>
                    <div class="form-group">
                        <label>Status *</label>
                        <select name="status" required>
                            <option value="prospecting">Prospecting</option>
                            <option value="to_be_scheduled">To Be Scheduled</option>
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

                    <div id="laborActualsSection" style="margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #ddd; display: none;">
                        <h3 style="margin-bottom: 1rem;">💰 Labor Actuals (Payouts to Workers)</h3>
                        <div id="laborActualsList" style="background: #f7fafc; padding: 1rem; border-radius: 8px;">
                            <!-- Labor actuals will be rendered here -->
                        </div>
                    </div>

                    <div style="margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #ddd;">
                        <h3 style="margin-bottom: 1rem;">Attachments</h3>
                        <div id="attachmentsList" style="margin-bottom: 1rem;">
                            <!-- Attachments will be rendered here -->
                        </div>
                        <div style="margin-bottom: 1rem;">
                            <input type="file" id="fileInput" accept="image/*,.pdf,.doc,.docx,.txt" multiple style="display: none;" onchange="handleFileSelect(event)">
                            <button type="button" class="btn btn-secondary" onclick="document.getElementById('fileInput').click()">
                                📎 Add Photos/Documents
                            </button>
                            <span style="margin-left: 1rem; color: #718096; font-size: 0.9rem;">Photos, PDFs, or documents</span>
                        </div>
                    </div>

                    <div style="margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #ddd;">
                        <h3 style="margin-bottom: 1rem;">Touch Points</h3>
                        <div id="touchPointsList" style="margin-bottom: 1rem;">
                            <!-- Touch points will be rendered here -->
                        </div>
                        <div style="display: flex; gap: 0.5rem;">
                            <input type="text" id="newTouchPoint" placeholder="Add a note..." style="flex: 1; padding: 0.5rem; border: 1px solid #cbd5e0; border-radius: 4px;">
                            <button type="button" class="btn btn-primary" onclick="addTouchPoint()">Add Note</button>
                        </div>
                    </div>

                    <!-- Audit Log -->
                    <div id="jobPhotosSection" style="margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #ddd; display: none;">
                        <h3 style="margin-bottom: 0.75rem;">📷 Photos</h3>
                        <div id="jobPhotoGrid" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
                    </div>

                    <div id="jobAuditLogSection" style="margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #ddd; display: none;">
                        <h3 style="margin-bottom: 1rem; color: #667eea;">📋 Activity Log</h3>
                        <div id="jobAuditLog" style="max-height: 300px; overflow-y: auto;"></div>
                    </div>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('jobModal')">Cancel</button>
                <button class="btn btn-secondary" id="jobSignoffBtn" style="display:none;" onclick="openSignoffForm(document.querySelector('#jobForm [name=id]').value)">✍️ Sign-Off</button>
                <button class="btn btn-primary" onclick="saveJob()">Save Job</button>
            </div>
        </div>
    </div>

    <!-- Quote Modal -->
    <div id="quoteModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 id="quoteModalTitle">Create Quote</h2>
                <button class="close-btn" onclick="closeModal('quoteModal')">&times;</button>
            </div>
            <div class="modal-body">
                <form id="quoteForm">
                    <input type="hidden" name="id">

                    <div class="form-group">
                        <label>Quote Number</label>
                        <input type="text" name="quoteNumber" readonly placeholder="Auto-generated" style="background: #f7fafc;">
                    </div>

                    <div class="form-group">
                        <label>Client *</label>
                        <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-start;">
                            <div style="position: relative; flex: 1; min-width: 200px;">
                                <input type="text" id="quoteClientInput" placeholder="Type to search clients..." autocomplete="off" oninput="filterQuoteClientTypeahead()" onfocus="filterQuoteClientTypeahead()" style="width: 100%; padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 16px;">
                                <input type="hidden" name="clientId" id="quoteClientSelect">
                                <div id="quoteClientTypeaheadDropdown" style="display:none; position:absolute; top:100%; left:0; right:0; background:white; border:2px solid #667eea; border-top:none; border-radius:0 0 8px 8px; max-height:220px; overflow-y:auto; z-index:1000; box-shadow:0 4px 12px rgba(0,0,0,0.15);"></div>
                            </div>
                            <button type="button" class="btn btn-secondary" onclick="openClientModalFromQuote()" style="white-space: nowrap;">+ Add Client</button>
                        </div>
                    </div>

                    <div class="form-group" id="quoteServiceLocationGroup" style="display: none;">
                        <label>Service Location</label>
                        <select name="serviceLocationId" id="quoteServiceLocationSelect">
                            <option value="">Select a location...</option>
                        </select>
                    </div>

                    <div class="form-group">
                        <label>Quote Title *</label>
                        <input type="text" name="title" required placeholder="e.g., Kitchen Renovation" oninput="debounceUpsell(this.value)">
                        <div id="upsellSuggestions" style="display:none;"></div>
                    </div>

                    <div class="form-group">
                        <label>Description</label>
                        <textarea name="description" rows="3" placeholder="Describe the work to be done..."></textarea>
                    </div>

                    <div class="form-group">
                        <label>Valid Until *</label>
                        <input type="date" name="validUntil" required>
                    </div>

                    <div class="form-group">
                        <label>Status</label>
                        <select name="status" required>
                            <option value="draft">Draft</option>
                            <option value="sent">Sent</option>
                            <option value="approved">Approved</option>
                            <option value="rejected">Rejected</option>
                            <option value="expired">Expired</option>
                        </select>
                    </div>

                    <div class="form-group" style="margin-top: 1rem;">
                        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                            <input type="checkbox" name="taxWaived" id="quoteTaxWaivedCheckbox" onchange="updateQuoteTotal()" style="width: auto; cursor: pointer;">
                            <span>Tax Exempt / Waive Tax</span>
                        </label>
                    </div>

                    <div style="margin-top: 2rem;">
                        <h3 style="margin-bottom: 1rem;">Labor</h3>
                        <div id="quoteLaborItems"></div>
                        <button type="button" class="btn btn-secondary" onclick="addQuoteLaborItem()" style="margin-top: 0.5rem;">+ Add Labor</button>
                    </div>

                    <div style="margin-top: 2rem;">
                        <h3 style="margin-bottom: 1rem;">Materials</h3>
                        <div id="quoteMaterialItems"></div>
                        <button type="button" class="btn btn-secondary" onclick="addQuoteMaterialItem()" style="margin-top: 0.5rem;">+ Add Material</button>
                    </div>

                    <div style="margin-top: 2rem; padding: 1rem; background-color: #f7fafc; border-radius: 8px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                            <span>Subtotal:</span>
                            <span>$<span id="quoteSubtotal">0.00</span></span>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                            <span>Tax:</span>
                            <span>$<span id="quoteTax">0.00</span></span>
                        </div>
                        <div style="display: flex; justify-content: space-between; padding-top: 0.5rem; border-top: 1px solid #cbd5e0;">
                            <strong>Total:</strong>
                            <strong>$<span id="quoteTotal">0.00</span></strong>
                        </div>
                    </div>

                    <div style="margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #ddd;">
                        <h3 style="margin-bottom: 1rem;">Notes</h3>
                        <div class="form-group">
                            <label>Internal Notes (not visible to client)</label>
                            <textarea name="notes" rows="2" placeholder="Notes for your reference only..."></textarea>
                        </div>
                        <div class="form-group">
                            <label>Client Notes (shown on quote)</label>
                            <textarea name="clientNotes" rows="3" placeholder="Additional information for the client..."></textarea>
                        </div>
                    </div>

                    <div style="margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #ddd;">
                        <h3 style="margin-bottom: 1rem;">Touch Points</h3>
                        <div id="quoteTouchPointsList" style="margin-bottom: 1rem;"></div>
                        <div style="display: flex; gap: 0.5rem;">
                            <input type="text" id="newQuoteTouchPoint" placeholder="Add a note..." style="flex: 1; padding: 0.5rem; border: 1px solid #cbd5e0; border-radius: 4px;">
                            <button type="button" class="btn btn-primary" onclick="addQuoteTouchPoint()">Add Note</button>
                        </div>
                    </div>

                    <!-- Photos -->
                    <div id="quotePhotosSection" style="margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #ddd;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
                            <h3 style="margin:0;">📷 Photos</h3>
                            <label style="cursor:pointer;">
                                <input type="file" id="quotePhotoUploadInput" accept="image/*" multiple style="display:none;" onchange="handleQuotePhotoUpload(event)">
                                <span class="btn btn-secondary btn-small">+ Add Photos</span>
                            </label>
                        </div>
                        <div id="quotePhotoGrid" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
                        <div id="quotePhotoUploadStatus" style="font-size:0.85rem;color:#718096;margin-top:0.5rem;display:none;"></div>
                    </div>

                    <!-- Audit Log -->
                    <div id="quoteAuditLogSection" style="margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #ddd; display: none;">
                        <h3 style="margin-bottom: 1rem; color: #667eea;">📋 Activity Log</h3>
                        <div id="quoteAuditLog" style="max-height: 300px; overflow-y: auto;"></div>
                    </div>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('quoteModal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveQuote()">Save Quote</button>
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

                    <h3 id="loginSectionTitle" style="margin-top: 1.5rem; margin-bottom: 0.5rem;">User Login Access</h3>
                    <div id="loginCheckboxContainer" style="background: #e3f2fd; padding: 1rem; border-radius: 8px; margin-bottom: 1rem;">
                        <label style="display: flex; align-items: center; cursor: pointer;">
                            <input type="checkbox" id="createUserLogin" onchange="toggleLoginFields()" style="margin-right: 0.5rem;">
                            <span id="loginCheckboxText">Create user login for this team member</span>
                        </label>
                        <small id="loginCheckboxSubtext" style="color: #666; display: block; margin-top: 0.5rem;">Allow this team member to log in and clock in/out on jobs</small>
                    </div>

                    <div id="loginFields" style="display: none;">
                        <div class="form-group">
                            <label>Login Email *</label>
                            <input type="email" id="loginEmail" placeholder="user@example.com">
                            <small style="color: #666;">This will be their username</small>
                        </div>
                        <div class="form-group">
                            <label>Password *</label>
                            <input type="password" id="loginPassword" placeholder="Minimum 6 characters">
                        </div>
                        <div class="form-group">
                            <label>Confirm Password *</label>
                            <input type="password" id="loginPasswordConfirm" placeholder="Re-enter password">
                        </div>
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

    <!-- Expense Receipts & Comments Modal -->
    <div id="expenseDetailModal" class="modal">
        <div class="modal-content" style="max-width:640px;">
            <div class="modal-header">
                <h2 id="expenseDetailTitle">Expense Receipts</h2>
                <button class="close-btn" onclick="closeModal('expenseDetailModal')">&times;</button>
            </div>
            <div class="modal-body">
                <!-- Attachments -->
                <div style="margin-bottom:1.5rem;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
                        <h3 style="color:#2d3748;font-size:1rem;">📎 Receipts & Attachments</h3>
                        <label style="cursor:pointer;">
                            <input type="file" id="expenseFileInput" accept="image/*,.pdf,.doc,.docx" multiple style="display:none;" onchange="handleExpenseFileSelect(event)">
                            <span class="btn btn-primary btn-small">+ Upload</span>
                        </label>
                    </div>
                    <div id="expenseAttachmentsList" style="min-height:60px;"></div>
                </div>
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:1.25rem 0;">
                <!-- Comments -->
                <div>
                    <h3 style="color:#2d3748;font-size:1rem;margin-bottom:0.75rem;">💬 Comments</h3>
                    <div id="expenseCommentsList" style="margin-bottom:1rem;"></div>
                    <div style="display:flex;gap:0.5rem;">
                        <input type="text" id="expenseCommentInput" placeholder="Add a comment…" style="flex:1;padding:0.6rem 0.75rem;border:2px solid #e2e8f0;border-radius:8px;font-size:0.9rem;" onkeydown="if(event.key==='Enter')addExpenseComment()">
                        <button class="btn btn-primary" onclick="addExpenseComment()">Post</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Expense Modal -->
    <div id="expenseModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 id="expenseModalTitle">Add Expense</h2>
                <button class="close-btn" onclick="closeModal('expenseModal')">&times;</button>
            </div>
            <div class="modal-body">
                <form id="expenseForm">
                    <div class="form-group">
                        <label>Date *</label>
                        <input type="date" name="date" required>
                    </div>
                    <div class="form-group">
                        <label>Category *</label>
                        <select name="category" required>
                            <option value="">Select category...</option>
                            <option value="vehicle">Vehicle & Fuel</option>
                            <option value="tools">Tools & Equipment</option>
                            <option value="materials">Materials & Supplies</option>
                            <option value="office">Office Expenses</option>
                            <option value="utilities">Utilities</option>
                            <option value="insurance">Insurance</option>
                            <option value="marketing">Marketing & Advertising</option>
                            <option value="meals">Meals & Entertainment</option>
                            <option value="travel">Travel</option>
                            <option value="professional">Professional Services</option>
                            <option value="other">Other</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Vendor/Merchant *</label>
                        <input type="text" name="vendor" required>
                    </div>
                    <div class="form-group">
                        <label>Description *</label>
                        <textarea name="description" rows="2" required></textarea>
                    </div>
                    <div class="form-group">
                        <label>Amount ($) *</label>
                        <input type="number" name="amount" step="0.01" min="0" required>
                    </div>
                    <div class="form-group">
                        <label>Payment Method</label>
                        <select name="paymentMethod">
                            <option value="cash">Cash</option>
                            <option value="credit_card">Credit Card</option>
                            <option value="debit_card">Debit Card</option>
                            <option value="check">Check</option>
                            <option value="bank_transfer">Bank Transfer</option>
                            <option value="other">Other</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Receipt/Notes</label>
                        <textarea name="notes" rows="2" placeholder="Receipt number, additional details..."></textarea>
                    </div>
                    <div class="form-group">
                        <label>📎 Attachments</label>
                        <label style="display:inline-flex;align-items:center;gap:0.5rem;cursor:pointer;background:#f7fafc;border:2px dashed #cbd5e0;border-radius:8px;padding:0.65rem 1rem;font-size:0.9rem;color:#4a5568;">
                            <input type="file" id="expenseModalFileInput" accept="image/*,.pdf,.doc,.docx" multiple style="display:none;" onchange="stageExpenseFiles(event)">
                            ＋ Add receipts / files
                        </label>
                        <div id="expenseModalAttachmentsList" style="margin-top:0.5rem;"></div>
                    </div>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('expenseModal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveExpense()">Save Expense</button>
            </div>
        </div>
    </div>

    <!-- Edit Time Entry Modal -->
    <div id="editTimeEntryModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>✏️ Edit Time Entry</h2>
                <button class="close-btn" onclick="closeModal('editTimeEntryModal')">&times;</button>
            </div>
            <div class="modal-body">
                <input type="hidden" id="editTimeEntryId">

                <div style="background: #e3f2fd; padding: 1rem; border-radius: 8px; margin-bottom: 1rem;">
                    <div><strong>Job:</strong> <span id="editTimeJobName"></span></div>
                    <div><strong>Worker:</strong> <span id="editTimeUserName"></span></div>
                </div>

                <div class="form-group">
                    <label>Clock In Time *</label>
                    <input type="datetime-local" id="editClockIn" required>
                </div>

                <div class="form-group">
                    <label>Clock Out Time *</label>
                    <input type="datetime-local" id="editClockOut" required>
                </div>

                <div class="form-group">
                    <label>Status *</label>
                    <select id="editStatus">
                        <option value="active">Active</option>
                        <option value="pending">Pending</option>
                        <option value="approved">Approved</option>
                        <option value="rejected">Rejected</option>
                    </select>
                </div>

                <div class="form-group">
                    <label>Payment Amount ($)</label>
                    <input type="number" id="editPaymentAmount" step="0.01" min="0" placeholder="Enter amount for approved entries">
                </div>

                <div style="background: #fff3cd; padding: 0.75rem; border-radius: 4px; margin-top: 1rem;">
                    <small><strong>Note:</strong> Duration will be automatically recalculated based on the times.</small>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('editTimeEntryModal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveTimeEntryEdit()">Save Changes</button>
            </div>
        </div>
    </div>

    <!-- SMS Modal -->
    <div id="smsModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>📱 Send Text Message</h2>
                <button class="close-btn" onclick="closeModal('smsModal')">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label>To</label>
                    <input type="tel" id="smsTo" readonly style="background: #f5f5f5;">
                </div>
                <div class="form-group">
                    <label>Message</label>
                    <textarea id="smsMessage" rows="5" placeholder="Type your message here..." maxlength="160"></textarea>
                    <small style="color: #718096; display: block; margin-top: 0.5rem;">
                        <span id="smsCharCount">0</span>/160 characters
                    </small>
                </div>
                <div id="smsStatus" style="margin-top: 1rem; padding: 0.75rem; border-radius: 8px; display: none;"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('smsModal')">Cancel</button>
                <button class="btn btn-primary" onclick="sendManualSMS()">Send Message</button>
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
                <div style="padding: 0.75rem; background: #e3f2fd; border-left: 4px solid #2196f3; margin-bottom: 1rem;">
                    <small><strong>Note:</strong> Full name must match Team Member name exactly (First Last) for Time Clock assignments.</small>
                </div>
                <form id="addUserForm">
                    <div class="form-group">
                        <label>Full Name *</label>
                        <input type="text" name="name" required placeholder="e.g. Matt Smith">
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
        // Global session expiry interceptor
        (function() {
            const _fetch = window.fetch;
            window.fetch = async function(...args) {
                const response = await _fetch(...args);
                if (response.status === 401) {
                    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                    const isAuthRoute = url.includes('/api/auth/login') || url.includes('/api/client-portal');
                    if (!isAuthRoute) {
                        document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;top:0;left:0;right:0;background:#e53e3e;color:white;text-align:center;padding:1rem;z-index:99999;font-weight:600;">Your session has expired. Redirecting to login...</div>');
                        setTimeout(() => { window.location.href = '/login'; }, 1500);
                    }
                }
                return response;
            };
        })();

        let clients = [];
        let jobs = [];
        let quotes = [];
        let clientJobCounts = {};
        let settings = {};
        let team = [];
        let expenses = [];
        let hasUnsavedChanges = false;
        let _complianceDocs = [];
        let _sendCompClientId = null;
        let _compDocFileData = null;
        let _currentClientId = null;
        let currentUserRole = 'user'; // Default to user, updated on load
        let isAdmin = false;

        const sortState = {
            clients:  { field: 'name',          dir: 'asc' },
            jobs:     { field: 'scheduledDate',  dir: 'desc' },
            quotes:   { field: 'validUntil',     dir: 'desc' },
            expenses: { field: 'date',           dir: 'desc' },
            vendors:  { field: 'name',           dir: 'asc' },
            team:     { field: 'name',           dir: 'asc' },
            leads:    { field: 'createdAt',      dir: 'desc' },
        };

        function sortTable(tableKey, field) {
            const s = sortState[tableKey];
            if (s.field === field) {
                s.dir = s.dir === 'asc' ? 'desc' : 'asc';
            } else {
                s.field = field;
                s.dir = (field === 'name' || field === 'title' || field === 'category') ? 'asc' : 'desc';
            }
            const renders = {
                clients: () => filterClients(),
                jobs:    renderJobsTable,
                quotes:  renderQuotesTable,
                expenses: () => filterExpenses(),
                vendors: renderVendors,
                team:    renderTeam,
                leads:   renderLeads,
            };
            if (renders[tableKey]) renders[tableKey]();
        }

        function sortArrow(tableKey, field) {
            const s = sortState[tableKey];
            const arrow = s.dir === 'asc' ? '▲' : '▼';
            const cls = s.field === field ? ('sort-' + s.dir) : '';
            return \`<th class="sortable \${cls}" onclick="sortTable('\${tableKey}','\${field}')">\`;
        }

        function applySortState(array, tableKey, fieldMap) {
            const s = sortState[tableKey];
            const key = fieldMap[s.field] || s.field;
            return [...array].sort((a, b) => {
                let av = a[key] ?? '';
                let bv = b[key] ?? '';
                if (typeof av === 'string') av = av.toLowerCase();
                if (typeof bv === 'string') bv = bv.toLowerCase();
                if (av < bv) return s.dir === 'asc' ? -1 : 1;
                if (av > bv) return s.dir === 'asc' ? 1 : -1;
                return 0;
            });
        }

        function sth(tableKey, field, label) {
            const s = sortState[tableKey];
            const isActive = s.field === field;
            const arrow = s.dir === 'asc' ? '▲' : '▼';
            const cls = isActive ? 'sort-' + s.dir : '';
            return \`<th class="sortable \${cls}" onclick="sortTable('\${tableKey}','\${field}')">\${label} <span class="sort-arrow">\${isActive ? arrow : '▼'}</span></th>\`;
        }

        function maskName(fullName) {
            if (isAdmin || !fullName) return fullName || 'Unknown';
            const parts = fullName.trim().split(/\s+/);
            if (parts.length === 1) return parts[0];
            return parts[0] + ' ' + parts[parts.length - 1].charAt(0) + '.';
        }
        let currentUserId = null;
        let currentTeamMember = null;

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
                return '(' + cleaned.slice(0,3) + ')' + cleaned.slice(3,6) + '-' + cleaned.slice(6);
            }
            return phone;
        }

        function maskPhoneInput(input) {
            let value = input.value.replace(/\D/g, '');
            if (value.length > 10) value = value.slice(0, 10);
            if (value.length >= 6) {
                input.value = '(' + value.slice(0,3) + ')' + value.slice(3,6) + '-' + value.slice(6);
            } else if (value.length >= 3) {
                input.value = '(' + value.slice(0,3) + ')' + value.slice(3);
            } else if (value.length > 0) {
                input.value = '(' + value;
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
            const adminOnlyViews = ['dashboard', 'clients', 'quotes', 'team', 'expenses', 'vendors', 'portfolio', 'messages', 'reports', 'activity', 'settings'];
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

            // Close admin dropdown
            const adminDropdown = document.getElementById('admin-dropdown');
            if (adminDropdown) adminDropdown.style.display = 'none';

            document.getElementById(viewName).classList.add('active');

            const adminViews = ['team', 'timeclock', 'expenses', 'vendors', 'portfolio', 'reports', 'analytics', 'settings'];
            if (adminViews.includes(viewName)) {
                const adminBtn = document.getElementById('admin-menu-btn');
                if (adminBtn) adminBtn.classList.add('active');
            } else if (event && event.target) {
                event.target.classList.add('active');
            }

            // Save current view to localStorage for persistence on refresh
            localStorage.setItem('currentView', viewName);

            if (viewName === 'dashboard') loadDashboard();
            if (viewName === 'clients') loadClients();
            if (viewName === 'quotes') loadQuotes();
            if (viewName === 'jobs') loadJobs();
            if (viewName === 'timeclock') loadTimeClock();
            if (viewName === 'mypay') loadMyPay();
            if (viewName === 'calendar') loadCalendar();
            if (viewName === 'team') loadTeam();
            if (viewName === 'expenses') loadExpenses();
            if (viewName === 'vendors') loadVendors();
            if (viewName === 'portfolio') loadPortfolio();
            if (viewName === 'messages') loadMessages();
            if (viewName === 'activity') loadActivityLog();
            if (viewName === 'reports') loadReports();
            if (viewName === 'analytics') loadAnalytics();
            if (viewName === 'leads') loadLeads();
            if (viewName === 'settings') {
                loadSettings();
                loadUsers();
            }
        }

        function toggleAdminMenu(e) {
            e.stopPropagation();
            const dropdown = document.getElementById('admin-dropdown');
            if (!dropdown) return;
            dropdown.style.display = dropdown.style.display === 'none' ? 'flex' : 'none';
        }

        document.addEventListener('click', function(e) {
            const wrapper = document.querySelector('.admin-menu-wrapper');
            const dropdown = document.getElementById('admin-dropdown');
            if (dropdown && wrapper && !wrapper.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        });

        // Add change listeners to all forms
        window.addEventListener('DOMContentLoaded', () => {
            // Handle post-OAuth redirect
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('analytics') === 'connected') {
                history.replaceState({}, '', '/');
                showView('analytics');
            }

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

            // Quote form
            const quoteForm = document.getElementById('quoteForm');
            if (quoteForm) {
                quoteForm.addEventListener('input', markFormDirty);
                quoteForm.addEventListener('change', markFormDirty);
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
            if (!checkAdminPermission('edit clients')) return;
            const client = clients.find(c => c.id == clientId || c._id == clientId);
            if (client) {
                openClientModal(client);
            }
        }

        function openClientModal(client = null) {
            if (!checkAdminPermission('create or edit clients')) return;

            const form = document.getElementById('clientForm');
            currentEditingClientId = null;

            if (client) {
                document.getElementById('clientModalTitle').textContent = 'Edit Client';
                currentEditingClientId = client._id || client.id;

                // Populate form fields
                form.reset();
                Object.keys(client).forEach(key => {
                    const input = form.elements[key];
                    if (input && input.type !== 'checkbox') {
                        input.value = client[key] || '';
                    }
                });
                // Explicitly reset select fields that may not exist on older records
                const ptSelect = form.elements['paymentTerms'];
                if (ptSelect) ptSelect.value = client.paymentTerms || '';

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

                // Handle portal access
                const hasPortalAccess = !!client.portalPassword;
                document.getElementById('enablePortalAccess').checked = hasPortalAccess;
                if (hasPortalAccess) {
                    document.getElementById('portalPassword').value = ''; // Can't show hashed password
                    document.getElementById('portalPassword').placeholder = 'Leave blank to keep existing code, or enter new code';
                }
                togglePortalFields();
            } else {
                document.getElementById('clientModalTitle').textContent = 'Add Client';
                form.reset();
                serviceLocations = [];
                document.getElementById('propertyManagementFields').style.display = 'none';
                document.getElementById('enablePortalAccess').checked = false;
                document.getElementById('portalPassword').value = '';
                document.getElementById('portalPassword').placeholder = 'Set a simple access code (e.g., 1234)';
                togglePortalFields();
                renderServiceLocations();
            }

            document.getElementById('clientModal').classList.add('active');
        }

        let currentEditingJobId = null;

        function toggleJobMenu(id, event) {
            event.stopPropagation();
            const menu = document.getElementById('jm-' + id);
            document.querySelectorAll('.job-action-menu').forEach(m => { if (m !== menu) m.style.display = 'none'; });
            menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
        }
        document.addEventListener('click', () => {
            document.querySelectorAll('.job-action-menu').forEach(m => m.style.display = 'none');
        });

        window._saveSignoffToJob = function(jobId, imageDataUrl, signerName, cb) {
            fetch(\`/api/jobs/\${jobId}/signoff-attachment\`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageDataUrl: imageDataUrl, signerName: signerName })
            }).then(function(r) { return r.json(); })
              .then(function(d) {
                  if (d.ok && d.attachment) {
                      attachments.push(d.attachment);
                      renderAttachments();
                  }
                  cb(d.ok, d.error);
              })
              .catch(function(e) { cb(false, e.message); });
        };

        function openSignoffForm(jobId) {
            const job = [...(jobs||[]),...(window.upcomingJobs||[]),...(window.inProgressJobs||[])].find(j=>j.id==jobId||j._id==jobId);
            if (!job) return;
            const client = (clients||[]).find(c=>c.id==job.clientId||c._id==job.clientId);
            let locAddr = '';
            if (job.serviceLocationId && client && client.serviceLocations) {
                const loc = client.serviceLocations.find(l=>(l.id||l._id)==job.serviceLocationId);
                if (loc) locAddr = loc.address || loc.label || '';
            }
            if (!locAddr && client) locAddr = [client.addressLine1,client.city,client.state].filter(Boolean).join(', ') || client.address || '';
            const signerName = (client && (client.contactName || client.name)) || '';
            const today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
            const schedDate = job.scheduledDate ? new Date(job.scheduledDate).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}) : 'TBD';
            const desc = (job.description||'').trim() || 'See work order for details.';
            const _jobId = job._id || job.id;
            const win = window.open('','_blank','width=840,height=1000');
            win.document.write(\`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Sign-Off — \${job.title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;background:#fff;padding:2.5rem 3rem;max-width:760px;margin:0 auto;}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0f1c2e;padding-bottom:1.25rem;margin-bottom:2rem;}
.co-name{font-size:1.35rem;font-weight:800;color:#0f1c2e;letter-spacing:-0.01em;}
.co-sub{font-size:0.78rem;color:#666;margin-top:0.25rem;line-height:1.6;}
.doc-title{font-size:0.95rem;font-weight:800;color:#0f1c2e;text-align:right;text-transform:uppercase;letter-spacing:0.05em;}
.doc-date{font-size:0.78rem;color:#888;text-align:right;margin-top:0.25rem;}
.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem 2.5rem;margin-bottom:1.75rem;}
.meta-label{font-size:0.63rem;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:#aaa;margin-bottom:0.2rem;}
.meta-value{font-size:0.95rem;font-weight:600;color:#1a1a1a;line-height:1.4;}
.section-head{font-size:0.63rem;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:#aaa;margin-bottom:0.5rem;}
.work-box{background:#f8fafc;border:1.5px solid #e5e7eb;border-radius:6px;padding:1rem 1.25rem;font-size:0.9rem;line-height:1.7;color:#333;white-space:pre-wrap;min-height:90px;}
hr{border:none;border-top:1px solid #e5e7eb;margin:2rem 0;}
.statement{font-size:0.88rem;color:#444;line-height:1.7;margin-bottom:2.5rem;}
.sig-row{display:grid;grid-template-columns:2fr 1fr 1fr;gap:0 2rem;margin-bottom:1.75rem;}
.sig-field{padding-bottom:0.5rem;border-bottom:1.5px solid #222;}
.sig-prefill{font-size:0.875rem;color:#666;padding-top:0.2rem;min-height:1.5rem;}
.sig-hint{font-size:0.66rem;color:#bbb;font-style:italic;margin-top:0.2rem;}
.sig-label{font-size:0.6rem;text-transform:uppercase;letter-spacing:0.07em;color:#bbb;margin-top:0.3rem;}
.no-print{margin-top:2.5rem;text-align:center;padding-top:1.5rem;border-top:1px dashed #e5e7eb;}
.pbtn{background:#0f1c2e;color:#fff;border:none;padding:0.7rem 2.25rem;border-radius:6px;font-size:0.9rem;font-weight:700;cursor:pointer;margin-right:0.6rem;}
.pbtn:hover{background:#1a2f4a;}
@media print{.no-print{display:none!important}body{padding:1.5rem 2rem;}}
</style></head><body>
<div class="hdr">
  <div>
    <div class="co-name">GSD Property Services</div>
    <div class="co-sub">Mount Laurel, NJ &nbsp;·&nbsp; (856) 872-4636<br>info@gsdhandymanservice.com &nbsp;·&nbsp; LIC# 13VH13491700</div>
  </div>
  <div>
    <div class="doc-title">Work Completion Sign-Off</div>
    <div class="doc-date">Printed: \${today}</div>
  </div>
</div>

<div class="meta-grid">
  <div><div class="meta-label">Job</div><div class="meta-value">\${job.title}</div></div>
  <div><div class="meta-label">Client</div><div class="meta-value">\${client ? client.name : '—'}</div></div>
  <div><div class="meta-label">Service Location</div><div class="meta-value">\${locAddr || '—'}</div></div>
  <div><div class="meta-label">Date of Service</div><div class="meta-value">\${schedDate}</div></div>
</div>

<div class="section-head">Work Performed</div>
<div class="work-box">\${desc}</div>

<hr>

<div class="statement">By signing below, I confirm that the work described above has been completed satisfactorily and to my approval. GSD Property Services is authorized to close this work order.</div>

<div class="section-head">Authorized Signature</div>
<div style="border:2px dashed #cbd5e0;border-radius:8px;background:#fafafa;position:relative;margin-bottom:0.5rem;overflow:hidden;">
  <canvas id="sigPad" width="700" height="160" style="display:block;width:100%;height:auto;cursor:crosshair;touch-action:none;"></canvas>
  <div id="sigHint" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#ccc;font-size:0.9rem;pointer-events:none;user-select:none;letter-spacing:0.03em;">✏️ Sign here</div>
</div>
<div id="sigControls" style="margin-bottom:1.5rem;">
  <button onclick="clearSig()" type="button" style="background:none;border:1.5px solid #d1d5db;padding:0.3rem 0.9rem;border-radius:5px;cursor:pointer;font-size:0.78rem;color:#888;">Clear</button>
</div>

<div style="margin-bottom:1.5rem;">
  <label style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:#aaa;display:block;margin-bottom:0.4rem;">Print Full Name *</label>
  <input id="signerInput" type="text" value="\${signerName}" placeholder="Type your full name here" style="width:100%;border:none;border-bottom:2px solid #222;background:none;font-size:1rem;padding:0.3rem 0;outline:none;color:#1a1a1a;font-family:inherit;">
</div>
<div class="sig-row">
  <div>
    <div class="sig-field"><input id="titleInput" type="text" value="" placeholder="Title / role" style="border:none;background:none;width:100%;font-size:0.875rem;padding:0.15rem 0;outline:none;color:#333;font-family:inherit;"></div>
    <div class="sig-label">Title / Role</div>
  </div>
  <div>
    <div class="sig-field"><div class="sig-prefill">\${today}</div></div>
    <div class="sig-label">Date</div>
  </div>
</div>

<img id="sigImg" style="display:none;" alt="Signature">

<div class="no-print">
  <button class="pbtn" onclick="doPrint()">🖨️ Print / Save PDF</button>
  <button id="saveBtn" class="pbtn" onclick="saveToJob()" style="background:#48bb78;">💾 Save to Job</button>
  <button onclick="window.close()" style="background:none;border:1.5px solid #d1d5db;padding:0.7rem 1.5rem;border-radius:6px;cursor:pointer;font-size:0.88rem;color:#555;margin-left:0.25rem;">Close</button>
</div>

<script>
var canvas = document.getElementById('sigPad');
var ctx = canvas.getContext('2d');
ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a1a1a';
var drawing = false, lastX = 0, lastY = 0, hasSig = false;
function getPos(e) {
  var r = canvas.getBoundingClientRect();
  var sx = canvas.width / r.width, sy = canvas.height / r.height;
  var src = (e.touches && e.touches[0]) ? e.touches[0] : e;
  return { x: (src.clientX - r.left) * sx, y: (src.clientY - r.top) * sy };
}
function startDraw(e) { e.preventDefault(); drawing = true; var p = getPos(e); lastX = p.x; lastY = p.y; }
function draw(e) {
  e.preventDefault(); if (!drawing) return;
  var p = getPos(e);
  ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
  lastX = p.x; lastY = p.y; hasSig = true;
  document.getElementById('sigHint').style.display = 'none';
}
function stopDraw() { drawing = false; }
canvas.addEventListener('mousedown', startDraw);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDraw);
canvas.addEventListener('mouseleave', stopDraw);
canvas.addEventListener('touchstart', startDraw, { passive: false });
canvas.addEventListener('touchmove', draw, { passive: false });
canvas.addEventListener('touchend', stopDraw);
function clearSig() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  hasSig = false;
  document.getElementById('sigHint').style.display = '';
}
function doPrint() {
  var img = document.getElementById('sigImg');
  var ctrl = document.getElementById('sigControls');
  img.src = canvas.toDataURL('image/png');
  img.style.cssText = 'display:block;width:' + canvas.offsetWidth + 'px;height:' + canvas.offsetHeight + 'px;border:2px dashed #cbd5e0;border-radius:8px;margin-bottom:0.5rem;';
  canvas.style.display = 'none';
  ctrl.style.display = 'none';
  window.print();
  canvas.style.display = 'block';
  ctrl.style.display = 'block';
  img.style.display = 'none';
}
var JOB_ID = \${JSON.stringify(_jobId)};
var D_TITLE = \${JSON.stringify(job.title)};
var D_CLIENT = \${JSON.stringify(client ? client.name : '')};
var D_LOC = \${JSON.stringify(locAddr || '')};
var D_DATE = \${JSON.stringify(schedDate)};
var D_DESC = \${JSON.stringify(desc)};
var D_TODAY = \${JSON.stringify(today)};

function wrapLines(ctx, text, maxW) {
  var words = (text || '').split(/\\s+/);
  var lines = [], line = '';
  for (var i = 0; i < words.length; i++) {
    var test = line ? line + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = words[i]; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function buildDoc() {
  var W = 800, pad = 40;
  var inner = W - pad * 2;
  // Measure description height first
  var tmpC = document.createElement('canvas'); tmpC.width = W * 2;
  var tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = '13px Arial';
  var descLines = wrapLines(tmpCtx, D_DESC, inner);
  var H = 580 + descLines.length * 18;
  var c = document.createElement('canvas');
  c.width = W * 2; c.height = H * 2;
  var x = c.getContext('2d');
  x.scale(2, 2);
  // Background
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  // Top bar
  x.fillStyle = '#0f1c2e'; x.fillRect(0, 0, W, 4);
  // Company name
  x.fillStyle = '#0f1c2e'; x.font = 'bold 18px Arial';
  x.fillText('GSD Property Services', pad, 32);
  x.fillStyle = '#888'; x.font = '10px Arial';
  x.fillText('Mount Laurel, NJ  ·  (856) 872-4636  ·  info@gsdhandymanservice.com  ·  LIC# 13VH13491700', pad, 48);
  // Doc title right
  x.fillStyle = '#0f1c2e'; x.font = 'bold 11px Arial'; x.textAlign = 'right';
  x.fillText('WORK COMPLETION SIGN-OFF', W - pad, 28);
  x.fillStyle = '#aaa'; x.font = '10px Arial';
  x.fillText('Printed: ' + D_TODAY, W - pad, 44);
  x.textAlign = 'left';
  // Header rule
  x.strokeStyle = '#0f1c2e'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(pad, 60); x.lineTo(W - pad, 60); x.stroke();
  // Meta grid
  var col2 = pad + inner / 2 + 20;
  var labels = [['JOB', D_TITLE, pad, 80], ['CLIENT', D_CLIENT, col2, 80],
                ['SERVICE LOCATION', D_LOC || '—', pad, 116], ['DATE OF SERVICE', D_DATE, col2, 116]];
  labels.forEach(function(l) {
    x.fillStyle = '#aaa'; x.font = 'bold 8px Arial';
    x.fillText(l[0], l[2], l[3]);
    x.fillStyle = '#1a1a1a'; x.font = 'bold 12px Arial';
    x.fillText((l[1] || '—').substring(0, 45), l[2], l[3] + 14);
  });
  // Section rule
  x.strokeStyle = '#e5e7eb'; x.lineWidth = 1;
  x.beginPath(); x.moveTo(pad, 142); x.lineTo(W - pad, 142); x.stroke();
  // Description
  x.fillStyle = '#aaa'; x.font = 'bold 8px Arial'; x.fillText('WORK PERFORMED', pad, 158);
  x.fillStyle = '#333'; x.font = '12px Arial';
  descLines.forEach(function(l, i) { x.fillText(l, pad, 173 + i * 18); });
  var afterDesc = 173 + descLines.length * 18 + 20;
  // Rule
  x.strokeStyle = '#e5e7eb'; x.lineWidth = 1;
  x.beginPath(); x.moveTo(pad, afterDesc); x.lineTo(W - pad, afterDesc); x.stroke();
  // Statement
  x.fillStyle = '#555'; x.font = '11px Arial';
  x.fillText('By signing below, I confirm the work described above has been completed satisfactorily.', pad, afterDesc + 20);
  // Sig label
  x.fillStyle = '#aaa'; x.font = 'bold 8px Arial'; x.fillText('AUTHORIZED SIGNATURE', pad, afterDesc + 42);
  // Sig box (draw from sigPad canvas)
  var sigY = afterDesc + 50, sigH = 110, sigW = inner;
  x.strokeStyle = '#cbd5e0'; x.lineWidth = 1.5;
  x.setLineDash([5,4]); x.strokeRect(pad, sigY, sigW, sigH); x.setLineDash([]);
  x.drawImage(canvas, pad, sigY, sigW, sigH);
  // Name / title / date row
  var fieldY = sigY + sigH + 28;
  var nameW = inner * 0.45, titleW = inner * 0.28, dateW = inner * 0.22;
  var signer = document.getElementById('signerInput').value;
  var title  = document.getElementById('titleInput').value;
  [['PRINTED NAME', signer, pad], ['TITLE / ROLE', title, pad + nameW + 20], ['DATE', D_TODAY, pad + nameW + titleW + 40]].forEach(function(f) {
    x.strokeStyle = '#222'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(f[2], fieldY); x.lineTo(f[2] + (f[0]==='DATE' ? dateW : f[0]==='TITLE / ROLE' ? titleW : nameW), fieldY); x.stroke();
    x.fillStyle = '#aaa'; x.font = 'bold 8px Arial'; x.fillText(f[0], f[2], fieldY + 12);
    x.fillStyle = '#1a1a1a'; x.font = '12px Arial'; x.fillText(f[1] || '', f[2], fieldY + 26);
  });
  return c;
}

function saveToJob() {
  if (!hasSig) { alert('Please sign first.'); return; }
  var signer = document.getElementById('signerInput').value.trim();
  if (!signer) { alert('Please enter your full name.'); document.getElementById('signerInput').focus(); return; }
  if (!window.opener || !window.opener._saveSignoffToJob) {
    alert('Cannot reach main window. Please keep the admin tab open.');
    return;
  }
  var btn = document.getElementById('saveBtn');
  btn.textContent = 'Saving...'; btn.disabled = true;
  try {
    var doc = buildDoc();
    var imgData = doc.toDataURL('image/jpeg', 0.82);
    window.opener._saveSignoffToJob(JOB_ID, imgData, signer, function(ok, err) {
      if (ok) { btn.textContent = '✅ Saved!'; btn.style.background = '#22543d'; setTimeout(function(){ window.close(); }, 800); }
      else { alert('Error: ' + (err || 'Save failed')); btn.textContent = '💾 Save to Job'; btn.disabled = false; }
    });
  } catch(e) {
    alert('Build failed: ' + e.message);
    btn.textContent = '💾 Save to Job'; btn.disabled = false;
  }
}
<\/script>
</body></html>\`);
            win.document.close();
        }

        function buildWorkflowStepper(stages) {
            const completedCount = stages.filter(s => s.s === 'wf-done').length;
            const activeIdx = stages.findIndex(s => s.s === 'wf-now');
            const doneCount = completedCount + (activeIdx >= 0 ? 1 : 0);
            const fillIdx = activeIdx >= 0 ? activeIdx : completedCount - 1;
            const fillPct = fillIdx < 0 ? 0 : (fillIdx / (stages.length - 1)) * 100;
            const dots = stages.map(s => {
                const icon = s.s === 'wf-done' ? '✓' : s.s === 'wf-now' ? '⬤' : '·';
                const badge = s.s === 'wf-done' ? 'DONE' : s.s === 'wf-now' ? 'NOW' : '';
                return \`<div class="wf-stage"><div class="wf-dot \${s.s}">\${icon}</div><div class="wf-lbl">\${s.l}</div>\${badge ? \`<div class="wf-st \${s.s}">\${badge}</div>\` : ''}</div>\`;
            }).join('');
            return \`<div class="wf-wrap"><div class="wf-hdr"><div class="wf-hdr-title">Workflow Progress</div><div class="wf-pill">⚡ \${doneCount} / \${stages.length} stages</div></div><div class="wf-stages-wrap"><div class="wf-track-bg"><div class="wf-track-fill" style="width:\${fillPct}%"></div></div>\${dots}</div></div>\`;
        }

        function buildJobStages(job) {
            const ordered = ['pending', 'scheduled', 'in-progress', 'completed', 'invoiced'];
            const idx = Math.max(0, ordered.indexOf(job.status));
            return [
                { l: 'Received', s: 'wf-done' },
                { l: 'Reviewed', s: 'wf-done' },
                { l: 'Approved', s: 'wf-done' },
                { l: 'Scheduled', s: idx >= 2 ? 'wf-done' : idx === 1 ? 'wf-now' : 'wf-wait' },
                { l: 'In Progress', s: idx >= 3 ? 'wf-done' : idx === 2 ? 'wf-now' : 'wf-wait' },
                { l: 'Complete', s: idx >= 4 ? 'wf-done' : idx === 3 ? 'wf-now' : 'wf-wait' },
            ];
        }

        function editJob(jobId) {
            if (!checkAdminPermission('edit jobs')) return;
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
            touchPoints = [];
            attachments = [];
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
                if (job.touchPoints) touchPoints = [...job.touchPoints];
                if (job.attachments) {
                    attachments = [...job.attachments];
                    console.log('Loaded attachments from job:', attachments);
                } else {
                    console.log('No attachments in job data');
                }

                // Sync typeahead text input with the loaded clientId
                const loadedClientId = form.elements['clientId'] && form.elements['clientId'].value;
                if (loadedClientId) {
                    const loadedClient = clients.find(c => c.id == loadedClientId || c._id == loadedClientId);
                    if (loadedClient) document.getElementById('jobClientInput').value = loadedClient.name;
                }

                // Trigger client change to populate service locations
                handleClientChange();

                // Set service location if it exists
                if (job.serviceLocationId) {
                    const locationSelect = document.getElementById('jobServiceLocationSelect');
                    locationSelect.value = job.serviceLocationId;
                    updateLocationDisplay();
                }

                // Check assigned team members
                const assignedIds = Array.isArray(job.assignedTo) ? job.assignedTo : (job.assignedTo ? [job.assignedTo] : []);
                document.querySelectorAll('.job-team-cb').forEach(cb => {
                    cb.checked = assignedIds.includes(cb.value);
                });
            } else {
                document.getElementById('jobModalTitle').textContent = 'Create Job';
                form.reset();
                document.getElementById('jobClientInput').value = '';
                document.getElementById('clientTypeaheadDropdown').style.display = 'none';
                document.getElementById('serviceLocationGroup').style.display = 'none';
                document.querySelectorAll('.job-team-cb').forEach(cb => cb.checked = false);
            }

            renderLineItems();
            renderTouchPoints();
            renderAttachments();

            // Load and render labor actuals if editing existing job
            if (job && (job._id || job.id)) {
                loadLaborActuals(job._id || job.id);
            } else {
                document.getElementById('laborActualsSection').style.display = 'none';
            }

            // Workflow stepper + sign-off button visibility
            const _stepperEl = document.getElementById('jobWorkflowStepper');
            const _signoffBtn = document.getElementById('jobSignoffBtn');
            if (job && (job._id || job.id)) {
                _stepperEl.style.display = 'block';
                _stepperEl.innerHTML = buildWorkflowStepper(buildJobStages(job));
                if (_signoffBtn) _signoffBtn.style.display = '';
            } else {
                _stepperEl.style.display = 'none';
                if (_signoffBtn) _signoffBtn.style.display = 'none';
            }

            // Load job photos (carried over from quote submission)
            const _photoJobId = job && (job._id || job.id);
            if (_photoJobId) {
                fetch(\`/api/jobs/\${_photoJobId}/photos\`)
                    .then(r => r.json())
                    .then(({ photos }) => {
                        const section = document.getElementById('jobPhotosSection');
                        const grid = document.getElementById('jobPhotoGrid');
                        if (photos && photos.length > 0) {
                            section.style.display = 'block';
                            grid.innerHTML = photos.map(p =>
                                \`<img src="\${p}" style="width:130px;height:97px;object-fit:cover;border-radius:8px;border:1.5px solid #e2e8f0;cursor:pointer;" onclick="openLightbox(this.src)">\`
                            ).join('');
                        } else {
                            section.style.display = 'none';
                        }
                    }).catch(() => {});
            } else {
                document.getElementById('jobPhotosSection').style.display = 'none';
            }

            // Show merged audit log: job entries + source quote history
            const _jobEntries = (job.auditLog || []).map(e => ({ ...e, _src: 'job' }));
            const _quoteEntries = (job.sourceQuoteHistory || []).map(e => ({ ...e, _src: 'quote' }));
            const _allEntries = [..._jobEntries, ..._quoteEntries]
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            if (_allEntries.length > 0) {
                document.getElementById('jobAuditLogSection').style.display = 'block';
                const auditLogHtml = _allEntries.map(entry => {
                    const date = new Date(entry.timestamp);
                    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
                    const actionColor = entry.action === 'created' ? '#48bb78' :
                                      entry.action === 'sent_email' ? '#4299e1' :
                                      entry.action === 'converted_to_job' ? '#9f7aea' :
                                      entry.action === 'status_change' ? '#ed8936' : '#718096';
                    const srcTag = entry._src === 'quote'
                        ? `<span style="background:#9f7aea;color:white;font-size:0.7rem;padding:1px 7px;border-radius:10px;margin-left:6px;vertical-align:middle;">QUOTE</span>`
                        : '';
                    return `
                        <div style="padding:1rem;margin-bottom:0.75rem;background:#f7fafc;border-left:4px solid ${actionColor};border-radius:4px;">
                            <div style="display:flex;justify-content:space-between;margin-bottom:0.5rem;">
                                <span><strong style="color:${actionColor};">${entry.action.replace(/_/g, ' ').toUpperCase()}</strong>${srcTag}</span>
                                <span style="color:#718096;font-size:0.875rem;">${dateStr}</span>
                            </div>
                            <div style="color:#4a5568;font-size:0.9rem;">${entry.note || ''}</div>
                            <div style="color:#a0aec0;font-size:0.8rem;margin-top:0.25rem;">by ${entry.userName || '—'}</div>
                        </div>
                    `;
                }).join('');
                document.getElementById('jobAuditLog').innerHTML = auditLogHtml;
            } else {
                document.getElementById('jobAuditLogSection').style.display = 'none';
            }

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

        async function openTeamModal(member = null) {
            if (!isAdmin) {
                alert('You do not have permission to create or edit team members.');
                return;
            }

            const form = document.getElementById('teamForm');
            currentEditingTeamId = null;

            // Reset login section to defaults
            document.getElementById('createUserLogin').checked = false;
            document.getElementById('createUserLogin').disabled = false;
            document.getElementById('loginFields').style.display = 'none';
            document.getElementById('loginEmail').value = '';
            document.getElementById('loginPassword').value = '';
            document.getElementById('loginPasswordConfirm').value = '';
            document.getElementById('loginPassword').placeholder = 'Minimum 6 characters';
            document.getElementById('loginPasswordConfirm').placeholder = 'Re-enter password';

            // Reset section texts
            document.getElementById('loginSectionTitle').textContent = 'User Login Access';
            document.getElementById('loginCheckboxText').textContent = 'Create user login for this team member';
            document.getElementById('loginCheckboxSubtext').textContent = 'Allow this team member to log in and clock in/out on jobs';

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

                // Check if this team member has a user login
                console.log('Team member data:', member);
                console.log('Team member userId:', member.userId);
                console.log('Team member email:', member.email);

                // Try to find user by email if userId is not set
                let hasUserLogin = false;
                let userAccount = null;

                try {
                    const response = await fetch('/api/users');
                    const users = await response.json();
                    console.log('All users:', users);

                    if (member.userId) {
                        userAccount = users.find(u => u.id === member.userId || u._id === member.userId);
                        console.log('Found by userId:', userAccount);
                    } else if (member.email) {
                        // Try to match by email
                        userAccount = users.find(u => u.email === member.email);
                        console.log('Found by email:', userAccount);
                    }

                    hasUserLogin = !!userAccount;
                } catch (err) {
                    console.error('Error fetching users:', err);
                }

                if (hasUserLogin && userAccount) {
                    // Show existing login section
                    document.getElementById('createUserLogin').checked = true;
                    document.getElementById('createUserLogin').disabled = true;
                    document.getElementById('loginFields').style.display = 'block';
                    document.getElementById('loginEmail').value = userAccount.email;

                    // Update the section header and instructions
                    document.getElementById('loginSectionTitle').textContent = 'User Login Access (Existing)';
                    document.getElementById('loginCheckboxText').textContent = 'User login exists for this team member';
                    document.getElementById('loginCheckboxSubtext').textContent = 'Update email or password below (password optional)';

                    // Update password fields to be optional for editing
                    document.getElementById('loginPassword').placeholder = 'Leave blank to keep current password';
                    document.getElementById('loginPasswordConfirm').placeholder = 'Leave blank to keep current password';

                    // Store the user ID in the member object if it wasn't there
                    if (!member.userId) {
                        member.userId = userAccount.id || userAccount._id;
                    }
                }
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

        function openModal(modalId) {
            document.getElementById(modalId).classList.add('active');
        }

        function populateJobSelects() {
            const container = document.getElementById('jobTeamCheckboxes');
            const activeTeam = team.filter(t => t.active);
            if (activeTeam.length === 0) {
                container.innerHTML = '<span style="color:#718096;font-size:0.875rem;">No active team members</span>';
                return;
            }
            container.innerHTML = activeTeam.map(t => \`
                <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-weight:normal;">
                    <input type="checkbox" class="job-team-cb" value="\${t.id}" onchange="handleTeamMemberChange()" style="width:1rem;height:1rem;">
                    <span>\${t.name}</span>
                </label>\`).join('');
        }

        function filterClientTypeahead() {
            const q = document.getElementById('jobClientInput').value.toLowerCase();
            const dropdown = document.getElementById('clientTypeaheadDropdown');
            const matches = q
                ? clients.filter(c => c.name.toLowerCase().includes(q) || (c.phone || '').includes(q))
                : clients;

            if (matches.length === 0) {
                dropdown.innerHTML = '<div style="padding:0.75rem 1rem;color:#718096;">No clients found</div>';
            } else {
                dropdown.innerHTML = matches.slice(0, 20).map(c => {
                    const phone = c.phone ? ' — ' + c.phone : '';
                    return '<div onmousedown="selectJobClient(\'' + c.id + '\')" style="padding:0.75rem 1rem;cursor:pointer;border-bottom:1px solid #f0f0f0;" onmouseover="this.style.background=\'#f0f4ff\'" onmouseout="this.style.background=\'\'"><span style="font-weight:500;">' + c.name + '</span><span style="color:#a0aec0;font-size:0.85rem;">' + phone + '</span></div>';
                }).join('');
            }
            dropdown.style.display = 'block';
        }

        function selectJobClient(clientId) {
            const client = clients.find(c => c.id == clientId);
            document.getElementById('jobClientSelect').value = clientId;
            document.getElementById('jobClientInput').value = client ? client.name : '';
            document.getElementById('clientTypeaheadDropdown').style.display = 'none';
            handleClientChange();
        }

        function setJobClientById(clientId) {
            const client = clients.find(c => c.id == clientId || c._id == clientId);
            document.getElementById('jobClientSelect').value = clientId;
            document.getElementById('jobClientInput').value = client ? client.name : '';
            document.getElementById('clientTypeaheadDropdown').style.display = 'none';
            handleClientChange();
        }

        document.addEventListener('click', function(e) {
            const wrapper = document.getElementById('jobClientInput');
            const dropdown = document.getElementById('clientTypeaheadDropdown');
            if (dropdown && !dropdown.contains(e.target) && e.target !== wrapper) {
                dropdown.style.display = 'none';
            }
            const qWrapper = document.getElementById('quoteClientInput');
            const qDropdown = document.getElementById('quoteClientTypeaheadDropdown');
            if (qDropdown && !qDropdown.contains(e.target) && e.target !== qWrapper) {
                qDropdown.style.display = 'none';
            }
        });

        function togglePortalFields() {
            const enabled = document.getElementById('enablePortalAccess').checked;
            document.getElementById('portalFields').style.display = enabled ? 'block' : 'none';

            // Show send button only if editing existing client with portal access
            const isEditing = currentEditingClientId !== null;
            const sendBtn = document.getElementById('sendPortalInfoBtn');
            sendBtn.style.display = (enabled && isEditing) ? 'block' : 'none';
        }

        function sendPortalInfo() {
            if (!currentEditingClientId) {
                alert('Please save the client first before sending portal info');
                return;
            }
            const client = clients.find(c => (c.id || c._id) == currentEditingClientId);
            if (!client) { alert('Client not found'); return; }
            if (!client.portalPassword) { alert('Client does not have portal access enabled'); return; }

            // Build list of available email addresses
            const options = [];
            if (client.email) options.push({ label: \`Primary — \${client.email}\`, value: client.email });
            (client.serviceLocations || []).forEach(loc => {
                if (loc.contactEmail) {
                    const name = loc.name || loc.address || 'Property';
                    options.push({ label: \`\${name} — \${loc.contactEmail}\`, value: loc.contactEmail });
                }
            });

            if (options.length === 0) { alert('No email address on file for this client or any of their properties.'); return; }

            // If only one option, skip the modal and send directly
            if (options.length === 1) {
                if (!confirm(\`Send portal login to \${options[0].value}?\`)) return;
                doSendPortalInfo(options[0].value);
                return;
            }

            // Multiple options — show picker modal
            const select = document.getElementById('portalSendToSelect');
            select.innerHTML = options.map(o => \`<option value="\${o.value}">\${o.label}</option>\`).join('');
            openModal('sendPortalModal');
        }

        async function confirmSendPortalInfo() {
            const toEmail = document.getElementById('portalSendToSelect').value;
            closeModal('sendPortalModal');
            await doSendPortalInfo(toEmail);
        }

        async function doSendPortalInfo(toEmail) {
            try {
                const response = await fetch('/api/clients/send-portal-info', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId: currentEditingClientId, toEmail })
                });
                if (!response.ok) throw new Error('Failed to send email');
                alert(\`✅ Portal login info sent to \${toEmail}!\`);
            } catch (error) {
                alert('Failed to send portal info: ' + error.message);
            }
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

            // Portal access
            const enablePortal = document.getElementById('enablePortalAccess').checked;
            const portalPassword = document.getElementById('portalPassword').value;

            if (enablePortal && portalPassword) {
                client.portalPassword = portalPassword;
            } else if (!enablePortal) {
                client.portalPassword = null; // Remove access
            }

            // If editing, include the _id
            if (currentEditingClientId) {
                client._id = currentEditingClientId;
            }

            try {
                const response = await fetch('/api/clients', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(client)
                });

                if (!response.ok) throw new Error('Failed to save client');

                const savedClient = await response.json();

                // Mark form as clean
                markFormClean('clientForm');

                // Reload clients list
                await loadClients();

                // Close client modal
                closeModal('clientModal');

                // If opened from job/quote context, reopen that modal and restore data
                if (clientModalContext === 'job') {
                    setTimeout(() => {
                        openJobModal();

                        // Restore form data
                        if (savedJobFormData) {
                            const form = document.getElementById('jobForm');
                            for (let [key, value] of savedJobFormData.entries()) {
                                const input = form.elements[key];
                                if (input && key !== 'clientId') {
                                    input.value = value;
                                }
                            }
                        }

                        // Set the new client
                        setJobClientById(savedClient.id || savedClient._id);

                        savedJobFormData = null;
                    }, 100);
                } else if (clientModalContext === 'quote') {
                    setTimeout(() => {
                        openQuoteModal();

                        // Restore form data
                        if (savedQuoteFormData) {
                            const form = document.getElementById('quoteForm');
                            for (let [key, value] of savedQuoteFormData.entries()) {
                                const input = form.elements[key];
                                if (input && key !== 'clientId') {
                                    input.value = value;
                                }
                            }
                        }

                        // Set the new client
                        setQuoteClientById(savedClient.id || savedClient._id);

                        savedQuoteFormData = null;
                    }, 100);
                }

                // Reset context
                clientModalContext = null;

            } catch (error) {
                alert('Failed to save client: ' + error.message);
            }
        }

        // Track context when opening client modal from job/quote
        let clientModalContext = null;
        let savedJobFormData = null;
        let savedQuoteFormData = null;

        function openClientModalFromJob() {
            // Save current job form data
            const form = document.getElementById('jobForm');
            savedJobFormData = new FormData(form);

            clientModalContext = 'job';
            closeModal('jobModal');
            setTimeout(() => openClientModal(), 100);
        }

        function openClientModalFromQuote() {
            // Save current quote form data
            const form = document.getElementById('quoteForm');
            savedQuoteFormData = new FormData(form);

            clientModalContext = 'quote';
            closeModal('quoteModal');
            setTimeout(() => openClientModal(), 100);
        }

        let laborItems = [];
        let materialItems = [];
        let paymentItems = [];
        let touchPoints = [];
        let attachments = [];

        // Image optimization function
        async function optimizeImage(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = function(e) {
                    const img = new Image();
                    img.onload = function() {
                        // Set max dimensions (1920px for standard HD)
                        const MAX_WIDTH = 1920;
                        const MAX_HEIGHT = 1920;

                        let width = img.width;
                        let height = img.height;

                        // Only resize if image is larger than max dimensions
                        if (width > MAX_WIDTH || height > MAX_HEIGHT) {
                            if (width > height) {
                                if (width > MAX_WIDTH) {
                                    height = Math.round((height * MAX_WIDTH) / width);
                                    width = MAX_WIDTH;
                                }
                            } else {
                                if (height > MAX_HEIGHT) {
                                    width = Math.round((width * MAX_HEIGHT) / height);
                                    height = MAX_HEIGHT;
                                }
                            }
                        }

                        // Create canvas and resize
                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);

                        // Convert to JPEG with 85% quality (great balance of size/quality)
                        canvas.toBlob(
                            (blob) => {
                                const optimizedFile = new File([blob], file.name.replace(/\\.png$/i, '.jpg'), {
                                    type: 'image/jpeg',
                                    lastModified: Date.now()
                                });
                                console.log(\`Optimized \${file.name}: \${(file.size / 1024).toFixed(1)}KB → \${(optimizedFile.size / 1024).toFixed(1)}KB (saved \${(((file.size - optimizedFile.size) / file.size) * 100).toFixed(0)}%)\`);
                                resolve(optimizedFile);
                            },
                            'image/jpeg',
                            0.85
                        );
                    };
                    img.onerror = reject;
                    img.src = e.target.result;
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }

        async function handleFileSelect(event) {
            const files = event.target.files;
            if (!files.length) return;

            for (let file of files) {
                // Prompt for comment
                const comment = prompt(\`Add a description for "\${file.name}":\`, '');
                if (comment === null) {
                    // User clicked cancel, skip this file
                    continue;
                }

                // Optimize images before upload
                const isImage = file.type.startsWith('image/');
                if (isImage) {
                    try {
                        file = await optimizeImage(file);
                    } catch (error) {
                        console.error('Image optimization failed, uploading original:', error);
                        // Continue with original file if optimization fails
                    }
                }

                // Read file as base64
                const reader = new FileReader();
                reader.onload = async function(e) {
                    try {
                        // Upload to server (will be stored in S3 or MongoDB)
                        const response = await fetch('/api/upload', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                fileName: file.name,
                                fileType: file.type,
                                fileData: e.target.result
                            })
                        });

                        if (response.ok) {
                            const result = await response.json();
                            const attachment = {
                                id: Date.now() + Math.random(),
                                name: file.name,
                                type: file.type,
                                size: file.size,
                                s3Key: result.s3Key, // Will be set if using S3
                                data: result.data, // Will be set if using MongoDB fallback
                                uploadedAt: new Date().toISOString(),
                                comment: comment.trim() // Add comment field
                            };
                            attachments.push(attachment);
                            renderAttachments();
                            markFormDirty();
                        } else {
                            alert(\`Failed to upload "\${file.name}"\`);
                        }
                    } catch (error) {
                        console.error('Upload error:', error);
                        alert(\`Error uploading "\${file.name}"\`);
                    }
                };
                reader.readAsDataURL(file);
            }

            // Clear the input so the same file can be selected again
            event.target.value = '';
        }

        function renderAttachments() {
            const container = document.getElementById('attachmentsList');
            if (attachments.length === 0) {
                container.innerHTML = '<p style="color: #a0aec0; font-style: italic;">No attachments yet</p>';
                return;
            }

            container.innerHTML = attachments.map(att => {
                const isImage = att.type.startsWith('image/');
                const sizeKB = (att.size / 1024).toFixed(1);
                const icon = isImage ? '🖼️' : '📄';

                return \`
                    <div style="display: flex; align-items: center; gap: 1rem; padding: 0.75rem; background: #f7fafc; border-radius: 8px; margin-bottom: 0.5rem;">
                        <span style="font-size: 1.5rem;">\${icon}</span>
                        <div style="flex: 1;">
                            <div style="font-weight: 600; color: #2d3748;">\${att.name}</div>
                            <div style="font-size: 0.85rem; color: #718096;">\${sizeKB} KB</div>
                            \${att.comment ? \`<div style="font-size: 0.9rem; color: #4a5568; margin-top: 0.25rem; font-style: italic;">"\${att.comment}"</div>\` : ''}
                        </div>
                        \${isImage ? \`<button type="button" class="btn btn-secondary btn-small" onclick="viewAttachment('\${att.id}')">View</button>\` : ''}
                        <button type="button" class="btn btn-secondary btn-small" onclick="downloadAttachment('\${att.id}')">Download</button>
                        <button type="button" class="btn btn-danger btn-small" onclick="removeAttachment('\${att.id}')">Remove</button>
                    </div>
                \`;
            }).join('');
        }

        async function removeAttachment(id) {
            const attachment = attachments.find(att => att.id == id);
            if (!attachment) return;

            if (confirm(\`Remove "\${attachment.name}"?\`)) {
                // If file is in S3, delete it from S3
                if (attachment.s3Key) {
                    try {
                        const response = await fetch(\`/api/file/\${attachment.s3Key}\`, {
                            method: 'DELETE'
                        });
                        if (!response.ok) {
                            console.error('Failed to delete file from S3');
                        }
                    } catch (error) {
                        console.error('Error deleting file from S3:', error);
                    }
                }

                // Remove from attachments array
                attachments = attachments.filter(att => att.id != id);
                renderAttachments();
                markFormDirty();
            }
        }

        async function viewAttachment(id) {
            const attachment = attachments.find(att => att.id == id);
            if (!attachment) return;

            try {
                let imageUrl;
                if (attachment.s3Key) {
                    // Get signed URL from S3
                    const response = await fetch(\`/api/file/\${attachment.s3Key}\`);
                    if (response.ok) {
                        const result = await response.json();
                        imageUrl = result.url;
                    } else {
                        alert('Failed to load image');
                        return;
                    }
                } else {
                    // Use base64 data directly
                    imageUrl = attachment.data;
                }

                // Open image in a new window
                const win = window.open('', '_blank');
                win.document.write(\`
                    <html>
                        <head><title>\${attachment.name}</title></head>
                        <body style="margin: 0; display: flex; justify-content: center; align-items: center; background: #000;">
                            <img src="\${imageUrl}" style="max-width: 100%; max-height: 100vh;" />
                        </body>
                    </html>
                \`);
            } catch (error) {
                console.error('View attachment error:', error);
                alert('Failed to view attachment');
            }
        }

        async function downloadAttachment(id) {
            const attachment = attachments.find(att => att.id == id);
            if (!attachment) return;

            try {
                let downloadUrl;
                if (attachment.s3Key) {
                    // Get signed URL from S3
                    const response = await fetch(\`/api/file/\${attachment.s3Key}\`);
                    if (response.ok) {
                        const result = await response.json();
                        downloadUrl = result.url;
                    } else {
                        alert('Failed to download file');
                        return;
                    }
                } else {
                    // Use base64 data directly
                    downloadUrl = attachment.data;
                }

                // Create a temporary link and click it
                const link = document.createElement('a');
                link.href = downloadUrl;
                link.download = attachment.name;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            } catch (error) {
                console.error('Download attachment error:', error);
                alert('Failed to download attachment');
            }
        }

        function addLaborItem() {
            const id = Date.now();
            const checkedBoxes = document.querySelectorAll('.job-team-cb:checked');
            const selectedTeamId = checkedBoxes.length === 1 ? checkedBoxes[0].value : null;

            let defaultRate = settings.hourlyRate || 75;

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
            const balanceEl = document.getElementById('balanceOwedSummary');
            const defaultAmount = balanceEl ? Math.max(0, parseFloat(balanceEl.textContent) || 0) : 0;
            paymentItems.push({ id, date: today, amount: defaultAmount, method: 'cash', notes: '' });
            renderLineItems();
            markFormDirty();
        }

        function handleClientChange() {
            const clientSelect = document.getElementById('jobClientSelect');
            const selectedClientId = clientSelect.value;
            const locationGroup = document.getElementById('serviceLocationGroup');
            const locationSelect = document.getElementById('jobServiceLocationSelect');

            if (!selectedClientId) {
                locationGroup.style.display = 'none';
                locationSelect.innerHTML = '<option value="">Select a location...</option>';
                return;
            }

            const client = clients.find(c => c.id == selectedClientId);

            if (client && client.isPropertyManagement && client.serviceLocations && client.serviceLocations.length > 0) {
                locationGroup.style.display = 'block';
                locationSelect.innerHTML = '<option value="">Select a location...</option>' +
                    client.serviceLocations.map((loc, index) => {
                        const label = loc.name || loc.address || \`Location #\${index + 1}\`;
                        return \`<option value="\${loc.id}">\${label}</option>\`;
                    }).join('');
            } else {
                locationGroup.style.display = 'none';
                locationSelect.innerHTML = '<option value="">Select a location...</option>';
            }
        }

        function updateLocationDisplay() {
            const select = document.getElementById('jobServiceLocationSelect');
            const display = document.getElementById('locationInfoDisplay');
            const selectedClientId = document.getElementById('jobClientSelect').value;
            const client = clients.find(c => c.id == selectedClientId);
            if (!display) return;

            const locId = select && select.value;
            if (!locId || !client || !client.serviceLocations) {
                display.style.display = 'none';
                return;
            }

            const loc = client.serviceLocations.find(l => String(l.id) === String(locId));
            if (!loc) { display.style.display = 'none'; return; }

            const parts = [];
            if (loc.name) parts.push(\`<strong>\${loc.name}</strong>\`);
            if (loc.address) parts.push(loc.address.replace(/\n/g, ', ').replace(/,\s*,/g, ',').trim());
            if (loc.contact) parts.push(\`Contact: \${loc.contact}\`);
            if (loc.contactEmail) parts.push(\`📧 \${loc.contactEmail}\`);

            if (parts.length) {
                display.innerHTML = parts.join('<br>');
                display.style.display = 'block';
            } else {
                display.style.display = 'none';
            }
        }

        function handleTeamMemberChange() {
            const checked = Array.from(document.querySelectorAll('.job-team-cb:checked'));
            if (checked.length !== 1) return;
            const teamMember = team.find(t => t.id == checked[0].value);
            if (!teamMember || !teamMember.hourlyRate) return;

            laborItems.forEach(item => { item.rate = parseFloat(teamMember.hourlyRate); });
            if (laborItems.length === 0) {
                laborItems.push({ id: Date.now(), description: '', hours: 0, rate: parseFloat(teamMember.hourlyRate) });
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
                <div class="line-item" draggable="true" data-id="\${item.id}" style="display: grid; grid-template-columns: 20px 2fr 1fr 1fr 1fr 40px; gap: 0.5rem; margin-bottom: 0.5rem; align-items: end; cursor: default;">
                    <div class="drag-handle" style="display:flex;align-items:center;justify-content:center;height:38px;color:#cbd5e0;cursor:grab;font-size:1.1rem;user-select:none;">⠿</div>
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
                <div class="line-item" draggable="true" data-id="\${item.id}" style="display: grid; grid-template-columns: 20px 2fr 1fr 1fr 1fr 40px; gap: 0.5rem; margin-bottom: 0.5rem; align-items: end; cursor: default;">
                    <div class="drag-handle" style="display:flex;align-items:center;justify-content:center;height:38px;color:#cbd5e0;cursor:grab;font-size:1.1rem;user-select:none;">⠿</div>
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

            initLineItemDrag(laborContainer, laborItems);
            initLineItemDrag(materialContainer, materialItems);

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

        function initLineItemDrag(container, itemsArray) {
            let dragSrc = null;

            container.querySelectorAll('.line-item').forEach(row => {
                row.addEventListener('dragstart', function(e) {
                    // Only start drag from the handle
                    if (!e.target.closest('.drag-handle')) { e.preventDefault(); return; }
                    dragSrc = this;
                    e.dataTransfer.effectAllowed = 'move';
                    setTimeout(() => this.style.opacity = '0.4', 0);
                });

                row.addEventListener('dragend', function() {
                    this.style.opacity = '';
                    container.querySelectorAll('.line-item').forEach(r => r.classList.remove('drag-over'));
                });

                row.addEventListener('dragover', function(e) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    container.querySelectorAll('.line-item').forEach(r => r.classList.remove('drag-over'));
                    if (this !== dragSrc) this.style.borderTop = '2px solid #667eea';
                });

                row.addEventListener('dragleave', function() {
                    this.style.borderTop = '';
                });

                row.addEventListener('drop', function(e) {
                    e.preventDefault();
                    this.style.borderTop = '';
                    if (!dragSrc || dragSrc === this) return;

                    const srcId = parseInt(dragSrc.dataset.id);
                    const tgtId = parseInt(this.dataset.id);
                    const srcIdx = itemsArray.findIndex(i => i.id === srcId);
                    const tgtIdx = itemsArray.findIndex(i => i.id === tgtId);
                    if (srcIdx === -1 || tgtIdx === -1) return;

                    const [moved] = itemsArray.splice(srcIdx, 1);
                    itemsArray.splice(tgtIdx, 0, moved);
                    renderLineItems();
                });
            });
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

        function addTouchPoint() {
            const input = document.getElementById('newTouchPoint');
            const noteText = input.value.trim();

            if (!noteText) {
                alert('Please enter a note');
                return;
            }

            const touchPoint = {
                id: Date.now(),
                note: noteText,
                timestamp: new Date().toISOString(),
                user: document.getElementById('currentUserName').textContent
            };

            touchPoints.push(touchPoint);
            input.value = '';
            renderTouchPoints();
            markFormDirty();
        }

        function removeTouchPoint(id) {
            if (confirm('Remove this touch point?')) {
                touchPoints = touchPoints.filter(tp => tp.id !== id);
                renderTouchPoints();
                markFormDirty();
            }
        }

        async function loadLaborActuals(jobId) {
            try {
                const response = await fetch('/api/timeentries');
                if (!response.ok) {
                    console.error('Failed to load time entries');
                    return;
                }

                const allEntries = await response.json();
                const jobEntries = allEntries.filter(entry =>
                    entry.jobId === jobId && entry.status === 'approved'
                );

                const section = document.getElementById('laborActualsSection');
                const container = document.getElementById('laborActualsList');

                if (jobEntries.length === 0) {
                    section.style.display = 'none';
                    return;
                }

                section.style.display = 'block';

                const totalPayout = jobEntries.reduce((sum, entry) =>
                    sum + (parseFloat(entry.paymentAmount) || 0), 0
                );

                container.innerHTML = \`
                    <div style="margin-bottom: 1rem;">
                        <p style="color: #4a5568; margin-bottom: 0.5rem;">
                            <strong>Approved labor payments for this job:</strong>
                        </p>
                    </div>
                    \${jobEntries.map(entry => {
                        const clockIn = new Date(entry.clockIn);
                        const clockOut = entry.clockOut ? new Date(entry.clockOut) : null;
                        const hours = entry.duration ? (entry.duration / 3600).toFixed(2) : '0.00';
                        const payout = parseFloat(entry.paymentAmount) || 0;

                        return \`
                            <div style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #e2e8f0;">
                                <div>
                                    <strong style="color: #2d3748;">\${entry.userName}</strong>
                                    <div style="font-size: 0.85rem; color: #718096;">
                                        \${clockIn.toLocaleDateString()} · \${hours} hours
                                    </div>
                                </div>
                                <div style="font-weight: 600; color: #48bb78;">
                                    \${formatMoney(payout)}
                                </div>
                            </div>
                        \`;
                    }).join('')}
                    <div style="display: flex; justify-content: space-between; padding: 1rem 0; margin-top: 0.5rem; border-top: 2px solid #cbd5e0;">
                        <strong style="color: #1a202c;">Total Labor Costs:</strong>
                        <strong style="color: #e53e3e; font-size: 1.1rem;">\${formatMoney(totalPayout)}</strong>
                    </div>
                \`;
            } catch (error) {
                console.error('Error loading labor actuals:', error);
            }
        }

        function renderTouchPoints() {
            const container = document.getElementById('touchPointsList');

            if (touchPoints.length === 0) {
                container.innerHTML = '<p style="color: #718096; font-style: italic;">No touch points yet. Add notes to track communications and updates.</p>';
                return;
            }

            container.innerHTML = touchPoints.slice().reverse().map(tp => {
                const date = new Date(tp.timestamp);
                const formattedDate = date.toLocaleString();
                const borderColor = tp.fromQuote ? '#9f7aea' : '#667eea';
                const srcBadge = tp.fromQuote
                    ? \`<span style="background:#9f7aea;color:white;font-size:0.68rem;padding:1px 6px;border-radius:10px;margin-left:5px;vertical-align:middle;">QUOTE</span>\`
                    : '';
                const deleteBtn = tp.fromQuote
                    ? ''
                    : \`<button type="button" onclick="removeTouchPoint(\${tp.id})" style="background:transparent;border:none;color:#e53e3e;cursor:pointer;padding:0;font-size:1.2rem;line-height:1;">&times;</button>\`;

                return \`
                    <div style="background:#f7fafc;border-left:3px solid \${borderColor};padding:0.75rem;margin-bottom:0.5rem;border-radius:4px;">
                        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem;">
                            <div style="font-size:0.85rem;color:#4a5568;">
                                <strong>\${tp.user}</strong> · \${formattedDate}\${srcBadge}
                            </div>
                            \${deleteBtn}
                        </div>
                        <div style="color:#1a202c;">\${tp.note}</div>
                    </div>
                \`;
            }).join('');
        }

        async function saveJob() {
            const form = document.getElementById('jobForm');
            const formData = new FormData(form);
            const job = Object.fromEntries(formData);

            // If editing, include the _id
            if (currentEditingJobId) {
                job._id = currentEditingJobId;
            }

            // Collect assigned team members from checkboxes
            job.assignedTo = Array.from(document.querySelectorAll('.job-team-cb:checked')).map(cb => cb.value);

            // Add line items, payments, touch points, and attachments
            job.laborItems = laborItems;
            job.materialItems = materialItems;
            job.payments = paymentItems;
            job.touchPoints = touchPoints;
            // Clean attachments - remove base64 data if s3Key exists (save space)
            job.attachments = attachments.map(att => {
                if (att.s3Key) {
                    // Only store S3 metadata, not the full base64 data
                    return {
                        id: att.id,
                        name: att.name,
                        type: att.type,
                        size: att.size,
                        s3Key: att.s3Key,
                        uploadedAt: att.uploadedAt,
                        comment: att.comment // Preserve comment field
                    };
                }
                return att; // Keep full data for MongoDB fallback
            });

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

            console.log('Saving job with attachments:', job.attachments);

            try {
                const response = await fetch('/api/jobs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(job)
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.error || 'Failed to save job');
                }

                // Check if we should auto-create calendar event
                const isNewJob = !currentEditingJobId;
                const hasScheduledDate = job.scheduledDate && job.status === 'scheduled';

                if (isNewJob && hasScheduledDate && settings.calendarSettings?.autoSync) {
                    try {
                        const calendarResponse = await fetch('/api/calendar/create-event', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                jobId: result.id || result._id,
                                sendInvite: settings.calendarSettings?.sendInvites || false
                            })
                        });

                        if (calendarResponse.ok) {
                            console.log('✅ Calendar event auto-created');
                        }
                    } catch (calError) {
                        console.warn('Calendar event creation failed:', calError);
                        // Don't block job save if calendar fails
                    }
                }

                markFormClean('jobForm');
                closeModal('jobModal');
                loadJobs();
                loadDashboard();
            } catch (error) {
                alert('Failed to save job: ' + error.message);
            }
        }

        function toggleLoginFields() {
            const checkbox = document.getElementById('createUserLogin');
            const loginFields = document.getElementById('loginFields');
            loginFields.style.display = checkbox.checked ? 'block' : 'none';
        }

        async function saveTeamMember() {
            const form = document.getElementById('teamForm');
            const formData = new FormData(form);
            const member = Object.fromEntries(formData);

            // If editing, include the _id
            if (currentEditingTeamId) {
                member._id = currentEditingTeamId;
            }

            // Check if user login creation/update is requested
            const createLogin = document.getElementById('createUserLogin').checked;
            if (createLogin) {
                const loginEmail = document.getElementById('loginEmail').value.trim();
                const loginPassword = document.getElementById('loginPassword').value;
                const loginPasswordConfirm = document.getElementById('loginPasswordConfirm').value;

                // For new logins, email and password are required
                // For existing logins, only email is required (password optional)
                const existingMember = team.find(t => (t.id == currentEditingTeamId || t._id == currentEditingTeamId));
                const isNewLogin = !existingMember || !existingMember.userId;

                if (!loginEmail) {
                    alert('Please provide a login email');
                    return;
                }

                if (isNewLogin) {
                    // Creating new login - password required
                    if (!validatePassword(loginPassword, loginPasswordConfirm)) return;

                    member.createUserLogin = true;
                    member.loginEmail = loginEmail;
                    member.loginPassword = loginPassword;
                } else {
                    // Updating existing login
                    member.updateUserLogin = true;
                    member.loginEmail = loginEmail;

                    // Only include password if it was changed
                    if (loginPassword && loginPasswordConfirm) {
                        if (!validatePassword(loginPassword, loginPasswordConfirm)) return;
                        member.loginPassword = loginPassword;
                    }
                }
            }

            try {
                const result = await postData('/api/team', member, {
                    markClean: true,
                    closeModal: 'teamModal',
                    reload: loadTeam
                });

                if (createLogin && result.userCreated) {
                    alert('Team member saved and user login created!\\n\\nEmail: ' + loginEmail + '\\nThey can now log in to clock in/out.');
                } else if (member.updateUserLogin) {
                    alert('Team member and login updated successfully!');
                }
            } catch (error) {
                alert('Error: ' + error.message);
            }
        }

        // ============================================================
        // UTILITY FUNCTIONS
        // ============================================================

        // Format money with thousands separator
        function formatMoney(amount) {
            return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        // Check admin permission
        function checkAdminPermission(actionName) {
            if (!isAdmin) {
                alert(`You do not have permission to ${actionName}.`);
                return false;
            }
            return true;
        }

        // Export data to CSV
        function exportToCSV(data, headers, filename, rowMapper) {
            let csv = headers.map(h => '"' + h + '"').join(',') + '\n';
            data.forEach(item => {
                const row = rowMapper(item);
                csv += row.map(cell => '"' + (cell || '') + '"').join(',') + '\n';
            });

            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }

        // POST data to API
        async function postData(endpoint, data, options = {}) {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (response.ok) {
                if (options.markClean) markFormClean();
                if (options.closeModal) closeModal(options.closeModal);
                if (options.reload) options.reload();
                return await response.json();
            } else {
                const error = await response.text();
                throw new Error(error || 'Request failed');
            }
        }

        // Render empty state
        function renderEmptyState(container, title, message) {
            container.innerHTML = `<div class="empty-state"><h3>${title}</h3><p>${message}</p></div>`;
        }

        // Find client by ID
        function findClient(id) {
            return clients.find(c => c.id == id) || null;
        }

        // Find team member by ID
        function findTeamMember(id) {
            return team.find(t => t.id == id) || null;
        }

        // Get display names for assignedTo (handles array or legacy single value)
        function getAssignedNames(assignedTo) {
            const ids = Array.isArray(assignedTo) ? assignedTo : (assignedTo ? [assignedTo] : []);
            if (ids.length === 0) return 'Unassigned';
            const names = ids.map(id => { const m = findTeamMember(id); return m ? m.name : null; }).filter(Boolean);
            if (names.length === 0) return 'Unassigned';
            if (names.length <= 2) return names.join(', ');
            return names[0] + ' +' + (names.length - 1);
        }

        function isAssignedTo(job, memberId) {
            const ids = Array.isArray(job.assignedTo) ? job.assignedTo : (job.assignedTo ? [job.assignedTo] : []);
            return ids.some(id => String(id) === String(memberId));
        }

        // Validate password
        function validatePassword(password, confirmPassword) {
            if (!password || !confirmPassword) {
                alert('Please enter both password fields');
                return false;
            }
            if (password !== confirmPassword) {
                alert('Passwords do not match');
                return false;
            }
            if (password.length < 6) {
                alert('Password must be at least 6 characters');
                return false;
            }
            return true;
        }

        // Calculate job payment status
        function calculateJobPaymentStatus(job) {
            const total = job.totalWithTax ? job.totalWithTax : (job.total ? calculateTotalWithTax(parseFloat(job.total)) : 0);
            const paid = job.totalPaid ? parseFloat(job.totalPaid) : 0;
            const owed = total - paid;
            const isPaidInFull = Math.abs(owed) < 0.01;
            return { total, paid, owed, isPaidInFull };
        }

        // Get filtered jobs
        function getFilteredJobs(statusFilter, clientFilter, assignedFilter) {
            const today = new Date();
            const weekStart = new Date(today);
            weekStart.setDate(today.getDate() - today.getDay());
            weekStart.setHours(0, 0, 0, 0);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekStart.getDate() + 7);
            const weekStartStr = weekStart.toISOString().slice(0, 10);
            const weekEndStr = weekEnd.toISOString().slice(0, 10);

            return jobs.filter(j => {
                if (statusFilter === 'ACTIVE_WORK') {
                    if (j.status === 'completed' || j.status === 'invoiced' || j.status === 'bid_lost') return false;
                } else if (statusFilter === 'COMPLETED_WEEK') {
                    if (j.status !== 'completed' && j.status !== 'invoiced') return false;
                    if (!j.scheduledDate || j.scheduledDate < weekStartStr || j.scheduledDate >= weekEndStr) return false;
                } else if (statusFilter && j.status !== statusFilter) {
                    return false;
                }
                if (clientFilter) {
                    const jClient = findClient(j.clientId);
                    if (!jClient || !jClient.name.toLowerCase().includes(clientFilter.toLowerCase())) return false;
                }
                if (assignedFilter && !isAssignedTo(j, assignedFilter)) return false;
                return true;
            });
        }

        // Populate dropdown
        function populateDropdown(selectElement, items, valueKey, displayKey, placeholder = 'Select...') {
            selectElement.innerHTML = `<option value="">${placeholder}</option>` +
                items.map(item => `<option value="${item[valueKey]}">${item[displayKey]}</option>`).join('');
        }

        // ============================================================
        // LOAD FUNCTIONS
        // ============================================================

        async function loadDashboard() {
            try {
                const response = await fetch('/api/dashboard');
                const stats = await response.json();

            document.getElementById('stat-clients').textContent = stats.totalClients;
            document.getElementById('stat-jobs-month').textContent = stats.jobsThisMonth;
            document.getElementById('stat-revenue').textContent = formatMoney(stats.revenueThisMonth || 0);
            document.getElementById('stat-profit').textContent = formatMoney(stats.profitThisMonth || 0);
            document.getElementById('stat-jobs-today').textContent = stats.jobsToday;

            // Month-over-month deltas
            (function() {
                function deltaHtml(current, last) {
                    if (!last || last === 0) return '';
                    const pct = Math.round((current - last) / last * 100);
                    const up = pct >= 0;
                    return `<span style="color:${up ? '#48bb78' : '#e53e3e'}">${up ? '▲' : '▼'} ${Math.abs(pct)}% vs last month</span>`;
                }
                const rd = document.getElementById('stat-revenue-delta');
                const jd = document.getElementById('stat-jobs-month-delta');
                if (rd) rd.innerHTML = deltaHtml(stats.revenueThisMonth || 0, stats.lastMonthRevenue || 0);
                if (jd) jd.innerHTML = deltaHtml(stats.jobsThisMonth || 0, stats.lastMonthJobs || 0);
            })();

            // Revenue trend bar chart
            (function() {
                const months = stats.revenueByMonth;
                const svg = document.getElementById('revenueTrendSvg');
                if (!svg || !months || months.length === 0) return;
                const maxRev = Math.max(...months.map(m => m.revenue), 1);
                const W = 600, chartH = 115, barAreaW = W / months.length;
                const barW = barAreaW * 0.52;
                svg.innerHTML = months.map((m, i) => {
                    const barH = Math.max(4, (m.revenue / maxRev) * chartH);
                    const x = i * barAreaW + (barAreaW - barW) / 2;
                    const y = chartH - barH;
                    const isCurrent = i === months.length - 1;
                    const fill = isCurrent ? '#667eea' : '#e2e8f0';
                    const textFill = isCurrent ? '#667eea' : '#a0aec0';
                    const valLabel = m.revenue >= 1000 ? `$${(m.revenue/1000).toFixed(1)}k` : m.revenue > 0 ? `$${Math.round(m.revenue)}` : '';
                    const labelY = Math.max(11, y - 5);
                    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="4" fill="${fill}"/>` +
                        `<text x="${(x+barW/2).toFixed(1)}" y="135" text-anchor="middle" font-size="11" fill="#718096" font-family="sans-serif">${m.label}</text>` +
                        (valLabel ? `<text x="${(x+barW/2).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="10" fill="${textFill}" font-weight="600" font-family="sans-serif">${valLabel}</text>` : '');
                }).join('');
            })();

            document.getElementById('stat-prospecting').textContent = stats.prospecting;
            document.getElementById('stat-to-be-scheduled').textContent = stats.toBeScheduled;
            document.getElementById('stat-scheduled').textContent = stats.scheduled;
            document.getElementById('stat-in-progress').textContent = stats.inProgress;
            document.getElementById('stat-completed').textContent = stats.completed;
            document.getElementById('stat-invoiced').textContent = stats.invoiced;
            document.getElementById('stat-bid-lost').textContent = stats.bidLost;
            document.getElementById('stat-ar').textContent = formatMoney(stats.totalAccountsReceivable || 0);

            // Render job list helper function
            const renderJobList = (jobs, emptyMessage) => {
                if (!jobs || jobs.length === 0) {
                    return \`<div class="empty-state" style="padding: 2rem;"><p style="color: #a0aec0;">\${emptyMessage}</p></div>\`;
                }

                return '<div style="max-height: 400px; overflow-y: auto;"><table style="font-size: 0.875rem;"><tbody>' +
                    jobs.map(j => {
                        const client = findClient(j.clientId);
                        const assignedNames = getAssignedNames(j.assignedTo);
                        return \`<tr style="cursor: pointer; border-bottom: 1px solid #e2e8f0;" onclick="editJob('\${j.id}')">
                            <td style="padding: 0.75rem;">
                                <div style="font-weight: 600; margin-bottom: 0.25rem;">\${j.title}</div>
                                <div style="font-size: 0.75rem; color: #718096;">
                                    \${maskName(client ? client.name : 'Unknown')} • \${j.scheduledDate || 'No date'}
                                    \${assignedNames !== 'Unassigned' ? ' • ' + assignedNames : ''}
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
            document.getElementById('upcoming-count').textContent = '(' + (stats.upcomingJobs?.length || 0) + ')';
            document.getElementById('upcoming-jobs-list').innerHTML =
                renderJobList(stats.upcomingJobs, 'No upcoming jobs');

            // In Progress jobs
            document.getElementById('in-progress-count').textContent = '(' + (stats.inProgressJobs?.length || 0) + ')';
            document.getElementById('in-progress-jobs-list').innerHTML =
                renderJobList(stats.inProgressJobs, 'No jobs in progress');

            // Completed last 30 days
            document.getElementById('completed-count').textContent = '(' + (stats.completedLast30Days?.length || 0) + ')';
            document.getElementById('completed-jobs-list').innerHTML =
                renderJobList(stats.completedLast30Days, 'No completed jobs');

            // Accounts Receivable tile
            document.getElementById('ar-count').textContent = '(' + (stats.accountsReceivableJobs?.length || 0) + ')';
            const arJobs = stats.accountsReceivableJobs || [];
            if (arJobs.length === 0) {
                document.getElementById('ar-jobs-list').innerHTML = '<div class="empty-state" style="padding: 2rem;"><p style="color: #a0aec0;">No outstanding balances</p></div>';
            } else {
                const _termsDays = { due_receipt: 0, net_15: 15, net_30: 30, net_45: 45, net_60: 60, net_90: 90 };
                document.getElementById('ar-jobs-list').innerHTML = '<div style="max-height: 400px; overflow-y: auto;"><table style="font-size: 0.875rem;"><tbody>' +
                    arJobs.map(j => {
                        const client = findClient(j.clientId);
                        const balanceOwed = j.balanceOwed || 0;
                        const terms = client?.paymentTerms;
                        const td = _termsDays[terms];
                        let dueInfo = '';
                        if (td !== undefined && j.invoicedAt) {
                            const dueDate = new Date(new Date(j.invoicedAt).getTime() + td * 86400000);
                            const today = new Date(); today.setHours(0,0,0,0);
                            const diffDays = Math.round((dueDate.setHours(0,0,0,0), dueDate - today) / 86400000);
                            if (diffDays > 0)      dueInfo = `<div style="font-size:0.7rem;color:#48bb78;">Due in ${diffDays}d (${new Date(new Date(j.invoicedAt).getTime() + td*86400000).toLocaleDateString()})</div>`;
                            else if (diffDays === 0) dueInfo = `<div style="font-size:0.7rem;color:#ed8936;font-weight:600;">Due today</div>`;
                            else                    dueInfo = `<div style="font-size:0.7rem;color:#e53e3e;font-weight:600;">${Math.abs(diffDays)} days overdue</div>`;
                        } else if (terms) {
                            dueInfo = `<div style="font-size:0.7rem;color:#a0aec0;">${terms.replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase())}</div>`;
                        }
                        return `<tr style="cursor: pointer; border-bottom: 1px solid #e2e8f0;" onclick="editJob('${j.id}')">
                            <td style="padding: 0.75rem;">
                                <div style="font-weight: 600; margin-bottom: 0.25rem;">${j.title}</div>
                                <div style="font-size: 0.75rem; color: #718096;">
                                    ${maskName(client ? client.name : 'Unknown')} • ${j.scheduledDate || 'No date'}
                                </div>
                            </td>
                            <td style="padding: 0.75rem; text-align: right;">
                                <div style="font-weight: 700; color: #e53e3e; font-size: 1rem;">${formatMoney(balanceOwed)}</div>
                                ${dueInfo || '<div style="font-size:0.7rem;color:#718096;">owed</div>'}
                            </td>
                        </tr>`;
                    }).join('') +
                    '</tbody></table></div>';
            }
            } catch (error) {
                console.error('Failed to load dashboard:', error);
            }
        }

        async function loadClients() {
            try {
                const response = await fetch('/api/clients');
                clients = await response.json();

                // Always reload jobs to ensure fresh data for stats
                const jobsResponse = await fetch('/api/jobs');
                jobs = await jobsResponse.json();

            // Calculate stats
            const totalClients = clients.length;
            clientJobCounts = {};

            jobs.forEach(j => {
                if (j.clientId) {
                    // Handle both string and ObjectId formats
                    const clientIdStr = String(j.clientId);
                    clientJobCounts[clientIdStr] = (clientJobCounts[clientIdStr] || 0) + 1;
                }
            });

            const repeatClients = Object.values(clientJobCounts).filter(count => count > 1).length;

            document.getElementById('stat-total-clients').textContent = totalClients;
            document.getElementById('stat-repeat-clients').textContent = repeatClients;

            // Render ZIP distribution
            renderZipDistribution();

            renderClientsList(clients);
            } catch (error) {
                console.error('Failed to load clients:', error);
            }
        }

        function renderClientsList(list) {
            const container = document.getElementById('clients-list');
            if (!container) return;
            if (list.length === 0) {
                container.innerHTML = \`<div style="text-align:center;padding:3rem;color:#718096;">No clients match your search.</div>\`;
                return;
            }

            list = applySortState(list, 'clients', { name: 'name', email: 'email', phone: 'phone', city: 'city', marketingChannel: 'marketingChannel' });

            const isMobile = window.innerWidth < 768;

            if (isMobile) {
                container.innerHTML = list.map(c => {
                    const cityState = [c.city, c.state].filter(x => x).join(', ') || (c.address ? c.address.substring(0, 30) : '');
                    const jobCount = clientJobCounts[String(c.id)] || 0;
                    let starHtml = '';
                    if (jobCount > 2) starHtml = \`<span style="color:#f59e0b;">★</span> \`;
                    else if (jobCount === 2) starHtml = \`<span style="color:#10b981;">★</span> \`;

                    return \`<div style="background:white;border:2px solid #e2e8f0;border-radius:10px;padding:1rem;margin-bottom:0.75rem;" onclick="viewClientDetail('\${c.id}')">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.35rem;">
                            <div style="font-size:1.1rem;font-weight:700;color:#2d3748;">\${starHtml}\${c.name}\${jobCount > 2 ? \` <span style="background:#fbbf24;color:#78350f;padding:1px 6px;border-radius:10px;font-size:0.75rem;font-weight:600;">\${jobCount}</span>\` : ''}</div>
                        </div>
                        \${c.phone ? \`<div style="color:#4a5568;font-size:0.9rem;">📞 \${formatPhoneNumber(c.phone)}</div>\` : ''}
                        \${c.email ? \`<div style="color:#4a5568;font-size:0.9rem;">✉️ \${c.email}</div>\` : ''}
                        \${cityState ? \`<div style="color:#718096;font-size:0.85rem;margin-top:0.2rem;">📍 \${cityState}</div>\` : ''}
                        <div style="display:flex;gap:0.5rem;margin-top:0.75rem;" onclick="event.stopPropagation()">
                            <button class="btn btn-secondary btn-small" onclick="openSMSModal('\${c.phone}', '\${c.id}', null)">📱 Text</button>
                            <button class="btn btn-secondary btn-small" onclick="editClient('\${c.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;"' : ''}>Edit</button>
                            <button class="btn btn-danger btn-small" onclick="deleteClient('\${c.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;"' : ''}>Delete</button>
                        </div>
                    </div>\`;
                }).join('');
            } else {
                container.innerHTML = '<table><thead><tr>' + sth('clients','name','Name') + sth('clients','email','Email') + sth('clients','phone','Phone') + sth('clients','city','City, State') + sth('clients','marketingChannel','Marketing Channel') + '<th>Actions</th></tr></thead><tbody>' +
                list.map(c => {
                    const cityState = [c.city, c.state].filter(x => x).join(', ') || (c.address ? c.address.substring(0, 30) : '-');
                    const jobCount = clientJobCounts[String(c.id)] || 0;

                    let nameHtml = '';
                    if (jobCount > 2) {
                        nameHtml = \`<span style="color: #f59e0b; font-size: 1.1rem;">★</span> <strong style="color: #d97706;">\${c.name}</strong> <span style="background: #fbbf24; color: #78350f; padding: 2px 6px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; margin-left: 4px;">\${jobCount}</span>\`;
                    } else if (jobCount === 2) {
                        nameHtml = \`<span style="color: #10b981; font-size: 1.1rem;">★</span> <strong>\${c.name}</strong>\`;
                    } else {
                        nameHtml = \`<strong>\${c.name}</strong>\`;
                    }

                    return \`<tr style="cursor: pointer;" onclick="viewClientDetail('\${c.id}')">
                        <td>\${nameHtml}</td>
                        <td>\${c.email || '-'}</td>
                        <td>\${formatPhoneNumber(c.phone)}</td>
                        <td>\${cityState}</td>
                        <td>\${c.marketingChannel || '-'}</td>
                        <td onclick="event.stopPropagation()">
                            <button class="btn btn-secondary btn-small" onclick="openSMSModal('\${c.phone}', '\${c.id}', null)" title="Send text message">📱</button>
                            <button class="btn btn-secondary btn-small" onclick="editClient('\${c.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Edit</button>
                            <button class="btn btn-danger btn-small" onclick="deleteClient('\${c.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Delete</button>
                        </td>
                    </tr>\`;
                }).join('') +
                '</tbody></table>';
            }
        }

        let serviceLocations = [];
        let expandedLocations = new Set();

        async function prefillStateFromZip(zipInput) {
            const zip = zipInput.value.trim();
            if (zip.length < 5) return;

            const zipCode = zip.substring(0, 5);
            const stateInput = document.getElementById('clientState');
            const cityInput = document.getElementById('clientCity');

            // Only prefill if state is empty
            if (stateInput.value) return;

            try {
                const response = await fetch(\`https://api.zippopotam.us/us/\${zipCode}\`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.places && data.places.length > 0) {
                        stateInput.value = data.places[0]['state abbreviation'];
                        if (!cityInput.value) {
                            cityInput.value = data.places[0]['place name'];
                        }
                    }
                }
            } catch (err) {
                // Silently fail if API is unavailable
            }
        }

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
            expandedLocations.add(id);
            renderServiceLocations();
        }

        function removeServiceLocation(id) {
            serviceLocations = serviceLocations.filter(loc => loc.id !== id);
            expandedLocations.delete(id);
            renderServiceLocations();
        }

        function toggleServiceLocation(id) {
            if (expandedLocations.has(id)) {
                expandedLocations.delete(id);
            } else {
                expandedLocations.add(id);
            }
            renderServiceLocations();
        }

        function renderServiceLocations() {
            const container = document.getElementById('serviceLocationsContainer');

            if (serviceLocations.length === 0) {
                container.innerHTML = '<p style="color: #718096; padding: 1rem; text-align: center;">No service locations added yet.</p>';
                return;
            }

            container.innerHTML = serviceLocations.map((loc, index) => {
                const isExpanded = expandedLocations.has(loc.id);
                const summary = loc.name || loc.address || 'Untitled Location';

                return \`
                <div style="background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.75rem; margin-bottom: 0.75rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="toggleServiceLocation(\${loc.id})">
                        <div style="display: flex; align-items: center; gap: 0.5rem;">
                            <span style="font-size: 1.2rem; user-select: none;">\${isExpanded ? '▼' : '▶'}</span>
                            <strong style="color: #2d3748;">Location #\${index + 1}:</strong>
                            <span style="color: #4a5568;">\${summary}</span>
                        </div>
                        <button type="button" class="btn btn-danger btn-small" onclick="event.stopPropagation(); removeServiceLocation(\${loc.id})">Remove</button>
                    </div>
                    <div id="location-details-\${loc.id}" style="display: \${isExpanded ? 'block' : 'none'}; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #e2e8f0;">
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
                            <label>Invoice / Contact Email</label>
                            <input type="email" placeholder="Invoices for this location go here" onchange="updateServiceLocation(\${loc.id}, 'contactEmail', this.value)" value="\${loc.contactEmail || ''}">
                        </div>
                        <div class="form-group">
                            <label>Notes</label>
                            <textarea onchange="updateServiceLocation(\${loc.id}, 'notes', this.value)" rows="2">\${loc.notes || ''}</textarea>
                        </div>
                    </div>
                </div>
                \`;
            }).join('');
        }

        function updateServiceLocation(id, field, value) {
            const location = serviceLocations.find(loc => loc.id === id);
            if (location) {
                location[field] = value;
            }
        }

        function toggleClientStats() {
            const container = document.getElementById('client-stats-content');
            const icon = document.getElementById('stats-toggle-icon');

            if (container.style.display === 'none') {
                container.style.display = 'block';
                icon.textContent = '▼';
            } else {
                container.style.display = 'none';
                icon.textContent = '▶';
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
                    return \`
                        <div style="padding: 1rem; background: white; border-radius: 8px; border: 1px solid #e2e8f0;">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                                <strong style="color: #667eea;">\${zip}</strong>
                                <span style="font-weight: 600; color: #2d3748;">\${count} client\${count !== 1 ? 's' : ''}</span>
                            </div>
                            <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.5rem;">\${city}</div>
                            <div style="background: #e2e8f0; height: 8px; border-radius: 4px; overflow: hidden;">
                                <div style="background: #667eea; height: 100%; width: \${percentage}%; transition: width 0.3s;"></div>
                            </div>
                        </div>
                    \`;
                }).join('') +
                '</div>';
        }

        function filterClients() {
            const searchTerm = document.getElementById('client-search').value.toLowerCase();
            const filtered = searchTerm
                ? clients.filter(c => (c.name + ' ' + (c.phone || '') + ' ' + (c.email || '') + ' ' + (c.city || '')).toLowerCase().includes(searchTerm))
                : clients;
            renderClientsList(filtered);
        }

        function exportClientsToExcel() {
            // Apply current search filter
            const searchTerm = document.getElementById('client-search').value.toLowerCase();

            const filteredClients = clients.filter(c => {
                if (!searchTerm) return true;
                const searchText = (c.name + ' ' + (c.email || '') + ' ' + (c.phone || '') + ' ' + (c.addressLine1 || '') + ' ' + (c.city || '') + ' ' + (c.state || '')).toLowerCase();
                return searchText.includes(searchTerm);
            });

            if (filteredClients.length === 0) {
                alert('No clients to export');
                return;
            }

            const headers = ['Name', 'Email', 'Phone', 'Address Line 1', 'Address Line 2', 'Address Line 3', 'City', 'State', 'ZIP Code', 'Marketing Channel', 'Notes', 'Date Added'];
            const timestamp = new Date().toISOString().split('T')[0];

            exportToCSV(filteredClients, headers, `clients_export_${timestamp}.csv`, (c) => {
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
                    (c.notes || '').replace(/"/g, '""'),
                    c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''
                ];
            });
        }

        async function viewClientDetail(clientId) {
            const client = clients.find(c => c.id == clientId);
            if (!client) return;
            _currentClientId = clientId;

            // Show client detail view
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('client-detail').classList.add('active');

            // Load time entries for cost calculation
            const timeEntriesResponse = await fetch('/api/timeentries');
            const timeEntries = await timeEntriesResponse.json();

            // Update client info
            document.getElementById('client-detail-name').textContent = client.name;
            document.getElementById('client-detail-info').innerHTML = \`
                <p style="margin-bottom: 0.75rem;"><strong>Email:</strong> \${client.email || 'N/A'}</p>
                <p style="margin-bottom: 0.75rem;"><strong>Phone:</strong> \${formatPhoneNumber(client.phone) || 'N/A'}</p>
                <p style="margin-bottom: 0.75rem;"><strong>Address:</strong><br>\${
                    (client.addressLine1 || client.address)
                        ? [client.addressLine1, client.addressLine2, client.addressLine3, [client.city, client.state].filter(Boolean).join(', '), client.zipCode].filter(Boolean).join('<br>')
                        : (client.address ? client.address.replace(/\\n/g, '<br>') : 'N/A')
                }</p>
                <p style="margin-bottom: 0.75rem;"><strong>Notes:</strong><br>\${client.notes || 'N/A'}</p>
                <p style="margin-bottom: 0.75rem; color: #718096; font-size: 0.875rem;"><strong>Added:</strong> \${new Date(client.createdAt).toLocaleDateString()}</p>
            \`;

            // Load client jobs
            const clientJobs = jobs.filter(j => j.clientId == client.id || String(j.clientId) === String(client.id));
            const jobsContainer = document.getElementById('client-detail-jobs');

            // Calculate client stats
            const totalJobs = clientJobs.length;

            // Debug: log jobs data
            console.log('Client Jobs Data:', clientJobs.map(j => ({
                title: j.title,
                total: j.total,
                laborItems: j.laborItems,
                materialItems: j.materialItems
            })));

            const totalRevenue = clientJobs.reduce((sum, j) => {
                // j.total already includes tax (calculated as subtotal + taxAmount when job is saved)
                const jobTotal = parseFloat(j.total) || 0;
                console.log('Job revenue:', j.title, jobTotal);
                return sum + jobTotal;
            }, 0);

            // Calculate net profit (revenue - material costs - labor payments to workers)
            // Labor items in jobs = what you BILL (revenue, not cost)
            // Material items = actual material costs
            // Real labor costs = approved time entry payments
            const materialCosts = clientJobs.reduce((sum, j) => {
                const materialCost = (j.materialItems || []).reduce((mSum, item) => {
                    const quantity = parseFloat(item.quantity) || 0;
                    const price = parseFloat(item.price) || 0;
                    return mSum + (quantity * price);
                }, 0);
                return sum + materialCost;
            }, 0);

            // Get approved time entries for this client's jobs to calculate actual labor costs
            const clientJobIds = clientJobs.map(j => j.id || j._id).filter(id => id);
            const laborCosts = timeEntries
                .filter(entry =>
                    entry.status === 'approved' &&
                    clientJobIds.includes(entry.jobId)
                )
                .reduce((sum, entry) => sum + (parseFloat(entry.paymentAmount) || 0), 0);

            const totalCosts = materialCosts + laborCosts;
            console.log('Job costs breakdown:', { materialCosts, laborCosts, totalCosts });
            const netProfit = totalRevenue - totalCosts;
            console.log('Client Net Profit Calc:', { totalRevenue, totalCosts, netProfit, jobCount: clientJobs.length });

            const avgJobValue = totalJobs > 0 ? totalRevenue / totalJobs : 0;
            const totalPaid = clientJobs.reduce((sum, j) => sum + (parseFloat(j.totalPaid) || 0), 0);
            const outstanding = totalRevenue - totalPaid;

            // Format client since date
            const clientSince = client.createdAt ? new Date(client.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            }) : '--';

            // Update stats display
            document.getElementById('client-stat-total-jobs').textContent = totalJobs;
            document.getElementById('client-stat-since').textContent = clientSince;
            document.getElementById('client-stat-total-revenue').textContent = formatMoney(totalRevenue);
            document.getElementById('client-stat-net-profit').textContent = formatMoney(netProfit);
            document.getElementById('client-stat-avg-job').textContent = formatMoney(avgJobValue);
            document.getElementById('client-stat-total-paid').textContent = formatMoney(totalPaid);
            document.getElementById('client-stat-outstanding').textContent = formatMoney(outstanding);

            if (clientJobs.length === 0) {
                renderEmptyState(jobsContainer, 'No jobs yet', 'Create a job for this client');
                return;
            }

            jobsContainer.innerHTML = '<table><thead><tr><th>Date</th><th>Job</th><th>Status</th><th>Total</th><th>Actions</th></tr></thead><tbody>' +
                clientJobs.map(j => {
                    // Format date more compactly for mobile
                    const dateObj = new Date(j.scheduledDate);
                    const shortDate = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    return \`<tr>
                        <td data-label="Date">\${shortDate}<br><small>\${j.scheduledTime || ''}</small></td>
                        <td data-label="Job">
                            <strong>\${j.title}</strong><br>
                            <small>\${(j.description || '').substring(0, 50)}</small>
                        </td>
                        <td data-label="Status"><span class="status-badge status-\${j.status}">\${j.status.replace('_', ' ')}</span></td>
                        <td data-label="Total">\${j.totalWithTax ? formatMoney(j.totalWithTax) : (j.total ? formatMoney(calculateTotalWithTax(parseFloat(j.total))) : '-')}</td>
                        <td data-label="Actions">
                            <button class="btn btn-secondary btn-small" onclick='openJobModal(\${JSON.stringify(j).replace(/'/g, "&apos;")})'>Edit</button>
                            <button class="btn btn-primary btn-small" onclick="window.open('/invoice/${j.id}', '_blank')">📄</button>
                        </td>
                    </tr>\`;
                }).join('') +
                '</tbody></table>';
        }

        async function loadJobs() {
            try {
                const response = await fetch('/api/jobs');
                jobs = await response.json();

            // Populate filter dropdowns
            const assignedFilter = document.getElementById('filter-assigned');
            const currentAssigned = assignedFilter.value;
            populateDropdown(assignedFilter, team, 'id', 'name', 'All Team Members');
            assignedFilter.value = currentAssigned;

            renderStatusPills();
            renderJobsTable();
            } catch (error) {
                console.error('Failed to load jobs:', error);
            }
        }

        // ===== QUOTES FUNCTIONS =====

        let quoteLaborItems = [];
        let quoteMaterialItems = [];
        let quoteTouchPoints = [];
        let currentEditingQuoteId = null;

        async function loadQuotes() {
            try {
                const response = await fetch('/api/quotes');
                quotes = await response.json();

                renderQuotesTable();
            } catch (error) {
                console.error('Failed to load quotes:', error);
            }
        }

        async function archiveQuote(id, archive) {
            await fetch(\`/api/quotes/\${id}/archive\`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ archived: archive })
            });
            await loadQuotes();
        }

        function renderQuotesTable() {
            const container = document.getElementById('quotes-list');

            if (quotes.length === 0) {
                renderEmptyState(container, 'No quotes yet', 'Create your first quote to get started');
                return;
            }

            const statusFilter = document.getElementById('filter-quote-status').value;
            const clientFilter = document.getElementById('filter-quote-client').value;

            const allFiltered = quotes.filter(q => {
                if (statusFilter && q.status !== statusFilter) return false;
                if (clientFilter) {
                    const qClient = findClient(q.clientId);
                    if (!qClient || !qClient.name.toLowerCase().includes(clientFilter.toLowerCase())) return false;
                }
                return true;
            });

            let filteredQuotes = allFiltered.filter(q => !q.archived);
            const archivedQuotes = allFiltered.filter(q => q.archived);
            filteredQuotes = applySortState(filteredQuotes, 'quotes', { quoteNumber: 'quoteNumber', client: 'clientId', title: 'title', validUntil: 'validUntil', status: 'status', total: 'total' });

            if (filteredQuotes.length === 0 && archivedQuotes.length === 0) {
                renderEmptyState(container, 'No quotes match filters', 'Try adjusting your filters');
                return;
            }

            const isMobile = window.innerWidth < 768;

            if (isMobile) {
                container.innerHTML = filteredQuotes.map(q => {
                    const client = findClient(q.clientId);
                    const statusClass = q.status === 'approved' ? 'status-completed' :
                                       q.status === 'in_review' ? 'status-scheduled' :
                                       q.status === 'rejected' ? 'status-bid_lost' :
                                       q.status === 'expired' ? 'status-bid_lost' :
                                       q.status === 'sent' ? 'status-in_progress' : 'status-prospecting';
                    const validUntil = new Date(q.validUntil);
                    const isExpired = validUntil < new Date() && q.status === 'sent';

                    return \`<div style="background:white;border:2px solid #e2e8f0;border-radius:10px;padding:1rem;margin-bottom:0.75rem;">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.4rem;">
                            <div>
                                <div style="font-size:1.1rem;font-weight:700;color:#2d3748;">\${maskName(client ? client.name : 'Unknown')}</div>
                                <div style="font-weight:600;color:#4a5568;margin-top:0.15rem;">\${q.title}</div>
                            </div>
                            <span class="status-badge \${statusClass}" style="white-space:nowrap;margin-left:0.5rem;">\${q.status.replace('_', ' ')}</span>
                        </div>
                        <div style="color:#718096;font-size:0.85rem;margin-bottom:0.4rem;">
                            #\${q.quoteNumber} · Valid: \${q.validUntil}\${isExpired ? ' <span style="color:#e53e3e;">(Expired)</span>' : ''}\${q.priority ? ' · ' + ({urgent:'🔴 Urgent','1_day':'🟠 1 Day','3_days':'🟡 3 Days','1_week':'🟢 1 Week','2_weeks':'🔵 2 Weeks',flexible:'⚪ Flexible'}[q.priority] || q.priority) : ''}
                        </div>
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
                            <div style="font-size:1rem;font-weight:700;color:#2d3748;">\${formatMoney(parseFloat(q.total || 0))}</div>
                            <div style="font-size:0.78rem;text-align:right;">
                                \${q.sentAt ? \`<div style="color:#4a5568;">📧 \${new Date(q.sentAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>\` : ''}
                                \${q.viewCount > 0 ? \`<button onclick="showQuoteViewLog('\${q.id}')" style="background:none;border:none;color:#667eea;cursor:pointer;padding:0;font-size:0.78rem;">👁 \${q.viewCount} view\${q.viewCount>1?'s':''}</button>\` : (q.sentAt ? \`<div style="color:#9ca3af;">Not opened</div>\` : '')}
                            </div>
                        </div>
                        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                            <button class="btn btn-secondary btn-small" onclick="editQuote('\${q.id}')">Edit</button>
                            <button class="btn btn-primary btn-small" onclick="window.open('/quote-view/\${q.secureToken}', '_blank')">📄 View</button>
                            \${q.status === 'draft' || q.status === 'sent' ? \`<button class="btn btn-secondary btn-small" onclick="emailQuote('\${q.id}')">📧 Email</button>\` : ''}
                            \${(q.status === 'approved' || q.status === 'in_review') && !q.convertedToJobId ? \`<button class="btn btn-success btn-small" onclick="convertQuoteToJob('\${q.id}')">➡️ Job</button>\` : ''}
                            \${q.convertedToJobId ? \`<span style="color:#48bb78;font-size:0.85rem;">✓ Converted</span>\` : ''}
                            <button class="btn btn-secondary btn-small" onclick="archiveQuote('\${q.id}', true)">📦</button>
                            <button class="btn btn-danger btn-small" onclick="deleteQuote('\${q.id}')">Delete</button>
                        </div>
                    </div>\`;
                }).join('');
            } else {
                container.innerHTML = '<table><thead><tr>' + sth('quotes','quoteNumber','Quote #') + sth('quotes','clientId','Client') + sth('quotes','title','Title') + sth('quotes','validUntil','Valid Until') + sth('quotes','status','Status') + sth('quotes','total','Total') + '<th>Activity</th><th>Actions</th></tr></thead><tbody>' +
                filteredQuotes.map(q => {
                    const client = findClient(q.clientId);
                    const statusClass = q.status === 'approved' ? 'status-completed' :
                                       q.status === 'in_review' ? 'status-scheduled' :
                                       q.status === 'rejected' ? 'status-bid_lost' :
                                       q.status === 'expired' ? 'status-bid_lost' :
                                       q.status === 'sent' ? 'status-in_progress' : 'status-prospecting';

                    const validUntil = new Date(q.validUntil);
                    const isExpired = validUntil < new Date() && q.status === 'sent';

                    return \`<tr>
                        <td>\${q.quoteNumber}</td>
                        <td>\${maskName(client ? client.name : 'Unknown')}</td>
                        <td><strong>\${q.title}</strong>\${q.priority ? ' <span style="font-size:0.8rem;color:#718096;">' + ({urgent:'🔴 Urgent','1_day':'🟠 1 Day','3_days':'🟡 3 Days','1_week':'🟢 1 Week','2_weeks':'🔵 2 Weeks',flexible:'⚪ Flexible'}[q.priority] || q.priority) + '</span>' : ''}</td>
                        <td>\${q.validUntil}\${isExpired ? ' <span style="color: #e53e3e;">(Expired)</span>' : ''}</td>
                        <td><span class="status-badge \${statusClass}">\${q.status.replace('_', ' ')}</span></td>
                        <td>\${formatMoney(parseFloat(q.total || 0))}</td>
                        <td style="font-size:0.8rem;white-space:nowrap;">
                            \${q.sentAt ? \`<div style="color:#4a5568;">📧 \${new Date(q.sentAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>\` : ''}
                            \${q.viewCount > 0 ? \`<div><button onclick="showQuoteViewLog('\${q.id}')" style="background:none;border:none;color:#667eea;cursor:pointer;padding:0;font-size:0.8rem;">👁 \${q.viewCount} view\${q.viewCount>1?'s':''} · \${new Date(q.firstViewedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</button></div>\` : (q.sentAt ? \`<div style="color:#9ca3af;">Not opened</div>\` : '')}
                        </td>
                        <td>
                            <button class="btn btn-secondary btn-small" onclick="editQuote('\${q.id}')">Edit</button>
                            <button class="btn btn-primary btn-small" onclick="window.open('/quote-view/\${q.secureToken}', '_blank')">📄 View</button>
                            \${q.status === 'draft' || q.status === 'sent' ? \`<button class="btn btn-secondary btn-small" onclick="emailQuote('\${q.id}')" title="Email quote to client">📧 Email</button>\` : ''}
                            \${(q.status === 'approved' || q.status === 'in_review') && !q.convertedToJobId ? \`<button class="btn btn-success btn-small" onclick="convertQuoteToJob('\${q.id}')">➡️ Convert to Job</button>\` : ''}
                            \${q.convertedToJobId ? \`<span style="color: #48bb78;">✓ Converted</span>\` : ''}
                            <button class="btn btn-secondary btn-small" onclick="archiveQuote('\${q.id}', true)" title="Archive">📦 Archive</button>
                            <button class="btn btn-danger btn-small" onclick="deleteQuote('\${q.id}')">Delete</button>
                        </td>
                    </tr>\`;
                }).join('') +
                '</tbody></table>';
            }

            // Archive section
            if (archivedQuotes.length > 0) {
                const archiveHtml = isMobile
                    ? archivedQuotes.map(q => {
                        const client = findClient(q.clientId);
                        const statusClass = q.status === 'approved' ? 'status-completed' : q.status === 'rejected' ? 'status-bid_lost' : 'status-prospecting';
                        return \`<div style="background:#f9fafb;border:1px solid #e2e8f0;border-radius:10px;padding:0.75rem;margin-bottom:0.5rem;opacity:0.8;">
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <div>
                                    <div style="font-weight:700;color:#4a5568;">\${maskName(client ? client.name : 'Unknown')} — \${q.title}</div>
                                    <div style="font-size:0.8rem;color:#9ca3af;">#\${q.quoteNumber} · \${formatMoney(parseFloat(q.total||0))}</div>
                                </div>
                                <span class="status-badge \${statusClass}">\${q.status.replace('_',' ')}</span>
                            </div>
                            <div style="margin-top:0.5rem;display:flex;gap:0.5rem;">
                                <button class="btn btn-secondary btn-small" onclick="archiveQuote('\${q.id}', false)">Unarchive</button>
                                <button class="btn btn-danger btn-small" onclick="deleteQuote('\${q.id}')">Delete</button>
                            </div>
                        </div>\`;
                    }).join('')
                    : '<table><thead><tr>' + sth('quotes','quoteNumber','Quote #') + sth('quotes','clientId','Client') + sth('quotes','title','Title') + sth('quotes','status','Status') + sth('quotes','total','Total') + '<th>Actions</th></tr></thead><tbody>' +
                      archivedQuotes.map(q => {
                          const client = findClient(q.clientId);
                          const statusClass = q.status === 'approved' ? 'status-completed' : q.status === 'rejected' ? 'status-bid_lost' : 'status-prospecting';
                          return \`<tr style="opacity:0.7;">
                              <td>\${q.quoteNumber}</td>
                              <td>\${maskName(client ? client.name : 'Unknown')}</td>
                              <td>\${q.title}</td>
                              <td><span class="status-badge \${statusClass}">\${q.status.replace('_',' ')}</span></td>
                              <td>\${formatMoney(parseFloat(q.total||0))}</td>
                              <td>
                                  <button class="btn btn-secondary btn-small" onclick="window.open('/quote-view/\${q.secureToken}', '_blank')">📄 View</button>
                                  <button class="btn btn-secondary btn-small" onclick="archiveQuote('\${q.id}', false)">Unarchive</button>
                                  <button class="btn btn-danger btn-small" onclick="deleteQuote('\${q.id}')">Delete</button>
                              </td>
                          </tr>\`;
                      }).join('') + '</tbody></table>';

                container.innerHTML += \`
                    <details style="margin-top:1.5rem;" open>
                        <summary style="cursor:pointer;font-weight:700;color:#4a5568;padding:0.75rem;background:#f1f5f9;border-radius:8px;list-style:none;display:flex;align-items:center;gap:0.5rem;">
                            <span>▶</span> Archive <span style="background:#9ca3af;color:white;border-radius:999px;padding:1px 8px;font-size:0.75rem;font-weight:600;">\${archivedQuotes.length}</span>
                        </summary>
                        <div style="margin-top:0.75rem;">\${archiveHtml}</div>
                    </details>\`;

                // Rotate arrow on open
                container.querySelector('details').addEventListener('toggle', function() {
                    this.querySelector('span').textContent = this.open ? '▼' : '▶';
                });
            }
        }

        async function showQuoteViewLog(quoteId) {
            const content = document.getElementById('viewLogContent');
            content.innerHTML = '<p style="color:#718096;text-align:center;padding:1rem;">Loading…</p>';
            openModal('viewLogModal');
            try {
                const res = await fetch(\`/api/quotes/\${quoteId}/view-log\`);
                const log = await res.json();
                if (!Array.isArray(log) || log.length === 0) {
                    content.innerHTML = '<p style="color:#718096;text-align:center;padding:1rem;">No detailed view history available.<br><small>Views recorded before this feature was added only show a count.</small></p>';
                    return;
                }
                content.innerHTML = \`
                    <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
                        <thead>
                            <tr style="border-bottom:2px solid #e2e8f0;">
                                <th style="text-align:left;padding:0.5rem 0.75rem;color:#4a5568;">#</th>
                                <th style="text-align:left;padding:0.5rem 0.75rem;color:#4a5568;">Date & Time</th>
                                <th style="text-align:left;padding:0.5rem 0.75rem;color:#4a5568;">IP Address</th>
                            </tr>
                        </thead>
                        <tbody>
                            \${log.map((v, i) => \`
                                <tr style="border-bottom:1px solid #f0f0f0;">
                                    <td style="padding:0.6rem 0.75rem;color:#9ca3af;">\${i + 1}</td>
                                    <td style="padding:0.6rem 0.75rem;color:#2d3748;">\${new Date(v.at).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true})}</td>
                                    <td style="padding:0.6rem 0.75rem;color:#4a5568;font-family:monospace;">\${v.ip || '—'}</td>
                                </tr>\`).join('')}
                        </tbody>
                    </table>\`;
            } catch (e) {
                content.innerHTML = '<p style="color:#e53e3e;text-align:center;padding:1rem;">Failed to load view history.</p>';
            }
        }

        async function showInvoiceViewLog(jobId) {
            const content = document.getElementById('viewLogContent');
            content.innerHTML = '<p style="color:#718096;text-align:center;padding:1rem;">Loading…</p>';
            openModal('viewLogModal');
            try {
                const res = await fetch(\`/api/jobs/\${jobId}/invoice-view-log\`);
                const log = await res.json();
                if (!Array.isArray(log) || log.length === 0) {
                    content.innerHTML = '<p style="color:#718096;text-align:center;padding:1rem;">No detailed view history available.<br><small>Views recorded before this feature was added only show a count.</small></p>';
                    return;
                }
                content.innerHTML = \`
                    <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
                        <thead>
                            <tr style="border-bottom:2px solid #e2e8f0;">
                                <th style="text-align:left;padding:0.5rem 0.75rem;color:#4a5568;">#</th>
                                <th style="text-align:left;padding:0.5rem 0.75rem;color:#4a5568;">Date & Time</th>
                                <th style="text-align:left;padding:0.5rem 0.75rem;color:#4a5568;">IP Address</th>
                            </tr>
                        </thead>
                        <tbody>
                            \${log.map((v, i) => \`
                                <tr style="border-bottom:1px solid #f0f0f0;">
                                    <td style="padding:0.6rem 0.75rem;color:#9ca3af;">\${i + 1}</td>
                                    <td style="padding:0.6rem 0.75rem;color:#2d3748;">\${new Date(v.at).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true})}</td>
                                    <td style="padding:0.6rem 0.75rem;color:#4a5568;font-family:monospace;">\${v.ip || '—'}</td>
                                </tr>\`).join('')}
                        </tbody>
                    </table>\`;
            } catch (e) {
                content.innerHTML = '<p style="color:#e53e3e;text-align:center;padding:1rem;">Failed to load view history.</p>';
            }
        }

        const PAY_ERROR_GUIDE = {
            card_declined:            { label: 'Card Declined',          fix: 'Ask client to contact their bank or try a different card.' },
            insufficient_funds:       { label: 'Insufficient Funds',     fix: 'Balance too low. Have them try a smaller deposit or a different card.' },
            incorrect_number:         { label: 'Wrong Card Number',      fix: 'Card number was mistyped. Have client re-enter carefully.' },
            invalid_number:           { label: 'Invalid Card Number',    fix: 'Card number failed the checksum. Client should double-check the number.' },
            expired_card:             { label: 'Expired Card',           fix: 'Card is expired. Client needs to use a current card.' },
            invalid_expiry_month:     { label: 'Bad Expiry Month',       fix: 'Expiry month entered incorrectly (use MM format, e.g. 03).' },
            invalid_expiry_year:      { label: 'Bad Expiry Year',        fix: 'Expiry year entered incorrectly. Check the date on the front of the card.' },
            incorrect_cvc:            { label: 'Wrong CVV',              fix: '3-digit code on the back (or 4-digit on front for Amex) was wrong.' },
            do_not_honor:             { label: 'Do Not Honor',           fix: 'Bank declined with no specific reason. Client should call the number on the back of their card.' },
            processing_error:         { label: 'Processing Error',       fix: 'Temporary issue with Clover. Have the client wait a minute and try again.' },
            authentication_required:  { label: 'Auth Required',          fix: 'Bank requires additional verification. Client should try again or use a different card.' },
            server_error:             { label: 'Server Error',           fix: 'Something went wrong on our end. Check Heroku logs or try again.' },
            unknown:                  { label: 'Unknown Error',          fix: 'Review the full error message below. If recurring, check Clover dashboard.' }
        };

        async function showPayDiag(jobId) {
            const content = document.getElementById('payDiagContent');
            content.innerHTML = '<p style="color:#718096;text-align:center;padding:1.5rem;">Loading…</p>';
            openModal('payDiagModal');
            try {
                const res = await fetch(\`/api/jobs/\${jobId}/payment-attempts\`);
                const attempts = await res.json();

                if (!attempts.length) {
                    content.innerHTML = \`
                        <p style="color:#718096;text-align:center;padding:1rem;margin-bottom:1.5rem;">No payment attempts recorded yet for this invoice.</p>
                        \${troubleshootingGuide(null)}\`;
                    return;
                }

                const lastFail = attempts.find(a => !a.success);
                const rows = attempts.map((a, i) => {
                    const icon = a.success ? '✅' : '❌';
                    const guide = !a.success ? PAY_ERROR_GUIDE[a.errorCode] || PAY_ERROR_GUIDE.unknown : null;
                    return \`<tr style="border-bottom:1px solid #f1f5f9;vertical-align:top;">
                        <td style="padding:0.65rem 0.75rem;color:#94a3b8;font-size:0.8rem;">\${icon}</td>
                        <td style="padding:0.65rem 0.75rem;font-size:0.82rem;color:#1e293b;">
                            \${new Date(a.at).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true})}
                        </td>
                        <td style="padding:0.65rem 0.75rem;font-size:0.82rem;color:#1e293b;">$\${(a.amount||0).toFixed(2)}</td>
                        <td style="padding:0.65rem 0.75rem;font-size:0.82rem;">
                            \${a.success
                                ? \`<span style="color:#16a34a;font-weight:600;">Approved</span>\${a.last4 ? \`<span style="color:#64748b;font-size:0.78rem;margin-left:0.4rem;">••••\${a.last4}</span>\` : ''}<br><span style="color:#94a3b8;font-family:monospace;font-size:0.75rem;">\${a.chargeId||''}</span>\`
                                : \`<span style="color:#dc2626;font-weight:600;">\${guide ? guide.label : 'Failed'}</span><br><span style="color:#64748b;font-size:0.78rem;">\${a.error||''}</span>\`}
                        </td>
                        <td style="padding:0.65rem 0.75rem;font-family:monospace;font-size:0.75rem;color:#64748b;">\${a.ip||'—'}</td>
                    </tr>\`;
                }).join('');

                content.innerHTML = \`
                    <div style="overflow-x:auto;margin-bottom:1.5rem;">
                        <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
                            <thead>
                                <tr style="border-bottom:2px solid #e2e8f0;background:#f8fafc;">
                                    <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.05em;width:2rem;"></th>
                                    <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.05em;">Time</th>
                                    <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.05em;">Amount</th>
                                    <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.05em;">Result / Charge ID</th>
                                    <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.05em;">IP</th>
                                </tr>
                            </thead>
                            <tbody>\${rows}</tbody>
                        </table>
                    </div>
                    \${troubleshootingGuide(lastFail)}\`;
            } catch (e) {
                content.innerHTML = '<p style="color:#dc2626;text-align:center;padding:1rem;">Failed to load payment diagnostics.</p>';
            }
        }

        function troubleshootingGuide(lastFail) {
            const guide = lastFail ? (PAY_ERROR_GUIDE[lastFail.errorCode] || PAY_ERROR_GUIDE.unknown) : null;
            const specific = guide ? \`
                <div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:0.875rem 1rem;margin-bottom:1rem;">
                    <p style="font-weight:700;color:#854d0e;margin-bottom:0.25rem;">⚠️ Most recent failure: \${guide.label}</p>
                    <p style="color:#92400e;font-size:0.875rem;">\${guide.fix}</p>
                </div>\` : '';
            return \`
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:1.1rem 1.25rem;">
                    <p style="font-weight:700;color:#1e293b;margin-bottom:0.75rem;">🔧 Troubleshooting Checklist</p>
                    \${specific}
                    <ol style="margin:0 0 0 1.25rem;color:#475569;font-size:0.875rem;line-height:1.8;">
                        <li>Have the client <strong>refresh the invoice page</strong> and try again.</li>
                        <li>Confirm the card number, expiry, CVV, and ZIP are all correct.</li>
                        <li>Ask if their bank has <strong>online or card-not-present purchases enabled</strong>.</li>
                        <li>Try a <strong>different card</strong> (debit vs credit, different issuer).</li>
                        <li>Check that the <strong>payment amount isn't over the balance</strong> owed.</li>
                        <li>If repeated failures, have them <strong>call the number on the back of their card</strong>.</li>
                        <li>As a last resort, collect payment <strong>in person or by phone</strong> using your Clover device.</li>
                    </ol>
                </div>\`;
        }

        function filterQuotes() {
            renderQuotesTable();
        }

        function clearQuoteFilters() {
            document.getElementById('filter-quote-status').value = '';
            document.getElementById('filter-quote-client').value = '';
            renderQuotesTable();
        }

        function showAddQuoteModal() {
            currentEditingQuoteId = null;
            document.getElementById('quoteModalTitle').textContent = 'Create Quote';
            document.getElementById('quoteForm').reset();

            // Clear line items
            quoteLaborItems = [];
            quoteMaterialItems = [];
            renderQuoteLaborItems();
            renderQuoteMaterialItems();

            // Clear client typeahead
            document.getElementById('quoteClientInput').value = '';
            document.getElementById('quoteClientSelect').value = '';
            quoteTouchPoints = [];
            renderQuoteTouchPoints();

            // Set default valid until date (30 days from now)
            const defaultValidUntil = new Date();
            defaultValidUntil.setDate(defaultValidUntil.getDate() + 30);
            document.querySelector('[name="validUntil"]').value = defaultValidUntil.toISOString().split('T')[0];

            updateQuoteTotal();
            document.getElementById('quoteModal').classList.add('active');
            markFormClean('quoteForm');
        }

        function handleQuoteClientChange() {
            const clientId = document.getElementById('quoteClientSelect').value;
            const client = clients.find(c => (c.id == clientId || c._id == clientId));

            const serviceLocationGroup = document.getElementById('quoteServiceLocationGroup');
            const serviceLocationSelect = document.getElementById('quoteServiceLocationSelect');

            if (client && client.serviceLocations && client.serviceLocations.length > 0) {
                serviceLocationGroup.style.display = 'block';
                serviceLocationSelect.innerHTML = '<option value="">Primary address</option>' +
                    client.serviceLocations.map((loc, idx) =>
                        \`<option value="\${idx}">\${loc.name || 'Location ' + (idx + 1)}</option>\`
                    ).join('');
            } else {
                serviceLocationGroup.style.display = 'none';
            }
        }

        function addQuoteTouchPoint() {
            const input = document.getElementById('newQuoteTouchPoint');
            const noteText = input.value.trim();
            if (!noteText) return;
            quoteTouchPoints.push({ id: Date.now(), note: noteText, timestamp: new Date().toISOString(), user: document.getElementById('currentUserName').textContent });
            input.value = '';
            renderQuoteTouchPoints();
            markFormDirty();
        }

        function removeQuoteTouchPoint(id) {
            if (confirm('Remove this touch point?')) {
                quoteTouchPoints = quoteTouchPoints.filter(tp => tp.id !== id);
                renderQuoteTouchPoints();
                markFormDirty();
            }
        }

        function renderQuoteTouchPoints() {
            const container = document.getElementById('quoteTouchPointsList');
            if (!container) return;
            if (quoteTouchPoints.length === 0) {
                container.innerHTML = '<p style="color:#718096;font-style:italic;">No touch points yet. Add notes to track communications and updates.</p>';
                return;
            }
            container.innerHTML = quoteTouchPoints.slice().reverse().map(tp =>
                \`<div style="background:#f7fafc;border-left:3px solid #667eea;padding:0.75rem;margin-bottom:0.5rem;border-radius:4px;">
                    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem;">
                        <div style="font-size:0.85rem;color:#4a5568;"><strong>\${tp.user}</strong> · \${new Date(tp.timestamp).toLocaleString()}</div>
                        <button type="button" onclick="removeQuoteTouchPoint(\${tp.id})" style="background:transparent;border:none;color:#e53e3e;cursor:pointer;padding:0;font-size:1.2rem;line-height:1;">&times;</button>
                    </div>
                    <div style="color:#1a202c;">\${tp.note}</div>
                </div>\`
            ).join('');
        }

        function filterQuoteClientTypeahead() {
            const q = document.getElementById('quoteClientInput').value.toLowerCase();
            const dropdown = document.getElementById('quoteClientTypeaheadDropdown');
            const matches = q
                ? clients.filter(c => c.name.toLowerCase().includes(q) || (c.phone || '').includes(q))
                : clients;

            if (matches.length === 0) {
                dropdown.innerHTML = '<div style="padding:0.75rem 1rem;color:#718096;">No clients found</div>';
            } else {
                dropdown.innerHTML = matches.slice(0, 20).map(c => {
                    const phone = c.phone ? ' — ' + c.phone : '';
                    return '<div onmousedown="selectQuoteClient(\'' + c.id + '\')" style="padding:0.75rem 1rem;cursor:pointer;border-bottom:1px solid #f0f0f0;" onmouseover="this.style.background=\'#f0f4ff\'" onmouseout="this.style.background=\'\'"><span style="font-weight:500;">' + c.name + '</span><span style="color:#a0aec0;font-size:0.85rem;">' + phone + '</span></div>';
                }).join('');
            }
            dropdown.style.display = 'block';
        }

        function selectQuoteClient(clientId) {
            const client = clients.find(c => c.id == clientId);
            document.getElementById('quoteClientSelect').value = clientId;
            document.getElementById('quoteClientInput').value = client ? client.name : '';
            document.getElementById('quoteClientTypeaheadDropdown').style.display = 'none';
            handleQuoteClientChange();
        }

        function setQuoteClientById(clientId) {
            const client = clients.find(c => c.id == clientId || c._id == clientId);
            document.getElementById('quoteClientSelect').value = clientId;
            document.getElementById('quoteClientInput').value = client ? client.name : '';
            document.getElementById('quoteClientTypeaheadDropdown').style.display = 'none';
            handleQuoteClientChange();
        }

        function exportTaxPrep() {
            const year = new Date().getFullYear();
            window.location.href = `/api/export/tax-prep?year=${year}`;
        }

        let _upsellTimer;
        function debounceUpsell(val) {
            clearTimeout(_upsellTimer);
            const el = document.getElementById('upsellSuggestions');
            if (!el) return;
            if (val.length < 4) { el.style.display = 'none'; return; }
            _upsellTimer = setTimeout(() => fetchUpsellSuggestions(val), 600);
        }
        async function fetchUpsellSuggestions(title) {
            try {
                const res = await fetch(`/api/quotes/upsell-suggestions?title=${encodeURIComponent(title)}`);
                const { suggestions } = await res.json();
                const el = document.getElementById('upsellSuggestions');
                if (!el) return;
                if (!suggestions || suggestions.length === 0) { el.style.display = 'none'; return; }
                el.style.display = 'block';
                el.innerHTML = `<div style="background:#fffbeb;border:1.5px solid #fde68a;border-radius:8px;padding:0.6rem 0.9rem;font-size:0.82rem;margin-top:0.5rem;">
                    💡 <strong>Often paired with this job:</strong> ${suggestions.map(s => `<span style="background:#fef3c7;border-radius:4px;padding:2px 7px;margin:0 3px;cursor:pointer;" onclick="addSuggestedQuoteItem('${s.desc.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">` + s.desc + ` (${s.pct}%)</span>`).join('')}
                </div>`;
            } catch(e) {}
        }
        function addSuggestedQuoteItem(desc) {
            addQuoteLaborItem();
            const items = document.querySelectorAll('#quoteLaborItems input[placeholder="Description"]');
            if (items.length) items[items.length - 1].value = desc;
            const idx = quoteLaborItems.length - 1;
            if (idx >= 0) quoteLaborItems[idx].description = desc;
        }

        function addQuoteLaborItem() {
            quoteLaborItems.push({ description: '', hours: 0, rate: 0 });
            renderQuoteLaborItems();
            updateQuoteTotal();
        }

        function addQuoteMaterialItem() {
            quoteMaterialItems.push({ description: '', quantity: 0, price: 0 });
            renderQuoteMaterialItems();
            updateQuoteTotal();
        }

        function renderQuoteLaborItems() {
            const container = document.getElementById('quoteLaborItems');
            container.innerHTML = quoteLaborItems.map((item, index) => \`
                <div style="display: grid; grid-template-columns: 2fr 1fr 1fr auto; gap: 0.5rem; margin-bottom: 0.5rem; align-items: end;">
                    <input type="text" placeholder="Description" value="\${item.description}" onchange="quoteLaborItems[\${index}].description = this.value; updateQuoteTotal()" style="padding: 0.5rem;">
                    <input type="number" placeholder="Hours" value="\${item.hours}" onchange="quoteLaborItems[\${index}].hours = parseFloat(this.value) || 0; updateQuoteTotal()" step="0.25" style="padding: 0.5rem;">
                    <input type="number" placeholder="Rate" value="\${item.rate}" onchange="quoteLaborItems[\${index}].rate = parseFloat(this.value) || 0; updateQuoteTotal()" step="0.01" style="padding: 0.5rem;">
                    <button type="button" class="btn btn-danger btn-small" onclick="quoteLaborItems.splice(\${index}, 1); renderQuoteLaborItems(); updateQuoteTotal()">Remove</button>
                </div>
            \`).join('');
        }

        function renderQuoteMaterialItems() {
            const container = document.getElementById('quoteMaterialItems');
            container.innerHTML = quoteMaterialItems.map((item, index) => \`
                <div style="display: grid; grid-template-columns: 2fr 1fr 1fr auto; gap: 0.5rem; margin-bottom: 0.5rem; align-items: end;">
                    <input type="text" placeholder="Description" value="\${item.description}" onchange="quoteMaterialItems[\${index}].description = this.value; updateQuoteTotal()" style="padding: 0.5rem;">
                    <input type="number" placeholder="Qty" value="\${item.quantity}" onchange="quoteMaterialItems[\${index}].quantity = parseFloat(this.value) || 0; updateQuoteTotal()" step="1" style="padding: 0.5rem;">
                    <input type="number" placeholder="Price" value="\${item.price}" onchange="quoteMaterialItems[\${index}].price = parseFloat(this.value) || 0; updateQuoteTotal()" step="0.01" style="padding: 0.5rem;">
                    <button type="button" class="btn btn-danger btn-small" onclick="quoteMaterialItems.splice(\${index}, 1); renderQuoteMaterialItems(); updateQuoteTotal()">Remove</button>
                </div>
            \`).join('');
        }

        function updateQuoteTotal() {
            const laborTotal = quoteLaborItems.reduce((sum, item) => sum + (item.hours * item.rate), 0);
            const materialTotal = quoteMaterialItems.reduce((sum, item) => sum + (item.quantity * item.price), 0);
            const subtotal = laborTotal + materialTotal;

            const taxWaived = document.getElementById('quoteTaxWaivedCheckbox').checked;
            const taxRate = settings.taxRate || 0.06625;
            const taxAmount = taxWaived ? 0 : subtotal * taxRate;
            const total = subtotal + taxAmount;

            document.getElementById('quoteSubtotal').textContent = subtotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('quoteTax').textContent = taxAmount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('quoteTotal').textContent = total.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
        }

        async function saveQuote() {
            const form = document.getElementById('quoteForm');
            const formData = new FormData(form);
            const quote = Object.fromEntries(formData);

            if (currentEditingQuoteId) {
                quote._id = currentEditingQuoteId;
            }

            quote.laborItems = quoteLaborItems;
            quote.materialItems = quoteMaterialItems;
            quote.taxWaived = document.getElementById('quoteTaxWaivedCheckbox').checked;

            const laborTotal = quoteLaborItems.reduce((sum, item) => sum + (item.hours * item.rate), 0);
            const materialTotal = quoteMaterialItems.reduce((sum, item) => sum + (item.quantity * item.price), 0);
            const subtotal = laborTotal + materialTotal;
            const taxRate = settings.taxRate || 0.06625;
            const taxAmount = quote.taxWaived ? 0 : subtotal * taxRate;

            quote.subtotal = subtotal;
            quote.taxAmount = taxAmount;
            quote.total = subtotal + taxAmount;
            quote.touchPoints = quoteTouchPoints;

            try {
                await postData('/api/quotes', quote, {
                    markClean: true,
                    closeModal: 'quoteModal',
                    reload: loadQuotes
                });
            } catch (error) {
                alert('Failed to save quote: ' + error.message);
            }
        }

        async function editQuote(quoteId) {
            const quote = quotes.find(q => q.id == quoteId || q._id == quoteId);
            if (!quote) {
                alert('Quote not found');
                return;
            }

            currentEditingQuoteId = quote.id || quote._id;
            document.getElementById('quoteModalTitle').textContent = 'Edit Quote';

            // Populate form
            const form = document.getElementById('quoteForm');
            form.elements.quoteNumber.value = quote.quoteNumber || '';
            // Set client typeahead
            if (quote.clientId) {
                setQuoteClientById(quote.clientId);
            } else {
                document.getElementById('quoteClientInput').value = '';
                document.getElementById('quoteClientSelect').value = '';
            }
            form.elements.title.value = quote.title;
            form.elements.description.value = quote.description || '';
            form.elements.validUntil.value = quote.validUntil;
            form.elements.status.value = quote.status;
            form.elements.notes.value = quote.notes || '';
            form.elements.clientNotes.value = quote.clientNotes || '';
            document.getElementById('quoteTaxWaivedCheckbox').checked = quote.taxWaived || false;

            // Load line items
            quoteLaborItems = quote.laborItems || [];
            quoteMaterialItems = quote.materialItems || [];

            renderQuoteLaborItems();
            renderQuoteMaterialItems();
            handleQuoteClientChange();

            if (quote.serviceLocationId) {
                form.elements.serviceLocationId.value = quote.serviceLocationId;
            }

            updateQuoteTotal();

            quoteTouchPoints = quote.touchPoints ? [...quote.touchPoints] : [];
            renderQuoteTouchPoints();

            // Show and populate audit log if exists
            if (quote.auditLog && quote.auditLog.length > 0) {
                document.getElementById('quoteAuditLogSection').style.display = 'block';
                const auditLogHtml = quote.auditLog
                    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                    .map(entry => {
                        const date = new Date(entry.timestamp);
                        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
                        const actionColor = entry.action === 'created' ? '#48bb78' :
                                          entry.action === 'sent_email' ? '#4299e1' :
                                          entry.action === 'converted_to_job' ? '#9f7aea' :
                                          entry.action === 'status_change' ? '#ed8936' : '#718096';
                        return `
                            <div style="padding: 1rem; margin-bottom: 0.75rem; background: #f7fafc; border-left: 4px solid ${actionColor}; border-radius: 4px;">
                                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                                    <strong style="color: ${actionColor};">${entry.action.replace(/_/g, ' ').toUpperCase()}</strong>
                                    <span style="color: #718096; font-size: 0.875rem;">${dateStr}</span>
                                </div>
                                <div style="color: #4a5568; font-size: 0.9rem;">${entry.note}</div>
                                <div style="color: #a0aec0; font-size: 0.8rem; margin-top: 0.25rem;">by ${entry.userName}</div>
                            </div>
                        `;
                    }).join('');
                document.getElementById('quoteAuditLog').innerHTML = auditLogHtml;
            } else {
                document.getElementById('quoteAuditLogSection').style.display = 'none';
            }

            // Photos section
            document.getElementById('quotePhotoUploadStatus').style.display = 'none';
            loadQuotePhotos(quote.id);

            document.getElementById('quoteModal').classList.add('active');
            markFormClean('quoteForm');
        }

        function loadQuotePhotos(quoteId) {
            const grid = document.getElementById('quotePhotoGrid');
            grid.innerHTML = '<div style="color:#718096;font-size:0.85rem;">Loading...</div>';
            fetch(\`/api/quotes/\${quoteId}/photos\`)
                .then(r => r.json())
                .then(data => {
                    const photos = data.photos || [];
                    grid.innerHTML = photos.length
                        ? photos.map((url, i) => \`
                            <div style="position:relative;display:inline-block;">
                                <a href="\${url}" target="_blank"><img src="\${url}" style="width:110px;height:85px;object-fit:cover;border-radius:6px;border:2px solid #e2e8f0;display:block;" title="Click to open full size"></a>
                                <button onclick="deleteQuotePhoto(\${i})" style="position:absolute;top:-6px;right:-6px;background:#e53e3e;color:white;border:none;border-radius:50%;width:20px;height:20px;cursor:pointer;font-size:0.75rem;line-height:20px;padding:0;" title="Remove">✕</button>
                            </div>\`).join('')
                        : '<div style="color:#a0aec0;font-size:0.85rem;">No photos yet</div>';
                })
                .catch(() => { grid.innerHTML = '<div style="color:#e53e3e;">Failed to load</div>'; });
        }

        async function handleQuotePhotoUpload(event) {
            const files = Array.from(event.target.files);
            event.target.value = '';
            if (!files.length) return;
            const status = document.getElementById('quotePhotoUploadStatus');
            status.style.display = 'block';
            status.textContent = \`Uploading \${files.length} photo\${files.length > 1 ? 's' : ''}...\`;

            const dataUrls = await Promise.all(files.map(f => new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = e => {
                    // Compress via canvas
                    const img = new Image();
                    img.onload = () => {
                        const MAX = 1200;
                        let w = img.width, h = img.height;
                        if (w > MAX || h > MAX) { if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; } }
                        const canvas = document.createElement('canvas');
                        canvas.width = w; canvas.height = h;
                        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                        resolve(canvas.toDataURL('image/jpeg', 0.82));
                    };
                    img.src = e.target.result;
                };
                reader.readAsDataURL(f);
            })));

            try {
                const res = await fetch(\`/api/quotes/\${currentEditingQuoteId}/photos\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ photos: dataUrls })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Upload failed');
                status.textContent = '✓ Uploaded';
                setTimeout(() => { status.style.display = 'none'; }, 2000);
                loadQuotePhotos(currentEditingQuoteId);
                // Update local quote object so re-opening shows photos
                const q = quotes.find(q => q.id == currentEditingQuoteId);
                if (q) q.photos = (q.photos || []).concat(data.keys || []);
            } catch (e) {
                status.textContent = 'Upload failed: ' + e.message;
                status.style.color = '#e53e3e';
            }
        }

        async function deleteQuotePhoto(index) {
            if (!confirm('Remove this photo?')) return;
            try {
                const res = await fetch(\`/api/quotes/\${currentEditingQuoteId}/photos/\${index}\`, { method: 'DELETE' });
                if (!res.ok) throw new Error('Failed');
                loadQuotePhotos(currentEditingQuoteId);
            } catch (e) {
                alert('Failed to remove photo: ' + e.message);
            }
        }

        async function deleteQuote(quoteId) {
            if (!confirm('Are you sure you want to delete this quote?')) return;

            try {
                await fetch(\`/api/quotes/\${quoteId}\`, { method: 'DELETE' });
                await loadQuotes();
            } catch (error) {
                alert('Failed to delete quote: ' + error.message);
            }
        }

        async function emailQuote(quoteId) {
            const quote = quotes.find(q => q.id == quoteId || q._id == quoteId);
            if (!quote) {
                alert('Quote not found');
                return;
            }

            const client = findClient(quote.clientId);
            if (!client || !client.email) {
                alert('Cannot send quote: Client has no email address.\\n\\nPlease add an email to the client profile first.');
                return;
            }

            if (!confirm(\`Send quote to \${client.name} at \${client.email}?\`)) {
                return;
            }

            try {
                const response = await fetch('/api/quotes/send-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quoteId: quote.id || quote._id })
                });

                const data = await response.json();

                if (response.ok) {
                    alert(\`✅ Quote sent successfully to \${client.email}!\`);
                    await loadQuotes();
                } else {
                    alert(\`❌ Failed to send quote email:\\n\${data.error || 'Unknown error'}\\n\\nMake sure email is configured in Settings > Email Settings.\`);
                }
            } catch (error) {
                alert('❌ Error sending quote: ' + error.message);
            }
        }

        async function convertQuoteToJob(quoteId) {
            if (!confirm('Convert this approved quote to a job? This will create a new job with all the quote details.')) {
                return;
            }

            try {
                const response = await fetch(\`/api/quotes/\${quoteId}/convert\`, {
                    method: 'POST'
                });

                const data = await response.json();

                if (response.ok) {
                    alert(\`✅ Quote converted to job successfully!\\n\\nJob #\${data.jobId} has been created.\`);
                    await loadQuotes();
                    await loadJobs();
                } else {
                    alert(\`❌ Failed to convert quote:\\n\${data.error || 'Unknown error'}\`);
                }
            } catch (error) {
                alert('❌ Error converting quote: ' + error.message);
            }
        }

        // ===== END QUOTES FUNCTIONS =====

        function renderJobsTable() {
            const container = document.getElementById('jobs-list');

            if (jobs.length === 0) {
                renderEmptyState(container, 'No jobs yet', 'Create your first job to get started');
                return;
            }

            // Apply filters
            const statusFilter = !isAdmin ? 'ACTIVE_WORK' : document.getElementById('filter-status').value;
            const clientFilter = !isAdmin ? '' : document.getElementById('filter-client').value;
            const assignedFilter = document.getElementById('filter-assigned').value;

            let filteredJobs = getFilteredJobs(statusFilter, clientFilter, assignedFilter);

            if (filteredJobs.length === 0) {
                renderEmptyState(container, 'No jobs match filters', 'Try adjusting your filters');
                return;
            }

            filteredJobs = applySortState(filteredJobs, 'jobs', { date: 'scheduledDate', client: 'clientId', title: 'title', status: 'status' });

            const isMobile = window.innerWidth < 768;

            if (isMobile) {
                container.innerHTML = filteredJobs.map(j => {
                    const client = findClient(j.clientId);
                    const assignedNames = getAssignedNames(j.assignedTo);
                    const total = j.totalWithTax ? j.totalWithTax : (j.total ? calculateTotalWithTax(parseFloat(j.total)) : 0);
                    const paid = j.totalPaid ? parseFloat(j.totalPaid) : 0;
                    const owed = total - paid;
                    const isPaidInFull = Math.abs(owed) < 0.01;

                    // Non-admin: calculate potential earnings from labor hours × their pay rate
                    let earningsHtml = '';
                    if (!isAdmin && currentTeamMember && currentTeamMember.hourlyRate) {
                        const laborHours = (j.laborItems || []).reduce((sum, item) => sum + (parseFloat(item.hours) || 0), 0);
                        if (laborHours > 0) {
                            const earnings = laborHours * parseFloat(currentTeamMember.hourlyRate);
                            earningsHtml = \`<div style="margin-bottom:0.5rem;">
                                <div style="font-size:0.72rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.25rem;">Potential Earnings</div>
                                <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:7px;padding:0.45rem 0.65rem;font-size:0.85rem;">
                                    💰 <strong style="color:#15803d;">\${formatMoney(earnings)}</strong>
                                    <span style="color:#4b5563;"> · \${laborHours}hr @ \$\${parseFloat(currentTeamMember.hourlyRate).toFixed(2)}/hr</span>
                                </div>
                            </div>\`;
                        }
                    }

                    const truncDesc = w => { const words = (w||'').split(/\s+/); return words.length > 20 ? words.slice(0,20).join(' ') + '…' : w; };
                    return \`<div style="background:white;border:2px solid #e2e8f0;border-radius:10px;padding:1rem;margin-bottom:0.75rem;">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5rem;">
                            <div>
                                <div style="font-size:1.1rem;font-weight:700;"><a href="#" onclick="editJob('\${j.id}');return false;" style="color:#667eea;text-decoration:none;">\${maskName(client ? client.name : 'Unknown')}</a></div>
                                <div style="font-weight:600;color:#4a5568;margin-top:0.15rem;">\${j.title}</div>
                                \${j.description ? \`<div style="color:#718096;font-size:0.8rem;margin-top:0.1rem;">\${truncDesc(j.description)}</div>\` : ''}
                            </div>
                            <span class="status-badge status-\${j.status}" style="white-space:nowrap;margin-left:0.5rem;">\${j.status.replace(/_/g, ' ')}</span>
                            \${j.signoff ? \`<span style="background:#c6f6d5;color:#22543d;font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:0.4rem;white-space:nowrap;">✅ Signed</span>\` : ''}
                        </div>
                        <div style="color:#718096;font-size:0.85rem;margin-bottom:0.5rem;">
                            \${j.scheduledDate ? \`📅 \${j.scheduledDate}\${j.scheduledTime ? ' · ' + j.scheduledTime : ''}\` : 'No date set'}
                            \${assignedNames !== 'Unassigned' ? \` · 👷 \${assignedNames}\` : ''}
                        </div>
                        \${earningsHtml}
                        \${isAdmin && total > 0 ? \`<div style="font-size:0.85rem;margin-bottom:0.5rem;">
                            <span style="color:#4a5568;">Billed: \${formatMoney(total)}</span> ·
                            <span style="color:#48bb78;">Paid: \${formatMoney(paid)}</span> ·
                            <span style="color:\${isPaidInFull ? '#48bb78' : '#e53e3e'};">Owed: \${formatMoney(Math.max(0, owed))}</span>
                        </div>\` : ''}
                        \${isAdmin ? \`<div style="font-size:0.78rem;margin-bottom:0.5rem;">
                            \${j.invoiceSentAt ? \`<span style="color:#4a5568;">📧 \${new Date(j.invoiceSentAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>\` : ''}
                            \${j.invoiceViewCount > 0 ? \` · <button onclick="showInvoiceViewLog('\${j.id}')" style="background:none;border:none;color:#667eea;cursor:pointer;padding:0;font-size:0.78rem;">👁 \${j.invoiceViewCount} view\${j.invoiceViewCount>1?'s':''}</button>\` : (j.invoiceSentAt ? \` · <span style="color:#9ca3af;">Not opened</span>\` : '')}
                        </div>\` : ''}
                        <div style="display:flex;gap:0.4rem;align-items:center;" onclick="event.stopPropagation()">
                            <button class="btn btn-secondary btn-small" onclick="editJob('\${j.id}')">Edit</button>
                            \${isAdmin ? \`<button class="btn btn-primary btn-small" onclick="window.open('/invoice/\${j.id}', '_blank')" style="white-space:nowrap;">📄 Invoice</button>\` : ''}
                            \${isAdmin ? \`<div style="position:relative;display:inline-block;">
                                <button class="btn btn-secondary btn-small" onclick="toggleJobMenu('\${j.id}',event)" style="letter-spacing:0.1em;padding:0.3rem 0.7rem;">···</button>
                                <div id="jm-\${j.id}" class="job-action-menu" onclick="event.stopPropagation()" style="display:none;position:absolute;left:0;top:calc(100% + 4px);background:white;border:1.5px solid #e2e8f0;border-radius:9px;box-shadow:0 6px 18px rgba(0,0,0,0.13);z-index:200;min-width:175px;padding:0.3rem 0;">
                                    <button onclick="emailInvoice('\${j.id}')" class="jm-item">📧 Email Invoice</button>
                                    \${!isPaidInFull ? \`<button onclick="openDepositModal('\${j.id}', \${parseFloat(j.total)||0})" class="jm-item">💳 Request Deposit</button>\` : ''}
                                    \${!isPaidInFull && client?.cloverCustomerId ? \`<button onclick="openChargeCardModal('\${j.id}','\${client.cloverCardLast4||''}','\${client.cloverCardBrand||''}',\${j.totalWithTax||j.total||0})" class="jm-item">💳 Charge ••••\${client.cloverCardLast4||'?'}</button>\` : ''}
                                    \${!isPaidInFull ? \`<button onclick="openEnterCardModal('\${j.id}')" class="jm-item">💳 Enter Card</button>\` : ''}
                                    <button onclick="showPayDiag('\${j.id}')" class="jm-item">⚡ Pay Log</button>
                                    <button onclick="openSignoffForm('\${j.id}')" class="jm-item">✍️ Sign-Off Form</button>
                                    <div style="border-top:1px solid #f1f5f9;margin:0.25rem 0;"></div>
                                    <button onclick="deleteJob('\${j.id}')" class="jm-item" style="color:#dc2626;">🗑 Delete</button>
                                </div>
                            </div>\` : ''}
                        </div>
                    </div>\`;
                }).join('');
            } else {
            const moneyColumn = isAdmin ? '<th>Billed / Paid / Owed</th>' : '';
            const activityColumn = isAdmin ? '<th>Activity</th>' : '';
            container.innerHTML = '<table><thead><tr>' + sth('jobs','scheduledDate','Date') + sth('jobs','clientId','Client') + sth('jobs','title','Job') + '<th>Assigned To</th>' + sth('jobs','status','Status') + moneyColumn + activityColumn + '<th>Actions</th></tr></thead><tbody>' +
                filteredJobs.map(j => {
                    const client = findClient(j.clientId);
                    const assignedNames = getAssignedNames(j.assignedTo);

                    const _total = j.totalWithTax ? j.totalWithTax : (j.total ? calculateTotalWithTax(parseFloat(j.total)) : 0);
                    const _paid = j.totalPaid ? parseFloat(j.totalPaid) : 0;
                    const isPaidInFull = Math.abs(_total - _paid) < 0.01;
                    let moneyCell = '';
                    let activityCell = '';
                    if (isAdmin) {
                        const total = _total;
                        const paid = _paid;
                        const owed = total - paid;
                        const owedDisplay = isPaidInFull ? 0 : owed;
                        const paymentStatus = isPaidInFull ? '✓' : owed < total ? '◐' : '';
                        moneyCell = \`<td>
                            <div style="font-size: 0.9rem;">
                                <div>$\${total.toFixed(2)} / <span style="color: #48bb78;">$\${paid.toFixed(2)}</span> / <span style="color: \${isPaidInFull ? '#48bb78' : '#e53e3e'};">$\${owedDisplay.toFixed(2)}</span> \${paymentStatus}</div>
                            </div>
                        </td>\`;
                        activityCell = \`<td style="font-size:0.8rem;white-space:nowrap;">
                            \${j.invoiceSentAt ? \`<div style="color:#4a5568;">📧 \${new Date(j.invoiceSentAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>\` : ''}
                            \${j.invoiceViewCount > 0 ? \`<div><button onclick="showInvoiceViewLog('\${j.id}')" style="background:none;border:none;color:#667eea;cursor:pointer;padding:0;font-size:0.8rem;">👁 \${j.invoiceViewCount} view\${j.invoiceViewCount>1?'s':''} · \${new Date(j.invoiceFirstViewedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</button></div>\` : (j.invoiceSentAt ? \`<div style="color:#9ca3af;">Not opened</div>\` : '')}
                        </td>\`;
                    }

                    const truncD = w => { const ws = (w||'').split(/\s+/); return ws.length > 20 ? ws.slice(0,20).join(' ') + '…' : w; };
                    return \`<tr>
                        <td>\${j.scheduledDate}<br><small>\${j.scheduledTime || ''}</small></td>
                        <td><a href="#" onclick="editJob('\${j.id}');return false;" style="color:#667eea;font-weight:600;text-decoration:none;">\${maskName(client ? client.name : 'Unknown')}</a></td>
                        <td><strong>\${j.title}</strong>\${j.description ? \`<br><small style="color:#718096;">\${truncD(j.description)}</small>\` : ''}</td>
                        <td>\${assignedNames}</td>
                        <td><span class="status-badge status-\${j.status}">\${j.status.replace('_', ' ')}</span>\${j.signoff ? \` <span style="background:#c6f6d5;color:#22543d;font-size:0.68rem;font-weight:700;padding:1px 7px;border-radius:999px;white-space:nowrap;">✅ Signed</span>\` : ''}</td>
                        \${moneyCell}
                        \${activityCell}
                        <td>
                            <div style="display:flex;gap:0.4rem;align-items:center;" onclick="event.stopPropagation()">
                                <button class="btn btn-secondary btn-small" onclick="editJob('\${j.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Edit</button>
                                \${isAdmin ? \`<button class="btn btn-primary btn-small" onclick="window.open('/invoice/\${j.id}', '_blank')" style="white-space:nowrap;">📄 Invoice</button>\` : ''}
                                \${isAdmin ? \`<div style="position:relative;display:inline-block;">
                                    <button class="btn btn-secondary btn-small" onclick="toggleJobMenu('\${j.id}',event)" style="letter-spacing:0.1em;padding:0.3rem 0.7rem;">···</button>
                                    <div id="jm-\${j.id}" class="job-action-menu" onclick="event.stopPropagation()" style="display:none;position:absolute;right:0;top:calc(100% + 4px);background:white;border:1.5px solid #e2e8f0;border-radius:9px;box-shadow:0 6px 18px rgba(0,0,0,0.13);z-index:200;min-width:175px;padding:0.3rem 0;">
                                        <button onclick="emailInvoice('\${j.id}')" class="jm-item">📧 Email Invoice</button>
                                        \${!isPaidInFull ? \`<button onclick="openDepositModal('\${j.id}', \${parseFloat(j.total)||0})" class="jm-item">💳 Request Deposit</button>\` : ''}
                                        \${!isPaidInFull && client?.cloverCustomerId ? \`<button onclick="openChargeCardModal('\${j.id}','\${client.cloverCardLast4||''}','\${client.cloverCardBrand||''}',\${j.totalWithTax||j.total||0})" class="jm-item">💳 Charge ••••\${client.cloverCardLast4||'?'}</button>\` : ''}
                                        \${!isPaidInFull ? \`<button onclick="openEnterCardModal('\${j.id}')" class="jm-item">💳 Enter Card</button>\` : ''}
                                        <button onclick="showPayDiag('\${j.id}')" class="jm-item">⚡ Pay Log</button>
                                        \${j.calendarEventId ? \`<button onclick="window.open('\${j.calendarEventLink}','_blank')" class="jm-item">📅 View Calendar</button>\` : (j.scheduledDate && j.status==='scheduled' ? \`<button onclick="createCalendarEvent('\${j.id}')" class="jm-item">📅 Add to Calendar</button>\` : '')}
                                        <button onclick="openSignoffForm('\${j.id}')" class="jm-item">✍️ Sign-Off Form</button>
                                        <div style="border-top:1px solid #f1f5f9;margin:0.25rem 0;"></div>
                                        <button onclick="deleteJob('\${j.id}')" class="jm-item" style="color:#dc2626;">🗑 Delete</button>
                                    </div>
                                </div>\` : ''}
                            </div>
                        </td>
                    </tr>\`;
                }).join('') +
                '</tbody></table>';
            }
        }

        function filterJobs() {
            renderStatusPills();
            renderJobsTable();
        }

        function setStatusPill(value) {
            document.getElementById('filter-status').value = value;
            filterJobs();
        }

        function renderStatusPills() {
            const container = document.getElementById('job-status-pills');
            if (!container) return;
            const current = document.getElementById('filter-status').value;

            const today = new Date();
            const weekStart = new Date(today);
            weekStart.setDate(today.getDate() - today.getDay()); // Sunday
            weekStart.setHours(0, 0, 0, 0);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekStart.getDate() + 7);
            const weekStartStr = weekStart.toISOString().slice(0, 10);
            const weekEndStr = weekEnd.toISOString().slice(0, 10);

            const counts = {
                ACTIVE_WORK: jobs.filter(j => j.status !== 'completed' && j.status !== 'invoiced' && j.status !== 'bid_lost').length,
                prospecting: jobs.filter(j => j.status === 'prospecting').length,
                to_be_scheduled: jobs.filter(j => j.status === 'to_be_scheduled').length,
                scheduled: jobs.filter(j => j.status === 'scheduled').length,
                in_progress: jobs.filter(j => j.status === 'in_progress').length,
                completed: jobs.filter(j => j.status === 'completed').length,
                invoiced: jobs.filter(j => j.status === 'invoiced').length,
                bid_lost: jobs.filter(j => j.status === 'bid_lost').length,
                COMPLETED_WEEK: jobs.filter(j => (j.status === 'completed' || j.status === 'invoiced') && j.scheduledDate >= weekStartStr && j.scheduledDate < weekEndStr).length
            };

            const pills = [
                { value: 'ACTIVE_WORK', label: '🔥 Active Work' },
                { value: 'prospecting', label: 'Prospecting' },
                { value: 'to_be_scheduled', label: 'To Be Scheduled' },
                { value: 'scheduled', label: 'Scheduled' },
                { value: 'in_progress', label: 'In Progress' },
                { value: 'completed', label: 'Completed' },
                { value: 'invoiced', label: 'Invoiced' },
                { value: 'bid_lost', label: 'Bid Lost' },
                { value: 'COMPLETED_WEEK', label: '✅ Done This Week' }
            ];

            container.innerHTML = pills.map(p => \`
                <button class="status-pill\${current === p.value ? ' active' : ''}" onclick="setStatusPill('\${p.value}')">
                    \${p.label}<span class="pill-count">\${counts[p.value] ?? 0}</span>
                </button>\`).join('');
        }

        function clearJobFilters() {
            document.getElementById('filter-status').value = 'ACTIVE_WORK';
            document.getElementById('filter-client').value = '';
            document.getElementById('filter-assigned').value = '';
            filterJobs();
        }

        async function createCalendarEvent(jobId) {
            if (!confirm('Add this job to your Google Calendar?')) {
                return;
            }

            try {
                const response = await fetch('/api/calendar/create-event', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId, sendInvite: false })
                });

                const data = await response.json();

                if (response.ok) {
                    alert('✅ Calendar event created!\n\nClick "View" to open it in Google Calendar.');
                    loadJobs(); // Reload to show View button
                } else {
                    alert(`❌ Failed to create calendar event:\n${data.error || 'Unknown error'}\n\nMake sure Calendar is configured in Settings > Email Settings.`);
                }
            } catch (error) {
                alert('❌ Error creating calendar event:\n' + error.message);
            }
        }

        // ── Vendors ─────────────────────────────────────────────────────────────
        let allVendors = [];

        async function loadVendors() {
            const resp = await fetch('/api/vendors');
            allVendors = await resp.json();
            renderVendors();
        }

        function renderVendors() {
            const search = (document.getElementById('vendor-search')?.value || '').toLowerCase();
            const cat = document.getElementById('vendor-category-filter')?.value || '';
            let list = allVendors.filter(v => {
                const matchesSearch = !search || [v.name, v.category, v.contact, v.phone, v.email, v.notes].join(' ').toLowerCase().includes(search);
                const matchesCat = !cat || v.category === cat;
                return matchesSearch && matchesCat;
            });

            const container = document.getElementById('vendors-list');
            if (list.length === 0) {
                container.innerHTML = '<div class="empty-state"><p>No vendors yet. Add your first supplier.</p></div>';
                return;
            }

            const categoryLabels = { lumber:'Lumber & Building Materials', electrical:'Electrical', plumbing:'Plumbing', hvac:'HVAC', hardware:'Hardware & Fasteners', paint:'Paint & Finishes', flooring:'Flooring', roofing:'Roofing', tools:'Tools & Equipment', landscaping:'Landscaping & Outdoor', subcontractor:'Subcontractor', other:'Other' };

            list = applySortState(list, 'vendors', { name: 'name', category: 'category', phone: 'phone', email: 'email', contact: 'contact', accountNumber: 'accountNumber' });

            const isMobile = window.innerWidth < 768;
            if (isMobile) {
                container.innerHTML = list.map(v => '<div style="background:white;border:2px solid #e2e8f0;border-radius:10px;padding:1rem;margin-bottom:0.75rem;">' +
                    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.4rem;">' +
                    '<div><div style="font-size:1.1rem;font-weight:700;color:#2d3748;">' + v.name + '</div>' +
                    (v.category ? '<div style="color:#667eea;font-size:0.85rem;margin-top:0.1rem;">' + (categoryLabels[v.category] || v.category) + '</div>' : '') +
                    '</div></div>' +
                    (v.phone ? '<div style="color:#4a5568;font-size:0.9rem;">📞 ' + formatPhoneNumber(v.phone) + '</div>' : '') +
                    (v.email ? '<div style="color:#4a5568;font-size:0.9rem;">✉️ ' + v.email + '</div>' : '') +
                    (v.contact ? '<div style="color:#718096;font-size:0.85rem;">👤 ' + v.contact + '</div>' : '') +
                    (v.accountNumber ? '<div style="color:#718096;font-size:0.85rem;">Account: ' + v.accountNumber + '</div>' : '') +
                    (v.notes ? '<div style="color:#718096;font-size:0.85rem;margin-top:0.4rem;font-style:italic;">' + v.notes.substring(0, 80) + (v.notes.length > 80 ? '...' : '') + '</div>' : '') +
                    '<div style="display:flex;gap:0.5rem;margin-top:0.75rem;">' +
                    (v.website ? '<a href="' + (v.website.startsWith('http') ? v.website : 'https://' + v.website) + '" target="_blank" class="btn btn-secondary btn-small">🌐 Website</a>' : '') +
                    '<button class="btn btn-secondary btn-small" onclick="openVendorModal(\'' + v.id + '\')">Edit</button>' +
                    '<button class="btn btn-danger btn-small" onclick="deleteVendor(\'' + v.id + '\')">Delete</button>' +
                    '</div></div>'
                ).join('');
            } else {
                container.innerHTML = '<table><thead><tr>' + sth('vendors','name','Name') + sth('vendors','category','Category') + sth('vendors','phone','Phone') + sth('vendors','email','Email') + sth('vendors','contact','Contact') + sth('vendors','accountNumber','Account #') + '<th>Notes</th><th>Actions</th></tr></thead><tbody>' +
                list.map(v => '<tr>' +
                    '<td><strong>' + v.name + '</strong>' + (v.website ? ' <a href="' + (v.website.startsWith('http') ? v.website : 'https://' + v.website) + '" target="_blank" style="color:#667eea;font-size:0.8rem;">🌐</a>' : '') + '</td>' +
                    '<td>' + (categoryLabels[v.category] || v.category || '-') + '</td>' +
                    '<td>' + (formatPhoneNumber(v.phone) || '-') + '</td>' +
                    '<td>' + (v.email ? '<a href="mailto:' + v.email + '" style="color:#667eea;">' + v.email + '</a>' : '-') + '</td>' +
                    '<td>' + (v.contact || '-') + '</td>' +
                    '<td>' + (v.accountNumber || '-') + '</td>' +
                    '<td style="max-width:160px;color:#718096;font-size:0.85rem;">' + (v.notes ? v.notes.substring(0, 60) + (v.notes.length > 60 ? '...' : '') : '-') + '</td>' +
                    '<td>' +
                    '<button class="btn btn-secondary btn-small" onclick="openVendorModal(\'' + v.id + '\')">Edit</button> ' +
                    '<button class="btn btn-danger btn-small" onclick="deleteVendor(\'' + v.id + '\')">Delete</button>' +
                    '</td></tr>'
                ).join('') + '</tbody></table>';
            }
        }

        function filterVendors() { renderVendors(); }

        function openVendorModal(vendorId) {
            document.getElementById('vendorId').value = '';
            document.getElementById('vendorName').value = '';
            document.getElementById('vendorCategory').value = '';
            document.getElementById('vendorAccountNumber').value = '';
            document.getElementById('vendorPhone').value = '';
            document.getElementById('vendorEmail').value = '';
            document.getElementById('vendorWebsite').value = '';
            document.getElementById('vendorContact').value = '';
            document.getElementById('vendorAddress').value = '';
            document.getElementById('vendorNotes').value = '';

            if (vendorId) {
                const v = allVendors.find(x => x.id === vendorId);
                if (v) {
                    document.getElementById('vendorModalTitle').textContent = 'Edit Vendor';
                    document.getElementById('vendorId').value = v.id;
                    document.getElementById('vendorName').value = v.name || '';
                    document.getElementById('vendorCategory').value = v.category || '';
                    document.getElementById('vendorAccountNumber').value = v.accountNumber || '';
                    document.getElementById('vendorPhone').value = v.phone || '';
                    document.getElementById('vendorEmail').value = v.email || '';
                    document.getElementById('vendorWebsite').value = v.website || '';
                    document.getElementById('vendorContact').value = v.contact || '';
                    document.getElementById('vendorAddress').value = v.address || '';
                    document.getElementById('vendorNotes').value = v.notes || '';
                }
            } else {
                document.getElementById('vendorModalTitle').textContent = 'Add Vendor';
            }
            openModal('vendorModal');
        }

        async function saveVendor() {
            const name = document.getElementById('vendorName').value.trim();
            if (!name) { alert('Vendor name is required'); return; }

            const vendor = {
                id: document.getElementById('vendorId').value || undefined,
                name,
                category: document.getElementById('vendorCategory').value,
                accountNumber: document.getElementById('vendorAccountNumber').value.trim(),
                phone: document.getElementById('vendorPhone').value.trim(),
                email: document.getElementById('vendorEmail').value.trim(),
                website: document.getElementById('vendorWebsite').value.trim(),
                contact: document.getElementById('vendorContact').value.trim(),
                address: document.getElementById('vendorAddress').value.trim(),
                notes: document.getElementById('vendorNotes').value.trim()
            };

            const resp = await fetch('/api/vendors', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(vendor)
            });

            if (resp.ok) {
                closeModal('vendorModal');
                loadVendors();
            } else {
                const d = await resp.json();
                alert('Failed to save: ' + (d.error || 'Unknown error'));
            }
        }

        async function deleteVendor(vendorId) {
            const v = allVendors.find(x => x.id === vendorId);
            if (!confirm('Delete ' + (v?.name || 'this vendor') + '?')) return;
            await fetch('/api/vendors/' + vendorId, { method: 'DELETE' });
            loadVendors();
        }

        // ── Portfolio ─────────────────────────────────────────────────────────────

        let allPortfolioItems = [];
        let _portfolioPhotoData = null;

        async function loadPortfolio() {
            const res = await fetch('/api/portfolio');
            allPortfolioItems = await res.json();
            renderPortfolio();
        }

        function filterPortfolio() { renderPortfolio(); }

        function renderPortfolio() {
            const grid = document.getElementById('portfolio-grid');
            const search = (document.getElementById('portfolio-search')?.value || '').toLowerCase();
            const cat = document.getElementById('portfolio-category-filter')?.value || '';

            let items = allPortfolioItems;
            if (search) items = items.filter(i => (i.title + i.caption + i.category).toLowerCase().includes(search));
            if (cat) items = items.filter(i => i.category === cat);

            if (items.length === 0) {
                grid.innerHTML = '<p style="color:#718096;grid-column:1/-1;padding:1rem 0;">No portfolio items yet. Click "+ Add Work" to add your first.</p>';
                return;
            }

            const catLabel = { bathroom:'Bathroom', kitchen:'Kitchen', deck:'Deck / Patio', flooring:'Flooring',
                painting:'Painting', carpentry:'Carpentry', electrical:'Electrical', plumbing:'Plumbing',
                exterior:'Exterior', general:'General' };

            grid.innerHTML = items.map(item => \`
                <div style="background:white;border:2px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
                    <div style="position:relative;padding-top:66%;background:#f1f5f9;overflow:hidden;">
                        <img src="\${item.photoUrl}" alt="\${item.title}" loading="lazy"
                            style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;cursor:pointer;"
                            onclick="openLightbox(this.src)">
                    </div>
                    <div style="padding:0.9rem 1rem;">
                        <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.35rem;">
                            \${item.category ? \`<span style="background:#ede9fe;color:#6d28d9;border-radius:999px;padding:2px 10px;font-size:0.72rem;font-weight:700;text-transform:uppercase;">\${catLabel[item.category] || item.category}</span>\` : ''}
                            \${item.commercial ? \`<span style="background:#dbeafe;color:#1d4ed8;border-radius:999px;padding:2px 10px;font-size:0.72rem;font-weight:700;text-transform:uppercase;">🏢 Commercial</span>\` : ''}
                        </div>
                        \${item.title ? \`<div style="font-weight:700;color:#1f2937;margin-top:0.5rem;font-size:1rem;">\${item.title}</div>\` : ''}
                        \${item.caption ? \`<div style="color:#6b7280;font-size:0.85rem;margin-top:0.25rem;line-height:1.4;">\${item.caption}</div>\` : ''}
                        <div style="display:flex;gap:0.5rem;margin-top:0.75rem;">
                            <button onclick="openPortfolioModal('\${item.id}')" style="padding:0.35rem 0.8rem;background:#ede9fe;color:#6d28d9;border:none;border-radius:6px;font-size:0.82rem;cursor:pointer;font-weight:600;">Edit</button>
                            <button onclick="deletePortfolioItem('\${item.id}')" style="padding:0.35rem 0.7rem;background:#fee2e2;color:#dc2626;border:1.5px solid #fca5a5;border-radius:6px;font-size:0.82rem;cursor:pointer;">🗑</button>
                        </div>
                    </div>
                </div>
            \`).join('');
        }

        function openPortfolioModal(id) {
            _portfolioPhotoData = null;
            document.getElementById('portfolioEditId').value = id || '';
            document.getElementById('portfolioModalTitle').textContent = id ? 'Edit Item' : 'Add Work';
            document.getElementById('portfolio-upload-preview').style.display = 'none';
            document.getElementById('portfolio-upload-prompt').style.display = '';

            if (id) {
                const item = allPortfolioItems.find(i => i.id === id);
                if (item) {
                    document.getElementById('portfolioTitle').value = item.title;
                    document.getElementById('portfolioCategory').value = item.category;
                    document.getElementById('portfolioCaption').value = item.caption;
                    document.getElementById('portfolioCommercial').checked = !!item.commercial;
                    if (item.photoUrl) {
                        document.getElementById('portfolio-preview-img').src = item.photoUrl;
                        document.getElementById('portfolio-upload-preview').style.display = '';
                        document.getElementById('portfolio-upload-prompt').style.display = 'none';
                    }
                }
            } else {
                document.getElementById('portfolioTitle').value = '';
                document.getElementById('portfolioCategory').value = '';
                document.getElementById('portfolioCaption').value = '';
                document.getElementById('portfolioCommercial').checked = false;
            }
            openModal('portfolioModal');
        }

        function closePortfolioModal() { closeModal('portfolioModal'); }

        async function compressPortfolioImage(file) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(file);
                const img = new Image();
                img.onload = () => {
                    URL.revokeObjectURL(url);
                    // Scale down more aggressively for large files
                    const MAX = file.size > 5 * 1024 * 1024 ? 900 : 1200;
                    let w = img.width, h = img.height;
                    if (w > MAX || h > MAX) {
                        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
                        else { w = Math.round(w * MAX / h); h = MAX; }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);

                    // Step quality down until under 800KB
                    const tryQuality = (q) => {
                        canvas.toBlob((blob) => {
                            if (!blob) { reject(new Error('Canvas toBlob failed')); return; }
                            if (blob.size > 800 * 1024 && q > 0.4) {
                                tryQuality(Math.round((q - 0.1) * 10) / 10);
                            } else {
                                const name = file.name.replace(/\.[^.]+$/, '.jpg');
                                resolve(new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }));
                            }
                        }, 'image/jpeg', q);
                    };
                    tryQuality(0.82);
                };
                img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
                img.src = url;
            });
        }

        async function handlePortfolioPhoto(input) {
            const file = input.files[0];
            if (!file) return;
            const zone = document.getElementById('portfolio-upload-zone');
            const prompt = document.getElementById('portfolio-upload-prompt');
            zone.style.opacity = '0.6';
            prompt.innerHTML = '<div style="color:#6b7280;font-size:0.9rem;">⏳ Compressing...</div>';
            try {
                const compressed = await compressPortfolioImage(file);
                const reader = new FileReader();
                reader.onload = (e) => {
                    _portfolioPhotoData = { dataUrl: e.target.result, name: compressed.name, type: compressed.type };
                    document.getElementById('portfolio-preview-img').src = e.target.result;
                    document.getElementById('portfolio-upload-preview').style.display = '';
                    prompt.style.display = 'none';
                };
                reader.readAsDataURL(compressed);
            } catch (err) {
                console.error('Compression failed:', err);
                prompt.innerHTML = '<div style="color:#dc2626;font-size:0.85rem;">⚠️ Could not process image. Try a different file.</div>';
            } finally {
                zone.style.opacity = '1';
            }
        }

        async function savePortfolioItem() {
            const id = document.getElementById('portfolioEditId').value;
            const title = document.getElementById('portfolioTitle').value.trim();
            const category = document.getElementById('portfolioCategory').value;
            const caption = document.getElementById('portfolioCaption').value.trim();
            const commercial = document.getElementById('portfolioCommercial').checked;

            if (!id && !_portfolioPhotoData) { alert('Please select a photo.'); return; }

            const saveBtn = document.querySelector('#portfolioModal .btn-primary');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';

            try {
                if (id) {
                    const body = { title, category, caption, commercial };
                    if (_portfolioPhotoData) {
                        body.fileData = _portfolioPhotoData.dataUrl;
                        body.fileName = _portfolioPhotoData.name;
                        body.fileType = _portfolioPhotoData.type;
                    }
                    if (_portfolioPhotoData) {
                        await fetch('/api/portfolio/' + id, { method: 'DELETE' });
                        const res = await fetch('/api/portfolio', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ ...body }) });
                        if (!res.ok) throw new Error('Save failed');
                    } else {
                        const res = await fetch('/api/portfolio/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
                        if (!res.ok) throw new Error('Save failed');
                    }
                } else {
                    const body = { title, category, caption, commercial, fileData: _portfolioPhotoData.dataUrl, fileName: _portfolioPhotoData.name, fileType: _portfolioPhotoData.type };
                    const res = await fetch('/api/portfolio', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
                    if (!res.ok) throw new Error('Save failed');
                }
                closePortfolioModal();
                loadPortfolio();
            } catch (err) {
                alert('Failed to save: ' + err.message);
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        }

        async function deletePortfolioItem(id) {
            if (!confirm('Remove this item from your portfolio?')) return;
            await fetch('/api/portfolio/' + id, { method: 'DELETE' });
            loadPortfolio();
        }

        // ── End Portfolio ─────────────────────────────────────────────────────────

        let _depositJobId = null;
        let _depositJobTotal = 0;

        let _chargeCardJobId = null;

        function openChargeCardModal(jobId, last4, brand, jobTotal) {
            _chargeCardJobId = jobId;
            const cardLabel = (brand ? brand + ' ' : '') + (last4 ? '••••' + last4 : 'saved card');
            document.getElementById('chargeCardInfo').textContent = 'Card: ' + cardLabel;
            const job = jobs.find(j => j.id === jobId);
            const total = parseFloat(job?.totalWithTax || job?.total) || 0;
            const paid = parseFloat(job?.totalPaid) || 0;
            const balance = Math.max(0, total - paid);
            document.getElementById('chargeCardAmount').value = balance > 0 ? balance.toFixed(2) : (jobTotal || '').toString();
            openModal('chargeCardModal');
        }

        async function submitChargeCard() {
            const amount = parseFloat(document.getElementById('chargeCardAmount').value);
            if (!amount || amount < 0.50) { alert('Please enter a valid amount (minimum $0.50)'); return; }

            const job = jobs.find(j => j.id === _chargeCardJobId);
            const client = clients.find(c => String(c.id) === String(job?.clientId));
            const cardLabel = (client?.cloverCardBrand ? client.cloverCardBrand + ' ' : '') + (client?.cloverCardLast4 ? '••••' + client.cloverCardLast4 : 'saved card');

            if (!confirm('Charge ' + cardLabel + ' $' + amount.toFixed(2) + ' for "' + (job?.title || 'this job') + '"?')) return;

            const btn = document.querySelector('#chargeCardModal .btn-primary');
            btn.disabled = true;
            btn.textContent = 'Processing...';

            try {
                const resp = await fetch('/api/jobs/' + _chargeCardJobId + '/charge-saved-card', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount })
                });
                const data = await resp.json();
                if (!resp.ok) {
                    alert('Charge failed: ' + (data.error || 'Unknown error'));
                    btn.disabled = false;
                    btn.textContent = 'Charge Card';
                    return;
                }
                closeModal('chargeCardModal');
                alert('✅ $' + amount.toFixed(2) + ' charged successfully!');
                loadJobs();
            } catch (e) {
                alert('Error: ' + e.message);
                btn.disabled = false;
                btn.textContent = 'Charge Card';
            }
        }

        let _enterCardJobId = null;
        let _adminCloverInst = null;
        let _adminCloverMounted = false;
        let _cloverConfig = null;

        async function openEnterCardModal(jobId) {
            _enterCardJobId = jobId;
            const job = jobs.find(j => j.id === jobId);
            const client = clients.find(c => String(c.id) === String(job?.clientId));
            document.getElementById('enterCardJobLabel').textContent = (client?.name || 'Client') + ' — ' + (job?.title || '');
            const total = parseFloat(job?.totalWithTax || job?.total) || 0;
            const paid = parseFloat(job?.totalPaid) || 0;
            const balance = Math.max(0, total - paid);
            document.getElementById('enterCardAmount').value = balance > 0 ? balance.toFixed(2) : '';
            document.getElementById('enterCardError').style.display = 'none';
            document.getElementById('enterCardSubmitBtn').disabled = false;
            document.getElementById('enterCardSubmitBtn').textContent = 'Charge Card';

            openModal('enterCardModal');

            if (!_adminCloverMounted) {
                try {
                    if (!_cloverConfig) {
                        const cfgResp = await fetch('/api/clover-config');
                        _cloverConfig = await cfgResp.json();
                    }
                    if (!_cloverConfig.publicKey || !_cloverConfig.merchantId) {
                        throw new Error('Clover keys not configured on server.');
                    }
                    if (typeof Clover === 'undefined') {
                        await new Promise((resolve, reject) => {
                            const s = document.createElement('script');
                            s.src = 'https://checkout.clover.com/sdk.js';
                            s.onload = resolve;
                            s.onerror = () => reject(new Error('Failed to load Clover SDK'));
                            document.head.appendChild(s);
                        });
                    }
                    _adminCloverInst = new Clover(_cloverConfig.publicKey, { merchantId: _cloverConfig.merchantId });
                    const elems = _adminCloverInst.elements();
                    elems.create('CARD_NUMBER').mount('#admin-card-number');
                    elems.create('CARD_DATE').mount('#admin-card-date');
                    elems.create('CARD_CVV').mount('#admin-card-cvv');
                    elems.create('CARD_POSTAL_CODE').mount('#admin-card-zip');
                    _adminCloverMounted = true;
                } catch(e) {
                    console.error('Clover init error:', e);
                    closeModal('enterCardModal');
                    alert('Payment module failed to load: ' + e.message);
                    return;
                }
            }
        }

        async function submitEnterCard() {
            const btn = document.getElementById('enterCardSubmitBtn');
            const errDiv = document.getElementById('enterCardError');
            const amount = parseFloat(document.getElementById('enterCardAmount').value);
            const saveCard = document.getElementById('enterCardSave').checked;

            errDiv.style.display = 'none';
            if (!amount || amount < 0.50) { errDiv.textContent = 'Please enter a valid amount (minimum $0.50)'; errDiv.style.display = 'block'; return; }
            if (!_adminCloverInst) { errDiv.textContent = 'Payment module not loaded. Please refresh.'; errDiv.style.display = 'block'; return; }

            btn.disabled = true;
            btn.textContent = 'Processing...';

            try {
                const result = await _adminCloverInst.createToken();
                if (!result?.token) {
                    const msg = result?.errors ? Object.values(result.errors).join(' ') : 'Card tokenization failed. Check card details.';
                    errDiv.textContent = msg;
                    errDiv.style.display = 'block';
                    btn.disabled = false;
                    btn.textContent = 'Charge Card';
                    return;
                }

                const resp = await fetch('/api/jobs/' + _enterCardJobId + '/manual-charge', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: result.token, amount, saveCard })
                });
                const data = await resp.json();

                if (!resp.ok) {
                    errDiv.textContent = data.error || 'Charge failed.';
                    errDiv.style.display = 'block';
                    btn.disabled = false;
                    btn.textContent = 'Charge Card';
                    return;
                }

                // Reset Clover fields for next use
                _adminCloverMounted = false;
                _adminCloverInst = null;
                ['admin-card-number','admin-card-date','admin-card-cvv','admin-card-zip'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.innerHTML = '';
                });

                closeModal('enterCardModal');
                const savedMsg = data.cardSaved ? ' Card saved for future use.' : '';
                alert('✅ $' + amount.toFixed(2) + ' charged successfully!' + savedMsg);
                loadJobs();
                if (data.cardSaved) loadClients();
            } catch(e) {
                errDiv.textContent = 'Connection error. Please try again.';
                errDiv.style.display = 'block';
                btn.disabled = false;
                btn.textContent = 'Charge Card';
            }
        }

        function openDepositModal(jobId, jobTotal) {
            _depositJobId = jobId;
            _depositJobTotal = jobTotal;
            const defaultAmt = (jobTotal * 0.5).toFixed(2);
            document.getElementById('depositAmount').value = defaultAmt;
            updateDepositPctLabel();
            openModal('depositModal');
        }

        function setDepositPct(pct) {
            document.getElementById('depositAmount').value = (_depositJobTotal * pct / 100).toFixed(2);
            updateDepositPctLabel();
        }

        function updateDepositPctLabel() {
            const amt = parseFloat(document.getElementById('depositAmount').value) || 0;
            const pct = _depositJobTotal > 0 ? ((amt / _depositJobTotal) * 100).toFixed(0) : 0;
            document.getElementById('depositPctLabel').textContent = _depositJobTotal > 0 ? pct + '% of $' + _depositJobTotal.toFixed(2) + ' total' : '';
        }

        document.getElementById('depositAmount')?.addEventListener('input', updateDepositPctLabel);

        async function sendDepositRequest() {
            const amount = parseFloat(document.getElementById('depositAmount').value);
            if (!amount || amount <= 0) { alert('Please enter a valid deposit amount'); return; }

            const job = jobs.find(j => j.id === _depositJobId);
            const client = clients.find(c => String(c.id) === String(job?.clientId));
            if (!confirm('Send a $' + amount.toFixed(2) + ' deposit request to ' + (client?.name || 'client') + '?')) return;

            try {
                const resp = await fetch('/api/jobs/' + _depositJobId + '/send-deposit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount })
                });
                const data = await resp.json();
                if (!resp.ok) { alert('Failed: ' + (data.error || 'Unknown error')); return; }
                closeModal('depositModal');
                alert('✅ Deposit request sent!');
                loadJobs();
            } catch (e) {
                alert('Error: ' + e.message);
            }
        }

        async function emailInvoice(jobId) {
            const job = jobs.find(j => j.id == jobId || j._id == jobId);
            if (!job) {
                alert('Job not found');
                return;
            }

            const client = findClient(job.clientId);
            if (!client) {
                alert('Cannot send invoice: Client not found.');
                return;
            }

            // Resolve invoice email — use location contactEmail if set, else client email
            let invoiceEmail = client.email;
            if (job.serviceLocationId && client.serviceLocations) {
                const loc = client.serviceLocations.find(l => String(l.id) === String(job.serviceLocationId));
                if (loc && loc.contactEmail) invoiceEmail = loc.contactEmail;
            }

            if (!invoiceEmail) {
                alert('Cannot send invoice: No email address found for this client or location.\n\nAdd an email to the client or set a Contact Email on the service location.');
                return;
            }

            if (!confirm(\`Send invoice to \${client.name} at \${invoiceEmail}?\`)) {
                return;
            }

            try {
                const response = await fetch('/api/email/send-invoice', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId: job._id || job.id })
                });

                const data = await response.json();

                if (response.ok) {
                    alert(\`✅ Invoice emailed successfully to \${invoiceEmail}!\`);
                } else {
                    alert(\`❌ Failed to send invoice email:\n\${data.error || 'Unknown error'}\n\nMake sure email is configured in Settings > Email Settings.\`);
                }
            } catch (error) {
                alert(\`❌ Error sending invoice email:\n\${error.message}\`);
            }
        }

        function exportJobsToExcel() {
            // Apply current filters to export
            const statusFilter = document.getElementById('filter-status').value;
            const clientFilter = document.getElementById('filter-client').value;
            const assignedFilter = document.getElementById('filter-assigned').value;

            const filteredJobs = getFilteredJobs(statusFilter, clientFilter, assignedFilter);

            if (filteredJobs.length === 0) {
                alert('No jobs to export');
                return;
            }

            const headers = ['Date', 'Time', 'Client', 'Job Title', 'Description', 'Assigned To', 'Status', 'Total Billed', 'Total Paid', 'Balance Owed'];
            const timestamp = new Date().toISOString().split('T')[0];

            exportToCSV(filteredJobs, headers, `jobs_export_${timestamp}.csv`, (j) => {
                const client = findClient(j.clientId);
                const total = j.totalWithTax ? j.totalWithTax : (j.total ? calculateTotalWithTax(parseFloat(j.total)) : 0);
                const paid = j.totalPaid ? parseFloat(j.totalPaid) : 0;
                const owed = total - paid;
                const isPaidInFull = Math.abs(owed) < 0.01;
                const owedDisplay = isPaidInFull ? 0 : owed;

                return [
                    j.scheduledDate || '',
                    j.scheduledTime || '',
                    maskName(client ? client.name : 'Unknown'),
                    j.title || '',
                    (j.description || '').replace(/"/g, '""'),
                    getAssignedNames(j.assignedTo),
                    j.status.replace('_', ' '),
                    total.toFixed(2),
                    paid.toFixed(2),
                    owedDisplay.toFixed(2)
                ];
            });
        }

        function renderTeam() {
            const container = document.getElementById('team-list');
            if (team.length === 0) {
                renderEmptyState(container, 'No team members yet', 'Add your first team member');
                return;
            }

            const sorted = applySortState(team, 'team', { name: 'name', role: 'role', phone: 'phone', email: 'email', city: 'city', status: 'active' });

            const isMobile = window.innerWidth < 768;

            if (isMobile) {
                container.innerHTML = sorted.map(t => {
                    const cityState = [t.city, t.state].filter(x => x).join(', ');
                    return \`<div class="team-card" data-search="\${t.name.toLowerCase()} \${(t.role||'').toLowerCase()} \${(t.email||'').toLowerCase()}" style="background:white;border:2px solid #e2e8f0;border-radius:10px;padding:1rem;margin-bottom:0.75rem;" onclick="viewTeamDetail('\${t.id}')">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.4rem;">
                            <div>
                                <div style="font-size:1.1rem;font-weight:700;color:#2d3748;">\${t.name}</div>
                                <div style="color:#4a5568;font-size:0.9rem;margin-top:0.1rem;">\${t.role || ''}</div>
                            </div>
                            <span class="status-badge \${t.active ? 'status-completed' : 'status-scheduled'}" style="white-space:nowrap;margin-left:0.5rem;">\${t.active ? 'Active' : 'Inactive'}</span>
                        </div>
                        \${t.phone ? \`<div style="color:#4a5568;font-size:0.9rem;">📞 \${formatPhoneNumber(t.phone)}</div>\` : ''}
                        \${t.email ? \`<div style="color:#4a5568;font-size:0.9rem;">✉️ \${t.email}</div>\` : ''}
                        \${cityState ? \`<div style="color:#718096;font-size:0.85rem;margin-top:0.2rem;">📍 \${cityState}</div>\` : ''}
                        <div style="display:flex;gap:0.5rem;margin-top:0.75rem;" onclick="event.stopPropagation()">
                            <button class="btn btn-secondary btn-small" onclick="editTeamMember('\${t.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;"' : ''}>Edit</button>
                            <button class="btn btn-danger btn-small" onclick="deleteTeamMember('\${t.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;"' : ''}>Delete</button>
                        </div>
                    </div>\`;
                }).join('');
            } else {
                container.innerHTML = '<table><thead><tr>' + sth('team','name','Name') + sth('team','role','Role') + sth('team','phone','Phone') + sth('team','email','Email') + sth('team','city','City, State') + sth('team','status','Status') + '<th>Actions</th></tr></thead><tbody>' +
                sorted.map(t => {
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
        }

        async function loadTeam() {
            const response = await fetch('/api/team');
            team = await response.json();
            renderTeam();
        }

        function filterTeam() {
            const searchTerm = document.getElementById('team-search').value.toLowerCase();
            const isMobile = window.innerWidth < 768;
            if (isMobile) {
                document.querySelectorAll('#team-list .team-card').forEach(card => {
                    card.style.display = card.dataset.search.includes(searchTerm) ? '' : 'none';
                });
            } else {
                const table = document.querySelector('#team-list table');
                if (!table) return;
                table.querySelectorAll('tbody tr').forEach(row => {
                    row.style.display = row.textContent.toLowerCase().includes(searchTerm) ? '' : 'none';
                });
            }
        }

        async function viewTeamDetail(teamId) {
            const member = team.find(t => t.id == teamId);
            if (!member) return;

            // Load jobs and clients if not already loaded
            if (jobs.length === 0) {
                await loadJobs();
            }
            if (clients.length === 0) {
                await loadClients();
            }

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
            const memberJobs = jobs.filter(j => isAssignedTo(j, member.id));
            const jobsContainer = document.getElementById('team-detail-jobs');

            console.log('Jobs matching for member:', member.name, 'member.id:', member.id);
            console.log('Total jobs:', jobs.length);
            console.log('Sample job assignedTo:', jobs[0]?.assignedTo, 'type:', typeof jobs[0]?.assignedTo);
            console.log('Matched jobs:', memberJobs.length);

            if (memberJobs.length === 0) {
                jobsContainer.innerHTML = \`
                    <div class="empty-state">
                        <h3>No jobs assigned</h3>
                        <p>Assign jobs to this team member</p>
                        <small style="color: #718096;">Debug: member.id=\${member.id}, found \${jobs.length} total jobs</small>
                    </div>\`;
            } else {
                // Calculate total hours and revenue
                const totalHours = memberJobs.reduce((sum, j) => {
                    const laborHrs = (j.laborItems || []).reduce((s, item) => s + (parseFloat(item.hours) || 0), 0);
                    return sum + laborHrs;
                }, 0);
                const totalRevenue = memberJobs.reduce((sum, j) => sum + (j.totalWithTax || parseFloat(j.total) || 0), 0);

                const isMobile = window.innerWidth < 768;
                const statsGrid = \`
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
                            <div style="font-size: 1.5rem; font-weight: 700;">\${formatMoney(totalRevenue)}</div>
                        </div>
                        <div style="background: #f8f9fa; padding: 1rem; border-radius: 8px;">
                            <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.25rem;">Avg Rate</div>
                            <div style="font-size: 1.5rem; font-weight: 700;">\${totalHours > 0 ? formatMoney(totalRevenue / totalHours) : '$0.00'}/hr</div>
                        </div>
                    </div>\`;

                const jobsHtml = isMobile
                    ? memberJobs.map(j => {
                        const client = clients.find(c => c.id == j.clientId || String(c.id) === String(j.clientId));
                        const total = j.totalWithTax ? j.totalWithTax : (j.total ? calculateTotalWithTax(parseFloat(j.total)) : 0);
                        return \`<div style="background:white;border:2px solid #e2e8f0;border-radius:10px;padding:1rem;margin-bottom:0.75rem;">
                            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.35rem;">
                                <div>
                                    <div style="font-size:1rem;font-weight:700;color:#2d3748;">\${maskName(client ? client.name : 'Unknown')}</div>
                                    <div style="font-weight:600;color:#4a5568;font-size:0.9rem;">\${j.title}</div>
                                </div>
                                <span class="status-badge status-\${j.status}" style="white-space:nowrap;margin-left:0.5rem;">\${j.status.replace('_', ' ')}</span>
                            </div>
                            <div style="color:#718096;font-size:0.85rem;margin-bottom:0.5rem;">\${j.scheduledDate || 'No date'}\${j.scheduledTime ? ' · ' + j.scheduledTime : ''}\${j.hours ? ' · ' + j.hours + 'h' : ''}</div>
                            \${total > 0 ? \`<div style="font-weight:700;color:#2d3748;margin-bottom:0.5rem;">\${formatMoney(total)}</div>\` : ''}
                            <div style="display:flex;gap:0.5rem;">
                                <button class="btn btn-secondary btn-small" onclick="editJob('\${j.id}')">Edit</button>
                                <button class="btn btn-primary btn-small" onclick="window.open('/invoice/\${j.id}', '_blank')">📄</button>
                            </div>
                        </div>\`;
                    }).join('')
                    : '<table><thead><tr><th>Date</th><th>Client</th><th>Job</th><th>Status</th><th>Hours</th><th>Total</th><th>Actions</th></tr></thead><tbody>' +
                    memberJobs.map(j => {
                        const client = clients.find(c => c.id == j.clientId || String(c.id) === String(j.clientId));
                        return \`<tr>
                            <td>\${j.scheduledDate}<br><small>\${j.scheduledTime || ''}</small></td>
                            <td>\${maskName(client ? client.name : 'Unknown')}</td>
                            <td>
                                <strong>\${j.title}</strong><br>
                                <small>\${(j.description || '').substring(0, 50)}</small>
                            </td>
                            <td><span class="status-badge status-\${j.status}">\${j.status.replace('_', ' ')}</span></td>
                            <td>\${((j.laborItems || []).reduce((s, i) => s + (parseFloat(i.hours) || 0), 0)).toFixed(1)}</td>
                            <td>\${j.totalWithTax ? formatMoney(j.totalWithTax) : (j.total ? formatMoney(parseFloat(j.total)) : '-')}</td>
                            <td>
                                <button class="btn btn-secondary btn-small" onclick="editJob('\${j.id}')">Edit</button>
                                <button class="btn btn-primary btn-small" onclick="window.open('/invoice/\${j.id}', '_blank')">📄</button>
                            </td>
                        </tr>\`;
                    }).join('') + '</tbody></table>';

                jobsContainer.innerHTML = statsGrid + jobsHtml;
            }

            // Get all time entries for this member
            const allEntries = await fetch('/api/timeentries').then(r => r.json());

            // Try matching by userId first, then fall back to userName
            let memberEntries = [];
            if (member.userId) {
                memberEntries = allEntries.filter(e => String(e.userId) === String(member.userId));
            }

            // Fallback: match by name if userId doesn't work
            if (memberEntries.length === 0) {
                memberEntries = allEntries.filter(e => e.userName === member.name);
            }

            console.log('Team member:', member.name, 'userId:', member.userId);
            console.log('Total time entries:', allEntries.length);
            console.log('Matched entries:', memberEntries.length);
            console.log('Sample entry:', allEntries[0]);

            // Get approved entries
            const approvedEntries = memberEntries.filter(e => e.status === 'approved');

            if (approvedEntries.length === 0) {
                document.getElementById('team-pay-summary').innerHTML = \`
                    <div class="empty-state">
                        <p>No approved time entries yet</p>
                        <small style="color: #718096;">Debug: Found \${memberEntries.length} total entries, 0 approved</small>
                    </div>\`;
                document.getElementById('team-pay-history').innerHTML = '';
                return;
            }

            // Calculate totals
            const totalHours = approvedEntries.reduce((sum, e) => sum + (e.duration ? e.duration / 3600 : (parseFloat(e.hours) || 0)), 0);
            const totalPayouts = approvedEntries.reduce((sum, e) => sum + (parseFloat(e.paymentAmount) || 0), 0);
            const avgHourlyRate = totalHours > 0 ? totalPayouts / totalHours : 0;

            // Get date range
            const dates = approvedEntries.map(e => new Date(e.clockIn));
            const firstPayout = new Date(Math.min(...dates));
            const lastPayout = new Date(Math.max(...dates));

            // Pay summary stats
            document.getElementById('team-pay-summary').innerHTML = \`
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
                    <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 1.5rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                        <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">Total Payouts</div>
                        <div style="font-size: 2rem; font-weight: 700;">\${formatMoney(totalPayouts)}</div>
                    </div>
                    <div style="background: #f8f9fa; padding: 1.5rem; border-radius: 12px; border: 2px solid #e2e8f0;">
                        <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.5rem;">Total Hours</div>
                        <div style="font-size: 2rem; font-weight: 700; color: #1a202c;">\${totalHours.toFixed(2)}</div>
                    </div>
                    <div style="background: #f8f9fa; padding: 1.5rem; border-radius: 12px; border: 2px solid #e2e8f0;">
                        <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.5rem;">Avg Rate</div>
                        <div style="font-size: 2rem; font-weight: 700; color: #1a202c;">\${formatMoney(avgHourlyRate)}/hr</div>
                    </div>
                    <div style="background: #f8f9fa; padding: 1.5rem; border-radius: 12px; border: 2px solid #e2e8f0;">
                        <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.5rem;">Total Entries</div>
                        <div style="font-size: 2rem; font-weight: 700; color: #1a202c;">\${approvedEntries.length}</div>
                    </div>
                    <div style="background: #f8f9fa; padding: 1.5rem; border-radius: 12px; border: 2px solid #e2e8f0;">
                        <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.5rem;">First Payout</div>
                        <div style="font-size: 1.25rem; font-weight: 600; color: #1a202c;">\${firstPayout.toLocaleDateString()}</div>
                    </div>
                    <div style="background: #f8f9fa; padding: 1.5rem; border-radius: 12px; border: 2px solid #e2e8f0;">
                        <div style="font-size: 0.875rem; color: #718096; margin-bottom: 0.5rem;">Last Payout</div>
                        <div style="font-size: 1.25rem; font-weight: 600; color: #1a202c;">\${lastPayout.toLocaleDateString()}</div>
                    </div>
                </div>
            \`;

            // Sort by date descending
            approvedEntries.sort((a, b) => new Date(b.clockIn) - new Date(a.clockIn));

            // Pay history table
            document.getElementById('team-pay-history').innerHTML = \`
                <table>
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Clock In</th>
                            <th>Clock Out</th>
                            <th>Hours</th>
                            <th>Rate</th>
                            <th>Payout</th>
                            <th>Job</th>
                        </tr>
                    </thead>
                    <tbody>\` +
                        approvedEntries.map(entry => {
                            const clockIn = new Date(entry.clockIn);
                            const clockOut = new Date(entry.clockOut);
                            const job = jobs.find(j => String(j.id) === String(entry.jobId));
                            const client = job ? clients.find(c => String(c.id) === String(job.clientId)) : null;

                            return \`<tr>
                                <td>\${clockIn.toLocaleDateString()}</td>
                                <td>\${clockIn.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</td>
                                <td>\${clockOut.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</td>
                                <td><strong>\${(entry.duration ? entry.duration / 3600 : parseFloat(entry.hours) || 0).toFixed(2)}</strong></td>
                                <td>$\${parseFloat(entry.hourlyRate || 0).toFixed(2)}/hr</td>
                                <td style="color: #10b981; font-weight: 700;">$\${formatMoney(entry.paymentAmount)}</td>
                                <td>\${job ? \`<small>\${maskName(client ? client.name : 'Unknown')}<br><strong>\${job.title}</strong></small>\` : '<small>Job not found</small>'}</td>
                            </tr>\`;
                        }).join('') +
                    \`</tbody>
                </table>
            \`;
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

        async function generateTaxReconciliation() {
            try {
                const yearSelect = document.getElementById('tax-year-select');
                const selectedYear = yearSelect.value;

                let startDate, endDate, yearLabel;

                if (selectedYear === 'current') {
                    const currentYear = new Date().getFullYear();
                    startDate = currentYear + '-01-01';
                    endDate = currentYear + '-12-31';
                    yearLabel = currentYear.toString();
                } else {
                    startDate = selectedYear + '-01-01';
                    endDate = selectedYear + '-12-31';
                    yearLabel = selectedYear;
                }

                // Get completed/invoiced jobs for the year
                const yearJobs = jobs.filter(j => {
                    if (!j.scheduledDate) return false;
                    if (j.status !== 'completed' && j.status !== 'invoiced') return false;
                    return j.scheduledDate >= startDate && j.scheduledDate <= endDate;
                });

                // Calculate total revenue
                const totalRevenue = yearJobs.reduce((sum, j) => sum + (parseFloat(j.total) || 0), 0);

                // Calculate material costs from jobs
                const materialCosts = yearJobs.reduce((sum, j) => {
                    if (j.materialItems && Array.isArray(j.materialItems)) {
                        return sum + j.materialItems.reduce((mSum, item) =>
                            mSum + ((item.quantity || 0) * (item.price || 0)), 0);
                    }
                    return sum;
                }, 0);

                // Get expenses for the year
                let expenses = [];
                try {
                    const expenseResponse = await fetch('/api/expenses');
                    expenses = await expenseResponse.json();
                } catch (err) {
                    console.error('Error loading expenses:', err);
                }

                const yearExpenses = expenses.filter(e => {
                    if (!e.date) return false;
                    return e.date >= startDate && e.date <= endDate;
                });

                const totalExpenses = yearExpenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);

                // Calculate net income
                const netIncome = totalRevenue - materialCosts - totalExpenses;

                // Breakdown by category
                const expensesByCategory = {};
                yearExpenses.forEach(e => {
                    const cat = e.category || 'other';
                    expensesByCategory[cat] = (expensesByCategory[cat] || 0) + (parseFloat(e.amount) || 0);
                });

                const categoryLabels = {
                    vehicle: 'Vehicle & Fuel',
                    tools: 'Tools & Equipment',
                    materials: 'Materials & Supplies',
                    office: 'Office Expenses',
                    utilities: 'Utilities',
                    insurance: 'Insurance',
                    marketing: 'Marketing & Advertising',
                    meals: 'Meals & Entertainment',
                    travel: 'Travel',
                    professional: 'Professional Services',
                    other: 'Other'
                };

                let categoryBreakdown = '';
                Object.keys(expensesByCategory).forEach(cat => {
                    categoryBreakdown += '<tr><td style="padding: 0.5rem; padding-left: 2rem; color: #4a5568;">' +
                        (categoryLabels[cat] || cat) + ':</td><td style="text-align: right;">$' +
                        formatMoney(expensesByCategory[cat]) + '</td></tr>';
                });

                document.getElementById('tax-reconciliation-report').innerHTML = \`
                    <div style="background: white; padding: 1.5rem; border-radius: 8px; border: 2px solid #667eea;">
                        <h4 style="margin-bottom: 1rem; color: #667eea; font-size: 1.3rem;">Tax Year \${yearLabel}</h4>
                        <table style="width: 100%; margin-top: 1rem; font-size: 1rem;">
                            <tr style="background: #f0f9ff;">
                                <td style="padding: 0.75rem; font-weight: 600; font-size: 1.1rem;">Gross Revenue</td>
                                <td style="text-align: right; font-weight: 600; font-size: 1.1rem; color: #48bb78;">$\${totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            </tr>
                            <tr><td colspan="2" style="padding: 0.25rem;"></td></tr>
                            <tr style="background: #fff5f5;">
                                <td style="padding: 0.5rem; font-weight: 600;">Less: Material Costs</td>
                                <td style="text-align: right; color: #e53e3e;">($\${materialCosts.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</td>
                            </tr>
                            <tr style="background: #fff5f5;">
                                <td style="padding: 0.5rem; font-weight: 600;">Less: Business Expenses</td>
                                <td style="text-align: right; color: #e53e3e;">($\${totalExpenses.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</td>
                            </tr>
                            \${categoryBreakdown}
                            <tr><td colspan="2" style="padding: 0.25rem;"></td></tr>
                            <tr style="border-top: 3px solid #667eea; background: #667eea; color: white;">
                                <td style="padding: 1rem; font-weight: 700; font-size: 1.3rem;">Net Income</td>
                                <td style="text-align: right; font-weight: 700; font-size: 1.3rem;">$\${netIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            </tr>
                        </table>
                        <div style="margin-top: 1.5rem; padding: 1rem; background: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 4px;">
                            <p style="margin: 0; color: #78350f; font-size: 0.9rem;">
                                <strong>Note:</strong> This is a preliminary calculation for tax planning purposes.
                                Consult with a qualified tax professional for final tax preparation.
                                Additional deductions may be available based on your business structure and situation.
                            </p>
                        </div>
                        <div style="margin-top: 1rem; display: flex; gap: 1rem;">
                            <button class="btn btn-primary" onclick="printTaxReconciliation()">🖨️ Print Report</button>
                            <button class="btn btn-secondary" onclick="exportTaxReconciliation()">📊 Export to CSV</button>
                        </div>
                    </div>
                \`;

            } catch (error) {
                console.error('Error generating tax reconciliation:', error);
                document.getElementById('tax-reconciliation-report').innerHTML =
                    '<p style="color: #e53e3e; padding: 1rem;">Error generating tax reconciliation: ' + error.message + '</p>';
            }
        }

        function printTaxReconciliation() {
            const content = document.getElementById('tax-reconciliation-report').innerHTML;
            const printWindow = window.open('', '', 'width=800,height=600');
            printWindow.document.write('<html><head><title>Tax Reconciliation</title>');
            printWindow.document.write('<style>body { font-family: Arial, sans-serif; padding: 20px; } table { width: 100%; border-collapse: collapse; }</style>');
            printWindow.document.write('</head><body>');
            printWindow.document.write(content);
            printWindow.document.write('</body></html>');
            printWindow.document.close();
            printWindow.print();
        }

        function exportTaxReconciliation() {
            const yearSelect = document.getElementById('tax-year-select');
            const selectedYear = yearSelect.value === 'current' ? new Date().getFullYear() : yearSelect.value;

            const content = document.getElementById('tax-reconciliation-report').innerText;
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'Tax_Reconciliation_' + selectedYear + '.txt';
            a.click();
            URL.revokeObjectURL(url);
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
                    if (teamFilter && !isAssignedTo(j, teamFilter)) return false;
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
                        <tr><td style="padding: 0.5rem;">Labor Revenue:</td><td style="text-align: right;">\${formatMoney(laborTotal)}</td></tr>
                        <tr><td style="padding: 0.5rem;">Material Revenue:</td><td style="text-align: right;">\${formatMoney(materialTotal)}</td></tr>
                        <tr style="border-top: 2px solid #e2e8f0;"><td style="padding: 0.5rem; font-weight: 600;">Subtotal:</td><td style="text-align: right; font-weight: 600;">\${formatMoney(subtotal)}</td></tr>
                        <tr><td style="padding: 0.5rem;">Tax (\${((settings.taxRate || 0.06625) * 100).toFixed(3)}%):</td><td style="text-align: right;">\${formatMoney(tax)}</td></tr>
                        <tr style="border-top: 2px solid #667eea; color: #667eea;"><td style="padding: 0.5rem; font-weight: 700; font-size: 1.2rem;">Total Revenue:</td><td style="text-align: right; font-weight: 700; font-size: 1.2rem;">\${formatMoney(total)}</td></tr>
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
                        <tr><td style="padding: 0.75rem; border-bottom: 1px solid #e2e8f0;">To Be Scheduled</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${statusCounts.to_be_scheduled || 0}</td><td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${((statusCounts.to_be_scheduled || 0) / total * 100).toFixed(1)}%</td></tr>
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
                const clientName = maskName(client ? client.name : 'Unknown');

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
                                <td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${formatMoney(stats.revenue)}</td>
                            </tr>
                        \`).join('')}
                    </tbody>
                </table>
            \`;
        }

        function generateTeamPerformance(filteredJobs) {
            const teamStats = {};

            filteredJobs.forEach(j => {
                const memberName = getAssignedNames(j.assignedTo);

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
                                <td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${formatMoney(stats.revenue)}</td>
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
                                <td style="padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${formatMoney(revenue)}</td>
                            </tr>
                        \`).join('')}
                        <tr style="background: #f8f9fa; font-weight: 600;">
                            <td style="padding: 0.75rem;">Total</td>
                            <td style="padding: 0.75rem; text-align: right;">\${formatMoney(sortedMonths.reduce((sum, [_, rev]) => sum + rev, 0))}</td>
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
                            return \`
                                <tr>
                                    <td style="padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">\${j.scheduledDate}</td>
                                    <td style="padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">\${maskName(client ? client.name : 'Unknown')}</td>
                                    <td style="padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">\${j.title}</td>
                                    <td style="padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">\${getAssignedNames(j.assignedTo)}</td>
                                    <td style="padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">\${j.status.replace('_', ' ')}</td>
                                    <td style="padding: 0.5rem; text-align: right; border-bottom: 1px solid #e2e8f0;">\${formatMoney(j.totalWithTax || calculateTotalWithTax(parseFloat(j.total) || 0))}</td>
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

        let analyticsRefreshTimer = null;

        async function loadAnalytics() {
            const body = document.getElementById('analyticsBody');
            body.innerHTML = '<div style="text-align:center;padding:3rem;color:#718096;">Loading...</div>';
            if (analyticsRefreshTimer) clearInterval(analyticsRefreshTimer);

            try {
                const res = await fetch('/api/analytics/summary');
                const data = await res.json();

                if (!data.connected) {
                    body.innerHTML = \`
                        <div style="text-align:center;padding:3rem;">
                            <p style="color:#718096;margin-bottom:1.5rem;font-size:1.1rem;">Connect your Google Analytics account to see website traffic in here.</p>
                            <a href="/analytics/auth" class="btn btn-primary" style="font-size:1rem;padding:0.85rem 2rem;">Connect Google Analytics</a>
                        </div>\`;
                    return;
                }

                if (data.needsProperty) {
                    const propsRes = await fetch('/api/analytics/properties');
                    const propsData = await propsRes.json();
                    const properties = [];
                    (propsData.accounts || []).forEach(acc => {
                        (acc.propertySummaries || []).forEach(p => {
                            properties.push({ id: p.property.replace('properties/', ''), name: p.displayName });
                        });
                    });
                    body.innerHTML = \`
                        <div style="text-align:center;padding:3rem;">
                            <p style="color:#718096;margin-bottom:1.5rem;">Select your GA4 property:</p>
                            <select id="propertyPicker" style="padding:0.75rem 1rem;border:2px solid #e2e8f0;border-radius:8px;font-size:1rem;margin-bottom:1rem;min-width:300px;">
                                <option value="">Select property...</option>
                                \${properties.map(p => \`<option value="\${p.id}">\${p.name} (\${p.id})</option>\`).join('')}
                            </select><br>
                            <button class="btn btn-primary" onclick="saveAnalyticsProperty()">Use This Property</button>
                        </div>\`;
                    return;
                }

                renderAnalytics(data);
                analyticsRefreshTimer = setInterval(async () => {
                    const r = await fetch('/api/analytics/summary');
                    const d = await r.json();
                    if (d.connected && !d.needsProperty) {
                        const el = document.getElementById('analyticsActiveCount');
                        if (el) el.textContent = d.activeUsers;
                        document.getElementById('analyticsActiveUsers').style.display = 'inline-block';
                    }
                }, 30000);

            } catch (e) {
                body.innerHTML = \`<div style="color:#e53e3e;padding:2rem;">Error loading analytics: \${e.message}</div>\`;
            }
        }

        async function saveAnalyticsProperty() {
            const id = document.getElementById('propertyPicker').value;
            if (!id) return alert('Select a property first');
            await fetch('/api/analytics/property', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ propertyId: id }) });
            loadAnalytics();
        }

        function renderAnalytics(data) {
            const body = document.getElementById('analyticsBody');

            // Active users badge
            document.getElementById('analyticsActiveCount').textContent = data.activeUsers;
            document.getElementById('analyticsActiveUsers').style.display = 'inline-block';

            // Aggregate 30-day totals
            const rows = data.report?.rows || [];
            const totalSessions = rows.reduce((s, r) => s + parseInt(r.metricValues[0].value), 0);
            const totalUsers = rows.reduce((s, r) => s + parseInt(r.metricValues[1].value), 0);
            const avgDur = rows.length ? rows.reduce((s, r) => s + parseFloat(r.metricValues[2].value), 0) / rows.length : 0;
            const durMin = Math.floor(avgDur / 60);
            const durSec = Math.round(avgDur % 60);

            // Traffic sources
            const sourceRows = data.sources?.rows || [];
            const maxSourceSessions = Math.max(...sourceRows.map(r => parseInt(r.metricValues[0].value)), 1);
            const sourceBars = sourceRows.map(r => {
                const name = r.dimensionValues[0].value;
                const count = parseInt(r.metricValues[0].value);
                const pct = Math.round((count / maxSourceSessions) * 100);
                return \`<div style="margin-bottom:0.75rem;">
                    <div style="display:flex;justify-content:space-between;margin-bottom:0.25rem;font-size:0.9rem;">
                        <span style="font-weight:600;">\${name}</span><span style="color:#718096;">\${count} sessions</span>
                    </div>
                    <div style="background:#e2e8f0;border-radius:4px;height:8px;"><div style="background:#667eea;width:\${pct}%;height:8px;border-radius:4px;"></div></div>
                </div>\`;
            }).join('');

            // Top pages
            const pageRows = data.pages?.rows || [];
            const pagesHtml = pageRows.map(r => {
                const path = r.dimensionValues[0].value;
                const views = parseInt(r.metricValues[0].value);
                return \`<div style="display:flex;justify-content:space-between;padding:0.6rem 0;border-bottom:1px solid #f0f0f0;font-size:0.9rem;">
                    <span style="color:#2d3748;">\${path === '/' ? 'Home' : path}</span>
                    <span style="font-weight:600;color:#667eea;">\${views.toLocaleString()} views</span>
                </div>\`;
            }).join('');

            // Daily sessions sparkline (last 30 days)
            const maxSessions = Math.max(...rows.map(r => parseInt(r.metricValues[0].value)), 1);
            const bars = rows.slice(-30).map(r => {
                const date = r.dimensionValues[0].value;
                const s = parseInt(r.metricValues[0].value);
                const h = Math.max(4, Math.round((s / maxSessions) * 80));
                const label = date.slice(4, 6) + '/' + date.slice(6, 8);
                return \`<div title="\${label}: \${s} sessions" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:2px;cursor:default;">
                    <div style="width:100%;background:#667eea;border-radius:2px 2px 0 0;height:\${h}px;min-height:4px;"></div>
                </div>\`;
            }).join('');

            body.innerHTML = \`
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1.5rem;">
                    <div style="background:#f7fafc;padding:1.25rem;border-radius:10px;text-align:center;">
                        <div style="font-size:2rem;font-weight:700;color:#667eea;">\${totalSessions.toLocaleString()}</div>
                        <div style="color:#718096;font-size:0.85rem;margin-top:0.25rem;">Sessions (30d)</div>
                    </div>
                    <div style="background:#f7fafc;padding:1.25rem;border-radius:10px;text-align:center;">
                        <div style="font-size:2rem;font-weight:700;color:#667eea;">\${totalUsers.toLocaleString()}</div>
                        <div style="color:#718096;font-size:0.85rem;margin-top:0.25rem;">Users (30d)</div>
                    </div>
                    <div style="background:#f7fafc;padding:1.25rem;border-radius:10px;text-align:center;">
                        <div style="font-size:2rem;font-weight:700;color:#667eea;">\${durMin}m \${durSec}s</div>
                        <div style="color:#718096;font-size:0.85rem;margin-top:0.25rem;">Avg Session</div>
                    </div>
                </div>
                <div style="background:#f7fafc;padding:1.25rem;border-radius:10px;margin-bottom:1.5rem;">
                    <div style="font-weight:600;color:#2d3748;margin-bottom:0.75rem;">Daily Sessions — Last 30 Days</div>
                    <div style="display:flex;align-items:flex-end;gap:2px;height:90px;">\${bars}</div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
                    <div style="background:#f7fafc;padding:1.25rem;border-radius:10px;">
                        <div style="font-weight:600;color:#2d3748;margin-bottom:1rem;">Traffic Sources</div>
                        \${sourceBars || '<p style="color:#718096;font-size:0.9rem;">No data yet</p>'}
                    </div>
                    <div style="background:#f7fafc;padding:1.25rem;border-radius:10px;">
                        <div style="font-weight:600;color:#2d3748;margin-bottom:0.5rem;">Top Pages</div>
                        \${pagesHtml || '<p style="color:#718096;font-size:0.9rem;">No data yet</p>'}
                    </div>
                </div>\`;
        }

        async function loadActivityLog() {
            const container = document.getElementById('activityLogList');
            container.innerHTML = '<div style="color:#718096;padding:1rem;">Loading activity...</div>';
            const filterType = document.getElementById('activityFilterType')?.value || '';
            try {
                const res  = await fetch('/api/activity-log?limit=150');
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);
                const filtered = filterType ? data.filter(e => e.type === filterType) : data;
                if (!filtered.length) { container.innerHTML = '<div style="color:#718096;padding:1rem;">No activity found.</div>'; return; }

                const rows = filtered.map(e => {
                    const ts = new Date(e.ts);
                    const dateStr = ts.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
                    const timeStr = ts.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
                    const clientHtml = e.clientName ? \`<span style="color:#667eea;font-size:0.8rem;">\${e.clientName}</span>\` : '';
                    const byHtml    = e.by ? \`<span style="color:#a0aec0;font-size:0.78rem;">by \${e.by}</span>\` : '';
                    return \`
                        <div style="display:grid;grid-template-columns:90px 28px 1fr auto;gap:0.5rem;align-items:start;padding:0.65rem 0;border-bottom:1px solid #f0f0f0;">
                            <div style="font-size:0.78rem;color:#a0aec0;white-space:nowrap;">\${dateStr}<br>\${timeStr}</div>
                            <div style="font-size:1.15rem;line-height:1.4;">\${e.icon}</div>
                            <div>
                                <div style="font-weight:600;font-size:0.875rem;color:#2d3748;">\${e.title}</div>
                                <div style="font-size:0.82rem;color:#718096;margin-top:0.1rem;">\${e.detail}</div>
                                <div style="display:flex;gap:0.5rem;margin-top:0.15rem;">\${clientHtml}\${byHtml}</div>
                            </div>
                        </div>\`;
                }).join('');
                container.innerHTML = \`<div style="font-size:0.8rem;color:#a0aec0;margin-bottom:0.5rem;">\${filtered.length} events</div>\` + rows;
            } catch (e) {
                container.innerHTML = \`<div style="color:#e53e3e;padding:1rem;">Failed to load: \${e.message}</div>\`;
            }
        }

        async function loadReports() {
            try {
                // Load jobs if not already loaded
                if (!jobs || jobs.length === 0) {
                    const response = await fetch('/api/jobs');
                    jobs = await response.json();
                }

                // Populate tax year dropdown
                const currentYear = new Date().getFullYear();
                const taxYearSelect = document.getElementById('tax-year-select');
                let yearOptions = '<option value="current">Current Year (' + currentYear + ')</option>';
                for (let i = 1; i <= 5; i++) {
                    const year = currentYear - i;
                    yearOptions += '<option value="' + year + '">' + year + '</option>';
                }
                taxYearSelect.innerHTML = yearOptions;

                // Populate filter dropdowns
                const clientFilter = document.getElementById('report-filter-client');
                const teamFilter = document.getElementById('report-filter-team');

                clientFilter.innerHTML = '<option value="">All Clients</option>' +
                    clients.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');

                teamFilter.innerHTML = '<option value="">All Team Members</option>' +
                    team.map(t => \`<option value="\${t.id}">\${t.name}</option>\`).join('');

                // Generate tax reconciliation first
                await generateTaxReconciliation();

                // Generate reports with default filters
                await generateReports();
            } catch (error) {
                console.error('Error loading reports:', error);
                alert('Error loading reports: ' + error.message);
            }
        }

        function switchSettingsTab(tabName) {
            // Hide all tab contents
            document.querySelectorAll('.settings-tab-content').forEach(content => {
                content.style.display = 'none';
            });

            // Remove active class from all tabs
            document.querySelectorAll('.settings-tab').forEach(tab => {
                tab.classList.remove('active');
            });

            // Show selected tab content
            const contentId = tabName === 'users' ? 'usersTab-content' : tabName + 'Tab';
            document.getElementById(contentId).style.display = 'block';

            // Add active class to selected tab
            const selectedTab = document.querySelector(`[data-tab="${tabName}"]`);
            if (selectedTab) {
                selectedTab.classList.add('active');
            }

            // Load tab-specific data
            if (tabName === 'email') {
                loadEmailSettings();
            }
            if (tabName === 'compliance') {
                loadComplianceDocs();
            }
        }

        async function loadSettings() {
            const response = await fetch('/api/settings');
            const settings = await response.json();

            // Show/hide user management tab based on admin status
            if (isAdmin) {
                document.getElementById('usersTab').style.display = 'block';
                loadUsers(); // Load users when settings loads
            }

            const form = document.getElementById('settingsForm');

            // App branding
            form.elements.appName.value = settings.appName || 'Jobber Pro';
            updateAppBranding(settings.appName, settings.favicon);

            // Load favicon if exists
            if (settings.favicon) {
                document.getElementById('favicon').value = settings.favicon;
                const preview = document.getElementById('favicon-preview');
                preview.src = settings.favicon;
                preview.style.display = 'block';
                document.getElementById('remove-favicon').style.display = 'inline-block';
            }

            form.elements.companyName.value = settings.companyName || '';
            form.elements.companyAddress.value = settings.companyAddress || '';
            form.elements.companyPhone.value = settings.companyPhone || '';
            form.elements.companyEmail.value = settings.companyEmail || '';
            form.elements.hourlyRate.value = settings.hourlyRate || 75;
            form.elements.taxRatePercent.value = ((settings.taxRate || 0.06625) * 100).toFixed(3);
            form.elements.contractTerms.value = settings.contractTerms || '';

            // Load logo if exists
            if (settings.companyLogo) {
                document.getElementById('companyLogo').value = settings.companyLogo;
                const preview = document.getElementById('logo-preview');
                preview.src = settings.companyLogo;
                preview.style.display = 'block';
                document.getElementById('remove-logo').style.display = 'inline-block';
            }

            // Check SMS status
            const smsStatus = await fetch('/api/sms/status').then(r => r.json()).catch(() => ({ enabled: false }));
            const statusDiv = document.getElementById('smsConfigStatus');
            if (smsStatus.enabled) {
                statusDiv.innerHTML = '<p style="margin: 0; color: #48bb78;"><strong>✓ SMS Enabled</strong> - Text messaging is active</p>';
                statusDiv.style.background = '#f0fff4';
                statusDiv.style.border = '2px solid #9ae6b4';
            } else {
                statusDiv.innerHTML = '<p style="margin: 0; color: #e53e3e;"><strong>⚠ SMS Not Configured</strong> - Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER environment variables on Heroku to enable text messaging.</p>';
                statusDiv.style.background = '#fff5f5';
                statusDiv.style.border = '2px solid #fc8181';
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

        function handleFaviconUpload(event) {
            const file = event.target.files[0];
            if (!file) return;

            // Check file size (max 100KB)
            if (file.size > 100000) {
                alert('File too large! Please use an image under 100KB.');
                return;
            }

            // Check file type
            if (!file.type.match('image.*')) {
                alert('Please upload an image file (ICO, PNG, etc.)');
                return;
            }

            // Read and convert to base64
            const reader = new FileReader();
            reader.onload = function(e) {
                const base64 = e.target.result;
                document.getElementById('favicon').value = base64;

                // Show preview
                const preview = document.getElementById('favicon-preview');
                preview.src = base64;
                preview.style.display = 'block';
                document.getElementById('remove-favicon').style.display = 'inline-block';
            };
            reader.readAsDataURL(file);
        }

        function removeFavicon() {
            document.getElementById('favicon').value = '';
            document.getElementById('favicon-preview').src = '';
            document.getElementById('favicon-preview').style.display = 'none';
            document.getElementById('remove-favicon').style.display = 'none';
            document.getElementById('favicon-upload').value = '';
        }

        function updateAppBranding(appName, favicon) {
            // Update page title
            const title = appName || 'Jobber Pro';
            document.getElementById('page-title').textContent = `${title} - Field Service Management`;

            // Update header
            document.getElementById('header-app-name').textContent = `⚡ ${title}`;

            // Update favicon
            const faviconLink = document.getElementById('page-favicon');
            if (favicon) {
                faviconLink.href = favicon;
            }
        }

        async function saveSettings() {
            const form = document.getElementById('settingsForm');
            const settings = {
                appName: form.elements.appName.value || 'Jobber Pro',
                favicon: document.getElementById('favicon').value || null,
                companyName: form.elements.companyName.value,
                companyAddress: form.elements.companyAddress.value,
                companyPhone: form.elements.companyPhone.value,
                companyEmail: form.elements.companyEmail.value,
                hourlyRate: parseFloat(form.elements.hourlyRate.value),
                taxRate: parseFloat(form.elements.taxRatePercent.value) / 100,
                companyLogo: document.getElementById('companyLogo').value || null,
                contractTerms: form.elements.contractTerms.value
            };

            try {
                await postData('/api/settings', settings, { markClean: true });
                alert('Settings saved successfully!');
                // Update header logo and app branding
                loadHeaderLogo();
                updateAppBranding(settings.appName, settings.favicon);
            } catch (error) {
                alert('Failed to save settings: ' + error.message);
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

        // Email Settings
        async function loadEmailSettings() {
            try {
                const response = await fetch('/api/email/config');
                const config = await response.json();

                // Update status display
                const statusDiv = document.getElementById('emailConfigStatus');
                if (config.configured) {
                    statusDiv.innerHTML = `
                        <p style="margin: 0; color: #48bb78; font-weight: 600;">✅ Email is configured and ready</p>
                        <p style="margin: 0.5rem 0 0 0; font-size: 0.9rem; color: #4a5568;">
                            Sending from: ${config.gmailUser || 'Not set'}
                        </p>
                    `;
                    statusDiv.style.background = '#f0fdf4';
                    statusDiv.style.borderColor = '#48bb78';
                } else {
                    statusDiv.innerHTML = `
                        <p style="margin: 0; color: #f59e0b; font-weight: 600;">⚠️ Email not configured</p>
                        <p style="margin: 0.5rem 0 0 0; font-size: 0.9rem; color: #4a5568;">
                            Enter Gmail API credentials below to enable email functionality
                        </p>
                    `;
                    statusDiv.style.background = '#fffbeb';
                    statusDiv.style.borderColor = '#f59e0b';
                }

                // Load existing values (masked for security)
                if (config.gmailClientId) {
                    document.getElementById('gmailClientId').value = config.gmailClientId;
                }
                if (config.gmailClientSecret) {
                    document.getElementById('gmailClientSecret').placeholder = '••••••••';
                    document.getElementById('gmailClientSecret').dataset.masked = 'true';
                }
                if (config.gmailRefreshToken) {
                    document.getElementById('gmailRefreshToken').placeholder = '••••••••';
                    document.getElementById('gmailRefreshToken').dataset.masked = 'true';
                }
                if (config.gmailUser) {
                    document.getElementById('gmailUser').value = config.gmailUser;
                }

                // Load email templates
                document.getElementById('invoiceEmailSubject').value = config.templates?.invoiceSubject || 'Invoice #{invoiceNumber} from {companyName}';
                document.getElementById('invoiceEmailBody').value = config.templates?.invoiceBody || 'Dear {clientName},\n\nThank you for your business! Your invoice is ready for review.\n\nInvoice #{invoiceNumber}\nJob: {jobTitle}\nTotal: ${total}\n\nView your invoice: {invoiceUrl}\n\nThank you for choosing {companyName}!';
                document.getElementById('credentialsEmailSubject').value = config.templates?.credentialsSubject || 'Your {companyName} Account Credentials';
                document.getElementById('credentialsEmailBody').value = config.templates?.credentialsBody || 'Hi {name},\n\nYour account has been created!\n\nEmail: {email}\nTemporary Password: {tempPassword}\n\nLogin at: {loginUrl}\n\nPlease change your password after logging in.';

                // Load calendar settings
                document.getElementById('calendarAutoSync').checked = config.calendar?.autoSync || false;
                document.getElementById('calendarSendInvites').checked = config.calendar?.sendInvites || false;
                document.getElementById('calendarUpdateOnChange').checked = config.calendar?.updateOnChange || false;
            } catch (error) {
                console.error('Failed to load email settings:', error);
                const statusDiv = document.getElementById('emailConfigStatus');
                statusDiv.innerHTML = `
                    <p style="margin: 0; color: #e53e3e; font-weight: 600;">❌ Error loading email settings</p>
                    <p style="margin: 0.5rem 0 0 0; font-size: 0.9rem;">${error.message}</p>
                `;
                statusDiv.style.background = '#fef2f2';
                statusDiv.style.borderColor = '#e53e3e';
            }
        }

        async function saveEmailSettings() {
            const clientId = document.getElementById('gmailClientId').value.trim();
            const clientSecret = document.getElementById('gmailClientSecret').value.trim();
            const refreshToken = document.getElementById('gmailRefreshToken').value.trim();
            const gmailUser = document.getElementById('gmailUser').value.trim();

            if (!clientId || !gmailUser) {
                alert('Client ID and Gmail User Email are required');
                return;
            }

            // Only include secret/token if they were actually entered (not just placeholder)
            const emailConfig = {
                gmailClientId: clientId,
                gmailUser: gmailUser
            };

            if (clientSecret && !clientSecret.startsWith('•')) {
                emailConfig.gmailClientSecret = clientSecret;
            }
            if (refreshToken && !refreshToken.startsWith('•')) {
                emailConfig.gmailRefreshToken = refreshToken;
            }

            try {
                const response = await fetch('/api/email/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(emailConfig)
                });

                const data = await response.json();

                if (response.ok) {
                    alert('✅ Email settings saved successfully!\n\nEmail service has been reinitialized. Try sending a test email!');
                    loadEmailSettings(); // Reload to show updated status
                } else {
                    alert('❌ Failed to save email settings:\n' + (data.error || 'Unknown error'));
                }
            } catch (error) {
                alert('❌ Error saving email settings:\n' + error.message);
            }
        }

        async function revealSecrets() {
            const password = prompt('Enter your account password to reveal secrets:');
            if (!password) return;

            try {
                // Verify password with backend
                const response = await fetch('/api/email/reveal-secrets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });

                const data = await response.json();

                if (response.ok) {
                    // Reveal and enable editing
                    const secretField = document.getElementById('gmailClientSecret');
                    const tokenField = document.getElementById('gmailRefreshToken');

                    if (data.gmailClientSecret) {
                        secretField.value = data.gmailClientSecret;
                        secretField.type = 'text';
                        secretField.readOnly = false;
                        secretField.dataset.masked = 'false';
                    }

                    if (data.gmailRefreshToken) {
                        tokenField.value = data.gmailRefreshToken;
                        tokenField.type = 'text';
                        tokenField.readOnly = false;
                        tokenField.dataset.masked = 'false';
                    }

                    alert('✅ Secrets revealed! You can now copy or edit them.');
                } else {
                    alert('❌ Incorrect password');
                }
            } catch (error) {
                alert('❌ Error: ' + error.message);
            }
        }

        async function testEmailConnection() {
            const testEmail = prompt('Enter email address to send test message:');
            if (!testEmail) return;

            try {
                const response = await fetch('/api/email/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to: testEmail })
                });

                const data = await response.json();

                if (response.ok) {
                    alert('✅ Test email sent successfully!\n\nCheck ' + testEmail + ' for the test message.');
                } else {
                    alert('❌ Failed to send test email:\n' + (data.error || 'Unknown error') + '\n\nMake sure your Gmail API credentials are correct.');
                }
            } catch (error) {
                alert('❌ Error sending test email:\n' + error.message);
            }
        }

        function toggleGmailApiConfig() {
            const content = document.getElementById('gmailApiConfigContent');
            const icon = document.getElementById('gmailApiToggleIcon');

            if (content.style.display === 'none') {
                content.style.display = 'block';
                icon.textContent = '▼';
            } else {
                content.style.display = 'none';
                icon.textContent = '▶';
            }
        }

        async function saveCalendarSettings() {
            const calendarSettings = {
                autoSync: document.getElementById('calendarAutoSync').checked,
                sendInvites: document.getElementById('calendarSendInvites').checked,
                updateOnChange: document.getElementById('calendarUpdateOnChange').checked
            };

            try {
                const response = await fetch('/api/calendar/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(calendarSettings)
                });

                const data = await response.json();

                if (response.ok) {
                    alert('✅ Calendar settings saved successfully!');
                } else {
                    alert('❌ Failed to save calendar settings:\n' + (data.error || 'Unknown error'));
                }
            } catch (error) {
                alert('❌ Error saving calendar settings:\n' + error.message);
            }
        }

        async function saveEmailTemplates() {
            const templates = {
                invoiceSubject: document.getElementById('invoiceEmailSubject').value,
                invoiceBody: document.getElementById('invoiceEmailBody').value,
                credentialsSubject: document.getElementById('credentialsEmailSubject').value,
                credentialsBody: document.getElementById('credentialsEmailBody').value
            };

            try {
                const response = await fetch('/api/email/templates', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(templates)
                });

                const data = await response.json();

                if (response.ok) {
                    alert('✅ Email templates saved successfully!');
                } else {
                    alert('❌ Failed to save email templates:\n' + (data.error || 'Unknown error'));
                }
            } catch (error) {
                alert('❌ Error saving email templates:\n' + error.message);
            }
        }

        // User management
        let currentEditingUserId = null;

        async function loadUsers() {
            console.log('Loading users...');
            const response = await fetch('/api/users');
            console.log('Response status:', response.status);
            if (response.ok) {
                const users = await response.json();
                console.log('Users loaded:', users);
                const usersList = document.getElementById('usersList');
                console.log('usersList element:', usersList);
                if (!usersList) {
                    console.error('usersList element not found!');
                    return;
                }
                usersList.innerHTML = users.map(user => {
                    const lastLoginText = user.lastLogin
                        ? new Date(user.lastLogin).toLocaleString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                            hour12: true
                          })
                        : 'Never';
                    const role = user.role || (user.isAdmin ? 'admin' : 'user');
                    return \`
                    <div style="padding: 1rem; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong>\${user.name}</strong>
                            <div style="color: #718096; font-size: 0.9rem;">
                                \${user.email} •
                                <span style="color: \${role === 'admin' ? '#667eea' : '#48bb78'}; font-weight: 600;">\${role.toUpperCase()}</span>
                            </div>
                            <div style="color: #a0aec0; font-size: 0.8rem;">
                                Created: \${new Date(user.createdAt).toLocaleDateString()} • Last Login: \${lastLoginText}
                            </div>
                        </div>
                        <div>
                            <button class="btn btn-secondary btn-small" onclick="showLoginLog('\${user._id || user.id}','business','\${user.name}')" style="margin-right:0.5rem;" title="Sign-in history">📋 Log</button>
                            <button class="btn btn-secondary btn-small" onclick="emailUserCredentials('\${user._id || user.id}')" style="margin-right: 0.5rem;" title="Email login credentials">📧 Email Login</button>
                            <button class="btn btn-primary btn-small" onclick="editUser('\${user._id || user.id}')" style="margin-right: 0.5rem;">Edit</button>
                            <button class="btn btn-danger btn-small" onclick="deleteUser('\${user._id || user.id}')">Delete</button>
                        </div>
                    </div>
                \`;
                }).join('');
            } else {
                console.error('Failed to load users:', response.status);
            }
        }

        function switchUserMgmtTab(tab) {
            const tabs = ['business', 'portal'];
            tabs.forEach(t => {
                const btn = document.getElementById(\`umTab-\${t}\`);
                const panel = document.getElementById(\`umPanel-\${t}\`);
                if (t === tab) {
                    btn.style.borderBottomColor = '#667eea';
                    btn.style.color = '#667eea';
                    panel.style.display = '';
                } else {
                    btn.style.borderBottomColor = 'transparent';
                    btn.style.color = '#718096';
                    panel.style.display = 'none';
                }
            });
            if (tab === 'portal') loadPortalUsers();
        }

        let allPortalClients = [];

        function filterPortalUsers() {
            const q = (document.getElementById('portalUserSearch').value || '').toLowerCase();
            const filtered = q ? allPortalClients.filter(c => c.name.toLowerCase().includes(q)) : allPortalClients;
            renderPortalUsers(filtered);
        }

        function renderPortalUsers(portalClients) {
            const container = document.getElementById('portalUsersList');
            if (portalClients.length === 0) {
                container.innerHTML = '<div style="text-align:center;padding:3rem;color:#718096;"><p>No clients found.</p></div>';
                return;
            }
            container.innerHTML = \`
                <table style="width:100%;border-collapse:collapse;">
                    <thead>
                        <tr style="background:#f8f9fa;border-bottom:2px solid #e2e8f0;">
                            <th style="padding:0.75rem 1rem;text-align:left;font-weight:600;color:#4a5568;">Client</th>
                            <th style="padding:0.75rem 1rem;text-align:left;font-weight:600;color:#4a5568;">Email</th>
                            <th style="padding:0.75rem 1rem;text-align:left;font-weight:600;color:#4a5568;">Phone</th>
                            <th style="padding:0.75rem 1rem;text-align:left;font-weight:600;color:#4a5568;">Last Portal Login</th>
                            <th style="padding:0.75rem 1rem;text-align:right;font-weight:600;color:#4a5568;">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${portalClients.map(c => {
                            const lastLogin = c.lastPortalLogin
                                ? new Date(c.lastPortalLogin).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
                                : '<span style="color:#a0aec0;">Never</span>';
                            return \`
                            <tr style="border-bottom:1px solid #e2e8f0;" onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background=''">
                                <td style="padding:0.85rem 1rem;font-weight:500;color:#2d3748;">\${c.name}</td>
                                <td style="padding:0.85rem 1rem;color:#718096;">\${c.email || '—'}</td>
                                <td style="padding:0.85rem 1rem;color:#718096;">\${c.phone || '—'}</td>
                                <td style="padding:0.85rem 1rem;color:#4a5568;font-size:0.9rem;">\${lastLogin}</td>
                                <td style="padding:0.85rem 1rem;text-align:right;">
                                    <button class="btn btn-secondary btn-small" onclick="showLoginLog('\${c.id}','client','\${c.name}')" style="margin-right:0.5rem;" title="Sign-in history">📋 Log</button>
                                    <button class="btn btn-primary btn-small" onclick="showPortalPwModal('\${c.id}','\${c.name.replace(/'/g,'\\\\\'')}')" style="margin-right:0.5rem;" title="Change access code">✏️ Password</button>
                                    \${c.email ? \`<button class="btn btn-secondary btn-small" onclick="sendPortalInfo('\${c.id}')" style="margin-right:0.5rem;" title="Resend portal access email">📧 Email</button>\` : ''}
                                    <button class="btn btn-danger btn-small" onclick="revokePortalAccess('\${c.id}', '\${c.name}')" title="Remove portal access">Revoke</button>
                                </td>
                            </tr>\`;
                        }).join('')}
                    </tbody>
                </table>
                <p style="margin-top:0.75rem;color:#a0aec0;font-size:0.8rem;text-align:right;">\${portalClients.length} client\${portalClients.length !== 1 ? 's' : ''} with portal access</p>
            \`;
        }

        async function loadPortalUsers() {
            const container = document.getElementById('portalUsersList');
            try {
                const response = await fetch('/api/clients');
                const allClients = await response.json();
                allPortalClients = allClients.filter(c => c.portalPassword);
                renderPortalUsers(allPortalClients);
            } catch (error) {
                container.innerHTML = '<p style="color:#e53e3e;padding:1rem;">Failed to load portal users</p>';
            }
        }

        let portalPwClientId = null;
        function showPortalPwModal(clientId, clientName) {
            portalPwClientId = clientId;
            document.getElementById('portalPwClientName').textContent = clientName;
            document.getElementById('portalPwInput').value = '';
            document.getElementById('portalPwError').style.display = 'none';
            openModal('portalPwModal');
        }

        async function savePortalPassword() {
            const pw = document.getElementById('portalPwInput').value.trim();
            const errEl = document.getElementById('portalPwError');
            if (!pw) { errEl.textContent = 'Please enter an access code.'; errEl.style.display = 'block'; return; }
            try {
                const res = await fetch(\`/api/clients/\${portalPwClientId}/set-portal-password\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pw })
                });
                if (!res.ok) throw new Error('Failed');
                closeModal('portalPwModal');
                alert('✅ Access code updated.');
                loadPortalUsers();
            } catch (e) {
                errEl.textContent = 'Failed to update. Try again.';
                errEl.style.display = 'block';
            }
        }

        async function showLoginLog(id, type, name) {
            document.getElementById('loginLogTitle').textContent = \`Sign-In History — \${name}\`;
            document.getElementById('loginLogContent').innerHTML = '<p style="color:#718096;text-align:center;padding:1.5rem;">Loading…</p>';
            openModal('loginLogModal');
            try {
                const url = type === 'business' ? \`/api/users/\${id}/login-log\` : \`/api/clients/\${id}/login-log\`;
                const res = await fetch(url);
                const logs = await res.json();
                if (!logs.length) {
                    document.getElementById('loginLogContent').innerHTML = '<p style="color:#718096;text-align:center;padding:2rem;">No sign-in attempts recorded yet.</p>';
                    return;
                }
                const rows = logs.map(l => {
                    const icon = l.success ? '✅' : '❌';
                    const when = new Date(l.at).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true});
                    return \`<tr style="border-bottom:1px solid #f1f5f9;">
                        <td style="padding:0.6rem 0.75rem;font-size:0.85rem;">\${icon}</td>
                        <td style="padding:0.6rem 0.75rem;font-size:0.82rem;color:#1e293b;">\${when}</td>
                        <td style="padding:0.6rem 0.75rem;font-size:0.82rem;color:\${l.success ? '#16a34a' : '#dc2626'};font-weight:600;">\${l.success ? 'Success' : l.reason || 'Failed'}</td>
                        <td style="padding:0.6rem 0.75rem;font-family:monospace;font-size:0.75rem;color:#94a3b8;">\${l.ip || '—'}</td>
                    </tr>\`;
                }).join('');
                document.getElementById('loginLogContent').innerHTML = \`
                    <table style="width:100%;border-collapse:collapse;">
                        <thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                            <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;width:2rem;"></th>
                            <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;">Time</th>
                            <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;">Result</th>
                            <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;">IP</th>
                        </tr></thead>
                        <tbody>\${rows}</tbody>
                    </table>\`;
            } catch (e) {
                document.getElementById('loginLogContent').innerHTML = '<p style="color:#dc2626;text-align:center;padding:1rem;">Failed to load log.</p>';
            }
        }

        async function revokePortalAccess(clientId, clientName) {
            if (!confirm(\`Remove portal access for \${clientName}? They will no longer be able to log into the client portal.\`)) return;
            const client = clients.find(c => c.id === clientId);
            if (!client) return;
            const updated = { ...client, _id: clientId, portalPassword: null };
            await fetch('/api/clients', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updated)
            });
            await loadClients();
            loadPortalUsers();
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

        async function emailUserCredentials(userId) {
            const response = await fetch('/api/users');
            if (!response.ok) {
                alert('Failed to load user information');
                return;
            }

            const users = await response.json();
            const user = users.find(u => (u._id || u.id) == userId);

            if (!user) {
                alert('User not found');
                return;
            }

            if (!user.email) {
                alert('User has no email address');
                return;
            }

            if (!confirm(\`Send login credentials to ${user.name} at ${user.email}?\n\nNote: This will include their current/temporary password.\`)) {
                return;
            }

            try {
                const emailResponse = await fetch('/api/email/send-credentials', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: user._id || user.id })
                });

                const data = await emailResponse.json();

                if (emailResponse.ok) {
                    alert(\`✅ Login credentials emailed to ${user.email}!\`);
                } else {
                    alert(\`❌ Failed to send credentials email:\n${data.error || 'Unknown error'}\n\nMake sure email is configured in Settings > Email Settings.\`);
                }
            } catch (error) {
                alert(\`❌ Error sending credentials email:\n${error.message}\`);
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
            const clientName = maskName(client ? client.name : 'this client');
            if (!confirm(\`⚠️ Are you sure you want to delete \${clientName}?\n\nThis will also affect all jobs associated with this client.\`)) return;
            await fetch(\`/api/clients/\${id}\`, { method: 'DELETE' });
            loadClients();
        }

        async function deleteJob(id) {
            if (!checkAdminPermission('delete jobs')) return;
            const job = jobs.find(j => j.id == id);
            const jobTitle = job ? job.title : 'this job';
            if (!confirm(\`⚠️ Are you sure you want to delete "\${jobTitle}"?\n\nThis action cannot be undone.\`)) return;
            await fetch(\`/api/jobs/\${id}\`, { method: 'DELETE' });
            loadJobs();
            loadDashboard();
        }

        async function deleteTeamMember(id) {
            if (!checkAdminPermission('delete team members')) return;
            const member = team.find(t => t.id == id);
            const memberName = member ? member.name : 'this team member';
            if (!confirm(\`⚠️ Are you sure you want to delete \${memberName}?\n\nThis will affect all jobs assigned to them.\`)) return;
            await fetch(\`/api/team/\${id}\`, { method: 'DELETE' });
            loadTeam();
        }

        // Expenses Functions
        let currentEditingExpenseId = null;

        let allEmailLogs = [];

        function switchMessagesTab(tab) {
            const inboundPanel = document.getElementById('msg-panel-inbound');
            const outboundPanel = document.getElementById('msg-panel-outbound');
            const inboundBtn = document.getElementById('msg-tab-inbound');
            const outboundBtn = document.getElementById('msg-tab-outbound');

            if (tab === 'inbound') {
                inboundPanel.style.display = '';
                outboundPanel.style.display = 'none';
                inboundBtn.style.borderBottomColor = '#667eea';
                inboundBtn.style.color = '#667eea';
                outboundBtn.style.borderBottomColor = 'transparent';
                outboundBtn.style.color = '#718096';
            } else {
                inboundPanel.style.display = 'none';
                outboundPanel.style.display = '';
                outboundBtn.style.borderBottomColor = '#667eea';
                outboundBtn.style.color = '#667eea';
                inboundBtn.style.borderBottomColor = 'transparent';
                inboundBtn.style.color = '#718096';
                loadEmailLogs();
            }
        }

        async function loadEmailLogs() {
            try {
                const response = await fetch('/api/email-logs');
                allEmailLogs = await response.json();
                filterEmailLogs();
            } catch (error) {
                document.getElementById('email-logs-list').innerHTML = '<p style="color:#e53e3e;padding:1rem;">Failed to load email history</p>';
            }
        }

        function filterEmailLogs() {
            const typeFilter = document.getElementById('email-log-filter').value;
            const searchVal = (document.getElementById('email-log-search').value || '').toLowerCase();
            const filtered = allEmailLogs.filter(log => {
                const matchType = !typeFilter || log.type === typeFilter;
                const matchSearch = !searchVal ||
                    (log.toName || '').toLowerCase().includes(searchVal) ||
                    (log.to || '').toLowerCase().includes(searchVal) ||
                    (log.subject || '').toLowerCase().includes(searchVal) ||
                    (log.trigger || '').toLowerCase().includes(searchVal);
                return matchType && matchSearch;
            });
            renderEmailLogs(filtered);
        }

        function renderEmailLogs(logs) {
            const container = document.getElementById('email-logs-list');
            if (logs.length === 0) {
                container.innerHTML = '<div style="text-align:center;padding:3rem;color:#718096;"><p>No emails found</p><p style="font-size:0.9rem;margin-top:0.5rem;">Emails sent from the app will appear here</p></div>';
                return;
            }

            const typeConfig = {
                invoice:      { icon: '🧾', label: 'Invoice',      color: '#667eea', bg: '#ebf4ff' },
                quote:        { icon: '📋', label: 'Quote',        color: '#38a169', bg: '#f0fff4' },
                credentials:  { icon: '🔑', label: 'Credentials',  color: '#d69e2e', bg: '#fffff0' },
                portal_access:{ icon: '🏠', label: 'Portal Access',color: '#805ad5', bg: '#faf5ff' },
                test:         { icon: '🧪', label: 'Test',         color: '#718096', bg: '#f7fafc' }
            };

            container.innerHTML = \`
                <table style="width:100%;border-collapse:collapse;">
                    <thead>
                        <tr style="background:#f8f9fa;border-bottom:2px solid #e2e8f0;">
                            <th style="padding:0.75rem 1rem;text-align:left;font-weight:600;color:#4a5568;width:110px;">Type</th>
                            <th style="padding:0.75rem 1rem;text-align:left;font-weight:600;color:#4a5568;">Recipient</th>
                            <th style="padding:0.75rem 1rem;text-align:left;font-weight:600;color:#4a5568;">Triggered By</th>
                            <th style="padding:0.75rem 1rem;text-align:left;font-weight:600;color:#4a5568;width:130px;">Sent By</th>
                            <th style="padding:0.75rem 1rem;text-align:right;font-weight:600;color:#4a5568;width:160px;">Date</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${logs.map(log => {
                            const cfg = typeConfig[log.type] || typeConfig.test;
                            const date = new Date(log.sentAt).toLocaleString();
                            return \`<tr style="border-bottom:1px solid #e2e8f0;" onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background=''">
                                <td style="padding:0.85rem 1rem;">
                                    <span style="background:\${cfg.bg};color:\${cfg.color};padding:0.25rem 0.6rem;border-radius:20px;font-size:0.8rem;font-weight:600;white-space:nowrap;">\${cfg.icon} \${cfg.label}</span>
                                </td>
                                <td style="padding:0.85rem 1rem;">
                                    <div style="font-weight:500;color:#2d3748;">\${log.toName || ''}</div>
                                    <div style="font-size:0.82rem;color:#718096;">\${log.to}</div>
                                </td>
                                <td style="padding:0.85rem 1rem;color:#4a5568;font-size:0.9rem;">\${log.trigger || '—'}</td>
                                <td style="padding:0.85rem 1rem;color:#718096;font-size:0.9rem;">\${log.sentBy || '—'}</td>
                                <td style="padding:0.85rem 1rem;text-align:right;color:#718096;font-size:0.85rem;white-space:nowrap;">\${date}</td>
                            </tr>\`;
                        }).join('')}
                    </tbody>
                </table>
                <p style="margin-top:0.75rem;color:#a0aec0;font-size:0.8rem;text-align:right;">\${logs.length} email\${logs.length !== 1 ? 's' : ''} shown</p>
            \`;
        }

        async function loadMessages() {
            try {
                const response = await fetch('/api/client-messages');
                const messages = await response.json();

                const container = document.getElementById('messages-list');
                updateMessagesBadge(messages);

                if (messages.length === 0) {
                    container.innerHTML = '<div style="text-align:center;padding:3rem;color:#718096;"><p>No messages yet</p><p style="font-size:0.9rem;margin-top:0.5rem;">Client messages will appear here</p></div>';
                    return;
                }

                const active = messages.filter(m => !m.archived);
                const archived = messages.filter(m => m.archived);

                const renderMsg = (msg) => {
                    const date = new Date(msg.createdAt).toLocaleString();
                    const isUnread = !msg.read;
                    let subjectBadge = '';
                    if (msg.subject === 'quote' && msg.reference) {
                        subjectBadge = \`<span style="background:#667eea;color:white;padding:0.25rem 0.5rem;border-radius:4px;font-size:0.75rem;margin-left:0.5rem;">📋 \${msg.reference}</span>\`;
                    } else if (msg.subject === 'job' && msg.reference) {
                        subjectBadge = \`<span style="background:#48bb78;color:white;padding:0.25rem 0.5rem;border-radius:4px;font-size:0.75rem;margin-left:0.5rem;">🔨 Job</span>\`;
                    }
                    const id = msg.id || msg._id;
                    return \`<div style="background:\${isUnread ? '#fffacd' : 'white'};border:2px solid \${isUnread ? '#f59e0b' : '#e2e8f0'};border-radius:8px;padding:1.5rem;margin-bottom:1rem;">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;">
                            <div>
                                <h3 style="margin:0;color:#2d3748;">\${msg.clientName}\${subjectBadge}</h3>
                                <p style="margin:0.25rem 0 0 0;color:#718096;font-size:0.9rem;">\${msg.clientEmail}</p>
                            </div>
                            <div style="text-align:right;">
                                <p style="margin:0;color:#718096;font-size:0.85rem;">\${date}</p>
                                \${isUnread ? '<span style="background:#f59e0b;color:white;padding:0.25rem 0.5rem;border-radius:4px;font-size:0.75rem;font-weight:600;">NEW</span>' : ''}
                            </div>
                        </div>
                        <div style="background:#f8fafc;padding:1rem;border-radius:4px;border-left:3px solid #667eea;margin-bottom:1rem;">
                            <p style="margin:0;white-space:pre-wrap;line-height:1.6;">\${msg.message}</p>
                        </div>
                        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                            \${isUnread ? \`<button class="btn btn-primary btn-small" onclick="markMessageRead('\${id}')">Mark as Read</button>\` : ''}
                            \${msg.archived
                                ? \`<button class="btn btn-secondary btn-small" onclick="archiveMessage('\${id}', false)">↩ Unarchive</button>\`
                                : \`<button class="btn btn-secondary btn-small" onclick="archiveMessage('\${id}', true)">📁 Archive</button>\`
                            }
                            <a href="mailto:\${msg.clientEmail}" class="btn btn-secondary btn-small">📧 Email</a>
                            <button class="btn btn-danger btn-small" onclick="deleteMessage('\${id}')">Delete</button>
                        </div>
                    </div>\`;
                };

                let html = '';

                if (active.length > 0) {
                    html += active.map(renderMsg).join('');
                } else {
                    html += '<p style="color:#718096;padding:0.75rem 0;">No active messages.</p>';
                }

                if (archived.length > 0) {
                    html += \`<details style="margin-top:1.5rem;">
                        <summary style="cursor:pointer;font-weight:700;color:#4a5568;font-size:0.95rem;padding:0.6rem 0.75rem;background:#f1f5f9;border-radius:8px;list-style:none;display:flex;align-items:center;gap:0.5rem;">
                            <span style="font-size:0.8rem;">▶</span> Archive <span style="background:#9ca3af;color:white;border-radius:999px;padding:1px 8px;font-size:0.75rem;font-weight:600;">\${archived.length}</span>
                        </summary>
                        <div style="margin-top:1rem;">
                            \${archived.map(renderMsg).join('')}
                        </div>
                    </details>\`;
                }

                container.innerHTML = html;
            } catch (error) {
                console.error('Failed to load messages:', error);
            }
        }

        async function archiveMessage(messageId, archive) {
            try {
                await fetch(\`/api/client-messages/\${messageId}/archive\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ archived: archive })
                });
                loadMessages();
            } catch (error) {
                alert('Failed to archive message');
            }
        }

        function updateMessagesBadge(messages) {
            const unreadCount = messages.filter(m => !m.read).length;
            const badge = document.getElementById('messages-badge');

            if (unreadCount > 0) {
                badge.textContent = unreadCount;
                badge.style.display = 'block';
            } else {
                badge.style.display = 'none';
            }
        }

        async function checkUnreadMessages() {
            try {
                const response = await fetch('/api/client-messages');
                const messages = await response.json();
                updateMessagesBadge(messages);
            } catch (error) {
                console.error('Failed to check unread messages:', error);
            }
        }

        let _lastMessageCount = 0;
        let _lastLeadCount = 0;
        let _lastPortalQuoteCount = 0;
        let _notifPermAsked = false;

        function updatePageTitleBadge(total) {
            const base = document.title.replace(/^\(\d+\)\s*/, '');
            document.title = total > 0 ? \`(\${total}) \${base}\` : base;
        }

        function fireNotification(title, body) {
            if (window.Notification && Notification.permission === 'granted') {
                new Notification(title, { body, icon: '/favicon.ico' });
            }
        }

        async function pollNotificationCounts() {
            try {
                const res = await fetch('/api/notifications/counts');
                if (!res.ok) return;
                const { messages, leads, expiringDocs, portalQuotes } = await res.json();

                // Compliance expiry badge on settings tab
                const compTabBtn = document.getElementById('complianceTabBtn');
                if (compTabBtn) {
                    if (expiringDocs > 0) {
                        compTabBtn.innerHTML = \`🛡️ License & Insurance <span style="background:#ef4444;color:white;border-radius:10px;padding:0.1rem 0.45rem;font-size:0.72rem;font-weight:700;margin-left:4px;">\${expiringDocs}</span>\`;
                    } else {
                        compTabBtn.textContent = '🛡️ License & Insurance';
                    }
                }

                // Update badges
                const msgBadge = document.getElementById('messages-badge');
                if (msgBadge) {
                    msgBadge.textContent = messages;
                    msgBadge.style.display = messages > 0 ? 'block' : 'none';
                }
                const leadBadge = document.getElementById('leads-badge');
                if (leadBadge) {
                    leadBadge.textContent = leads;
                    leadBadge.style.display = leads > 0 ? 'inline' : 'none';
                }
                const quotesBadge = document.getElementById('quotes-badge');
                if (quotesBadge) {
                    quotesBadge.textContent = portalQuotes;
                    quotesBadge.style.display = portalQuotes > 0 ? 'inline' : 'none';
                }

                // Bot dot — show if anything new
                const botDot = document.getElementById('activityBotDot');
                if (botDot) botDot.style.display = (messages + leads + portalQuotes) > 0 ? 'block' : 'none';

                // Page title
                updatePageTitleBadge(messages + leads + portalQuotes);

                // Browser notifications on new arrivals
                if (messages > _lastMessageCount) {
                    const n = messages - _lastMessageCount;
                    fireNotification('New Message', \`You have \${n} new client message\${n > 1 ? 's' : ''}.\`);
                }
                if (leads > _lastLeadCount) {
                    const n = leads - _lastLeadCount;
                    fireNotification('New Lead', \`You have \${n} new lead\${n > 1 ? 's' : ''} waiting.\`);
                }
                if (portalQuotes > _lastPortalQuoteCount) {
                    const n = portalQuotes - _lastPortalQuoteCount;
                    fireNotification('New Work Order', \`\${n} new portal work order\${n > 1 ? 's' : ''} waiting for review.\`);
                }

                // Proactive Maddox alert on new arrivals
                const _prevTotal = _lastMessageCount + _lastLeadCount + _lastPortalQuoteCount;
                const _curTotal = messages + leads + portalQuotes;
                if (_curTotal > _prevTotal) {
                    const _panel = document.getElementById('activityBotPanel');
                    if (_panel && _panel.style.display === 'none') {
                        clippyAnim('clippyAlert 0.5s ease-in-out 3');
                        setTimeout(() => clippyAnim('clippyIdle 3s ease-in-out infinite'), 1700);
                    }
                }
                // Mood state
                if (_curTotal > 0) {
                    setMaddoxMood('alert');
                } else {
                    fetch('/api/dashboard').then(r => r.json()).then(dash => {
                        if (dash.totalAccountsReceivable > 500) setMaddoxMood('concerned');
                        else if (dash.jobsToday > 0) setMaddoxMood('excited');
                        else setMaddoxMood('happy');
                    }).catch(() => {});
                }

                _lastMessageCount = messages;
                _lastLeadCount = leads;
                _lastPortalQuoteCount = portalQuotes;

                // If leads are in memory, keep in sync too
                if (typeof allLeads !== 'undefined' && allLeads.length > 0) {
                    updateLeadsBadge();
                }
            } catch (e) {
                // silent — don't spam console on every poll failure
            }
        }

        // ── Compliance / License & Insurance ─────────────────────────────────────

        const _compTypeLabels = {
            license: 'License',
            gl_insurance: 'Insurance — General Liability',
            umbrella_insurance: 'Insurance — Umbrella',
            workers_comp: 'Workers Compensation',
            surety_bond: 'Surety Bond',
            other: 'Other'
        };

        async function loadComplianceDocs() {
            try {
                const res = await fetch('/api/compliance-docs');
                if (!res.ok) throw new Error('Failed to load');
                _complianceDocs = await res.json();
                renderComplianceDocs();
            } catch (e) {
                const el = document.getElementById('compDocsList');
                if (el) el.innerHTML = '<p style="color:#718096;">Failed to load documents.</p>';
            }
        }

        function renderComplianceDocs() {
            const container = document.getElementById('compDocsList');
            if (!container) return;
            const now = new Date();
            const warn30 = new Date(); warn30.setDate(warn30.getDate() + 30);
            const expiring = _complianceDocs.filter(d => d.expiresAt && new Date(d.expiresAt) <= warn30);
            const banner = document.getElementById('compDocExpiryWarning');
            if (expiring.length > 0) {
                const expired = expiring.filter(d => new Date(d.expiresAt) < now);
                const soon = expiring.filter(d => new Date(d.expiresAt) >= now);
                let msg = '';
                if (expired.length) msg += \`\${expired.length} document\${expired.length > 1 ? 's' : ''} expired. \`;
                if (soon.length) msg += \`\${soon.length} document\${soon.length > 1 ? 's' : ''} expiring within 30 days.\`;
                document.getElementById('compDocExpiryText').textContent = msg.trim();
                if (banner) banner.style.display = 'block';
            } else {
                if (banner) banner.style.display = 'none';
            }
            if (_complianceDocs.length === 0) {
                container.innerHTML = '<p style="color:#718096;text-align:center;padding:2rem 0;">No documents uploaded yet. Click "+ Add Document" to get started.</p>';
                return;
            }
            const rows = _complianceDocs.map(doc => {
                const expiry = doc.expiresAt ? new Date(doc.expiresAt) : null;
                const expired = expiry && expiry < now;
                const expiringSoon = expiry && expiry >= now && expiry <= warn30;
                let statusBadge;
                if (!expiry) statusBadge = '<span style="background:#e2e8f0;color:#718096;padding:0.2rem 0.6rem;border-radius:12px;font-size:0.75rem;font-weight:600;">No Expiry</span>';
                else if (expired) statusBadge = '<span style="background:#fee2e2;color:#dc2626;padding:0.2rem 0.6rem;border-radius:12px;font-size:0.75rem;font-weight:600;">Expired</span>';
                else if (expiringSoon) statusBadge = '<span style="background:#fef3c7;color:#92400e;padding:0.2rem 0.6rem;border-radius:12px;font-size:0.75rem;font-weight:600;">Expires Soon</span>';
                else statusBadge = '<span style="background:#d1fae5;color:#065f46;padding:0.2rem 0.6rem;border-radius:12px;font-size:0.75rem;font-weight:600;">Active</span>';
                const expiryStr = expiry ? expiry.toLocaleDateString() : '—';
                const notesStr = doc.notes ? \`<span style="color:#718096;font-size:0.82rem;">\${doc.notes}</span>\` : '';
                return \`<tr>
                    <td style="padding:0.75rem 1rem;">\${_compTypeLabels[doc.type] || doc.type}</td>
                    <td style="padding:0.75rem 1rem;">
                        <div style="font-weight:600;color:#2d3748;">\${doc.filename}</div>
                        \${notesStr}
                    </td>
                    <td style="padding:0.75rem 1rem;">\${expiryStr}</td>
                    <td style="padding:0.75rem 1rem;">\${statusBadge}</td>
                    <td style="padding:0.75rem 1rem;">
                        <div style="display:flex;gap:0.5rem;">
                            <button class="btn btn-secondary btn-small" onclick="downloadComplianceDoc('\${doc._id}')">⬇ Download</button>
                            <button class="btn btn-secondary btn-small" onclick="openEditComplianceDoc('\${doc._id}')">Edit</button>
                            <button class="btn btn-secondary btn-small" style="color:#dc2626;border-color:#fecaca;" onclick="deleteComplianceDoc('\${doc._id}')">Delete</button>
                        </div>
                    </td>
                </tr>\`;
            }).join('');
            container.innerHTML = \`<table style="width:100%;border-collapse:collapse;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
                <thead>
                    <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                        <th style="padding:0.75rem 1rem;text-align:left;color:#4a5568;font-size:0.85rem;">Type</th>
                        <th style="padding:0.75rem 1rem;text-align:left;color:#4a5568;font-size:0.85rem;">Document</th>
                        <th style="padding:0.75rem 1rem;text-align:left;color:#4a5568;font-size:0.85rem;">Expires</th>
                        <th style="padding:0.75rem 1rem;text-align:left;color:#4a5568;font-size:0.85rem;">Status</th>
                        <th style="padding:0.75rem 1rem;text-align:left;color:#4a5568;font-size:0.85rem;">Actions</th>
                    </tr>
                </thead>
                <tbody>\${rows}</tbody>
            </table>\`;
        }

        function handleCompDocFileSelect(event) {
            const file = event.target.files[0];
            if (!file) return;
            document.getElementById('compDocFileName').textContent = file.name;
            const reader = new FileReader();
            reader.onload = (e) => {
                _compDocFileData = { name: file.name, type: file.type, data: e.target.result.split(',')[1] };
            };
            reader.readAsDataURL(file);
        }

        async function uploadComplianceDoc() {
            if (!_compDocFileData) { alert('Please choose a file first.'); return; }
            const type = document.getElementById('compDocType').value;
            const expiresAt = document.getElementById('compDocExpiry').value || null;
            const notes = document.getElementById('compDocNotes').value.trim();
            try {
                const res = await fetch('/api/compliance-docs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type, expiresAt, notes, filename: _compDocFileData.name, mimeType: _compDocFileData.type, data: _compDocFileData.data })
                });
                if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
                _compDocFileData = null;
                document.getElementById('compDocFile').value = '';
                document.getElementById('compDocFileName').textContent = 'No file chosen';
                document.getElementById('compDocExpiry').value = '';
                document.getElementById('compDocNotes').value = '';
                document.getElementById('compDocUploadForm').style.display = 'none';
                loadComplianceDocs();
            } catch (e) {
                alert('Upload failed: ' + e.message);
            }
        }

        async function deleteComplianceDoc(docId) {
            if (!confirm('Delete this document?')) return;
            try {
                await fetch('/api/compliance-docs/' + docId, { method: 'DELETE' });
                loadComplianceDocs();
            } catch (e) {
                alert('Delete failed: ' + e.message);
            }
        }

        function openEditComplianceDoc(docId) {
            const doc = _complianceDocs.find(d => d._id === docId);
            if (!doc) return;
            document.getElementById('editCompDocId').value = docId;
            document.getElementById('editCompDocType').value = doc.type;
            document.getElementById('editCompDocExpiry').value = doc.expiresAt
                ? new Date(doc.expiresAt).toISOString().split('T')[0] : '';
            document.getElementById('editCompDocNotes').value = doc.notes || '';
            openModal('editComplianceModal');
        }

        async function saveComplianceDocEdit() {
            const docId = document.getElementById('editCompDocId').value;
            const type = document.getElementById('editCompDocType').value;
            const expiresAt = document.getElementById('editCompDocExpiry').value || null;
            const notes = document.getElementById('editCompDocNotes').value.trim();
            const btn = document.querySelector('#editComplianceModal .btn-primary');
            btn.textContent = 'Saving...'; btn.disabled = true;
            try {
                const res = await fetch('/api/compliance-docs/' + docId, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type, expiresAt, notes })
                });
                if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
                closeModal('editComplianceModal');
                loadComplianceDocs();
            } catch (e) {
                alert('Save failed: ' + e.message);
            } finally {
                btn.textContent = 'Save Changes'; btn.disabled = false;
            }
        }

        async function downloadComplianceDoc(docId) {
            const doc = _complianceDocs.find(d => d._id === docId);
            const filename = doc ? doc.filename : 'document';
            const res = await fetch('/api/compliance-docs/' + docId + '/file');
            if (!res.ok) { alert('Download failed'); return; }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
        }

        async function openSendComplianceModal(clientId) {
            if (!clientId) { alert('Open a client first.'); return; }
            _sendCompClientId = clientId;
            const clientName = document.getElementById('client-detail-name')?.textContent || 'Client';
            document.getElementById('sendCompClientName').textContent = clientName;
            document.getElementById('sendCompMessage').value = '';
            const checkboxes = document.getElementById('sendCompDocCheckboxes');
            checkboxes.innerHTML = '<p style="color:#718096;">Loading...</p>';
            openModal('sendComplianceModal');

            // Always fetch fresh so modal works even if Settings tab was never opened
            try {
                const res = await fetch('/api/compliance-docs');
                if (!res.ok) throw new Error('Failed to load');
                _complianceDocs = await res.json();
            } catch (e) {
                checkboxes.innerHTML = '<p style="color:#e53e3e;">Failed to load documents.</p>';
                return;
            }

            if (_complianceDocs.length === 0) {
                checkboxes.innerHTML = '<p style="color:#718096;">No documents on file. Upload documents in Settings → 🛡️ License & Insurance first.</p>';
            } else {
                checkboxes.innerHTML = _complianceDocs.map(doc => \`
                    <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;padding:0.5rem 0.75rem;border:2px solid #e2e8f0;border-radius:8px;background:#f8fafc;">
                        <input type="checkbox" value="\${doc._id}" style="width:16px;height:16px;accent-color:#667eea;" checked>
                        <span style="font-weight:600;">\${_compTypeLabels[doc.type] || doc.type}</span>
                        <span style="color:#718096;font-size:0.85rem;">\${doc.filename}</span>
                    </label>
                \`).join('');
            }
        }

        async function sendComplianceDocs() {
            const checked = [...document.querySelectorAll('#sendCompDocCheckboxes input[type=checkbox]:checked')].map(c => c.value);
            if (checked.length === 0) { alert('Select at least one document.'); return; }
            const message = document.getElementById('sendCompMessage').value.trim();
            const btn = document.querySelector('#sendComplianceModal .btn-primary');
            const origText = btn.textContent;
            btn.textContent = 'Sending...'; btn.disabled = true;
            try {
                const res = await fetch('/api/compliance-docs/send-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId: _sendCompClientId, docIds: checked, message })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Send failed');
                closeModal('sendComplianceModal');
                alert('Documents sent successfully!');
            } catch (e) {
                alert('Failed to send: ' + e.message);
            } finally {
                btn.textContent = origText; btn.disabled = false;
            }
        }

        // ── End Compliance ────────────────────────────────────────────────────────

        function initNotificationPolling() {
            // Ask for browser notification permission once
            if (!_notifPermAsked && window.Notification && Notification.permission === 'default') {
                _notifPermAsked = true;
                Notification.requestPermission();
            }
            pollNotificationCounts();
            setInterval(pollNotificationCounts, 30000);
            pollNudges();
            setInterval(pollNudges, 5 * 60 * 1000);

            // Morning briefing — auto-open Maddox once per calendar day
            const todayStr = new Date().toDateString();
            if (localStorage.getItem('maddoxBriefDate') !== todayStr) {
                localStorage.setItem('maddoxBriefDate', todayStr);
                setTimeout(() => {
                    const panel = document.getElementById('activityBotPanel');
                    if (panel && panel.style.display === 'none') toggleActivityBot();
                }, 2500);
            }
        }

        async function markMessageRead(messageId) {
            try {
                await fetch(`/api/client-messages/${messageId}/read`, { method: 'POST' });
                loadMessages();
            } catch (error) {
                alert('Failed to mark message as read');
            }
        }

        async function deleteMessage(messageId) {
            if (!confirm('Delete this message?')) return;

            try {
                await fetch(`/api/client-messages/${messageId}`, { method: 'DELETE' });
                loadMessages();
            } catch (error) {
                alert('Failed to delete message');
            }
        }

        let allLeads = [];

        function openLightbox(src) {
            let lb = document.getElementById('gsd-lightbox');
            if (!lb) {
                lb = document.createElement('div');
                lb.id = 'gsd-lightbox';
                lb.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;align-items:center;justify-content:center;';
                lb.innerHTML = '<img id="gsd-lightbox-img" style="max-width:92vw;max-height:88vh;border-radius:8px;"><button onclick="document.getElementById(\'gsd-lightbox\').style.display=\'none\'" style="position:absolute;top:1rem;right:1.25rem;background:none;border:none;color:white;font-size:2rem;cursor:pointer;">✕</button>';
                lb.addEventListener('click', e => { if (e.target === lb) lb.style.display = 'none'; });
                document.body.appendChild(lb);
            }
            document.getElementById('gsd-lightbox-img').src = src;
            lb.style.display = 'flex';
        }

        async function loadLeads() {
            const response = await fetch('/api/leads');
            allLeads = await response.json();
            updateLeadsBadge();
            renderLeads();
        }

        function updateLeadsBadge() {
            const newCount = allLeads.filter(l => l.status === 'new').length;
            const badge = document.getElementById('leads-badge');
            if (badge) {
                badge.textContent = newCount;
                badge.style.display = newCount > 0 ? 'inline' : 'none';
            }
        }

        function filterLeads() { renderLeads(); }

        function renderLeads() {
            const container = document.getElementById('leads-list');
            const statusFilter = document.getElementById('lead-status-filter').value;
            const searchFilter = document.getElementById('lead-search').value.toLowerCase();

            let filtered = allLeads;
            if (statusFilter) filtered = filtered.filter(l => l.status === statusFilter);
            if (searchFilter) filtered = filtered.filter(l =>
                (l.name || '').toLowerCase().includes(searchFilter) ||
                (l.phone || '').includes(searchFilter)
            );

            if (filtered.length === 0) {
                renderEmptyState(container, 'No leads yet', 'Quote requests from your website will appear here');
                return;
            }

            const activeLeadsSorted = applySortState(filtered.filter(l => l.status === 'new'), 'leads', { date: 'createdAt', name: 'name', service: 'service', city: 'city', status: 'status' });
            const archiveLeadsSorted = applySortState(filtered.filter(l => l.status !== 'new'), 'leads', { date: 'createdAt', name: 'name', service: 'service', city: 'city', status: 'status' });
            const activeLeads = activeLeadsSorted;
            const archiveLeads = archiveLeadsSorted;

            const statusColors = { new: '#3b82f6', contacted: '#f59e0b', quoted: '#8b5cf6', won: '#10b981', lost: '#6b7280', rejected: '#dc2626' };

            const photoStrip = (photos) => {
                if (!photos || !photos.length) return '';
                return \`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:0.5rem;">\${
                    photos.map(p => \`<img src="\${p}" style="width:72px;height:54px;object-fit:cover;border-radius:5px;border:1.5px solid #e2e8f0;cursor:pointer;" onclick="openLightbox(this.src)" title="Click to expand">\`).join('')
                }</div>\`;
            };

            const isMobile = window.innerWidth < 768;

            const renderCards = (leads) => leads.map(l => {
                const date = new Date(l.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                const color = statusColors[l.status] || '#6b7280';
                return \`<div style="background:white;border:2px solid #e2e8f0;border-radius:10px;padding:1rem;margin-bottom:0.75rem;">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5rem;">
                        <div>
                            <div style="font-size:1.1rem;font-weight:700;color:#2d3748;">\${l.name}</div>
                            <div style="font-weight:600;color:#4a5568;margin-top:0.1rem;">\${l.service}</div>
                        </div>
                        <span style="background:\${color};color:white;padding:3px 10px;border-radius:100px;font-size:0.72rem;font-weight:700;white-space:nowrap;margin-left:0.5rem;text-transform:uppercase;letter-spacing:0.03em;">\${l.status}</span>
                    </div>
                    <div style="color:#718096;font-size:0.85rem;margin-bottom:0.4rem;">
                        \${l.phone ? \`📞 <a href="tel:\${l.phone}" style="color:#1d6fa4;font-weight:600;">\${l.phone}</a>\` : ''}
                        \${l.city ? \` · 📍 \${l.city}\` : ''}
                    </div>
                    <div style="color:#718096;font-size:0.8rem;margin-bottom:0.5rem;">📅 \${date} · via \${l.contactPref || 'phone'}</div>
                    \${l.description ? \`<div style="color:#4a5568;font-size:0.85rem;padding:0.5rem 0.6rem;background:#f8f9fa;border-radius:6px;margin-bottom:0.5rem;">\${l.description}</div>\` : ''}
                    \${photoStrip(l.photos)}
                    \${l.note ? \`<div style="color:#6b7280;font-size:0.8rem;margin-top:0.4rem;font-style:italic;">📝 \${l.note}</div>\` : ''}
                    <div style="display:flex;gap:0.5rem;margin-top:0.75rem;align-items:center;">
                        <button onclick="openLead('\${l.id}')" style="padding:0.4rem 0.8rem;background:#667eea;color:white;border:none;border-radius:6px;font-size:0.85rem;cursor:pointer;font-weight:600;">Open</button>
                        <select onchange="updateLeadStatus('\${l.id}', this.value)" style="flex:1;padding:0.4rem 0.6rem;border:1.5px solid #e2e8f0;border-radius:6px;font-size:0.85rem;background:white;">
                            \${['new','contacted','quoted','won','lost','rejected'].map(s => \`<option value="\${s}" \${l.status===s?'selected':''}>\${s.charAt(0).toUpperCase()+s.slice(1)}</option>\`).join('')}
                        </select>
                        <button onclick="deleteLead('\${l.id}')" style="padding:0.4rem 0.7rem;background:#fee2e2;color:#dc2626;border:1.5px solid #fca5a5;border-radius:6px;font-size:0.85rem;cursor:pointer;white-space:nowrap;">🗑</button>
                    </div>
                </div>\`;
            }).join('');

            const renderTable = (leads) => \`<table><thead><tr>\` + sth('leads','createdAt','Date') + sth('leads','name','Name') + \`<th>Contact</th>\` + sth('leads','service','Service') + sth('leads','city','Location') + \`<th>Description & Photos</th>\` + sth('leads','status','Status') + \`<th></th></tr></thead><tbody>\` +
                leads.map(l => {
                    const date = new Date(l.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    const color = statusColors[l.status] || '#6b7280';
                    return \`<tr>
                        <td style="white-space:nowrap;">\${date}</td>
                        <td><strong>\${l.name}</strong></td>
                        <td>
                            \${l.phone ? \`<a href="tel:\${l.phone}" style="color:#1d6fa4;">\${l.phone}</a>\` : ''}
                            \${l.email ? \`<br><small style="color:#6b7280;">\${l.email}</small>\` : ''}
                        </td>
                        <td>\${l.service}</td>
                        <td>\${l.city || '-'}</td>
                        <td style="max-width:200px;">
                            \${l.description ? \`<div style="font-size:0.85rem;color:#4a5568;margin-bottom:0.3rem;">\${l.description.substring(0,60)}\${l.description.length > 60 ? '...' : ''}</div>\` : ''}
                            \${l.photos && l.photos.length ? \`<span style="font-size:0.78rem;color:#667eea;">📷 \${l.photos.length} photo\${l.photos.length>1?'s':''}</span>\` : ''}
                        </td>
                        <td>
                            <select onchange="updateLeadStatus('\${l.id}', this.value)" style="padding:0.35rem 0.5rem;border:1.5px solid #e2e8f0;border-radius:6px;font-size:0.8rem;background:\${color};color:white;">
                                \${['new','contacted','quoted','won','lost','rejected'].map(s => \`<option value="\${s}" style="background:white;color:#1f2937;" \${l.status===s?'selected':''}>\${s.charAt(0).toUpperCase()+s.slice(1)}</option>\`).join('')}
                            </select>
                        </td>
                        <td style="white-space:nowrap;">
                            <button onclick="openLead('\${l.id}')" style="padding:0.3rem 0.6rem;background:#667eea;color:white;border:none;border-radius:6px;font-size:0.8rem;cursor:pointer;margin-right:4px;">Open</button>
                            <button onclick="deleteLead('\${l.id}')" style="padding:0.3rem 0.6rem;background:#fee2e2;color:#dc2626;border:1.5px solid #fca5a5;border-radius:6px;font-size:0.8rem;cursor:pointer;">🗑</button>
                        </td>
                    </tr>\`;
                }).join('') + \`</tbody></table>\`;

            let html = '';

            if (activeLeads.length > 0) {
                html += isMobile ? renderCards(activeLeads) : renderTable(activeLeads);
            } else if (!statusFilter && !searchFilter) {
                html += \`<p style="color:#718096;padding:0.75rem 0;">No new leads.</p>\`;
            }

            if (archiveLeads.length > 0) {
                html += \`<details style="margin-top:1.5rem;">
                    <summary style="cursor:pointer;font-weight:700;color:#4a5568;font-size:0.95rem;padding:0.6rem 0.75rem;background:#f1f5f9;border-radius:8px;list-style:none;display:flex;align-items:center;gap:0.5rem;">
                        <span style="font-size:0.8rem;">▶</span> Archive (${archiveLeads.length})
                    </summary>
                    <div style="margin-top:1rem;">
                        \${isMobile ? renderCards(archiveLeads) : renderTable(archiveLeads)}
                    </div>
                </details>\`;
            }

            container.innerHTML = html;
        }

        function openLead(id) {
            const l = allLeads.find(l => l.id === id);
            if (!l) return;
            const statusColors = { new: '#3b82f6', contacted: '#f59e0b', quoted: '#8b5cf6', won: '#10b981', lost: '#6b7280', rejected: '#dc2626' };
            const color = statusColors[l.status] || '#6b7280';
            const date = new Date(l.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            document.getElementById('leadModalName').textContent = l.name;
            document.getElementById('leadModalBody').innerHTML = \`
                <div style="display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1rem;">
                    <span style="background:\${color};color:white;padding:4px 14px;border-radius:100px;font-size:0.8rem;font-weight:700;text-transform:uppercase;">\${l.status}</span>
                    <span style="color:#718096;font-size:0.9rem;">📅 \${date}</span>
                    \${l.city ? \`<span style="color:#718096;font-size:0.9rem;">📍 \${l.city}</span>\` : ''}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem;">
                    <div><div style="font-size:0.75rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.2rem;">Service</div><div style="font-weight:600;">\${l.service}</div></div>
                    \${l.phone ? \`<div><div style="font-size:0.75rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.2rem;">Phone</div><div><a href="tel:\${l.phone}" style="color:#1d6fa4;font-weight:600;">\${l.phone}</a></div></div>\` : ''}
                    \${l.email ? \`<div><div style="font-size:0.75rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.2rem;">Email</div><div><a href="mailto:\${l.email}" style="color:#1d6fa4;">\${l.email}</a></div></div>\` : ''}
                    <div><div style="font-size:0.75rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.2rem;">Contact Via</div><div>\${l.contactPref || 'phone'}</div></div>
                    \${(l.foundUs || (l.tracking && (l.tracking.utmSource || l.tracking.referer))) ? \`<div style="grid-column:1/-1;"><div style="font-size:0.75rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.2rem;">How They Found Us</div><div style="font-size:0.9rem;">
                        \${l.foundUs ? \`<span style="background:#eff6ff;color:#1d4ed8;padding:2px 8px;border-radius:100px;font-size:0.8rem;font-weight:600;">\${({'google_search':'Google Search','google_maps':'Google Maps','facebook':'Facebook','nextdoor':'Nextdoor','referral':'Friend / Neighbor','flyer_sign':'Flyer / Sign','returning':'Returning Customer','other':'Other'}[l.foundUs] || l.foundUs)}</span>\` : ''}
                        \${(l.tracking && l.tracking.utmSource) ? \`<span style="background:#f0fdf4;color:#166534;padding:2px 8px;border-radius:100px;font-size:0.8rem;margin-left:4px;">utm: \${l.tracking.utmSource}\${l.tracking.utmMedium ? ' / '+l.tracking.utmMedium : ''}</span>\` : ''}
                        \${(l.tracking && l.tracking.referer && !l.tracking.utmSource) ? \`<span style="background:#faf5ff;color:#6b21a8;padding:2px 8px;border-radius:100px;font-size:0.8rem;margin-left:4px;">via \${(function(u){try{return new URL(u).hostname;}catch(e){return u;}})(l.tracking.referer)}</span>\` : ''}
                    </div></div>\` : ''}
                </div>
                \${l.description ? \`<div style="margin-bottom:1rem;"><div style="font-size:0.75rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.4rem;">Description</div><div style="background:#f8f9fa;padding:0.75rem;border-radius:8px;color:#374151;line-height:1.6;white-space:pre-wrap;">\${l.description}</div></div>\` : ''}
                \${l.photos && l.photos.length ? \`<div style="margin-bottom:1rem;"><div style="font-size:0.75rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.4rem;">Photos (\${l.photos.length})</div><div style="display:flex;flex-wrap:wrap;gap:8px;">\${l.photos.map(p => \`<img src="\${p}" style="width:140px;height:105px;object-fit:cover;border-radius:8px;border:1.5px solid #e2e8f0;cursor:pointer;" onclick="openLightbox(this.src)">\`).join('')}</div></div>\` : ''}
                \${l.note ? \`<div style="margin-bottom:1rem;"><div style="font-size:0.75rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.4rem;">Note</div><div style="color:#4a5568;font-style:italic;">\${l.note}</div></div>\` : ''}
                <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid #e2e8f0;">
                    <h4 style="font-size:0.85rem;color:#4a5568;font-weight:700;margin-bottom:0.6rem;">Touch Points</h4>
                    <div id="leadTouchPointsList" style="margin-bottom:0.75rem;">\${
                        (l.touchPoints && l.touchPoints.length)
                        ? l.touchPoints.slice().reverse().map(tp =>
                            \`<div style="background:#f7fafc;border-left:3px solid #667eea;padding:0.6rem 0.75rem;margin-bottom:0.4rem;border-radius:4px;">
                                <div style="display:flex;justify-content:space-between;align-items:start;">
                                    <div style="font-size:0.8rem;color:#4a5568;"><strong>\${tp.user}</strong> · \${new Date(tp.timestamp).toLocaleString()}</div>
                                    <button onclick="removeLeadTouchPoint('\${l.id}',\${tp.id})" style="background:transparent;border:none;color:#e53e3e;cursor:pointer;padding:0;font-size:1.1rem;line-height:1;">&times;</button>
                                </div>
                                <div style="color:#1a202c;font-size:0.9rem;margin-top:0.2rem;">\${tp.note}</div>
                            </div>\`
                        ).join('')
                        : '<p style="color:#718096;font-style:italic;font-size:0.85rem;">No touch points yet.</p>'
                    }</div>
                    <div style="display:flex;gap:0.5rem;margin-bottom:1rem;">
                        <input type="text" id="newLeadTouchPoint" placeholder="Add a note..." style="flex:1;padding:0.45rem 0.6rem;border:1.5px solid #e2e8f0;border-radius:6px;font-size:0.9rem;">
                        <button onclick="addLeadTouchPoint('\${l.id}')" style="padding:0.45rem 0.9rem;background:#667eea;color:white;border:none;border-radius:6px;font-weight:600;cursor:pointer;">Add</button>
                    </div>
                </div>
                <div style="padding-top:1rem;border-top:1px solid #e2e8f0;display:flex;gap:0.75rem;align-items:flex-end;flex-wrap:wrap;">
                    <div style="flex:1;min-width:160px;">
                        <label style="font-size:0.8rem;color:#4a5568;font-weight:600;">Update Status</label>
                        <select onchange="updateLeadStatus('\${l.id}', this.value)" style="width:100%;margin-top:0.4rem;padding:0.5rem;border:1.5px solid #e2e8f0;border-radius:6px;background:white;">
                            \${['new','contacted','quoted','won','lost','rejected'].map(s => \`<option value="\${s}" \${l.status===s?'selected':''}>\${s.charAt(0).toUpperCase()+s.slice(1)}</option>\`).join('')}
                        </select>
                    </div>
                    <button onclick="convertLeadToQuote('\${l.id}')" style="padding:0.55rem 1.1rem;background:#48bb78;color:white;border:none;border-radius:8px;font-weight:700;font-size:0.9rem;cursor:pointer;white-space:nowrap;">➡️ Convert to Quote</button>
                </div>
            \`;
            document.getElementById('leadModal').classList.add('active');
        }

        function closeLeadModal() {
            document.getElementById('leadModal').classList.remove('active');
        }

        async function addLeadTouchPoint(leadId) {
            const input = document.getElementById('newLeadTouchPoint');
            const noteText = input.value.trim();
            if (!noteText) return;
            const lead = allLeads.find(l => l.id === leadId);
            if (!lead) return;
            const tp = { id: Date.now(), note: noteText, timestamp: new Date().toISOString(), user: document.getElementById('currentUserName').textContent };
            lead.touchPoints = [...(lead.touchPoints || []), tp];
            await fetch(\`/api/leads/\${leadId}\`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ touchPoints: lead.touchPoints }) });
            input.value = '';
            openLead(leadId);
        }

        async function removeLeadTouchPoint(leadId, tpId) {
            if (!confirm('Remove this touch point?')) return;
            const lead = allLeads.find(l => l.id === leadId);
            if (!lead) return;
            lead.touchPoints = (lead.touchPoints || []).filter(tp => tp.id !== tpId);
            await fetch(\`/api/leads/\${leadId}\`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ touchPoints: lead.touchPoints }) });
            openLead(leadId);
        }

        async function convertLeadToQuote(leadId) {
            const l = allLeads.find(l => l.id === leadId);
            if (!l) return;

            // Find existing client by phone match
            let client = l.phone
                ? clients.find(c => c.phone && c.phone.replace(/\D/g,'') === l.phone.replace(/\D/g,''))
                : null;

            if (!client) {
                // Auto-create client from lead data
                const r = await fetch('/api/clients', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: l.name, phone: l.phone || '', email: l.email || '', address: l.city || '' })
                });
                const data = await r.json();
                if (!data.id) { alert('Failed to create client.'); return; }
                client = { id: data.id, _id: data.id, name: l.name, phone: l.phone || '', email: l.email || '' };
                clients.push(client);
            }

            closeLeadModal();
            showAddQuoteModal();
            setQuoteClientById(client.id || client._id);
            document.querySelector('#quoteForm [name="title"]').value = l.service || '';
            document.querySelector('#quoteForm [name="description"]').value = l.description || '';

            // Mark lead as quoted
            updateLeadStatus(leadId, 'quoted');
        }

        async function updateLeadStatus(id, status) {
            await fetch(\`/api/leads/\${id}\`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status })
            });
            const lead = allLeads.find(l => l.id === id);
            if (lead) lead.status = status;
            updateLeadsBadge();
            renderLeads();
        }

        async function deleteLead(id) {
            if (!confirm('Delete this lead? Photos will also be removed. This cannot be undone.')) return;
            const r = await fetch(\`/api/leads/\${id}\`, { method: 'DELETE' });
            if (r.ok) {
                allLeads = allLeads.filter(l => l.id !== id);
                updateLeadsBadge();
                renderLeads();
            } else {
                alert('Failed to delete lead.');
            }
        }

        async function loadExpenses() {
            const response = await fetch('/api/expenses');
            expenses = await response.json();
            filterExpenses();
        }

        function filterExpenses() {
            const searchTerm = document.getElementById('expense-search').value.toLowerCase();
            const categoryFilter = document.getElementById('expense-category-filter').value;

            const filtered = expenses.filter(e => {
                const matchesSearch = !searchTerm ||
                    (e.vendor || '').toLowerCase().includes(searchTerm) ||
                    (e.description || '').toLowerCase().includes(searchTerm) ||
                    (e.category || '').toLowerCase().includes(searchTerm);
                const matchesCategory = !categoryFilter || e.category === categoryFilter;
                return matchesSearch && matchesCategory;
            });

            renderExpenses(filtered);
        }

        function renderExpenses(expensesToRender) {
            const container = document.getElementById('expenses-list');

            if (expensesToRender.length === 0) {
                renderEmptyState(container, 'No expenses yet', 'Add your first business expense to get started');
                return;
            }

            const categoryLabels = {
                vehicle: 'Vehicle & Fuel',
                tools: 'Tools & Equipment',
                materials: 'Materials & Supplies',
                office: 'Office Expenses',
                utilities: 'Utilities',
                insurance: 'Insurance',
                marketing: 'Marketing & Advertising',
                meals: 'Meals & Entertainment',
                travel: 'Travel',
                professional: 'Professional Services',
                other: 'Other'
            };

            const sorted = applySortState(expensesToRender, 'expenses', { date: 'date', category: 'category', vendor: 'vendor', description: 'description', amount: 'amount', paymentMethod: 'paymentMethod' });

            container.innerHTML = '<table><thead><tr>' + sth('expenses','date','Date') + sth('expenses','category','Category') + sth('expenses','vendor','Vendor') + sth('expenses','description','Description') + sth('expenses','amount','Amount') + sth('expenses','paymentMethod','Payment Method') + '<th>Actions</th></tr></thead><tbody>' +
                sorted.map(e => \`<tr>
                    <td>\${e.date || '-'}</td>
                    <td>\${categoryLabels[e.category] || e.category}</td>
                    <td>\${e.vendor || '-'}</td>
                    <td>\${e.description || '-'}</td>
                    <td style="font-weight: 600;">\${formatMoney(parseFloat(e.amount) || 0)}</td>
                    <td>\${(e.paymentMethod || 'cash').replace('_', ' ')}</td>
                    <td>
                        <button class="btn btn-secondary btn-small" onclick="showExpenseDetail('\${e.id}')" style="margin-right:0.25rem;" title="Receipts &amp; comments">📎 \${(e.attachments||[]).length > 0 ? e.attachments.length : ''}</button>
                        <button class="btn btn-secondary btn-small" onclick="editExpense('\${e.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''} style="margin-right:0.25rem;">Edit</button>
                        <button class="btn btn-danger btn-small" onclick="deleteExpense('\${e.id}')" \${!isAdmin ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Delete</button>
                    </td>
                </tr>\`).join('') +
                '</tbody></table>';
        }

        let stagedExpenseFiles = []; // { file, dataUrl, comment }

        function openExpenseModal(expense = null) {
            if (!isAdmin) {
                alert('You do not have permission to create or edit expenses.');
                return;
            }

            const form = document.getElementById('expenseForm');
            currentEditingExpenseId = null;
            stagedExpenseFiles = [];
            document.getElementById('expenseModalFileInput').value = '';

            if (expense) {
                document.getElementById('expenseModalTitle').textContent = 'Edit Expense';
                currentEditingExpenseId = expense._id || expense.id;
                Object.keys(expense).forEach(key => {
                    const input = form.elements[key];
                    if (input) input.value = expense[key] || '';
                });
            } else {
                document.getElementById('expenseModalTitle').textContent = 'Add Expense';
                form.reset();
                form.elements.date.value = new Date().toISOString().split('T')[0];
            }

            renderExpenseModalAttachments(expense?.attachments || []);
            document.getElementById('expenseModal').classList.add('active');
        }

        function renderExpenseModalAttachments(existing) {
            const c = document.getElementById('expenseModalAttachmentsList');
            const existingHtml = existing.map(att => {
                const icon = (att.type||'').startsWith('image/') ? '🖼️' : '📄';
                return \`<div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0.6rem;background:#f0fff4;border-radius:6px;margin-bottom:0.3rem;font-size:0.85rem;">
                    <span>\${icon}</span><span style="flex:1;color:#2d3748;">\${att.name}</span>
                    <span style="color:#a0aec0;font-size:0.75rem;">saved</span>
                </div>\`;
            }).join('');
            const stagedHtml = stagedExpenseFiles.map((f, i) => {
                const icon = f.file.type.startsWith('image/') ? '🖼️' : '📄';
                return \`<div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0.6rem;background:#ebf8ff;border-radius:6px;margin-bottom:0.3rem;font-size:0.85rem;">
                    <span>\${icon}</span><span style="flex:1;color:#2d3748;">\${f.file.name}</span>
                    <button type="button" onclick="removeStagedExpenseFile(\${i})" style="background:none;border:none;color:#e53e3e;cursor:pointer;font-size:0.85rem;">✕</button>
                </div>\`;
            }).join('');
            c.innerHTML = existingHtml + stagedHtml || '';
        }

        function removeStagedExpenseFile(index) {
            stagedExpenseFiles.splice(index, 1);
            const exp = currentEditingExpenseId ? expenses.find(e => e.id === currentEditingExpenseId) : null;
            renderExpenseModalAttachments(exp?.attachments || []);
        }

        async function stageExpenseFiles(event) {
            const existing = currentEditingExpenseId ? (expenses.find(e => e.id === currentEditingExpenseId)?.attachments || []) : [];
            for (let file of event.target.files) {
                if (file.type.startsWith('image/')) { try { file = await optimizeImage(file); } catch (_) {} }
                const dataUrl = await new Promise(resolve => { const r = new FileReader(); r.onload = e => resolve(e.target.result); r.readAsDataURL(file); });
                stagedExpenseFiles.push({ file, dataUrl });
            }
            event.target.value = '';
            renderExpenseModalAttachments(existing);
        }

        function editExpense(id) {
            if (!isAdmin) {
                alert('You do not have permission to edit expenses.');
                return;
            }
            const expense = expenses.find(e => e.id == id || e._id == id);
            if (expense) openExpenseModal(expense);
        }

        async function saveExpense() {
            const form = document.getElementById('expenseForm');
            const formData = new FormData(form);
            const expense = Object.fromEntries(formData);

            if (currentEditingExpenseId) {
                expense._id = currentEditingExpenseId;
            }

            try {
                const res = await fetch('/api/expenses', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(expense)
                });
                if (!res.ok) throw new Error('Failed to save expense');
                const saved = await res.json();
                const expenseId = currentEditingExpenseId || (saved.id?.toString() || saved.id);

                // Upload any staged files
                for (const { file, dataUrl } of stagedExpenseFiles) {
                    try {
                        await fetch(\`/api/expenses/\${expenseId}/attachments\`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ fileName: file.name, fileType: file.type, fileData: dataUrl, comment: '' })
                        });
                    } catch (_) { alert(\`Failed to upload "\${file.name}"\`); }
                }
                stagedExpenseFiles = [];
                closeModal('expenseModal');
                loadExpenses();
            } catch (error) {
                alert('Failed to save expense: ' + error.message);
            }
        }

        async function deleteExpense(id) {
            if (!isAdmin) {
                alert('You do not have permission to delete expenses.');
                return;
            }
            if (!confirm('⚠️ Are you sure you want to delete this expense?')) return;
            await fetch(\`/api/expenses/\${id}\`, { method: 'DELETE' });
            loadExpenses();
        }

        // ── Expense Receipts & Comments ──────────────────────────────
        let currentExpenseId = null;

        async function showExpenseDetail(id) {
            currentExpenseId = id;
            const expense = expenses.find(e => e.id === id || e._id === id);
            const label = expense ? (expense.vendor || expense.description || 'Expense') : 'Expense';
            document.getElementById('expenseDetailTitle').textContent = \`📎 \${label}\`;
            document.getElementById('expenseCommentInput').value = '';
            openModal('expenseDetailModal');
            renderExpenseAttachments(expense?.attachments || []);
            renderExpenseComments(expense?.comments || []);
        }

        function renderExpenseAttachments(attachments) {
            const c = document.getElementById('expenseAttachmentsList');
            if (!attachments.length) {
                c.innerHTML = '<p style="color:#a0aec0;font-style:italic;font-size:0.9rem;">No receipts uploaded yet.</p>';
                return;
            }
            c.innerHTML = attachments.map(att => {
                const isImg = (att.type || '').startsWith('image/');
                const kb = att.size ? (att.size / 1024).toFixed(1) + ' KB' : '';
                const icon = isImg ? '🖼️' : '📄';
                const date = att.uploadedAt ? new Date(att.uploadedAt).toLocaleDateString() : '';
                return \`<div style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 0.75rem;background:#f7fafc;border-radius:8px;margin-bottom:0.5rem;">
                    <span style="font-size:1.4rem;">\${icon}</span>
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:600;color:#2d3748;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${att.name}</div>
                        <div style="font-size:0.78rem;color:#a0aec0;">\${kb}\${date ? ' · ' + date : ''}\${att.uploadedBy ? ' · ' + att.uploadedBy : ''}</div>
                        \${att.comment ? \`<div style="font-size:0.85rem;color:#4a5568;font-style:italic;margin-top:0.1rem;">"\${att.comment}"</div>\` : ''}
                    </div>
                    \${isImg ? \`<button class="btn btn-secondary btn-small" onclick="viewExpenseAttachment('\${att.s3Key}')">View</button>\` : ''}
                    <button class="btn btn-secondary btn-small" onclick="downloadExpenseAttachment('\${att.s3Key}','\${att.name}')">⬇</button>
                    <button class="btn btn-danger btn-small" onclick="deleteExpenseAttachment('\${att.id}')">✕</button>
                </div>\`;
            }).join('');
        }

        function renderExpenseComments(comments) {
            const c = document.getElementById('expenseCommentsList');
            if (!comments.length) {
                c.innerHTML = '<p style="color:#a0aec0;font-style:italic;font-size:0.9rem;">No comments yet.</p>';
                return;
            }
            c.innerHTML = comments.map(cm => {
                const when = new Date(cm.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true});
                return \`<div style="padding:0.65rem 0.75rem;background:#f7fafc;border-radius:8px;margin-bottom:0.5rem;position:relative;">
                    <div style="font-size:0.78rem;color:#a0aec0;margin-bottom:0.2rem;">\${cm.author} · \${when}</div>
                    <div style="color:#2d3748;">\${cm.text}</div>
                    \${isAdmin ? \`<button onclick="deleteExpenseComment('\${cm.id}')" style="position:absolute;top:0.4rem;right:0.5rem;background:none;border:none;color:#e53e3e;cursor:pointer;font-size:0.8rem;">✕</button>\` : ''}
                </div>\`;
            }).join('');
        }

        async function handleExpenseFileSelect(event) {
            const files = event.target.files;
            if (!files.length) return;
            for (let file of files) {
                const isImage = file.type.startsWith('image/');
                if (isImage) { try { file = await optimizeImage(file); } catch (_) {} }
                const comment = prompt(\`Description for "\${file.name}" (optional):\`, '') ?? '';
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const res = await fetch(\`/api/expenses/\${currentExpenseId}/attachments\`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ fileName: file.name, fileType: file.type, fileData: e.target.result, comment })
                        });
                        if (!res.ok) throw new Error();
                        const { attachment } = await res.json();
                        const exp = expenses.find(e => e.id === currentExpenseId);
                        if (exp) { exp.attachments = [...(exp.attachments || []), attachment]; renderExpenseAttachments(exp.attachments); }
                        loadExpenses();
                    } catch (_) { alert(\`Failed to upload "\${file.name}"\`); }
                };
                reader.readAsDataURL(file);
            }
            event.target.value = '';
        }

        async function deleteExpenseAttachment(attachmentId) {
            if (!confirm('Remove this attachment?')) return;
            await fetch(\`/api/expenses/\${currentExpenseId}/attachments/\${attachmentId}\`, { method: 'DELETE' });
            const exp = expenses.find(e => e.id === currentExpenseId);
            if (exp) { exp.attachments = (exp.attachments || []).filter(a => a.id !== attachmentId); renderExpenseAttachments(exp.attachments); }
            loadExpenses();
        }

        async function viewExpenseAttachment(s3Key) {
            if (!s3Key) return;
            const res = await fetch(\`/api/file/\${s3Key}\`);
            if (!res.ok) { alert('Could not load file.'); return; }
            const { url } = await res.json();
            window.open(url, '_blank');
        }

        async function downloadExpenseAttachment(s3Key, name) {
            if (!s3Key) return;
            const res = await fetch(\`/api/file/\${s3Key}\`);
            if (!res.ok) { alert('Could not download file.'); return; }
            const { url } = await res.json();
            const a = document.createElement('a'); a.href = url; a.download = name;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        }

        async function addExpenseComment() {
            const input = document.getElementById('expenseCommentInput');
            const text = input.value.trim();
            if (!text) return;
            const res = await fetch(\`/api/expenses/\${currentExpenseId}/comments\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            if (!res.ok) { alert('Failed to post comment.'); return; }
            const { comment } = await res.json();
            input.value = '';
            const exp = expenses.find(e => e.id === currentExpenseId);
            if (exp) { exp.comments = [...(exp.comments || []), comment]; renderExpenseComments(exp.comments); }
        }

        async function deleteExpenseComment(commentId) {
            if (!confirm('Delete this comment?')) return;
            await fetch(\`/api/expenses/\${currentExpenseId}/comments/\${commentId}\`, { method: 'DELETE' });
            const exp = expenses.find(e => e.id === currentExpenseId);
            if (exp) { exp.comments = (exp.comments || []).filter(c => c.id !== commentId); renderExpenseComments(exp.comments); }
        }
        // ────────────────────────────────────────────────────────────

        function exportExpensesToExcel() {
            const searchTerm = document.getElementById('expense-search').value.toLowerCase();
            const categoryFilter = document.getElementById('expense-category-filter').value;

            const filtered = expenses.filter(e => {
                const matchesSearch = !searchTerm ||
                    (e.vendor || '').toLowerCase().includes(searchTerm) ||
                    (e.description || '').toLowerCase().includes(searchTerm);
                const matchesCategory = !categoryFilter || e.category === categoryFilter;
                return matchesSearch && matchesCategory;
            });

            const headers = ['Date', 'Category', 'Vendor', 'Description', 'Amount', 'Payment Method', 'Notes'];
            const timestamp = new Date().toISOString().split('T')[0];

            exportToCSV(filtered, headers, `expenses_export_${timestamp}.csv`, (e) => [
                e.date || '',
                e.category || '',
                e.vendor || '',
                e.description || '',
                (parseFloat(e.amount) || 0).toFixed(2),
                e.paymentMethod || '',
                e.notes || ''
            ]);
        }

        // SMS Functions
        let currentSMSClientId = null;
        let currentSMSJobId = null;

        function openSMSModal(phone, clientId, jobId) {
            currentSMSClientId = clientId;
            currentSMSJobId = jobId;
            document.getElementById('smsTo').value = phone;
            document.getElementById('smsMessage').value = '';
            document.getElementById('smsCharCount').textContent = '0';
            document.getElementById('smsStatus').style.display = 'none';
            document.getElementById('smsModal').classList.add('active');
        }

        document.getElementById('smsMessage')?.addEventListener('input', function() {
            const count = this.value.length;
            document.getElementById('smsCharCount').textContent = count;
        });

        async function sendManualSMS() {
            const to = document.getElementById('smsTo').value;
            const message = document.getElementById('smsMessage').value.trim();
            const statusDiv = document.getElementById('smsStatus');

            if (!message) {
                statusDiv.innerHTML = '<span style="color: #e53e3e;">Please enter a message</span>';
                statusDiv.style.display = 'block';
                statusDiv.style.background = '#fff5f5';
                statusDiv.style.border = '1px solid #fc8181';
                return;
            }

            try {
                const response = await fetch('/api/sms/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        to,
                        message,
                        clientId: currentSMSClientId,
                        jobId: currentSMSJobId
                    })
                });

                const result = await response.json();

                if (result.success) {
                    statusDiv.innerHTML = '<span style="color: #48bb78;">✓ Message sent successfully!</span>';
                    statusDiv.style.display = 'block';
                    statusDiv.style.background = '#f0fff4';
                    statusDiv.style.border = '1px solid #9ae6b4';
                    setTimeout(() => {
                        closeModal('smsModal');
                    }, 1500);
                } else {
                    statusDiv.innerHTML = '<span style="color: #e53e3e;">Error: ' + (result.error || 'Failed to send') + '</span>';
                    statusDiv.style.display = 'block';
                    statusDiv.style.background = '#fff5f5';
                    statusDiv.style.border = '1px solid #fc8181';
                }
            } catch (error) {
                statusDiv.innerHTML = '<span style="color: #e53e3e;">Error: ' + error.message + '</span>';
                statusDiv.style.display = 'block';
                statusDiv.style.background = '#fff5f5';
                statusDiv.style.border = '1px solid #fc8181';
            }
        }

        async function previewAppointmentReminders() {
            try {
                // Load jobs if not already loaded
                if (!jobs || jobs.length === 0) {
                    const response = await fetch('/api/jobs');
                    jobs = await response.json();
                }

                // Load clients if not already loaded
                if (!clients || clients.length === 0) {
                    const response = await fetch('/api/clients');
                    clients = await response.json();
                }

                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                const tomorrowStr = tomorrow.toISOString().split('T')[0];

                const tomorrowJobs = jobs.filter(j =>
                    j.scheduledDate === tomorrowStr &&
                    j.status === 'scheduled'
                );

                const previewDiv = document.getElementById('reminderPreview');
                const listDiv = document.getElementById('reminderPreviewList');

                if (tomorrowJobs.length === 0) {
                    listDiv.innerHTML = '<p style="color: #718096; margin: 0;">No scheduled jobs for tomorrow.</p>';
                    previewDiv.style.display = 'block';
                    return;
                }

                let html = '<table style="width: 100%; font-size: 0.9rem;"><thead><tr style="text-align: left; border-bottom: 2px solid #cbd5e0;"><th style="padding: 0.5rem;">Client</th><th style="padding: 0.5rem;">Phone</th><th style="padding: 0.5rem;">Job</th><th style="padding: 0.5rem;">Time</th><th style="padding: 0.5rem;">Will Send?</th></tr></thead><tbody>';

                for (const job of tomorrowJobs) {
                    const client = clients.find(c => c.id === job.clientId || c._id === job.clientId);
                    const hasPhone = client && client.phone;
                    const status = hasPhone ? '<span style="color: #48bb78;">✓ Yes</span>' : '<span style="color: #e53e3e;">✗ No phone</span>';

                    html += '<tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 0.5rem;">' + (maskName(client ? client.name : 'Unknown')) + '</td><td style="padding: 0.5rem;">' + (client?.phone || '-') + '</td><td style="padding: 0.5rem;">' + job.title + '</td><td style="padding: 0.5rem;">' + (job.scheduledTime || 'TBD') + '</td><td style="padding: 0.5rem;">' + status + '</td></tr>';
                }

                html += '</tbody></table>';

                const willSend = tomorrowJobs.filter(j => {
                    const client = clients.find(c => c.id === j.clientId || c._id === j.clientId);
                    return client && client.phone;
                }).length;

                listDiv.innerHTML = '<p style="margin: 0 0 1rem 0; font-weight: 600; color: #2d3748;">Will send ' + willSend + ' reminders out of ' + tomorrowJobs.length + ' scheduled jobs</p>' + html;
                previewDiv.style.display = 'block';

            } catch (error) {
                alert('Error loading preview: ' + error.message);
            }
        }

        async function sendAppointmentReminders() {
            if (!confirm('Send appointment reminders to all clients with jobs tomorrow?')) {
                return;
            }

            try {
                const response = await fetch('/api/sms/reminders', {
                    method: 'POST'
                });
                const result = await response.json();

                if (result.success) {
                    alert('Sent ' + result.sent + ' reminders out of ' + result.total + ' scheduled jobs');
                    document.getElementById('reminderPreview').style.display = 'none';
                } else {
                    alert('Error sending reminders: ' + (result.error || 'Unknown error'));
                }
            } catch (error) {
                alert('Error: ' + error.message);
            }
        }

        // Time Clock Functions
        let currentClockEntry = null;
        let timerInterval = null;

        async function loadTimeClock() {
            const response = await fetch('/api/jobs');
            const jobs = await response.json();
            let activeJobs = jobs.filter(j => j.status === 'scheduled' || j.status === 'in_progress');

            // Non-admins can only see jobs assigned to them
            if (!isAdmin) {
                // Get current user's info to find matching team member
                const userResponse = await fetch('/api/auth/me');
                const currentUser = await userResponse.json();

                // Get team members to find the one matching current user's name
                const teamResponse = await fetch('/api/team');
                const teamMembers = await teamResponse.json();
                const matchingTeamMember = teamMembers.find(t =>
                    t.name && t.name.toLowerCase().trim() === currentUser.name.toLowerCase().trim()
                );

                if (matchingTeamMember) {
                    // Filter jobs to only those assigned to this team member
                    // Use loose comparison to handle string/number ID differences
                    activeJobs = activeJobs.filter(j => isAssignedTo(j, matchingTeamMember.id));

                    console.log('User:', currentUser.name, 'Team Member ID:', matchingTeamMember.id, 'Found jobs:', activeJobs.length);
                } else {
                    console.log('No matching team member found for user:', currentUser.name);
                    // User not linked to team member - show no jobs
                    activeJobs = [];
                }
            }

            const select = document.getElementById('clockInJobSelect');
            select.innerHTML = '<option value="">Select a job to clock in...</option>';

            if (activeJobs.length === 0 && !isAdmin) {
                select.innerHTML = '<option value="">No jobs assigned to you</option>';
            } else {
                activeJobs.forEach(job => {
                    const option = document.createElement('option');
                    option.value = job.id;
                    option.textContent = job.title + ' - ' + (job.clientName || 'Client');
                    option.dataset.jobName = job.title;
                    select.appendChild(option);
                });
            }

            const entriesResponse = await fetch('/api/timeentries');
            const entries = await entriesResponse.json();
            const activeEntry = entries.find(e => e.status === 'active' && e.userId === currentUserId);

            if (activeEntry) {
                currentClockEntry = activeEntry;
                showClockedIn();
                startTimer();
            } else {
                showClockedOut();
            }

            loadTodayTimeEntries();

            if (isAdmin) {
                document.getElementById('approvalQueueCard').style.display = 'block';
                document.getElementById('allTimeEntriesCard').style.display = 'block';
                loadApprovalQueue();
                loadAllTimeEntries();
            }
        }

        async function clockIn() {
            const select = document.getElementById('clockInJobSelect');
            const jobId = select.value;

            if (!jobId) {
                alert('Please select a job to clock in');
                return;
            }

            const selectedOption = select.options[select.selectedIndex];
            const jobName = selectedOption.dataset.jobName;

            const response = await fetch('/api/timeentries/clockin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId: jobId,
                    jobName: jobName
                })
            });

            currentClockEntry = await response.json();
            showClockedIn();
            startTimer();
            loadTodayTimeEntries();
        }

        let surveyRating = 0;

        function openClockOutSurvey() {
            if (!currentClockEntry) return;
            surveyRating = 0;
            document.getElementById('surveyJobLabel').textContent = currentClockEntry.jobName || '';
            document.getElementById('surveyComment').value = '';
            document.getElementById('surveyRatingError').style.display = 'none';
            renderStars(0);
            openModal('clockOutSurveyModal');
        }

        function setSurveyRating(val) {
            surveyRating = val;
            renderStars(val);
            document.getElementById('surveyRatingError').style.display = 'none';
        }

        function renderStars(val) {
            document.querySelectorAll('#starRating span').forEach(s => {
                s.textContent = parseInt(s.dataset.val) <= val ? '★' : '☆';
                s.style.color = parseInt(s.dataset.val) <= val ? '#f59e0b' : '#cbd5e0';
            });
        }

        async function submitClockOutSurvey() {
            if (!surveyRating) {
                document.getElementById('surveyRatingError').style.display = 'block';
                return;
            }
            const comment = document.getElementById('surveyComment').value.trim();
            closeModal('clockOutSurveyModal');
            await clockOut({ rating: surveyRating, comment });
        }

        async function clockOutSkipSurvey() {
            closeModal('clockOutSurveyModal');
            await clockOut(null);
        }

        async function clockOut(survey = null) {
            if (!currentClockEntry) return;

            const response = await fetch('/api/timeentries/clockout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entryId: currentClockEntry.id, survey })
            });

            await response.json();
            stopTimer();
            currentClockEntry = null;
            showClockedOut(true);
            loadTodayTimeEntries();

            if (isAdmin) {
                loadApprovalQueue();
                loadAllTimeEntries();
            }
        }

        function showClockedIn() {
            document.getElementById('clockedOutView').style.display = 'none';
            document.getElementById('clockedInView').style.display = 'block';
            document.getElementById('currentJobTitle').textContent = currentClockEntry.jobName;

            const clockInTime = new Date(currentClockEntry.clockIn);
            document.getElementById('clockInTime').textContent = clockInTime.toLocaleTimeString();
        }

        function showClockedOut(showConfirmation) {
            document.getElementById('clockedOutView').style.display = 'block';
            document.getElementById('clockedInView').style.display = 'none';

            if (showConfirmation) {
                const banner = document.createElement('div');
                banner.id = 'clockOutBanner';
                banner.style.cssText = 'background:#c6f6d5;border:2px solid #48bb78;border-radius:12px;padding:1.25rem 2rem;text-align:center;margin-bottom:1rem;';
                banner.innerHTML = '<strong style="color:#22543d;font-size:1.1rem;">✅ You\'re Clocked Out — time submitted for approval</strong>';
                const statusDiv = document.getElementById('clockStatus');
                const existing = document.getElementById('clockOutBanner');
                if (existing) existing.remove();
                statusDiv.insertBefore(banner, statusDiv.firstChild);
                setTimeout(() => { const b = document.getElementById('clockOutBanner'); if (b) b.remove(); }, 4000);
            }
        }

        function startTimer() {
            if (timerInterval) clearInterval(timerInterval);

            function updateTimer() {
                const clockInTime = new Date(currentClockEntry.clockIn);
                const now = new Date();
                const elapsed = Math.floor((now - clockInTime) / 1000);

                const hours = Math.floor(elapsed / 3600);
                const minutes = Math.floor((elapsed % 3600) / 60);
                const seconds = elapsed % 60;

                document.getElementById('timerDisplay').textContent =
                    hours + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
            }

            updateTimer();
            timerInterval = setInterval(updateTimer, 1000);
        }

        function stopTimer() {
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
        }

        async function loadTodayTimeEntries() {
            const response = await fetch('/api/timeentries');
            const entries = await response.json();

            const today = new Date().toISOString().split('T')[0];
            const todayEntries = entries.filter(e => {
                const entryDate = e.clockIn.split('T')[0];
                return entryDate === today && e.userId === currentUserId;
            });

            renderTodayTimeEntries(todayEntries);
        }

        function renderTodayTimeEntries(entries) {
            const container = document.getElementById('todayTimeEntries');

            if (entries.length === 0) {
                container.innerHTML = '<div class="empty-state"><p>No time entries today</p></div>';
                return;
            }

            const html = entries.map(entry => {
                const clockIn = new Date(entry.clockIn);
                const clockOut = entry.clockOut ? new Date(entry.clockOut) : null;
                const duration = entry.duration ? formatDuration(entry.duration) : 'In Progress';
                const clockOutText = clockOut ? '| Out: ' + clockOut.toLocaleTimeString() : '';

                // Status colors: active=green, pending=yellow, approved=green, rejected=red
                let borderColor = '#667eea'; // default blue
                let statusBadge = '';
                if (entry.status === 'active') {
                    borderColor = '#48bb78';
                } else if (entry.status === 'pending') {
                    borderColor = '#ffc107';
                    statusBadge = '<span style="background: #ffc107; color: #000; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem;">⏳ Pending</span>';
                } else if (entry.status === 'approved') {
                    borderColor = '#48bb78';
                    statusBadge = '<span style="background: #48bb78; color: #fff; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem;">✓ Approved ($' + (entry.paymentAmount || 0).toFixed(2) + ')</span>';
                } else if (entry.status === 'rejected') {
                    borderColor = '#e53e3e';
                    statusBadge = '<span style="background: #e53e3e; color: #fff; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem;">✗ Rejected</span>';
                }

                const adminButtons = isAdmin ? '<div style="display: flex; gap: 0.25rem;">' +
                    '<button class="btn-icon" onclick="editTimeEntryById(\'' + entry.id + '\')" title="Edit">✏️</button>' +
                    '<button class="btn-icon" onclick="deleteTimeEntry(\'' + entry.id + '\')" title="Delete">🗑️</button>' +
                    '</div>' : '';

                return '<div class="time-entry-card" style="background: white; padding: 1rem; border-radius: 8px; margin-bottom: 0.5rem; border-left: 4px solid ' + borderColor + ';">' +
                    '<div style="display: flex; justify-content: space-between; align-items: start;">' +
                    '<div style="flex: 1;">' +
                    '<div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem;">' +
                    '<h4 style="margin: 0; color: #1a202c;">' + entry.jobName + '</h4>' +
                    statusBadge +
                    '</div>' +
                    '<div style="color: #718096; font-size: 0.9rem;">' +
                    '<div>⏰ In: ' + clockIn.toLocaleTimeString() + ' ' + clockOutText + '</div>' +
                    '<div>⏱️ Duration: ' + duration + '</div>' +
                    '</div></div>' +
                    adminButtons +
                    '</div></div>';
            }).join('');

            container.innerHTML = html;
        }

        async function loadAllTimeEntries() {
            const response = await fetch('/api/timeentries');
            let entries = await response.json();

            // Populate employee filter
            const employeeFilter = document.getElementById('entriesEmployeeFilter');
            const uniqueEmployees = [...new Set(entries.map(e => e.userName))].sort();
            if (employeeFilter.options.length === 1) { // Only populate once
                uniqueEmployees.forEach(name => {
                    const option = document.createElement('option');
                    option.value = name;
                    option.textContent = name;
                    employeeFilter.appendChild(option);
                });
            }

            // Apply filters
            const selectedEmployee = employeeFilter.value;
            const selectedStatus = document.getElementById('entriesStatusFilter').value;

            if (selectedEmployee) {
                entries = entries.filter(e => e.userName === selectedEmployee);
            }
            if (selectedStatus) {
                entries = entries.filter(e => e.status === selectedStatus);
            }

            entries.sort((a, b) => new Date(b.clockIn) - new Date(a.clockIn));

            const container = document.getElementById('allTimeEntries');

            if (entries.length === 0) {
                container.innerHTML = '<div class="empty-state"><p>No entries match filters</p></div>';
                return;
            }

            const html = entries.slice(0, 100).map(entry => {
                const clockIn = new Date(entry.clockIn);
                const clockOut = entry.clockOut ? new Date(entry.clockOut) : null;
                const isActive = entry.status === 'active' && !clockOut;
                const rateAttr = (isActive && entry.hourlyRate) ? ' data-rate="' + entry.hourlyRate + '"' : '';
                const duration = isActive
                    ? '<span class="active-elapsed" data-ts="' + clockIn.getTime() + '"' + rateAttr + ' style="color:#48bb78;font-weight:600;">--:--:--</span>'
                    : (entry.duration ? formatDuration(entry.duration) : '—');
                const date = clockIn.toLocaleDateString();
                const timeText = clockOut ? '- ' + clockOut.toLocaleTimeString() : '🟢 Active';

                // Status colors
                let borderColor = '#667eea';
                let statusBadge = '';
                if (entry.status === 'active') {
                    borderColor = '#48bb78';
                } else if (entry.status === 'pending') {
                    borderColor = '#ffc107';
                    statusBadge = '<span style="background: #ffc107; color: #000; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; margin-left: 0.5rem;">⏳ Pending</span>';
                } else if (entry.status === 'approved') {
                    borderColor = '#48bb78';
                    statusBadge = '<span style="background: #48bb78; color: #fff; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; margin-left: 0.5rem;">✓ $' + (entry.paymentAmount || 0).toFixed(2) + '</span>';
                } else if (entry.status === 'rejected') {
                    borderColor = '#e53e3e';
                    statusBadge = '<span style="background: #e53e3e; color: #fff; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; margin-left: 0.5rem;">✗ Rejected</span>';
                }

                return '<div class="time-entry-card" style="background: white; padding: 1rem; border-radius: 8px; margin-bottom: 0.5rem; border-left: 4px solid ' + borderColor + ';">' +
                    '<div style="display: flex; justify-content: space-between; align-items: start;">' +
                    '<div style="flex: 1;">' +
                    '<div style="display: flex; gap: 0.5rem; align-items: baseline; margin-bottom: 0.5rem;">' +
                    '<h4 style="margin: 0; color: #1a202c;">' + entry.jobName + '</h4>' +
                    '<span style="color: #718096; font-size: 0.9rem;">by ' + entry.userName + '</span>' +
                    statusBadge +
                    '</div>' +
                    '<div style="color: #718096; font-size: 0.9rem;">' +
                    '<div>📅 ' + date + ' | ⏰ ' + clockIn.toLocaleTimeString() + ' ' + timeText + '</div>' +
                    '<div>⏱️ Duration: ' + duration + (entry.survey ? ' | ' + '★'.repeat(entry.survey.rating) + '☆'.repeat(5 - entry.survey.rating) : '') + '</div>' +
                    (entry.survey?.comment ? '<div style="color:#4a5568;font-style:italic;margin-top:0.2rem;">💬 ' + entry.survey.comment + '</div>' : '') +
                    '</div></div>' +
                    '<div style="display: flex; gap: 0.25rem;">' +
                    '<button class="btn-icon" onclick="editTimeEntryById(\'' + entry.id + '\')" title="Edit">✏️</button>' +
                    '<button class="btn-icon" onclick="deleteTimeEntry(\'' + entry.id + '\')" title="Delete">🗑️</button>' +
                    '</div>' +
                    '</div></div>';
            }).join('');

            container.innerHTML = html;
            startActiveElapsedTicker();
        }

        let activeElapsedInterval = null;
        function startActiveElapsedTicker() {
            if (activeElapsedInterval) clearInterval(activeElapsedInterval);
            function tick() {
                document.querySelectorAll('.active-elapsed').forEach(el => {
                    const start = parseInt(el.dataset.ts, 10);
                    const elapsed = Math.floor((Date.now() - start) / 1000);
                    const h = Math.floor(elapsed / 3600);
                    const m = Math.floor((elapsed % 3600) / 60);
                    const s = elapsed % 60;
                    const timeStr = h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
                    const rate = parseFloat(el.dataset.rate);
                    const costStr = rate ? ' · <span style="color:#92400e;">~$' + (elapsed / 3600 * rate).toFixed(2) + '</span>' : '';
                    el.innerHTML = timeStr + costStr;
                });
            }
            tick();
            activeElapsedInterval = setInterval(tick, 1000);
        }

        async function deleteTimeEntry(id) {
            if (!isAdmin) {
                alert('Only admins can delete time entries');
                return;
            }

            if (!confirm('⚠️ WARNING: Delete this time entry?\\n\\nThis action cannot be undone and will permanently remove this time record.')) return;

            try {
                const response = await fetch('/api/timeentries/' + id, {
                    method: 'DELETE'
                });

                if (!response.ok) {
                    const error = await response.text();
                    alert('Failed to delete: ' + error);
                    return;
                }

                loadTodayTimeEntries();
                loadApprovalQueue();
                loadAllTimeEntries();
            } catch (error) {
                alert('Error deleting time entry: ' + error.message);
            }
        }

        let currentEditingTimeEntry = null;

        async function editTimeEntryById(id) {
            if (!isAdmin) {
                alert('Only admins can edit time entries');
                return;
            }

            try {
                // Fetch all entries and find the one we need
                const response = await fetch('/api/timeentries');
                if (!response.ok) {
                    alert('Failed to fetch time entries');
                    return;
                }

                const entries = await response.json();
                const entry = entries.find(e => e.id === id);

                if (!entry) {
                    alert('Time entry not found. ID: ' + id);
                    return;
                }

                editTimeEntry(entry);
            } catch (error) {
                alert('Error loading time entry: ' + error.message);
                console.error('editTimeEntryById error:', error);
            }
        }

        function editTimeEntry(entry) {
            if (!isAdmin) {
                alert('Only admins can edit time entries');
                return;
            }

            try {
                currentEditingTimeEntry = entry;

                // Populate the modal
                document.getElementById('editTimeEntryId').value = entry.id;
                document.getElementById('editTimeJobName').textContent = entry.jobName;
                document.getElementById('editTimeUserName').textContent = entry.userName;

                // Format dates for datetime-local inputs
                const clockIn = new Date(entry.clockIn);
                let clockOut;

                if (entry.clockOut) {
                    clockOut = new Date(entry.clockOut);
                } else {
                    // For active entries without clock out, default to now or 1 hour after clock in (whichever is later)
                    const now = new Date();
                    const oneHourLater = new Date(clockIn.getTime() + 3600000);
                    clockOut = now > oneHourLater ? now : oneHourLater;
                }

                // Format both dates
                const clockInFormatted = formatDateTimeLocal(clockIn);
                const clockOutFormatted = formatDateTimeLocal(clockOut);

                // If they format to the same minute, add 1 minute to clockOut
                if (clockInFormatted === clockOutFormatted) {
                    clockOut = new Date(clockOut.getTime() + 60000); // Add 1 minute
                }

                document.getElementById('editClockIn').value = clockInFormatted;
                document.getElementById('editClockOut').value = formatDateTimeLocal(clockOut);

                // Set status and payment amount
                document.getElementById('editStatus').value = entry.status || 'pending';
                document.getElementById('editPaymentAmount').value = entry.paymentAmount || '';

                // Show modal
                document.getElementById('editTimeEntryModal').classList.add('active');
            } catch (error) {
                alert('Error opening edit modal: ' + error.message);
                console.error('editTimeEntry error:', error, entry);
            }
        }

        function formatDateTimeLocal(date) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            return year + '-' + month + '-' + day + 'T' + hours + ':' + minutes;
        }

        async function saveTimeEntryEdit() {
            const id = document.getElementById('editTimeEntryId').value;
            const clockInValue = document.getElementById('editClockIn').value;
            const clockOutValue = document.getElementById('editClockOut').value;
            const status = document.getElementById('editStatus').value;
            const paymentAmount = parseFloat(document.getElementById('editPaymentAmount').value) || null;

            if (!clockInValue || !clockOutValue) {
                alert('Please provide both clock in and clock out times');
                return;
            }

            const clockIn = new Date(clockInValue);
            const clockOut = new Date(clockOutValue);

            // Validate times
            if (isNaN(clockIn.getTime()) || isNaN(clockOut.getTime())) {
                alert('Invalid date/time values');
                return;
            }

            const timeDiff = clockOut.getTime() - clockIn.getTime();
            if (timeDiff <= 0) {
                alert('Clock out time must be after clock in time\\n\\nClock In: ' + clockIn.toLocaleString() + '\\nClock Out: ' + clockOut.toLocaleString() + '\\nDifference: ' + timeDiff + 'ms');
                return;
            }

            if (status === 'approved' && (!paymentAmount || paymentAmount <= 0)) {
                alert('⚠️ Payment amount is required to approve time entry');
                document.getElementById('editPaymentAmount').focus();
                return;
            }

            const duration = Math.round((clockOut.getTime() - clockIn.getTime()) / 1000); // seconds

            const updates = {
                clockIn: clockIn.toISOString(),
                clockOut: clockOut.toISOString(),
                duration: duration,
                status: status,
                approvalStatus: status
            };

            if (paymentAmount !== null) {
                updates.paymentAmount = paymentAmount;
            }

            try {
                const response = await fetch('/api/timeentries/' + id, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(updates)
                });

                if (!response.ok) {
                    const error = await response.json();
                    alert('Failed to update: ' + (error.error || 'Unknown error'));
                    return;
                }

                closeModal('editTimeEntryModal');
                loadTodayTimeEntries();
                loadApprovalQueue();
                loadAllTimeEntries();
                loadMyPay();
            } catch (error) {
                alert('Error updating time entry: ' + error.message);
            }
        }

        function formatDuration(seconds) {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return hours + 'h ' + minutes + 'm';
        }

        function exportTimeEntries() {
            alert('Export feature coming soon!');
        }

        async function loadApprovalQueue() {
            const response = await fetch('/api/timeentries');
            const entries = await response.json();

            // Populate employee filter
            const employeeFilter = document.getElementById('approvalEmployeeFilter');
            const uniqueEmployees = [...new Set(entries.map(e => e.userName))].sort();
            if (employeeFilter.options.length === 1) { // Only populate once
                uniqueEmployees.forEach(name => {
                    const option = document.createElement('option');
                    option.value = name;
                    option.textContent = name;
                    employeeFilter.appendChild(option);
                });
            }

            // Filter by employee
            const selectedEmployee = employeeFilter.value;
            let pending = entries.filter(e => e.approvalStatus === 'pending' || e.status === 'pending');
            if (selectedEmployee) {
                pending = pending.filter(e => e.userName === selectedEmployee);
            }
            pending.sort((a, b) => new Date(b.clockOut) - new Date(a.clockOut));

            document.getElementById('pendingCount').textContent = pending.length;

            const container = document.getElementById('approvalQueue');

            if (pending.length === 0) {
                container.innerHTML = '<div class="empty-state"><p>✅ No pending approvals</p></div>';
                return;
            }

            const html = pending.map(entry => {
                const clockIn = new Date(entry.clockIn);
                const clockOut = new Date(entry.clockOut);
                const duration = formatDuration(entry.duration);
                const date = clockIn.toLocaleDateString();

                const hours = entry.duration ? entry.duration / 3600 : 0;
                const rate = parseFloat(entry.hourlyRate) || 0;
                const plannedPayout = (hours * rate).toFixed(2);
                const plannedLabel = rate > 0
                    ? '<div style="color:#276749;font-size:0.85rem;margin-top:0.25rem;">💰 Planned: $' + plannedPayout + ' (' + hours.toFixed(2) + 'hr × $' + rate.toFixed(2) + '/hr)</div>'
                    : '';

                return '<div class="time-entry-card" style="background: #fffbea; padding: 1rem; border-radius: 8px; margin-bottom: 0.5rem; border-left: 4px solid #ffc107;">' +
                    '<div style="display: flex; justify-content: space-between; align-items: start; gap: 1rem;">' +
                    '<div style="flex: 1;">' +
                    '<div style="display: flex; gap: 1rem; align-items: baseline; margin-bottom: 0.5rem;">' +
                    '<h4 style="margin: 0; color: #1a202c;">' + entry.jobName + '</h4>' +
                    '<span style="color: #718096; font-size: 0.9rem;">by ' + entry.userName + '</span>' +
                    '</div>' +
                    '<div style="color: #718096; font-size: 0.9rem;">' +
                    '<div>📅 ' + date + ' | ⏰ ' + clockIn.toLocaleTimeString() + ' - ' + clockOut.toLocaleTimeString() + '</div>' +
                    '<div>⏱️ Duration: ' + duration + '</div>' +
                    '</div>' +
                    plannedLabel +
                    '</div>' +
                    '<div style="display: flex; flex-direction: column; gap: 0.5rem; min-width: 200px;">' +
                    '<input type="number" id="payment_' + entry.id + '" placeholder="Payment amount" step="0.01" min="0" value="' + (rate > 0 ? plannedPayout : '') + '" style="padding: 0.5rem; border: 2px solid #cbd5e0; border-radius: 4px;">' +
                    '<div style="display: flex; gap: 0.5rem;">' +
                    '<button class="btn btn-primary btn-small" onclick="approveTimeEntry(\'' + entry.id + '\')" style="flex: 1;">✓ Approve</button>' +
                    '<button class="btn btn-danger btn-small" onclick="rejectTimeEntry(\'' + entry.id + '\')" style="flex: 1;">✗ Reject</button>' +
                    '</div>' +
                    '<div style="display: flex; gap: 0.5rem; margin-top: 0.25rem;">' +
                    '<button class="btn-icon" onclick=\'editTimeEntry(' + JSON.stringify(entry) + ')\' title="Edit" style="flex: 1; padding: 0.25rem;">✏️ Edit</button>' +
                    '<button class="btn-icon" onclick="deleteTimeEntry(\'' + entry.id + '\')" title="Delete" style="flex: 1; padding: 0.25rem;">🗑️ Delete</button>' +
                    '</div></div>' +
                    '</div></div>';
            }).join('');

            container.innerHTML = html;
        }

        async function approveTimeEntry(id) {
            const paymentInput = document.getElementById('payment_' + id);
            const paymentAmount = parseFloat(paymentInput.value);

            if (!paymentAmount || paymentAmount <= 0) {
                alert('⚠️ Payment amount is required to approve time entry');
                paymentInput.focus();
                return;
            }

            if (!confirm('Approve this time entry and pay $' + paymentAmount.toFixed(2) + '?\\n\\nThis will also create an expense record for this payment.')) return;

            try {
                const response = await fetch('/api/timeentries/' + id + '/approve', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paymentAmount: paymentAmount })
                });

                if (!response.ok) {
                    const error = await response.json();
                    alert('Failed to approve: ' + (error.error || 'Unknown error'));
                    return;
                }

                loadApprovalQueue();
                loadAllTimeEntries();
                loadMyPay();
            } catch (error) {
                alert('Error approving time entry: ' + error.message);
            }
        }

        async function rejectTimeEntry(id) {
            const reason = prompt('Reason for rejection (optional):');
            if (reason === null) return; // Cancelled

            await fetch('/api/timeentries/' + id + '/reject', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: reason })
            });

            loadApprovalQueue();
            loadAllTimeEntries();
        }

        // My Pay functions
        async function loadMyPay() {
            const response = await fetch('/api/timeentries');
            const allEntries = await response.json();

            // Filter to only current user's approved entries
            const myEntries = allEntries.filter(e => e.userId === currentUserId && e.status === 'approved');

            // Calculate date ranges
            const now = new Date();
            const today = now.toISOString().split('T')[0];
            const thisMonth = now.toISOString().slice(0, 7);
            const thisYear = now.getFullYear().toString();

            // Calculate totals
            let todayPay = 0, mtdPay = 0, ytdPay = 0, allTimePay = 0;

            myEntries.forEach(entry => {
                const entryDate = entry.clockIn.split('T')[0];
                const amount = entry.paymentAmount || 0;

                allTimePay += amount;
                if (entryDate.startsWith(thisYear)) ytdPay += amount;
                if (entryDate.startsWith(thisMonth)) mtdPay += amount;
                if (entryDate === today) todayPay += amount;
            });

            // Update summary cards
            document.getElementById('payToday').textContent = formatMoney(todayPay);
            document.getElementById('payMTD').textContent = formatMoney(mtdPay);
            document.getElementById('payYTD').textContent = formatMoney(ytdPay);
            document.getElementById('payAllTime').textContent = formatMoney(allTimePay);

            // Filter entries based on selected period
            const period = document.getElementById('payPeriodFilter').value;
            let filteredEntries = myEntries;

            if (period === 'today') {
                filteredEntries = myEntries.filter(e => e.clockIn.split('T')[0] === today);
            } else if (period === 'week') {
                const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                filteredEntries = myEntries.filter(e => new Date(e.clockIn) >= weekAgo);
            } else if (period === 'month') {
                filteredEntries = myEntries.filter(e => e.clockIn.startsWith(thisMonth));
            } else if (period === 'year') {
                filteredEntries = myEntries.filter(e => e.clockIn.startsWith(thisYear));
            }

            // Sort by date descending
            filteredEntries.sort((a, b) => new Date(b.clockIn) - new Date(a.clockIn));

            // Render details
            renderMyPayDetails(filteredEntries);
        }

        function renderMyPayDetails(entries) {
            const container = document.getElementById('myPayDetails');

            if (entries.length === 0) {
                container.innerHTML = '<div class="empty-state"><p>No approved payments for this period</p></div>';
                return;
            }

            const html = entries.map(entry => {
                const clockIn = new Date(entry.clockIn);
                const clockOut = new Date(entry.clockOut);
                const duration = formatDuration(entry.duration);
                const date = clockIn.toLocaleDateString();

                return '<div class="time-entry-card" style="background: white; padding: 1rem; border-radius: 8px; margin-bottom: 0.5rem; border-left: 4px solid #48bb78;">' +
                    '<div style="display: flex; justify-content: space-between; align-items: start;">' +
                    '<div style="flex: 1;">' +
                    '<div style="display: flex; gap: 1rem; align-items: baseline; margin-bottom: 0.5rem;">' +
                    '<h4 style="margin: 0; color: #1a202c;">' + entry.jobName + '</h4>' +
                    '<span style="background: #48bb78; color: #fff; padding: 0.25rem 0.75rem; border-radius: 12px; font-weight: 600; font-size: 1rem;">$' + (entry.paymentAmount || 0).toFixed(2) + '</span>' +
                    '</div>' +
                    '<div style="color: #718096; font-size: 0.9rem;">' +
                    '<div>📅 ' + date + ' | ⏰ ' + clockIn.toLocaleTimeString() + ' - ' + clockOut.toLocaleTimeString() + '</div>' +
                    '<div>⏱️ Duration: ' + duration + '</div>' +
                    (entry.approvedBy ? '<div style="margin-top: 0.25rem;">✓ Approved by ' + entry.approvedBy + '</div>' : '') +
                    '</div></div>' +
                    '</div></div>';
            }).join('');

            container.innerHTML = html;
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
            const agendaPanel = document.getElementById('calendar-agenda');
            agendaPanel.style.display = 'none';

            const isMobile = window.innerWidth < 768;
            const today = new Date().toISOString().split('T')[0];

            const statusDotColor = {
                scheduled: '#667eea', to_be_scheduled: '#d69e2e', in_progress: '#ed8936',
                completed: '#48bb78', invoiced: '#9f7aea', prospecting: '#a0aec0', bid_lost: '#fc8181'
            };

            // Day headers
            const dayNames = isMobile ? ['S','M','T','W','T','F','S'] : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
            dayNames.forEach(day => {
                const header = document.createElement('div');
                header.className = 'calendar-day-header';
                header.textContent = day;
                grid.appendChild(header);
            });

            // Previous month filler days
            const prevMonthDays = new Date(currentYear, currentMonth - 1, 0).getDate();
            for (let i = startDay - 1; i >= 0; i--) {
                const day = document.createElement('div');
                day.className = isMobile ? 'calendar-day-mobile other-month' : 'calendar-day other-month';
                day.innerHTML = isMobile
                    ? \`<div class="day-num">\${prevMonthDays - i}</div>\`
                    : \`<div class="day-number">\${prevMonthDays - i}</div>\`;
                grid.appendChild(day);
            }

            // Current month days
            for (let i = 1; i <= daysInMonth; i++) {
                const dateStr = \`\${currentYear}-\${String(currentMonth).padStart(2, '0')}-\${String(i).padStart(2, '0')}\`;
                const dayJobs = calendarJobs.filter(j => j.scheduledDate === dateStr);
                const day = document.createElement('div');

                if (isMobile) {
                    day.className = 'calendar-day-mobile' + (dateStr === today ? ' today' : '');
                    const badge = dayJobs.length > 0
                        ? \`<div class="cal-badge" style="background:\${statusDotColor[dayJobs[0].status] || '#667eea'}">\${dayJobs.length}</div>\`
                        : '';
                    day.innerHTML = \`<div class="day-num">\${i}</div>\${badge}\`;
                    day.addEventListener('click', () => showCalendarAgenda(dateStr, dayJobs, day));
                } else {
                    day.className = 'calendar-day' + (dateStr === today ? ' today' : '');
                    let html = \`<div class="day-number">\${i}</div>\`;
                    dayJobs.forEach(j => {
                        const client = findClient(j.clientId);
                        html += \`<div class="calendar-job \${j.status}" onclick='openJobModal(\${JSON.stringify(j).replace(/'/g, "&apos;")})' title="\${j.title} - \${maskName(client ? client.name : 'Unknown')}">\${j.title}</div>\`;
                    });
                    day.innerHTML = html;
                }
                grid.appendChild(day);
            }

            // Next month filler days
            const totalCells = startDay + daysInMonth;
            const remainingCells = 7 - (totalCells % 7);
            if (remainingCells < 7) {
                for (let i = 1; i <= remainingCells; i++) {
                    const day = document.createElement('div');
                    day.className = isMobile ? 'calendar-day-mobile other-month' : 'calendar-day other-month';
                    day.innerHTML = isMobile
                        ? \`<div class="day-num">\${i}</div>\`
                        : \`<div class="day-number">\${i}</div>\`;
                    grid.appendChild(day);
                }
            }

            // Auto-show today's agenda on mobile
            if (isMobile) {
                const todayJobs = calendarJobs.filter(j => j.scheduledDate === today);
                const todayEl = grid.querySelector('.calendar-day-mobile.today');
                if (todayEl) showCalendarAgenda(today, todayJobs, todayEl);
            }
        }

        function showCalendarAgenda(dateStr, dayJobs, dayEl) {
            // Highlight selected day
            document.querySelectorAll('.calendar-day-mobile.selected').forEach(el => el.classList.remove('selected'));
            if (dayEl) dayEl.classList.add('selected');

            const agendaPanel = document.getElementById('calendar-agenda');
            const label = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

            if (dayJobs.length === 0) {
                agendaPanel.style.display = 'block';
                agendaPanel.innerHTML = \`<div style="font-weight:700;font-size:1rem;color:#2d3748;margin-bottom:0.75rem;">\${label}</div>
                    <p style="color:#718096;">No jobs scheduled</p>\`;
                return;
            }

            const cards = dayJobs.map(j => {
                const client = findClient(j.clientId);
                return \`<div style="background:white;border:2px solid #e2e8f0;border-radius:10px;padding:0.875rem;margin-bottom:0.75rem;" onclick='editJob("\${j.id}")'>
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                        <div>
                            <div style="font-weight:700;color:#2d3748;">\${maskName(client ? client.name : 'Unknown')}</div>
                            <div style="color:#4a5568;font-size:0.9rem;">\${j.title}</div>
                        </div>
                        <span class="status-badge status-\${j.status}" style="white-space:nowrap;margin-left:0.5rem;">\${j.status.replace(/_/g,' ')}</span>
                    </div>
                    \${j.scheduledTime ? \`<div style="color:#718096;font-size:0.85rem;margin-top:0.3rem;">⏰ \${j.scheduledTime}</div>\` : ''}
                </div>\`;
            }).join('');

            agendaPanel.style.display = 'block';
            agendaPanel.innerHTML = \`<div style="font-weight:700;font-size:1rem;color:#2d3748;margin-bottom:0.75rem;">\${label} · \${dayJobs.length} job\${dayJobs.length !== 1 ? 's' : ''}</div>\${cards}\`;
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

                // Set user ID and role
                currentUserId = user._id;
                currentUserRole = user.role || 'user';
                isAdmin = currentUserRole === 'admin';

                // Display role
                const roleText = currentUserRole.charAt(0).toUpperCase() + currentUserRole.slice(1);
                document.getElementById('currentUserRole').textContent = roleText;

                if (user.lastLogin) {
                    const lastLogin = new Date(user.lastLogin);
                    document.getElementById('lastLoginTime').textContent = lastLogin.toLocaleString();
                } else {
                    document.getElementById('lastLoginTime').textContent = 'First login';
                }

                // Match to team member for pay rate lookups
                if (!isAdmin) {
                    currentTeamMember = team.find(t => t.name && t.name.toLowerCase().trim() === user.name.toLowerCase().trim()) || null;
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

                // Show user-only tabs
                document.querySelectorAll('[data-user-only]').forEach(btn => {
                    btn.style.display = 'inline-block';
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

                // Lock job filters for non-admins: active work only, no client search
                const statusFilter = document.getElementById('filter-status');
                if (statusFilter) {
                    statusFilter.value = 'ACTIVE_WORK';
                    statusFilter.disabled = true;
                    statusFilter.style.opacity = '0.6';
                    statusFilter.style.pointerEvents = 'none';
                }
                const clientFilter = document.getElementById('filter-client');
                if (clientFilter) clientFilter.style.display = 'none';
                const pills = document.getElementById('job-status-pills');
                if (pills) pills.style.display = 'none';
                const assignedFilter = document.getElementById('filter-assigned');
                if (assignedFilter) assignedFilter.style.display = 'none';
                const clearBtn = document.querySelector('[onclick="clearJobFilters()"]');
                if (clearBtn) clearBtn.style.display = 'none';
            } else {
                // Hide user-only tabs for admins
                document.querySelectorAll('[data-user-only]').forEach(btn => {
                    btn.style.display = 'none';
                });
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
            // Restore last viewed page from localStorage
            const savedView = localStorage.getItem('currentView');
            const defaultView = isAdmin ? 'dashboard' : 'jobs';
            const viewToShow = savedView || defaultView;

            // Make sure the view exists and user has permission
            const adminOnlyViews = ['dashboard', 'clients', 'quotes', 'team', 'expenses', 'vendors', 'portfolio', 'messages', 'reports', 'activity', 'settings'];
            if (!isAdmin && adminOnlyViews.includes(viewToShow)) {
                showView('jobs');
            } else {
                showView(viewToShow);
            }

            // Check for unread messages and leads (admins only)
            if (isAdmin) {
                initNotificationPolling();
            }
        });

        // Update clock every second
        updateDateTime();
        setInterval(updateDateTime, 1000);

        // Load app branding on page load
        (async function() {
            try {
                const response = await fetch('/api/settings');
                const settings = await response.json();
                updateAppBranding(settings.appName, settings.favicon);
            } catch (e) {
                console.error('Failed to load app branding:', e);
            }
        })();

        // Auto-refresh dashboard every 30 seconds
        setInterval(() => {
            if (document.getElementById('dashboard').classList.contains('active')) {
                loadDashboard();
            }
        }, 30000);

        // ── Clippit (Activity Bot) ────────────────────────────────────────────────
        let _botLoaded = false;

        function clippyAnim(anim) {
            const el = document.getElementById('clippyChar');
            if (!el) return;
            el.style.animation = 'none';
            void el.offsetWidth; // reflow
            el.style.animation = anim;
        }

        function toggleActivityBot() {
            const panel = document.getElementById('activityBotPanel');
            const isOpen = panel.style.display !== 'none';
            panel.style.display = isOpen ? 'none' : 'flex';
            document.getElementById('activityBotDot').style.display = 'none';
            if (!isOpen) {
                clippyAnim('clippyBounce 0.6s ease');
                setTimeout(() => clippyAnim('clippyIdle 3s ease-in-out infinite'), 650);
                if (!_botLoaded) { _botLoaded = true; loadActivityBrief(); }
            } else {
                clippyAnim('clippyIdle 3s ease-in-out infinite');
            }
        }

        async function loadActivityBrief() {
            clippyAnim('clippyThink 1s ease-in-out infinite');
            appendBotMessage('bot', 'It looks like you just logged in! Let me check what\'s new... 🔍');
            try {
                const res  = await fetch('/api/activity-brief');
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                const lines = [];
                lines.push(\`Here's your update since **\${data.since}**:\n\`);

                if (data.newPortalQuotes.length)
                    lines.push(\`📥 **\${data.newPortalQuotes.length} new work order\${data.newPortalQuotes.length !== 1 ? 's' : ''}** came in via the portal\${data.newPortalQuotes.length <= 3 ? ': ' + data.newPortalQuotes.map(q => q.clientName + ' (' + (q.priority || 'flexible') + ')').join(', ') : ''}.\`);
                if (data.quoteStatusChanges.length)
                    lines.push(\`📋 **\${data.quoteStatusChanges.length} quote\${data.quoteStatusChanges.length !== 1 ? 's' : ''}** changed status: \${data.quoteStatusChanges.map(q => q.clientName + ' → ' + q.status).join(', ')}.\`);
                if (data.completedJobs.length)
                    lines.push(\`✅ **\${data.completedJobs.length} job\${data.completedJobs.length !== 1 ? 's' : ''}** marked complete: \${data.completedJobs.map(j => j.clientName).slice(0,3).join(', ')}\${data.completedJobs.length > 3 ? ' +more' : ''}.\`);
                if (data.newJobs.length)
                    lines.push(\`🔨 **\${data.newJobs.length} new job\${data.newJobs.length !== 1 ? 's' : ''}** created.\`);
                if (data.newMessages > 0)
                    lines.push(\`💬 **\${data.newMessages} unread message\${data.newMessages !== 1 ? 's' : ''}** from clients.\`);
                if (data.newLeads > 0)
                    lines.push(\`🎯 **\${data.newLeads} new lead\${data.newLeads !== 1 ? 's' : ''}** came in.\`);
                if (data.upcomingJobs.length)
                    lines.push(\`📅 **Upcoming this week:** \${data.upcomingJobs.map(j => j.scheduledDate + ' · ' + j.clientName).join(' | ')}.\`);
                if (data.outstandingTotal > 0)
                    lines.push(\`💰 **\${formatMoney(data.outstandingTotal)}** in outstanding invoices.\`);
                if (lines.length === 1)
                    lines.push('All quiet since your last visit! Everything looks good. 👍');

                removeBotTyping();
                clippyAnim('clippyTalk 0.4s ease-in-out 3');
                setTimeout(() => clippyAnim('clippyIdle 3s ease-in-out infinite'), 1300);
                appendBotMessage('bot', lines.join('\n'));
            } catch (e) {
                removeBotTyping();
                clippyAnim('clippyIdle 3s ease-in-out infinite');
                appendBotMessage('bot', 'Hmm, I had trouble loading your activity. Sorry about that!');
            }
        }

        async function sendBotQuery(text) {
            appendBotMessage('user', text);
            appendBotMessage('bot', '...');
            clippyAnim('clippyThink 1s ease-in-out infinite');
            try {
                const res  = await fetch('/api/activity-query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: text }) });
                const data = await res.json();
                removeBotTyping();
                clippyAnim('clippyTalk 0.4s ease-in-out 3');
                setTimeout(() => clippyAnim('clippyIdle 3s ease-in-out infinite'), 1300);
                let msg = data.answer || 'No data found.';
                if (data.items && data.items.length) msg += '\n\n' + data.items.map(i => '• ' + i).join('\n');
                appendBotMessage('bot', msg);
            } catch (e) {
                removeBotTyping();
                clippyAnim('clippyIdle 3s ease-in-out infinite');
                appendBotMessage('bot', 'Something went wrong — try again!');
            }
        }

        function appendBotMessage(role, text) {
            const log = document.getElementById('botMessageLog');
            const div = document.createElement('div');
            div.className = 'bot-msg bot-msg-' + role;
            if (role === 'bot' && text === '...') { div.dataset.typing = '1'; div.innerHTML = '<span class="bot-dots"><span>.</span><span>.</span><span>.</span></span>'; log.appendChild(div); log.scrollTop = log.scrollHeight; return; }
            div.innerHTML = text
                .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\n/g, '<br>');
            log.appendChild(div);
            log.scrollTop = log.scrollHeight;
        }

        function removeBotTyping() {
            document.querySelectorAll('[data-typing="1"]').forEach(el => el.remove());
        }

        function handleBotInput(e) {
            if (e.key === 'Enter') {
                const input = document.getElementById('botInput');
                const val = input.value.trim();
                if (val) { input.value = ''; sendBotQuery(val); }
            }
        }

        // ── Maddox Nudges ────────────────────────────────────────────────────────
        let _nudgeQueue = [];
        let _nudgeTimer = null;

        async function pollNudges() {
            try {
                const res = await fetch('/api/maddox/nudges');
                if (!res.ok) return;
                const { nudges } = await res.json();
                // Filter out dismissed ones (stored in localStorage with 24h TTL)
                const now = Date.now();
                _nudgeQueue = nudges.filter(n => {
                    const dismissed = localStorage.getItem('nudge_dismiss_' + n.key);
                    return !dismissed || (now - parseInt(dismissed)) > 12 * 60 * 60 * 1000;
                });
                if (_nudgeQueue.length > 0) showNextNudge();
            } catch (e) { /* silent */ }
        }

        function showNextNudge() {
            if (_nudgeQueue.length === 0) return;
            const panel = document.getElementById('activityBotPanel');
            if (panel && panel.style.display !== 'none') return; // panel open, no need
            const nudge = _nudgeQueue[0];
            const el = document.getElementById('maddoxNudge');
            if (!el) return;
            document.getElementById('maddoxNudgeText').textContent = nudge.message;
            el.style.display = 'flex';
            el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
            // Accent color by severity
            const colors = { urgent: '#e53e3e', warning: '#ed8936', info: '#4299e1' };
            el.style.borderColor = colors[nudge.severity] || '#fde68a';
            // Auto-dismiss after 12s
            clearTimeout(_nudgeTimer);
            _nudgeTimer = setTimeout(dismissNudge, 12000);
        }

        function dismissNudge() {
            const el = document.getElementById('maddoxNudge');
            if (!el) return;
            el.style.display = 'none';
            clearTimeout(_nudgeTimer);
            if (_nudgeQueue.length > 0) {
                const dismissed = _nudgeQueue.shift();
                localStorage.setItem('nudge_dismiss_' + dismissed.key, Date.now().toString());
            }
        }

        function setMaddoxMood(mood) {
            const el = document.getElementById('clippyChar');
            if (!el) return;
            el.classList.remove('mood-happy', 'mood-concerned', 'mood-alert', 'mood-excited');
            if (mood !== 'happy') el.classList.add('mood-' + mood);
        }

        // Random blink every 3-6s
        setInterval(() => {
            const eyes = document.querySelectorAll('.clippy-eye');
            eyes.forEach(e => { e.style.transform = 'scaleY(0.1)'; setTimeout(() => e.style.transform = '', 120); });
        }, 3000 + Math.random() * 3000);
    </script>

    <!-- Rex -->
    <style>
        @keyframes clippyIdle {
            0%,100% { transform: translateY(0) rotate(0deg); }
            25%      { transform: translateY(-5px) rotate(2deg); }
            75%      { transform: translateY(-3px) rotate(-2deg); }
        }
        @keyframes tailWag {
            0%,100% { transform: rotate(-22deg); }
            50%      { transform: rotate(18deg); }
        }
        #rexTail { transform-box: fill-box; transform-origin: 0% 100%; animation: tailWag 0.55s ease-in-out infinite; }
        @keyframes clippyBounce {
            0%   { transform: translateY(0) scaleY(1); }
            30%  { transform: translateY(-18px) scaleY(1.06); }
            55%  { transform: translateY(-6px) scaleY(0.94); }
            75%  { transform: translateY(-12px) scaleY(1.03); }
            100% { transform: translateY(0) scaleY(1); }
        }
        @keyframes clippyTalk {
            0%,100% { transform: rotate(0deg) translateY(0); }
            25%     { transform: rotate(-7deg) translateY(-3px); }
            75%     { transform: rotate(7deg) translateY(-3px); }
        }
        @keyframes clippyThink {
            0%,100% { transform: rotate(0deg) translateY(0); }
            50%     { transform: rotate(18deg) translateY(-4px); }
        }
        @keyframes clippyAppear {
            0%   { transform: translateY(80px) rotate(-15deg); opacity: 0; }
            60%  { transform: translateY(-8px) rotate(3deg); opacity: 1; }
            80%  { transform: translateY(4px) rotate(-2deg); }
            100% { transform: translateY(0) rotate(0); }
        }
        @keyframes dotPulse {
            0%,80%,100% { opacity: 0.3; transform: scale(0.8); }
            40%         { opacity: 1;   transform: scale(1.2); }
        }
        @keyframes bubblePop {
            0%   { transform: scale(0.6) translateY(10px); opacity: 0; transform-origin: bottom right; }
            70%  { transform: scale(1.04) translateY(-2px); opacity: 1; }
            100% { transform: scale(1) translateY(0); opacity: 1; }
        }

        @keyframes clippyAlert {
            0%,100% { transform: translateX(0) rotate(0deg); }
            20%     { transform: translateX(-9px) rotate(-7deg); }
            40%     { transform: translateX(9px) rotate(7deg); }
            60%     { transform: translateX(-5px) rotate(-4deg); }
            80%     { transform: translateX(5px) rotate(4deg); }
        }
        .mood-alert #rexTail      { animation-duration: 0.22s !important; }
        .mood-excited #rexTail    { animation-duration: 0.33s !important; }
        .mood-concerned #rexTail  { animation-duration: 1.5s !important; }
        #maddoxMouthConcerned     { display: none; }
        .mood-concerned #maddoxMouthHappy     { display: none !important; }
        .mood-concerned #maddoxMouthConcerned { display: block !important; }
        @keyframes nudgePop {
            0%   { transform: scale(0.85) translateY(6px); opacity: 0; }
            100% { transform: scale(1) translateY(0); opacity: 1; }
        }
        #maddoxNudge { position:absolute;bottom:calc(100% + 10px);right:0;background:white;border:2px solid #fde68a;border-radius:12px 12px 2px 12px;padding:0.55rem 0.8rem 0.55rem 0.75rem;font-size:0.78rem;color:#1a202c;max-width:210px;box-shadow:0 4px 18px rgba(0,0,0,0.13);animation:nudgePop 0.3s cubic-bezier(.36,.07,.19,.97) both;display:flex;gap:0.4rem;align-items:flex-start;line-height:1.45; }
        #maddoxNudgeDismiss { background:none;border:none;color:#a0aec0;cursor:pointer;font-size:0.85rem;line-height:1;padding:0;flex-shrink:0;margin-top:1px; }
        #maddoxNudgeDismiss:hover { color:#e53e3e; }
        #clippyWrap { position:fixed;bottom:1.2rem;right:1.4rem;z-index:900;display:flex;flex-direction:column;align-items:flex-end;gap:0.5rem; }
        #clippyChar { width:72px;height:90px;cursor:pointer;animation: clippyAppear 0.7s cubic-bezier(.36,.07,.19,.97) both, clippyIdle 3s ease-in-out 0.7s infinite;position:relative;filter:drop-shadow(0 4px 8px rgba(0,0,0,0.18)); }
        #clippyChar:hover { filter:drop-shadow(0 6px 14px rgba(196,124,48,0.55)); }
        #activityBotDot { position:absolute;top:-2px;right:-2px;width:14px;height:14px;background:#e53e3e;border-radius:50%;border:2.5px solid white;box-shadow:0 0 6px rgba(229,62,62,0.6);display:none; }

        #activityBotPanel { width:320px;max-width:calc(100vw - 2rem);height:440px;background:white;border-radius:16px 16px 4px 16px;box-shadow:0 8px 40px rgba(0,0,0,0.2);flex-direction:column;overflow:hidden;border:2px solid #e2e8f0;animation:bubblePop 0.35s cubic-bezier(.36,.07,.19,.97) both; }
        #botHeader { background:#fef9c3;border-bottom:2px solid #fde68a;padding:0.7rem 1rem;display:flex;align-items:center;justify-content:space-between;flex-shrink:0; }
        #botHeader span { font-size:0.82rem;font-weight:700;color:#92400e;letter-spacing:0.02em; }
        #botHeader button { background:none;border:none;font-size:1rem;cursor:pointer;color:#92400e;line-height:1; }
        #botMessageLog { flex:1;overflow-y:auto;padding:0.75rem;display:flex;flex-direction:column;gap:0.6rem;background:#fffef7; }
        .bot-msg { max-width:90%;padding:0.55rem 0.85rem;border-radius:12px;font-size:0.83rem;line-height:1.55;word-break:break-word; }
        .bot-msg-bot { background:white;border:1.5px solid #fde68a;align-self:flex-start;border-bottom-left-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,0.06); }
        .bot-msg-user { background:#667eea;color:white;align-self:flex-end;border-bottom-right-radius:3px; }
        .bot-dots span { display:inline-block;animation:dotPulse 1.2s ease-in-out infinite; }
        .bot-dots span:nth-child(2) { animation-delay:0.2s; }
        .bot-dots span:nth-child(3) { animation-delay:0.4s; }
        #botQuickReplies { display:flex;flex-wrap:wrap;gap:0.35rem;padding:0.45rem 0.65rem;border-top:1.5px solid #fde68a;background:#fffef7;flex-shrink:0; }
        #botQuickReplies button { background:#fef9c3;border:1px solid #fde68a;color:#78350f;padding:0.25rem 0.6rem;border-radius:20px;font-size:0.73rem;cursor:pointer;white-space:nowrap;transition:background 0.15s; }
        #botQuickReplies button:hover { background:#fde68a; }
        #botInputRow { display:flex;padding:0.45rem 0.65rem;border-top:1.5px solid #fde68a;background:white;flex-shrink:0;gap:0.4rem; }
        #botInput { flex:1;padding:0.45rem 0.7rem;border:1.5px solid #fde68a;border-radius:20px;font-size:0.83rem;outline:none;background:#fffef7; }
        #botInput:focus { border-color:#f59e0b; }
        #botSendBtn { background:#f59e0b;color:white;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:0.9rem;flex-shrink:0;transition:background 0.15s; }
        #botSendBtn:hover { background:#d97706; }
        .clippy-eye { transition: transform 0.1s; transform-box: fill-box; transform-origin: center; }
    </style>

    <div id="clippyWrap">
        <!-- Speech bubble panel -->
        <div id="activityBotPanel" style="display:none;">
            <div id="botHeader">
                <span>🐾 Maddox says...</span>
                <button onclick="toggleActivityBot()" title="Close">✕</button>
            </div>
            <div id="botMessageLog"></div>
            <div id="botQuickReplies">
                <button onclick="sendBotQuery('Outstanding invoices')">💰 Outstanding</button>
                <button onclick="sendBotQuery('Urgent work orders')">🔴 Urgent</button>
                <button onclick="sendBotQuery('This week schedule')">📅 This week</button>
                <button onclick="sendBotQuery('Recent payments')">✅ Payments</button>
                <button onclick="sendBotQuery('Unread messages')">💬 Messages</button>
                <button onclick="sendBotQuery('Revenue this month')">📈 Revenue</button>
            </div>
            <div id="botInputRow">
                <input id="botInput" placeholder="Ask Maddox anything..." onkeydown="handleBotInput(event)">
                <button id="botSendBtn" onclick="(()=>{const i=document.getElementById('botInput');const v=i.value.trim();if(v){i.value='';sendBotQuery(v);}})()">➤</button>
            </div>
        </div>

        <!-- Maddox the German Shepherd -->
        <div id="clippyChar" onclick="toggleActivityBot()" title="Woof! Need a hand?">
            <span id="activityBotDot"></span>
            <div id="maddoxNudge" style="display:none;">
                <button id="maddoxNudgeDismiss" onclick="dismissNudge()" title="Dismiss">✕</button>
                <span id="maddoxNudgeText"></span>
            </div>
            <svg viewBox="0 0 90 100" width="72" height="90" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <filter id="gshadow" x="-20%" y="-20%" width="140%" height="140%">
                        <feDropShadow dx="0" dy="2" stdDeviation="2.2" flood-color="rgba(0,0,0,0.3)"/>
                    </filter>
                </defs>

                <!-- Ground shadow -->
                <ellipse cx="43" cy="97" rx="21" ry="3.5" fill="rgba(0,0,0,0.10)"/>

                <!-- TAIL (animated — behind body) -->
                <g id="rexTail">
                    <path d="M 63 74 Q 83 60 79 44 Q 76 34 67 41"
                          fill="none" stroke="#1c0a04" stroke-width="9" stroke-linecap="round"/>
                    <path d="M 63 74 Q 83 60 79 44 Q 76 34 67 41"
                          fill="none" stroke="#c98030" stroke-width="5.5" stroke-linecap="round"/>
                    <path d="M 77 37 Q 71 39 67 44"
                          fill="none" stroke="#f0dea0" stroke-width="5" stroke-linecap="round"/>
                </g>

                <!-- BODY — black saddle over rich tan, cream chest like Maddox -->
                <ellipse cx="42" cy="72" rx="24" ry="20" fill="#1c0a04"/>
                <ellipse cx="42" cy="76" rx="22" ry="17" fill="#c98030"/>
                <ellipse cx="41" cy="79" rx="13" ry="13" fill="#e8b050"/>

                <!-- FRONT PAWS -->
                <rect x="21" y="85" width="14" height="10" rx="7" fill="#c98030"/>
                <rect x="49" y="85" width="14" height="10" rx="7" fill="#c98030"/>
                <ellipse cx="28" cy="94" rx="6" ry="2.8" fill="#a06020"/>
                <ellipse cx="56" cy="94" rx="6" ry="2.8" fill="#a06020"/>
                <line x1="25" y1="93" x2="25" y2="88" stroke="#8a5010" stroke-width="1.1" stroke-linecap="round" opacity="0.55"/>
                <line x1="28" y1="94" x2="28" y2="88" stroke="#8a5010" stroke-width="1.1" stroke-linecap="round" opacity="0.55"/>
                <line x1="31" y1="93" x2="31" y2="88" stroke="#8a5010" stroke-width="1.1" stroke-linecap="round" opacity="0.55"/>
                <line x1="53" y1="93" x2="53" y2="88" stroke="#8a5010" stroke-width="1.1" stroke-linecap="round" opacity="0.55"/>
                <line x1="56" y1="94" x2="56" y2="88" stroke="#8a5010" stroke-width="1.1" stroke-linecap="round" opacity="0.55"/>
                <line x1="59" y1="93" x2="59" y2="88" stroke="#8a5010" stroke-width="1.1" stroke-linecap="round" opacity="0.55"/>

                <!-- EARS — behind head in render order -->
                <polygon points="23,28 14,5 37,20" fill="#1c0a04"/>
                <polygon points="24,26 18,9 35,21" fill="#c98030"/>
                <polygon points="24,25 21,13 32,21" fill="#d89060" opacity="0.5"/>
                <polygon points="65,28 76,5 53,20" fill="#1c0a04"/>
                <polygon points="64,26 72,9 55,21" fill="#c98030"/>
                <polygon points="64,25 69,13 58,21" fill="#d89060" opacity="0.5"/>

                <!-- HEAD — warm tan base, Maddox's coloring -->
                <circle cx="44" cy="37" r="22" fill="#c98030" filter="url(#gshadow)"/>

                <!-- BLACK CROWN — wide across top, the classic GSD cap -->
                <path d="M 23 31 Q 24 13 44 11 Q 64 13 65 31 Q 58 20 44 19 Q 30 20 23 31 Z" fill="#1c0a04"/>

                <!-- BLACK MASK — runs center forehead down to muzzle, GSD signature -->
                <path d="M 38 19 Q 44 20 50 19 L 52 31 Q 44 33 36 31 Z" fill="#1c0a04" opacity="0.65"/>

                <!-- TAN EYEBROW SPOTS — Maddox's most expressive feature -->
                <ellipse cx="35" cy="29" rx="5.2" ry="3.2" fill="#e8a830"/>
                <ellipse cx="53" cy="29" rx="5.2" ry="3.2" fill="#e8a830"/>

                <!-- TAN CHEEKS — warm sides of face around the black mask -->
                <ellipse cx="26" cy="43" rx="8" ry="10" fill="#c98030"/>
                <ellipse cx="62" cy="43" rx="8" ry="10" fill="#c98030"/>

                <!-- EYES — large, dark, soulful like the photo -->
                <g class="clippy-eye">
                    <circle cx="35" cy="37" r="6.2" fill="#1c0a04"/>
                    <circle cx="35" cy="37" r="4.2" fill="#5a2e10"/>
                    <circle cx="36.8" cy="35" r="2.1" fill="white" opacity="0.92"/>
                    <circle cx="33.2" cy="38.8" r="1.1" fill="white" opacity="0.32"/>
                </g>
                <g class="clippy-eye">
                    <circle cx="53" cy="37" r="6.2" fill="#1c0a04"/>
                    <circle cx="53" cy="37" r="4.2" fill="#5a2e10"/>
                    <circle cx="54.8" cy="35" r="2.1" fill="white" opacity="0.92"/>
                    <circle cx="51.2" cy="38.8" r="1.1" fill="white" opacity="0.32"/>
                </g>

                <!-- BLACK MUZZLE — long elegant GSD snout -->
                <ellipse cx="44" cy="49" rx="11.5" ry="10.5" fill="#1c0a04"/>
                <ellipse cx="44" cy="52" rx="8" ry="7" fill="#1e0c06"/>

                <!-- NOSE — broad, wet, prominent -->
                <ellipse cx="44" cy="44.5" rx="6.8" ry="5.2" fill="#080604"/>
                <ellipse cx="42" cy="43" rx="2.5" ry="1.6" fill="rgba(255,255,255,0.52)"/>
                <ellipse cx="46" cy="44" rx="1.1" ry="0.9" fill="rgba(255,255,255,0.22)"/>

                <g id="maddoxMouthHappy">
                    <path d="M 37.5 55 Q 44 61 50.5 55"
                          fill="none" stroke="#1c0a04" stroke-width="2" stroke-linecap="round"/>
                    <ellipse cx="44" cy="59.5" rx="5.2" ry="4.5" fill="#d83055"/>
                    <ellipse cx="44" cy="61.5" rx="4.4" ry="2.6" fill="#b82040"/>
                    <line x1="44" y1="56" x2="44" y2="60" stroke="#c02848" stroke-width="1.8" stroke-linecap="round"/>
                </g>
                <g id="maddoxMouthConcerned">
                    <path d="M 37.5 59 Q 44 54 50.5 59"
                          fill="none" stroke="#1c0a04" stroke-width="2" stroke-linecap="round"/>
                </g>

                <!-- BANDANA — red with white polka dots, triangle on chest -->
                <path d="M 30 63 Q 44 58 58 63 L 44 83 Z" fill="#c0392b"/>
                <circle cx="37" cy="69" r="2.2" fill="white" opacity="0.55"/>
                <circle cx="44" cy="75" r="2.2" fill="white" opacity="0.55"/>
                <circle cx="51" cy="69" r="2.2" fill="white" opacity="0.55"/>
                <circle cx="33" cy="64.5" r="1.4" fill="white" opacity="0.45"/>
                <circle cx="55" cy="64.5" r="1.4" fill="white" opacity="0.45"/>
                <circle cx="40.5" cy="80" r="1.5" fill="white" opacity="0.38"/>
                <circle cx="47.5" cy="80" r="1.5" fill="white" opacity="0.38"/>
                <!-- Knot roll -->
                <ellipse cx="44" cy="63" rx="9.5" ry="5.5" fill="#e74c3c"/>
                <ellipse cx="44" cy="61.5" rx="6.5" ry="3" fill="rgba(255,255,255,0.18)"/>
                <path d="M 35 63 Q 44 67 53 63" fill="none" stroke="#a93226" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/>

                <!-- TAG — green like the real Maddox tag in the photo -->
                <circle cx="44" cy="70" r="3.5" fill="#27ae60"/>
                <circle cx="44" cy="70" r="3.5" fill="none" stroke="#1e8449" stroke-width="0.8"/>
                <text x="44" y="71.5" text-anchor="middle" font-size="3.5" fill="white" font-weight="bold" font-family="Arial">M</text>
            </svg>
        </div>
    </div>
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
            if (!Array.isArray(job.assignedTo)) job.assignedTo = [];

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
        <p><strong>${maskName(client ? client.name : 'Unknown Client')}</strong></p>
        ${client && client.address ? `<p>${client.address.replace(/\n/g, '<br>')}</p>` : ''}
        ${client && client.phone ? `<p>Phone: ${client.phone}</p>` : ''}
        ${client && client.email ? `<p>Email: ${client.email}</p>` : ''}
    </div>

    <div style="margin-bottom: 20px;">
        <p><strong>Job:</strong> ${job.title}</p>
        <p><strong>Description:</strong> ${job.description || 'N/A'}</p>
        <p><strong>Date:</strong> ${job.scheduledDate || ''} ${job.scheduledTime || ''}</p>
        <p><strong>Technician:</strong> ${assignedNames}</p>
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
        <p>Please remit payment within 3 days.</p>
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
